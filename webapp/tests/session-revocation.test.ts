import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import {
  issueSession,
  loadSession,
  revokeAllForAccount,
  revokeSession,
} from "../src/lib/auth/session";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
let accountId: string;
let institutionId: string;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, email: { startsWith: "officer1@" } },
  });
  accountId = account.id;
});

describe("issueSession / loadSession", () => {
  it("loads a session it just issued", async () => {
    const sid = await issueSession(accountId, meta());
    const loaded = await loadSession(sid);
    expect(loaded?.userAccountId).toBe(accountId);
  });

  it("returns null for an id that was never issued", async () => {
    expect(await loadSession(randomUUID())).toBeNull();
  });

  it("returns null for a malformed id rather than throwing", async () => {
    // A junk cookie must read as "no session", not as a 500.
    expect(await loadSession("not-a-uuid")).toBeNull();
  });
});

describe("revocation", () => {
  it("refuses a revoked session immediately", async () => {
    const sid = await issueSession(accountId, meta());
    expect(await loadSession(sid)).not.toBeNull();

    await revokeSession(sid, meta());
    expect(await loadSession(sid)).toBeNull();
  });

  it("audits the revocation", async () => {
    const sid = await issueSession(accountId, meta());
    const before = await prisma.auditEvent.count({ where: { action: "session.revoked" } });
    await revokeSession(sid, meta());
    const after = await prisma.auditEvent.count({ where: { action: "session.revoked" } });
    expect(after).toBe(before + 1);
  });

  it("revoking one session leaves the account's other sessions alone", async () => {
    const keep = await issueSession(accountId, meta());
    const drop = await issueSession(accountId, meta());

    await revokeSession(drop, meta());

    expect(await loadSession(drop)).toBeNull();
    expect(await loadSession(keep)).not.toBeNull();
  });

  it("revokeAllForAccount ends every live session for that account", async () => {
    const a = await issueSession(accountId, meta());
    const b = await issueSession(accountId, meta());

    await revokeAllForAccount(accountId, meta());

    expect(await loadSession(a)).toBeNull();
    expect(await loadSession(b)).toBeNull();
  });
});

describe("expiry", () => {
  it("refuses a session whose expiry has passed", async () => {
    const sid = await issueSession(accountId, meta());
    await prisma.session.update({
      where: { id: sid },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await loadSession(sid)).toBeNull();
  });
});
