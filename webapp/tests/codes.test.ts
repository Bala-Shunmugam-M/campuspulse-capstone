import { describe, expect, it } from "vitest";
import {
  generateAccessSecret,
  generateReferenceCode,
  hashAccessSecret,
  verifyAccessSecret,
} from "../src/lib/reference/codes";

describe("generateReferenceCode", () => {
  it("matches the documented format", () => {
    expect(generateReferenceCode()).toMatch(/^CR-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  });

  it("excludes characters that are misread when spoken or written", () => {
    const sample = Array.from({ length: 200 }, generateReferenceCode).join("");
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it("does not collide across a large sample", () => {
    const codes = new Set(Array.from({ length: 5000 }, generateReferenceCode));
    expect(codes.size).toBe(5000);
  });
});

describe("access secrets", () => {
  it("verifies the secret it issued", async () => {
    const secret = generateAccessSecret();
    expect(await verifyAccessSecret(await hashAccessSecret(secret), secret)).toBe(true);
  });

  it("rejects a different secret", async () => {
    const hash = await hashAccessSecret(generateAccessSecret());
    expect(await verifyAccessSecret(hash, generateAccessSecret())).toBe(false);
  });

  it("accepts the secret without its grouping hyphens", async () => {
    const secret = generateAccessSecret();
    const hash = await hashAccessSecret(secret);
    expect(await verifyAccessSecret(hash, secret.replace(/-/g, "").toLowerCase())).toBe(true);
  });

  it("is long enough to resist brute force", () => {
    expect(generateAccessSecret().replace(/-/g, "").length).toBeGreaterThanOrEqual(52);
  });
});
