import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { listCases, triageReport } from "../src/server/cases";
import { decodeCursor, encodeCursor, pageSize } from "../src/lib/pagination";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const TOTAL = 24;
const PAGE = 5;

let institutionId: string;
let officer: Actor;
/**
 * A dedicated assignee for this run. The queue accumulates cases across every
 * test run, so walking the whole of it would never reach these rows; assigning
 * them to an account nothing else touches isolates the fixture while still
 * exercising the same keyset query.
 */
let assignee: string;
let ids: string[];

async function aCase(title: string): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title,
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
    officer,
    report.id,
    { severity: "moderate", title, confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

/** Walk the queue one page at a time and collect what each page returned. */
async function walk(limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;

  for (let guard = 0; guard < 100; guard++) {
    const page = await listCases(officer, { cursor, limit, assignedTo: assignee });
    pages.push(page.rows.map((r) => r.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return pages;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  officer = { accountId: account.id, institutionId, roles: account.roles.map((r) => r.role) };

  const marker = `PAGE-${randomUUID().slice(0, 8)}`;

  const [person] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.users (institution_id, full_name, email, department, is_active)
    VALUES (${institutionId}::uuid, ${`Paging Fixture ${marker}`},
            ${`${marker.toLowerCase()}@northgate.edu`}, 'Student Affairs', true)
    RETURNING id`;
  const fixtureAccount = await prisma.userAccount.create({
    data: {
      userId: person.id,
      institutionId,
      email: `${marker.toLowerCase()}@northgate.edu`,
      passwordHash: "not-a-usable-hash",
      roles: { create: { role: "officer" } },
    },
  });
  assignee = fixtureAccount.id;

  ids = [];
  for (let i = 0; i < TOTAL; i++) {
    ids.push(await aCase(`${marker} case ${String(i).padStart(2, "0")}`));
  }

  // Deterministic due dates, eight of them deliberately sharing one: that tie
  // spans a page boundary at limit 5, and it is the arrangement a cursor
  // without an id tiebreaker loses a row on.
  for (const [i, id] of ids.entries()) {
    const due =
      i < 8 ? new Date("2031-02-02T00:00:00.000Z") : new Date(Date.UTC(2031, 2, 1 + i, 0, 0, 0));
    await prisma.case.update({
      where: { id },
      data: { slaDueAt: due, assignedOfficerId: assignee },
    });
  }
});

describe("cursor encoding", () => {
  it("round-trips a cursor", () => {
    const cursor = { key: "2031-02-02T00:00:00.000Z", id: "b2f1e0d8-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("treats junk as the first page rather than raising", () => {
    // A cursor is a position and carries no authority, so a hand-edited query
    // string must not produce a stack trace.
    for (const junk of ["", "not-base64", "AAAA", Buffer.from('{"a":1}').toString("base64url")]) {
      expect(decodeCursor(junk)).toBeNull();
    }
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("clamps the page size", () => {
    expect(pageSize(undefined)).toBe(200);
    expect(pageSize(0)).toBe(1);
    expect(pageSize(-5)).toBe(1);
    expect(pageSize(10_000)).toBe(500);
    expect(pageSize(25)).toBe(25);
  });
});

describe("walking the case queue by keyset", () => {
  it("yields every case exactly once, with no duplicates and no gaps", async () => {
    const pages = await walk(PAGE);
    const seen = pages.flat();

    expect(new Set(seen).size, "a case was returned twice").toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen.length).toBe(TOTAL);
    // Several pages, not one big one.
    expect(pages.length).toBeGreaterThan(TOTAL / PAGE - 1);
  });

  it("orders ties on sla_due_at stably across a page boundary", async () => {
    // The eight cases sharing a due date span more than one page of five, which
    // is precisely the arrangement that loses a row without the id tiebreaker.
    const tied = await prisma.case.findMany({
      where: { id: { in: ids }, slaDueAt: new Date("2031-02-02T00:00:00.000Z") },
      select: { id: true },
    });
    expect(tied.length).toBe(8);

    const first = (await walk(PAGE)).flat();
    const second = (await walk(PAGE)).flat();
    const third = (await walk(3)).flat();

    expect(first).toEqual(second);
    // A different page size must not change the sequence, only where it breaks.
    expect(third).toEqual(first);

    const tiedIds = new Set(tied.map((t) => t.id));
    expect(first.filter((id) => tiedIds.has(id)).length).toBe(8);
  });

  it("returns a null cursor on the last page and not before", async () => {
    const full = await listCases(officer, { limit: 500, assignedTo: assignee });
    expect(full.rows.length).toBe(TOTAL);
    expect(full.nextCursor).toBeNull();

    const partial = await listCases(officer, { limit: PAGE, assignedTo: assignee });
    expect(partial.rows.length).toBe(PAGE);
    expect(partial.nextCursor).not.toBeNull();
  });

  it("still defaults to a single page of 200 for callers that do not paginate", async () => {
    const page = await listCases(officer, {});
    expect(page.rows.length).toBeLessThanOrEqual(200);
  });
});
