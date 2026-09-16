import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      accountId: string;
      institutionId: string;
      roles: string[];
      email?: string | null;
    };
  }

  /** authorize() returns the session row's id; the jwt callback carries it. */
  interface User {
    sessionId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** compliance.sessions id. The token is transport; this row is the authority. */
    sid?: string;
  }
}
