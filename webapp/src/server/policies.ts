import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { AlreadyPublishedError, NotFoundError } from "@/lib/errors";
import { now } from "@/lib/clock";
import type { RequestMeta } from "@/server/accounts";

/** Authoring a policy is a governance act, not case work. */
const AUTHORS = ["admin", "dpo"] as const;

export type PolicyInput = {
  code: string;
  title: string;
  ownerDepartment: string | null;
};

export type VersionInput = {
  bodyMarkdown: string;
  summary: string | null;
  /** The date the text takes effect. A date, not a moment: policies apply per day. */
  effectiveFrom: Date;
};

export type PolicyView = {
  id: string;
  code: string;
  title: string;
  ownerDepartment: string | null;
  isActive: boolean;
  liveVersionNo: number | null;
};

export type VersionView = {
  id: string;
  versionNo: number;
  summary: string | null;
  bodyMarkdown: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  publishedById: string | null;
};

/** Postgres DATE wants a day, not an instant in the caller's timezone. */
function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function auditContext(actor: Actor, meta: RequestMeta) {
  return {
    actorAccountId: actor.accountId,
    actorLabel: actor.email,
    institutionId: actor.institutionId,
    requestId: meta.requestId,
    occurredAt: meta.at,
    ipHash: meta.ipHash,
    userAgent: meta.userAgent,
  };
}

/**
 * Allocate the next version number and insert in one statement, holding a lock
 * on the parent policy row for the duration. Reading max(version_no) into
 * JavaScript and adding one hands every concurrent author the same answer --
 * the same lesson compliance.next_case_number already learned. The lock makes
 * concurrent drafters queue; the UNIQUE (policy_id, version_no) behind it means
 * a mistake here is a refusal rather than a duplicate.
 */
async function insertNextVersion(
  tx: Prisma.TransactionClient,
  policyId: string,
  input: VersionInput,
  publish: { publishedById: string; at: Date } | null,
): Promise<{ id: string; versionNo: number }> {
  await tx.$executeRaw`SELECT id FROM compliance.policies WHERE id = ${policyId}::uuid FOR UPDATE`;

  const [row] = await tx.$queryRaw<{ id: string; version_no: number }[]>`
    INSERT INTO compliance.policy_versions
      (id, policy_id, version_no, body_markdown, summary, effective_from, published_at, published_by)
    SELECT
      gen_random_uuid(),
      ${policyId}::uuid,
      coalesce(max(version_no), 0) + 1,
      ${input.bodyMarkdown},
      ${input.summary},
      ${asDate(input.effectiveFrom)}::date,
      ${publish ? publish.at : null},
      ${publish?.publishedById ?? null}::uuid
    FROM compliance.policy_versions
    WHERE policy_id = ${policyId}::uuid
    RETURNING id, version_no`;

  return { id: row.id, versionNo: Number(row.version_no) };
}

export async function createPolicy(
  actor: Actor,
  input: PolicyInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, [...AUTHORS]);

  const code = input.code.trim().toUpperCase();
  const title = input.title.trim();
  if (!code || !title) throw new NotFoundError("A policy needs a code and a title.");

  return prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: {
        institutionId: actor.institutionId,
        code,
        title,
        ownerDepartment: input.ownerDepartment?.trim() || null,
      },
    });

    await withAudit(tx, auditContext(actor, meta), {
      action: "policy.created",
      entityType: "policy",
      entityId: policy.id,
      after: { code, title },
    });

    return policy.id;
  });
}

async function policyFor(actor: Actor, policyId: string) {
  const policy = await prisma.policy.findUnique({ where: { id: policyId } });
  if (!policy) throw new NotFoundError("That policy does not exist.");
  requireSameInstitution(actor, policy.institutionId);
  return policy;
}

/** A new, unpublished version. Drafts are editable; publication closes that. */
export async function draftVersion(
  actor: Actor,
  policyId: string,
  input: VersionInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, [...AUTHORS]);
  const policy = await policyFor(actor, policyId);

  if (!input.bodyMarkdown.trim()) throw new NotFoundError("A policy version needs a body.");

  return prisma.$transaction(async (tx) => {
    const version = await insertNextVersion(tx, policy.id, input, null);

    await withAudit(tx, auditContext(actor, meta), {
      action: "policy.version_drafted",
      entityType: "policy",
      entityId: policy.id,
      after: { versionId: version.id, versionNo: version.versionNo },
    });

    return version.id;
  });
}

