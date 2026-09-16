import { describe, expect, it } from "vitest";
import { requireRole, requireSameInstitution, type Actor } from "../src/lib/auth/rbac";

const actor = (roles: Actor["roles"]): Actor => ({
  accountId: "a",
  institutionId: "inst-1",
  roles,
});

describe("requireRole", () => {
  it("allows an actor holding one of the permitted roles", () => {
    expect(() => requireRole(actor(["officer"]), ["officer", "admin"])).not.toThrow();
  });

  it("rejects an actor holding none of them", () => {
    expect(() => requireRole(actor(["reporter"]), ["officer"])).toThrow(/not permitted/i);
  });

  it("rejects an unauthenticated actor", () => {
    expect(() => requireRole(null, ["reporter"])).toThrow(/sign in/i);
  });

  it("returns the actor so callers can use it directly", () => {
    expect(requireRole(actor(["admin"]), ["admin"]).accountId).toBe("a");
  });
});

describe("requireSameInstitution", () => {
  it("allows a matching institution", () => {
    expect(() => requireSameInstitution(actor(["officer"]), "inst-1")).not.toThrow();
  });

  it("rejects a different institution even for an admin", () => {
    expect(() => requireSameInstitution(actor(["admin"]), "inst-2")).toThrow(/not permitted/i);
  });
});
