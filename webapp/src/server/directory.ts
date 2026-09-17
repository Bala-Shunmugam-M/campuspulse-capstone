import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";
import { decodeCursor, pageSize, toPage, type Page } from "@/lib/pagination";

/**
 * A read-only view of the campuspulse schema -- the tables the Python data
 * project owns and this application references but never writes.
 *
 * Nothing here mutates anything, by design rather than by omission: the
 * boundary described in schema.prisma is the whole reason the two halves of
 * this capstone can share a database without either corrupting the other.
 */

/** Staff only. A reporter does not get a searchable list of everyone on campus. */
const STAFF = ["officer", "investigator", "admin", "dpo"] as const;

export type Person = {
  id: string;
  fullName: string;
  email: string;
  department: string | null;
  isActive: boolean;
};

export type LocationRow = {
  id: string;
  name: string;
  locationType: string;
  code: string | null;
  parentName: string | null;
};

export type CategoryRow = {
  id: string;
  name: string;
  categoryType: string;
  slaHours: number | null;
};

export type PeopleFilter = {
  q?: string;
  department?: string;
  cursor?: string;
  limit?: number;
};

/**
 * People in the actor's institution, ordered by name.
 *
 * The cursor is (full_name, id): names are nowhere near unique on a campus, and
 * a cursor on the name alone would drop one of two people called the same thing
 * whenever they straddle a page boundary.
 */
export async function listPeople(actor: Actor, filter: PeopleFilter): Promise<Page<Person>> {
  requireRole(actor, [...STAFF]);

  const limit = pageSize(filter.limit);
  const cursor = decodeCursor(filter.cursor);
  const q = filter.q?.trim();

  const rows = await prisma.campusUser.findMany({
    where: {
      institutionId: actor.institutionId,
      ...(filter.department ? { department: filter.department } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { fullName: { gt: cursor.key } },
                  { fullName: cursor.key, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      fullName: true,
      email: true,
      department: true,
      isActive: true,
    },
  });

  return toPage(rows, limit, (row) => ({ key: row.fullName, id: row.id }));
}

/**
 * Locations, with their parent named.
 *
 * Read through $queryRaw because campuspulse.locations carries @@ignore in
 * schema.prisma and is therefore absent from Prisma Client. That is the
 * read-only boundary working as designed, not a workaround: un-ignoring the
 * model to "fix" this would put the table back inside Prisma Migrate's diff and
 * reopen the hazard that has already dropped hand-written SQL from this
 * database once. Raw SQL here is the cheaper half of that trade.
 */
export async function listLocations(actor: Actor): Promise<LocationRow[]> {
  requireRole(actor, [...STAFF]);

  const rows = await prisma.$queryRaw<
    {
      id: string;
      name: string;
      location_type: string;
      code: string | null;
      parent_name: string | null;
    }[]
  >`
    SELECT l.id, l.name, l.location_type::text AS location_type, l.code,
           p.name AS parent_name
    FROM campuspulse.locations l
    LEFT JOIN campuspulse.locations p ON p.id = l.parent_id
    WHERE l.institution_id = ${actor.institutionId}::uuid
    ORDER BY l.location_type, l.name`;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    locationType: r.location_type,
    code: r.code,
    parentName: r.parent_name,
  }));
}

/** Categories. Raw SQL for the same reason as listLocations. */
export async function listCategories(actor: Actor): Promise<CategoryRow[]> {
  requireRole(actor, [...STAFF]);

  const rows = await prisma.$queryRaw<
    { id: string; name: string; category_type: string; sla_hours: number | null }[]
  >`
    SELECT id, name, category_type::text AS category_type, sla_hours
    FROM campuspulse.categories
    WHERE institution_id = ${actor.institutionId}::uuid
    ORDER BY category_type, name`;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryType: r.category_type,
    slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
  }));
}

/** The departments present in this institution, for the filter. */
export async function listDepartments(actor: Actor): Promise<string[]> {
  requireRole(actor, [...STAFF]);

  const rows = await prisma.campusUser.findMany({
    where: { institutionId: actor.institutionId, department: { not: null } },
    distinct: ["department"],
    orderBy: { department: "asc" },
    select: { department: true },
  });

  return rows.map((r) => r.department).filter((d): d is string => d !== null);
}