/**
 * Publish a draft. One-way: the trigger on policy_versions refuses every later
 * edit but effective_to, so this is the last moment the text can change.
 */
export async function publishVersion(
  actor: Actor,
  versionId: string,
  effectiveFrom: Date,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, [...AUTHORS]);

  const version = await prisma.policyVersion.findUnique({
    where: { id: versionId },
    include: { policy: true },
  });
  if (!version) throw new NotFoundError("That policy version does not exist.");
  requireSameInstitution(actor, version.policy.institutionId);

  if (version.publishedAt) {
    throw new AlreadyPublishedError("That policy version is already published.");
  }

  await prisma.$transaction(async (tx) => {
    // effective_from is set here as well as published_at: the trigger permits it
    // because the row is still a draft at the moment of this UPDATE, and it is
    // the last chance to correct a date the draft only guessed at.
    await tx.$executeRaw`
      UPDATE compliance.policy_versions
      SET published_at = ${meta.at},
          published_by = ${actor.accountId}::uuid,
          effective_from = ${asDate(effectiveFrom)}::date
      WHERE id = ${versionId}::uuid`;

    await withAudit(tx, auditContext(actor, meta), {
      action: "policy.version_published",
      entityType: "policy",
      entityId: version.policyId,
      after: {
        versionId,
        versionNo: version.versionNo,
        effectiveFrom: asDate(effectiveFrom),
      },
    });
  });
}

/**
 * Replace what a policy says from a given date. Writes version n+1, publishes
 * it, and closes version n on the same date, all in one transaction.
 *
 * It publishes rather than leaving a draft because the two halves have to
 * agree: closing n while n+1 is unpublished leaves the policy with nothing live
 * from that date, which is both a lie and a hole in "exactly one version is live
 * per date". Authoring a replacement for later review is what draftVersion is
 * for.
 */
export async function supersede(
  actor: Actor,
  policyId: string,
  input: VersionInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, [...AUTHORS]);
  const policy = await policyFor(actor, policyId);

  if (!input.bodyMarkdown.trim()) throw new NotFoundError("A policy version needs a body.");

  return prisma.$transaction(async (tx) => {
    const created = await insertNextVersion(tx, policy.id, input, {
      publishedById: actor.accountId,
      at: meta.at,
    });

    // The live predecessor: published and not already closed. Closing it at the
    // successor's start date makes the two intervals meet exactly -- no gap
    // where nothing applies, no overlap where two texts both do.
    const [previous] = await tx.$queryRaw<{ id: string; version_no: number }[]>`
      UPDATE compliance.policy_versions
      SET effective_to = ${asDate(input.effectiveFrom)}::date
      WHERE id = (
        SELECT id FROM compliance.policy_versions
        WHERE policy_id = ${policy.id}::uuid
          AND id <> ${created.id}::uuid
          AND published_at IS NOT NULL
          AND effective_to IS NULL
        ORDER BY version_no DESC
        LIMIT 1
      )
      RETURNING id, version_no`;

    await withAudit(tx, auditContext(actor, meta), {
      action: "policy.superseded",
      entityType: "policy",
      entityId: policy.id,
      before: previous ? { versionId: previous.id, versionNo: Number(previous.version_no) } : null,
      after: {
        versionId: created.id,
        versionNo: created.versionNo,
        effectiveFrom: asDate(input.effectiveFrom),
      },
    });

    return created.id;
  });
}

