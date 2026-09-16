import { describe, expect, it } from "vitest";
import {
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
} from "../src/lib/auth/password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("produces a different hash for the same password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a long passphrase", () => {
    expect(() => assertPasswordAcceptable("correct horse battery staple")).not.toThrow();
  });

  it("rejects anything under 12 characters", () => {
    expect(() => assertPasswordAcceptable("Sh0rt!")).toThrow(/12 characters/);
  });

  it("rejects a common password even when long enough", () => {
    expect(() => assertPasswordAcceptable("password1234")).toThrow(/too common/);
  });
});
