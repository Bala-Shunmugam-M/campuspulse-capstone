/**
 * Keyset pagination.
 *
 * Not OFFSET. The case queue is ordered by sla_due_at, and that order changes
 * while someone is reading it -- every passing minute moves cases relative to
 * "now", and any triage inserts a row. Offset paging over a list that reorders
 * underneath the reader silently skips rows and repeats others, and a compliance
 * queue that loses a case is worse than one that is slow.
 *
 * A cursor names the last row of the previous page by BOTH its sort key and its
 * id. The id is not decoration: two cases sharing a due date can straddle a page
 * boundary, and a key-only cursor either drops one or returns it twice.
 */

export type Cursor = {
  /** The sort key of the last row on the previous page, as a sortable string. */
  key: string;
  id: string;
};

export type Page<T> = {
  rows: T[];
  /** Pass back as `cursor` for the next page; null when this is the last one. */
  nextCursor: string | null;
};

export const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id]), "utf8").toString("base64url");
}

/**
 * A cursor, or null for anything unusable. A junk value reads as "start at the
 * beginning" rather than raising: the cursor is a position, it carries no
 * authority, and a hand-edited query string should not produce a stack trace.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [key, id] = parsed;
    if (typeof key !== "string" || typeof id !== "string") return null;
    return { key, id };
  } catch {
    return null;
  }
}

/** Clamp a caller-supplied page size. An unbounded limit is an unbounded query. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/**
 * Split an over-fetched result into a page and the cursor that follows it.
 * Callers ask for `limit + 1` rows; the extra row is how we know another page
 * exists without a second COUNT query that could disagree with the first.
 */
export function toPage<T>(fetched: T[], limit: number, cursorOf: (row: T) => Cursor): Page<T> {
  if (fetched.length <= limit) return { rows: fetched, nextCursor: null };
  const rows = fetched.slice(0, limit);
  return { rows, nextCursor: encodeCursor(cursorOf(rows[rows.length - 1])) };
}
