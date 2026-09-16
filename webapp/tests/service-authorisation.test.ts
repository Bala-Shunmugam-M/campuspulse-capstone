import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every exported function in src/server/ must perform an authorisation check.
 * The exemption list is explicit and must stay short: anything on it is a
 * deliberate decision someone can review, not an oversight nobody noticed.
 */
const EXEMPT = new Set([
  "authenticate",           // produces identity; cannot require it
  "newRequestMeta",         // pure helper, touches no data
  "submitAnonymousReport",  // by definition has no actor; rate-limited instead
  "lookupAnonymousReport",  // authorised by reference code + access secret
]);

const SERVER_DIR = join(__dirname, "..", "src", "server");
const CHECKS = ["requireRole", "requireSameInstitution", "assertRateLimit"];

describe("service layer authorisation", () => {
  it("every exported service either authorises or is explicitly exempt", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(SERVER_DIR, file), "utf8");
      const exported = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
        (m) => m[1],
      );

      for (const name of exported) {
        if (EXEMPT.has(name)) continue;
        const start = source.indexOf(`function ${name}`);
        const rest = source.slice(start);
        const end = rest.indexOf("\nexport ");
        const fnSource = end === -1 ? rest : rest.slice(0, end);
        if (!CHECKS.some((check) => fnSource.includes(check))) {
          offenders.push(`${file}:${name}`);
        }
      }
    }

    expect(offenders, `services missing an authorisation call: ${offenders.join(", ")}`).toEqual([]);
  });
});
