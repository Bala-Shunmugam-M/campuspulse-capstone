import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { authenticate } from "@/server/accounts";
import { issueSession, loadSession, revokeSession } from "@/lib/auth/session";

/** Blank identity. Presented when the session row is gone, so a live token reads as signed out. */
const SIGNED_OUT = { accountId: "", institutionId: "", roles: [] as string[] };

export const { handlers, auth, signIn, signOut } = NextAuth({
  // The JWT is transport only. compliance.sessions holds the authority, so a
  // revoked session takes effect on the next request rather than at token
  // expiry. Auth.js v5 cannot use its database strategy with the Credentials
  // provider, which is why the token remains.
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = String(raw?.email ?? "");
        const password = String(raw?.password ?? "");
        if (!email || !password) return null;
        try {
          const meta = { requestId: randomUUID(), ipHash: null, userAgent: null };
          const account = await authenticate(email, password, meta);
          const sessionId = await issueSession(account.accountId, meta);
          return {
            id: account.accountId,
            email: account.email,
            sessionId,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.sid = (user as { sessionId: string }).sessionId;
      return token;
    },

    async session({ session, token }) {
      const sid = token.sid as string | undefined;
      const row = sid ? await loadSession(sid) : null;
      if (!row) return { ...session, user: { ...session.user, ...SIGNED_OUT } };

      // Roles are read from the database on every request rather than carried in
      // the token. A grant revoked mid-session must bite on the next request;
      // that is the point of doing this at all.
      const account = await prisma.userAccount.findFirst({
        where: { id: row.userAccountId, deletedAt: null },
        include: { roles: { where: { revokedAt: null } } },
      });
      if (!account) return { ...session, user: { ...session.user, ...SIGNED_OUT } };

      session.user.accountId = account.id;
      session.user.institutionId = account.institutionId;
      session.user.roles = account.roles.map((r) => r.role);
      session.user.email = account.email;
      return session;
    },
  },
  events: {
    // Signing out revokes the row. Clearing the cookie alone would leave a
    // token that still works if anyone kept a copy of it.
    async signOut(message) {
      const sid =
        "token" in message ? (message.token?.sid as string | undefined) : undefined;
      if (sid) {
        await revokeSession(sid, { requestId: randomUUID(), ipHash: null, userAgent: null });
      }
    },
  },
});
