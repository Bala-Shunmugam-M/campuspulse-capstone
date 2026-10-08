import { describe, expect, it } from "vitest";
import { queueQuery } from "@/lib/cases/queue-query";
import { encodeCursor } from "@/lib/pagination";
import type { Actor } from "@/lib/auth/rbac";

const actor: Actor = {
  accountId: "actor",
  institutionId: "institution",
  email: "officer@example.test",
  roles: ["officer"],
};
const at = new Date("2026-10-08T12:00:00.000Z");
describe("queue query boundaries", () => {
  it("retains tenant, deletion and sealed-case constraints when searching and paging", () => {
    const query = queueQuery(
      actor,
      {
        q: "Emergency",
        cursor: encodeCursor({
          key: at.toISOString(),
          id: "00000000-0000-4000-8000-000000000001",
        }),
      },
      at,
    );
    expect(query.where).toMatchObject({
      institutionId: actor.institutionId,
      deletedAt: null,
      confidentiality: { not: "sealed" },
    });
    expect(query.where.AND).toHaveLength(2);
    expect(query.where.AND).toContainEqual({
      OR: [
        { title: { contains: "Emergency", mode: "insensitive" } },
        { caseNumber: { contains: "Emergency", mode: "insensitive" } },
      ],
    });
  });
  it("uses a strict overdue boundary and excludes settled cases", () => {
    expect(queueQuery(actor, { deadline: "overdue" }, at).where.AND).toEqual([
      { status: { notIn: ["resolved", "closed"] } },
      { slaDueAt: { lt: at } },
    ]);
  });
  it("makes due-soon inclusive at now and exclusive at 24 hours", () => {
    expect(
      queueQuery(actor, { deadline: "soon" }, at).where.AND,
    ).toContainEqual({
      slaDueAt: { gte: at, lt: new Date("2026-10-09T12:00:00.000Z") },
    });
  });
  it("reverses both cursor comparisons with descending sort, including ties", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const query = queueQuery(
      actor,
      { sort: "desc", cursor: encodeCursor({ key: at.toISOString(), id }) },
      at,
    );
    expect(query.orderBy).toEqual([{ slaDueAt: "desc" }, { id: "desc" }]);
    expect(query.where.AND).toContainEqual({
      OR: [{ slaDueAt: { lt: at } }, { slaDueAt: at, id: { lt: id } }],
    });
  });
  it("ignores invalid date and identifier cursors", () => {
    for (const cursor of [
      encodeCursor({ key: "bad", id: "bad" }),
      encodeCursor({ key: at.toISOString(), id: "bad" }),
    ])
      expect(queueQuery(actor, { cursor }, at).where.AND).toEqual([]);
  });
  it("resolves personal and unassigned filters while preserving explicit status", () => {
    expect(
      queueQuery(actor, { assignedTo: "me", status: "triaged" }, at).where,
    ).toMatchObject({ assignedOfficerId: "actor", status: "triaged" });
    expect(
      queueQuery(actor, { assignedTo: "unassigned" }, at).where
        .assignedOfficerId,
    ).toBeNull();
  });
});
