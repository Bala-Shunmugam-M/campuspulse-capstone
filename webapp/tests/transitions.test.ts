import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { CaseStatus } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { changeCaseStatus, triageReport } from "../src/server/cases";
import { recordOutcome } from "../src/server/outcomes";
import { TRANSITIONS, canTransition, findTransition } from "../src/lib/cases/transitions";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

const ALL_STATUSES: CaseStatus[] = [
  "submitted", "triaged", "under_investigation", "pending_decision",
  "resolved", "closed", "dismissed", "appealed",
];

let institutionId: string;
let admin: Actor;
let investigator: Actor;

async function actorWith(role: "admin" | "investigator" | "officer"): Promise<Actor> {
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role, revokedAt: null } } },
  });
  return { accountId: account.id, institutionId, roles: [role] };
}

/** A fresh case, always at `submitted`. */
async function aCase(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Transition fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin,
    report.id,
    { severity: "moderate", title: "Transition fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

/** Walks a case to `target` along legal steps, as an admin. */
async function caseAt(target: CaseStatus): Promise<string> {
  const id = await aCase();
  if (target === "submitted") return id;

  const routes: Record<string, CaseStatus[]> = {
    triaged: ["triaged"],
    under_investigation: ["triaged", "under_investigation"],
    pending_decision: ["triaged", "under_investigation", "pending_decision"],
    resolved: ["triaged", "under_investigation", "pending_decision", "resolved"],
    closed: ["triaged", "under_investigation", "pending_decision", "resolved", "closed"],
    dismissed: ["triaged", "dismissed"],
    appealed: ["triaged", "under_investigation", "pending_decision", "resolved", "closed", "appealed"],
  };

  for (const step of routes[target]) {
    // "resolved" is reached by recording the decision, never by a bare status
    // change -- see changeCaseStatus.
    if (step === "resolved") {
      await recordOutcome(admin, id, { finding: "upheld", rationale: "fixture" }, meta());
    } else {
      await changeCaseStatus(admin, id, step, null, meta());
    }
  }
  return id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  admin = await actorWith("admin");
  investigator = await actorWith("investigator");
});

describe("the transition map", () => {
  it("refuses every pair that is not in the map", () => {
    // The whole cross-product, so a typo'd or duplicated map row shows up here
    // rather than as a path nobody can walk.
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const listed = Boolean(findTransition(from, to));
        const allowed = canTransition(from, to, ["officer", "investigator", "admin", "dpo"]);
        expect(allowed, `${from} -> ${to}`).toBe(listed);
      }
    }
  });

  it("has no duplicate rows", () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names at least one role for every transition", () => {
    for (const t of TRANSITIONS) {
      expect(t.roles.length, `${t.from} -> ${t.to}`).toBeGreaterThan(0);
    }
  });
});

describe("changeCaseStatus", () => {
  it("performs a legal transition and records it in history", async () => {
    const id = await aCase();
    await changeCaseStatus(admin, id, "triaged", "looks substantiated", meta());

    const kase = await prisma.case.findUniqueOrThrow({
      where: { id },
      include: { statusHistory: { orderBy: { changedAt: "asc" } } },
    });
    expect(kase.status).toBe("triaged");
    const last = kase.statusHistory.at(-1);
    expect(last?.fromStatus).toBe("submitted");
    expect(last?.toStatus).toBe("triaged");
    expect(last?.reason).toBe("looks substantiated");
  });

  it("refuses a transition that is not in the map", async () => {
    const id = await aCase();
    await expect(changeCaseStatus(admin, id, "closed", null, meta())).rejects.toThrow(
      /cannot move from submitted to closed/i,
    );
  });

  it("refuses a legal transition to an actor without the role", async () => {
    const id = await aCase();
    // submitted -> triaged is officer/admin only; an investigator may not.
    await expect(changeCaseStatus(investigator, id, "triaged", null, meta())).rejects.toThrow(
      /cannot move/i,
    );
  });

  it("writes neither history nor audit when the transition is refused", async () => {
    const id = await aCase();
    const historyBefore = await prisma.caseStatusHistory.count({ where: { caseId: id } });
    const auditBefore = await prisma.auditEvent.count({
      where: { entityId: id, action: "case.status_changed" },
    });

    await expect(changeCaseStatus(admin, id, "resolved", null, meta())).rejects.toThrow();

    expect(await prisma.caseStatusHistory.count({ where: { caseId: id } })).toBe(historyBefore);
    expect(
      await prisma.auditEvent.count({ where: { entityId: id, action: "case.status_changed" } }),
    ).toBe(auditBefore);
  });

  it("stamps closed_at once and does not move it on re-entry", async () => {
    const id = await caseAt("closed");
    const first = await prisma.case.findUniqueOrThrow({ where: { id } });
    expect(first.closedAt).not.toBeNull();

    // closed -> appealed -> under_investigation -> ... -> closed again
    await changeCaseStatus(admin, id, "appealed", null, meta());
    await changeCaseStatus(admin, id, "under_investigation", null, meta());
    await changeCaseStatus(admin, id, "pending_decision", null, meta());
    await recordOutcome(admin, id, { finding: "upheld", rationale: "re-decided" }, meta());
    await changeCaseStatus(admin, id, "closed", null, meta());

    const again = await prisma.case.findUniqueOrThrow({ where: { id } });
    expect(again.closedAt?.getTime()).toBe(first.closedAt?.getTime());
  });

  it("audits the change with before and after", async () => {
    const id = await aCase();
    await changeCaseStatus(admin, id, "triaged", null, meta());

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: id, action: "case.status_changed" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit.before).toMatchObject({ status: "submitted" });
    expect(audit.after).toMatchObject({ status: "triaged" });
  });
});
