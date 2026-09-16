import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      accountId: string;
      institutionId: string;
      roles: string[];
      email?: string | null;
    };
  }
}