/** The policies of the actor's institution, with the version live today noted. */
export async function listPolicies(actor: Actor): Promise<PolicyView[]> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const rows = await prisma.$queryRaw<
    {
      id: string;
      code: string;
      title: string;
      owner_department: string | null;
      is_active: boolean;
      live_version_no: number | null;
    }[]
  >`
    SELECT p.id, p.code, p.title, p.owner_department, p.is_active,
           (SELECT v.version_no FROM compliance.policy_versions v
             WHERE v.policy_id = p.id
               AND v.published_at IS NOT NULL
               AND v.effective_from <= current_date
               AND (v.effective_to IS NULL OR v.effective_to > current_date)
             ORDER BY v.version_no DESC LIMIT 1) AS live_version_no
    FROM compliance.policies p
    WHERE p.institution_id = ${actor.institutionId}::uuid
    ORDER BY p.code`;

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    ownerDepartment: r.owner_department,
    isActive: r.is_active,
    liveVersionNo: r.live_version_no === null ? null : Number(r.live_version_no),
  }));
}

export type PolicySearchHit = {
  policyId: string;
  code: string;
  title: string;
  versionId: string;
  versionNo: number;
  /** ts_headline output, marked with [[HL]]…[[/HL]] rather than HTML tags. */
  snippet: string;
  rank: number;
};

/**
 * Full-text search across the policy text that is actually in force.
 *
 * Drafts are excluded and superseded versions are excluded, because a search
 * result is an answer to "what are the rules", and an answer drawn from text
 * that either has not taken effect or no longer applies is worse than no answer.
 *
 * ts_headline is asked for sentinel markers instead of its default <b> tags:
 * the snippet is rendered as JSX, and a highlight that arrived as HTML would be
 * either escaped into visible angle brackets or, worse, trusted.
 */
export async function searchPolicies(
  actor: Actor,
  query: string,
  limit = 20,
): Promise<PolicySearchHit[]> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const text = query.trim();
  if (!text) return [];

  const rows = await prisma.$queryRaw<
    {
      policy_id: string;
      code: string;
      title: string;
      version_id: string;
      version_no: number;
      snippet: string;
      rank: number;
    }[]
  >`
    SELECT p.id AS policy_id, p.code, p.title,
           v.id AS version_id, v.version_no,
           ts_headline('english',
             coalesce(v.summary, '') || ' ' || v.body_markdown,
             q.query,
             'StartSel=[[HL]],StopSel=[[/HL]],MaxWords=40,MinWords=15,MaxFragments=2') AS snippet,
           ts_rank(v.body_tsv, q.query) AS rank
    FROM compliance.policies p
    JOIN compliance.policy_versions v ON v.policy_id = p.id
    CROSS JOIN LATERAL (SELECT plainto_tsquery('english', ${text}) AS query) q
    WHERE p.institution_id = ${actor.institutionId}::uuid
      AND v.published_at IS NOT NULL
      AND v.effective_from <= current_date
      AND (v.effective_to IS NULL OR v.effective_to > current_date)
      AND v.body_tsv @@ q.query
    ORDER BY rank DESC, p.code ASC
    LIMIT ${limit}::int`;

  return rows.map((r) => ({
    policyId: r.policy_id,
    code: r.code,
    title: r.title,
    versionId: r.version_id,
    versionNo: Number(r.version_no),
    snippet: r.snippet,
    rank: Number(r.rank),
  }));
}

/** One policy with its whole version history, newest first. */
export async function getPolicy(
  actor: Actor,
  policyId: string,
): Promise<{ policy: PolicyView; versions: VersionView[] }> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);
  const policy = await policyFor(actor, policyId);

  const versions = await prisma.policyVersion.findMany({
    where: { policyId: policy.id },
    orderBy: { versionNo: "desc" },
  });

  const today = asDate(now());
  const live = versions.find(
    (v) =>
      v.publishedAt !== null &&
      asDate(v.effectiveFrom) <= today &&
      (v.effectiveTo === null || asDate(v.effectiveTo) > today),
  );

  return {
    policy: {
      id: policy.id,
      code: policy.code,
      title: policy.title,
      ownerDepartment: policy.ownerDepartment,
      isActive: policy.isActive,
      liveVersionNo: live?.versionNo ?? null,
    },
    versions: versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      summary: v.summary,
      bodyMarkdown: v.bodyMarkdown,
      effectiveFrom: v.effectiveFrom,
      effectiveTo: v.effectiveTo,
      publishedAt: v.publishedAt,
      publishedById: v.publishedById,
    })),
  };
}
