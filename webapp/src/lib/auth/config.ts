import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { randomUUID } from "node:crypto";
import { authenticate } from "@/server/accounts";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
          const account = await authenticate(email, password, {
            requestId: randomUUID(),
            ipHash: null,
            userAgent: null,
          });
          return {
            id: account.accountId,
            email: account.email,
            institutionId: account.institutionId,
            roles: account.roles,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.institutionId = (user as { institutionId: string }).institutionId;
        token.roles = (user as { roles: string[] }).roles;
      }
      return token;
    },
    session({ session, token }) {
      session.user.accountId = token.sub!;
      session.user.institutionId = token.institutionId as string;
      session.user.roles = token.roles as string[];
      return session;
    },
  },
});
