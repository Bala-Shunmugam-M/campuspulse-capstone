import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { assignCase, changeCaseStatus, triageReport } from "../src/server/cases";
import { addParty } from "../src/server/parties";
import { listActivity, listNotifications, markRead, unreadCount } from "../src/server/notifications";
import { addNote } from "../src/server/notes";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let admin: Actor;
let officer: Actor;
let partyActor: Actor;

async function aCase(): Promise<{ id: string; caseNumber: string }> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Notification fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null, locationId: null, occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin, report.id,
    { severity: "moderate", title: "Notification fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return { id: kase.id, caseNumber };
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;

  const a = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  admin = { accountId: a.id, institutionId, email: a.email, roles: ["admin"] };

  const o = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
  });
  officer = { accountId: o.id, institutionId, email: o.email, roles: ["officer"] };

  const p = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, email: { startsWith: "reporter7@" } },
  });
  partyActor = { accountId: p.id, institutionId, email: p.email, roles: ["reporter"] };
});

describe("assignment notifies the assignee", () => {
  it("writes exactly one notification to the assigned officer", async () => {
    const { id, caseNumber } = await aCase();
    const before = await prisma.notification.count({ where: { recipientId: officer.accountId } });

    await assignCase(admin, id, officer.accountId, meta());

    const after = await prisma.notification.count({ where: { recipientId: officer.accountId } });
    expect(after).toBe(before + 1);

    const latest = await prisma.notification.findFirstOrThrow({
      where: { recipientId: officer.accountId, caseId: id },
      orderBy: { createdAt: "desc" },
    });
    expect(latest.subject).toContain(caseNumber);
  });
});

describe("status changes notify the case audience", () => {
  it("reaches the assigned officer and account parties", async () => {
    const { id } = await aCase();
    await assignCase(admin, id, officer.accountId, meta());
    await addParty(admin, id, { partyRole: "respondent", userAccountId: partyActor.accountId }, meta());

    await changeCaseStatus(admin, id, "triaged", "moving along", meta());

    const forOfficer = await prisma.notification.count({
      where: { recipientId: officer.accountId, caseId: id, subject: { contains: "triaged" } },
    });
    const forParty = await prisma.notification.count({
      where: { recipientId: partyActor.accountId, caseId: id, subject: { contains: "triaged" } },
    });
    expect({ forOfficer, forParty }).toEqual({ forOfficer: 1, forParty: 1 });
  });

  it("leaves no notification when the transition is refused", async () => {
    const { id } = await aCase();
    await assignCase(admin, id, officer.accountId, meta());
    const before = await prisma.notification.count({ where: { caseId: id } });

    // submitted -> closed is not in the map.
    await expect(changeCaseStatus(admin, id, "closed", null, meta())).rejects.toThrow();

    expect(await prisma.notification.count({ where: { caseId: id } })).toBe(before);
  });
});

describe("listNotifications", () => {
  it("returns only the actor's own rows", async () => {
    const { id } = await aCase();
    await assignCase(admin, id, officer.accountId, meta());

    const mine = await listNotifications(officer, { limit: 200 });
    const ids = mine.map((n) => n.id);
    const foreign = await prisma.notification.findFirst({
      where: { recipientId: { not: officer.accountId } },
    });
    if (foreign) expect(ids).not.toContain(foreign.id);
  });

  it("counts and clears unread", async () => {
    const { id } = await aCase();
    await assignCase(admin, id, officer.accountId, meta());

    const before = await unreadCount(officer);
    expect(before).toBeGreaterThan(0);

    const [newest] = await listNotifications(officer, { unreadOnly: true, limit: 1 });
    await markRead(officer, newest.id);

    expect(await unreadCount(officer)).toBe(before - 1);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: newest.id } });
    expect(row.readAt).not.toBeNull();
  });

  it("refuses to mark someone else's notification read", async () => {
    const { id } = await aCase();
    await assignCase(admin, id, officer.accountId, meta());
    const [theirs] = await listNotifications(officer, { limit: 1 });

    await expect(markRead(partyActor, theirs.id)).rejects.toThrow(/does not exist/i);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).isRead)
      .toBe(false);
  });
});

describe("the activity feed", () => {
  it("is a view over audit events, scoped to the tenant", async () => {
    const { id } = await aCase();
    await changeCaseStatus(admin, id, "triaged", null, meta());

    const feed = await listActivity(admin, 200);
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.map((e) => e.entityId)).toContain(id);
  });

  it("excludes sign-in noise and internal note traffic", async () => {
    const { id } = await aCase();
    await addNote(officer, id, "internal chatter", "internal", meta());

    const feed = await listActivity(admin, 200);
    expect(feed.some((e) => e.action.startsWith("auth."))).toBe(false);
    expect(feed.some((e) => e.action === "case.note_added")).toBe(false);
  });

  it("is newest first", async () => {
    const feed = await listActivity(admin, 50);
    const times = feed.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
