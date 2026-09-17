import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import {
  listCategories,
  listDepartments,
  listLocations,
  listPeople,
} from "../src/server/directory";
import { ForbiddenError } from "../src/lib/errors";
import type { Actor } from "../src/lib/auth/rbac";

const FIXTURES = 14;
const PAGE = 4;

let institutionId: string;
let otherInstitutionId: string;
let officer: Actor;
let reporter: Actor;
let foreignOfficer: Actor;
/** Distinguishes this run's people from the seeded population. */
let marker: string;

async function actorWithRole(institutionCode: string, role: string): Promise<Actor> {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: institutionCode } });
  const account = await prisma.userAccount.findFirstOrThrow({
    where: {
      institutionId: inst.id,
      roles: { some: { role: role as never, revokedAt: null } },
    },
    include: { roles: { where: { revokedAt: null } } },
  });
  return {
    accountId: account.id,
    institutionId: inst.id,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
}

beforeAll(async () => {
  officer = await actorWithRole("NGU", "officer");
  reporter = await actorWithRole("NGU", "reporter");
  foreignOfficer = await actorWithRole("RIT", "officer");
  institutionId = officer.institutionId;
  otherInstitutionId = foreignOfficer.institutionId;

  marker = randomUUID().slice(0, 8);
  for (let i = 0; i < FIXTURES; i++) {
    const n = String(i).padStart(2, "0");
    await prisma.$executeRaw`
      INSERT INTO campuspulse.users (institution_id, full_name, email, department, is_active)
      VALUES (${institutionId}::uuid,
              ${`ZZDirectory ${marker} ${n}`},
              ${`zz-${marker}-${n}@northgate.edu`},
              'Facilities', true)`;
  }
});

describe("listPeople", () => {
  it("refuses a reporter", async () => {
    // A reporter does not get a searchable list of everyone on campus.
    await expect(listPeople(reporter, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("returns only the actor's own institution", async () => {
    const { rows } = await listPeople(officer, { limit: 500 });
    expect(rows.length).toBeGreaterThan(0);

    const ids = rows.map((r) => r.id);
    const foreign = await prisma.campusUser.count({
      where: { id: { in: ids }, institutionId: { not: institutionId } },
    });
    expect(foreign).toBe(0);

    // And the other institution's people really are reachable by its own staff,
    // so the assertion above is about scoping rather than an empty table.
    const theirs = await listPeople(foreignOfficer, { limit: 10 });
    expect(theirs.rows.length).toBeGreaterThan(0);
    expect(theirs.rows.every((r) => !ids.includes(r.id))).toBe(true);
  });

  it("matches on name", async () => {
    const { rows } = await listPeople(officer, { q: `ZZDirectory ${marker}`, limit: 500 });
    expect(rows.length).toBe(FIXTURES);
  });

  it("matches on email, case-insensitively", async () => {
    const { rows } = await listPeople(officer, { q: `ZZ-${marker.toUpperCase()}-03@`, limit: 10 });
    expect(rows.map((r) => r.email)).toEqual([`zz-${marker}-03@northgate.edu`]);
  });

  it("filters by department", async () => {
    const { rows } = await listPeople(officer, {
      q: `ZZDirectory ${marker}`,
      department: "Facilities",
      limit: 500,
    });
    expect(rows.length).toBe(FIXTURES);
    expect(rows.every((r) => r.department === "Facilities")).toBe(true);

    const none = await listPeople(officer, {
      q: `ZZDirectory ${marker}`,
      department: "Library Services",
      limit: 500,
    });
    expect(none.rows).toEqual([]);
  });

  it("pages stably, yielding every person exactly once", async () => {
    const walk = async (limit: number) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await listPeople(officer, { q: `ZZDirectory ${marker}`, cursor, limit });
        seen.push(...page.rows.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return seen;
    };

    const first = await walk(PAGE);
    expect(new Set(first).size, "a person was returned twice").toBe(first.length);
    expect(first.length).toBe(FIXTURES);

    // The same sequence however the pages are cut.
    expect(await walk(3)).toEqual(first);
    expect(await walk(500)).toEqual(first);
  });

  it("orders by name and keeps duplicates of a name apart", async () => {
    // Two people sharing a name is ordinary on a campus, and the cursor carries
    // an id precisely so one of them cannot fall down a page boundary.
    const shared = `ZZTwins ${marker}`;
    for (const suffix of ["a", "b", "c"]) {
      await prisma.$executeRaw`
        INSERT INTO campuspulse.users (institution_id, full_name, email, department, is_active)
        VALUES (${institutionId}::uuid, ${shared},
                ${`zz-twin-${marker}-${suffix}@northgate.edu`}, 'Facilities', true)`;
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listPeople(officer, { q: shared, cursor, limit: 1 });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen.length).toBe(3);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("listLocations and listCategories", () => {
  it("refuses a reporter", async () => {
    await expect(listLocations(reporter)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listCategories(reporter)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listDepartments(reporter)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reads locations scoped to the institution, naming the parent", async () => {
    const rows = await listLocations(officer);
    expect(rows.length).toBeGreaterThan(0);

    const ids = rows.map((r) => r.id);
    const [leak] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM campuspulse.locations
      WHERE id = ANY(${ids}::uuid[]) AND institution_id <> ${institutionId}::uuid`;
    expect(Number(leak.n)).toBe(0);

    // A building sits inside the campus, and the join says so.
    expect(rows.some((r) => r.parentName !== null)).toBe(true);
  });

  it("reads categories scoped to the institution", async () => {
    const rows = await listCategories(officer);
    expect(rows.length).toBeGreaterThan(0);

    const ids = rows.map((r) => r.id);
    const [leak] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM campuspulse.categories
      WHERE id = ANY(${ids}::uuid[]) AND institution_id <> ${institutionId}::uuid`;
    expect(Number(leak.n)).toBe(0);

    expect(rows.some((r) => r.slaHours !== null)).toBe(true);
  });

  it("gives another institution's staff a different set", async () => {
    const mine = (await listCategories(officer)).map((c) => c.id);
    const theirs = (await listCategories(foreignOfficer)).map((c) => c.id);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.some((id) => mine.includes(id))).toBe(false);
    expect(otherInstitutionId).not.toBe(institutionId);
  });

  it("lists the departments actually present", async () => {
    const departments = await listDepartments(officer);
    expect(departments).toContain("Facilities");
    expect(new Set(departments).size).toBe(departments.length);
  });
});
