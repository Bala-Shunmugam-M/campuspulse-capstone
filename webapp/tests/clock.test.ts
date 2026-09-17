import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import {
  SIMULATED_NOW_HEADER,
  now,
  requestNow,
  simulationEnabled,
  withSimulatedTime,
} from "../src/lib/clock";
import { newRequestMeta } from "../src/server/accounts";
import { submitAnonymousReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

/** Well inside the past, and nowhere near any real clock this test could see. */
const SIMULATED = new Date("2026-04-12T08:15:00.000Z");

/**
 * Both gates, set together. vi.stubEnv rather than assignment because
 * process.env.NODE_ENV is not an ordinary writable property, and because
 * unstubAllEnvs puts the process back as it found it however a test ends.
 */
function setEnv(simulation: string | undefined, nodeEnv: string) {
  vi.stubEnv("SIMULATION_MODE", simulation);
  vi.stubEnv("NODE_ENV", nodeEnv as "test");
}

function headersWith(value: string): Headers {
  return new Headers({ [SIMULATED_NOW_HEADER]: value });
}

let institutionId: string;
let officer: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  officer = {
    accountId: account.id,
    institutionId,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the clock seam is shut by default", () => {
  it("reads the real clock with no flag set", () => {
    setEnv(undefined, "test");
    expect(simulationEnabled()).toBe(false);

    const before = Date.now();
    const reading = now().getTime();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  it("ignores the header without the flag", () => {
    setEnv(undefined, "test");
    expect(Math.abs(requestNow(headersWith(SIMULATED.toISOString())).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("ignores the header in production even with the flag", () => {
    // The second gate is a refusal, not a fallback. A stray SIMULATION_MODE in a
    // deployed environment must not hand a request the ability to date its own
    // writes.
    setEnv("1", "production");
    expect(simulationEnabled()).toBe(false);

    expect(Math.abs(requestNow(headersWith(SIMULATED.toISOString())).getTime() - Date.now())).toBeLessThan(5_000);

    // withSimulatedTime is refused on the same terms, so a script cannot reach
    // around the header.
    const seen = withSimulatedTime(SIMULATED, () => now().getTime());
    expect(Math.abs(seen - Date.now())).toBeLessThan(5_000);
  });

  it("ignores a malformed header rather than raising", () => {
    setEnv("1", "test");
    expect(Math.abs(requestNow(headersWith("not a date at all")).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("reads the real clock with the flag set but no header", () => {
    setEnv("1", "test");
    expect(simulationEnabled()).toBe(true);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe("with both gates open", () => {
  it("returns the simulated instant", () => {
    setEnv("1", "test");
    const seen = withSimulatedTime(SIMULATED, () => now());
    expect(seen.toISOString()).toBe(SIMULATED.toISOString());
  });

  it("keeps two concurrent contexts at their own instants", async () => {
    setEnv("1", "test");
    const a = new Date("2026-01-01T00:00:00.000Z");
    const b = new Date("2026-08-01T00:00:00.000Z");

    // Two simulated agents at different points in time must not see each
    // other's clock.
    const [seenA, seenB] = await Promise.all([
      withSimulatedTime(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return now().toISOString();
      }),
      withSimulatedTime(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return now().toISOString();
      }),
    ]);

    expect(seenA).toBe(a.toISOString());
    expect(seenB).toBe(b.toISOString());
  });

  it("dates a case opened through the service layer, including its audit row", async () => {
    setEnv("1", "test");

    const caseId = await withSimulatedTime(SIMULATED, async () => {
      // newRequestMeta is where a request adopts the clock, so go through it.
      const meta = newRequestMeta(headersWith(SIMULATED.toISOString()));

      const { referenceCode } = await submitAnonymousReport(
        institutionId,
        {
          title: "Clock fixture",
          description: "A description that comfortably exceeds the minimum length requirement.",
          severitySelfReported: "high",
          categoryId: null,
          locationId: null,
          occurredAt: null,
        },
        meta,
      );
      const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
      const { caseNumber } = await triageReport(
        officer,
        report.id,
        { severity: "high", title: "Clock fixture", confidentiality: "standard" },
        newRequestMeta(headersWith(SIMULATED.toISOString())),
      );
      const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
      return kase.id;
    });

    const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(kase.openedAt.toISOString()).toBe(SIMULATED.toISOString());
    // high severity is 72 hours, measured from the simulated opening.
    expect(kase.slaDueAt.toISOString()).toBe(
      new Date(SIMULATED.getTime() + 72 * 3_600_000).toISOString(),
    );

    // The audit row too. Postgres now() is transaction time and could not have
    // produced this, which is why withAudit stamps occurred_at itself.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "case", entityId: caseId, action: "case.opened" },
    });
    expect(event.occurredAt.toISOString()).toBe(SIMULATED.toISOString());
  });

  it("leaves no simulated instant behind once the scope closes", async () => {
    setEnv("1", "test");

    // The first version of this seam used AsyncLocalStorage.enterWith, which
    // mutates the current context instead of opening a new one. On a
    // long-lived server the instant outlived the request that set it and a
    // later request read an earlier one's clock -- the simulator produced a
    // case closed nine days before it was investigated. Nothing may survive
    // the scope that set it.
    await withSimulatedTime(SIMULATED, async () => {
      expect(now().toISOString()).toBe(SIMULATED.toISOString());
    });

    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);

    // And a second, different scope is unaffected by the first.
    const other = new Date("2026-07-04T00:00:00.000Z");
    const seen = await withSimulatedTime(other, async () => now().toISOString());
    expect(seen).toBe(other.toISOString());
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("reads the instant a request carries, and hands it back rather than stashing it", () => {
    setEnv("1", "test");

    // requestNow returns the instant instead of putting it in ambient storage.
    // The caller puts it on RequestMeta, so every stamp in the request can be
    // traced to this one decision and no request can inherit another's clock.
    expect(requestNow(headersWith(SIMULATED.toISOString())).toISOString()).toBe(
      SIMULATED.toISOString(),
    );
    expect(newRequestMeta(headersWith(SIMULATED.toISOString())).at.toISOString()).toBe(
      SIMULATED.toISOString(),
    );

    // Reading it changed nothing about what anyone else sees.
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("falls back to the real clock when a request carries no header", () => {
    setEnv("1", "test");
    const bare = new Headers();
    expect(Math.abs(requestNow(bare).getTime() - Date.now())).toBeLessThan(5_000);
    expect(Math.abs(newRequestMeta(bare).at.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("leaves the audit row dated with the event, not with the transaction", async () => {
    setEnv("1", "test");
    const marker = randomUUID();

    await withSimulatedTime(SIMULATED, async () => {
      await submitAnonymousReport(
        institutionId,
        {
          title: `Clock audit ${marker}`,
          description: "A description that comfortably exceeds the minimum length requirement.",
          severitySelfReported: "low",
          categoryId: null,
          locationId: null,
          occurredAt: null,
        },
        newRequestMeta(headersWith(SIMULATED.toISOString())),
      );
    });

    const report = await prisma.report.findFirstOrThrow({
      where: { title: `Clock audit ${marker}` },
    });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "report", entityId: report.id, action: "report.submitted" },
    });
    expect(event.occurredAt.toISOString()).toBe(SIMULATED.toISOString());
  });
});
