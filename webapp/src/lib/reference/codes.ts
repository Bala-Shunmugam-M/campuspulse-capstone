import { randomBytes, randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** Crockford base32: no I, L, O or U. Survives being read aloud and handwritten. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

function group(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateReferenceCode(): string {
  return `CR-${group(4)}-${group(4)}`;
}

/**
 * 32 bytes of entropy, base32-encoded and grouped for transcription. Shown once
 * and stored only as a hash: the server cannot reproduce it, so a leaked
 * reference code alone discloses nothing.
 */
export function generateAccessSecret(): string {
  const bytes = randomBytes(32);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** The entropy is in the characters, not the formatting. */
function normalise(secret: string): string {
  return secret.replace(/-/g, "").toUpperCase();
}

export function hashAccessSecret(secret: string): Promise<string> {
  return hash(normalise(secret), ARGON);
}

export async function verifyAccessSecret(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, normalise(secret), ARGON);
  } catch {
    return false;
  }
}
