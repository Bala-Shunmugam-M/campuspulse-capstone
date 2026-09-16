import { hash, verify } from "@node-rs/argon2";
import { WeakPasswordError } from "@/lib/errors";

// OWASP minimum for Argon2id.
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const MIN_LENGTH = 12;

/** Deliberately short. A full breach corpus is not shippable; this catches the obvious. */
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiop12",
  "administrator",
  "letmein12345",
  "welcome12345",
  "campuspulse1",
]);

export function assertPasswordAcceptable(plain: string): void {
  if (plain.length < MIN_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  if (COMMON.has(plain.toLowerCase())) {
    throw new WeakPasswordError("That password is too common. Choose another.");
  }
}

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON);
  } catch {
    // A malformed or truncated hash must read as a failed login, never as a crash.
    return false;
  }
}
