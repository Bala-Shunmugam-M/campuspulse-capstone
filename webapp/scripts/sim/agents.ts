import type { Faker } from "@faker-js/faker";
import { Client, formWith, optionalFormWith, SimulationError, type Form } from "./client";
import { ANONYMOUS_SHARE, type Rng, noLaterThan, plusHours } from "./distributions";
import {
  evidenceFile,
  followUpStatement,
  noteBody,
  outcomeRationale,
  reportDescription,
  reportTitle,
  type Register,
} from "./text";

/**
 * The behaviours. Everything here goes through the application's own forms, so
 * every case carries the audit rows, status history and notifications a real
 * action leaves.
 */

export type Person = { accountId: string; email: string };

export type Roster = {
  institutionId: string;
  officers: Person[];
  investigators: Person[];
  reporters: Person[];
  governance: Person[];
};

export type Tally = {
  reportsAnonymous: number;
  reportsAttributed: number;
  followUps: number;
  casesOpened: number;
  dismissals: number;
  statusChanges: number;
  assignments: number;
  reassignments: number;
  notes: number;
  evidence: number;
  outcomes: number;
  appeals: number;
  acknowledgements: number;
};

export function emptyTally(): Tally {
  return {
    reportsAnonymous: 0,
    reportsAttributed: 0,
    followUps: 0,
    casesOpened: 0,
    dismissals: 0,
    statusChanges: 0,
    assignments: 0,
    reassignments: 0,
    notes: 0,
    evidence: 0,
    outcomes: 0,
    appeals: 0,
    acknowledgements: 0,
  };
}

/** A unit of simulated work, to be performed at a given instant. */
export type Task = { at: Date; label: string; run: () => Promise<void> };

/**
 * A queue ordered by simulated time. Work is drained earliest-first and tasks
 * may schedule more, which is what lets a report submitted in March be triaged
 * in March while a report submitted in June is still being written.
 */
export class Scheduler {
  private tasks: Task[] = [];
  /** The instant of the task being run, so nothing can be scheduled behind it. */
  private clock = new Date(0);

  schedule(at: Date, label: string, run: () => Promise<void>): void {
    // Simulated time only moves forward. A task scheduled before the one
    // currently running would be inserted ahead of the queue and execute in the
    // past, writing history out of order -- which is how a case came to be
    // closed before it was investigated.
    if (at.getTime() < this.clock.getTime()) {
      throw new SimulationError(
        `"${label}" was scheduled for ${at.toISOString()}, behind the current ` +
          `simulated instant ${this.clock.toISOString()}`,
      );
    }

    const task = { at, label, run };
    let low = 0;
    let high = this.tasks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.tasks[mid].at.getTime() <= at.getTime()) low = mid + 1;
      else high = mid;
    }
    this.tasks.splice(low, 0, task);
  }

  get size(): number {
    return this.tasks.length;
  }

  async drain(onStep: (done: number, task: Task) => void): Promise<number> {
    let done = 0;
    while (this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      this.clock = task.at;
      await task.run();
      done += 1;
      onStep(done, task);
    }
    return done;
  }
}

export type World = {
  baseUrl: string;
  rng: Rng;
  faker: Faker;
  roster: Roster;
  anchor: Date;
  scheduler: Scheduler;
  tally: Tally;
  password: string;
  /** Cases already carried to a terminal state, so nobody works them twice. */
  finished: Set<string>;
  /** Live sessions by email, renewed as simulated time ages them out. */
  sessions: Map<string, { client: Client; issuedAt: Date }>;
};

const REGISTERS: Register[] = ["terse", "plain", "anxious", "formal"];
const SEVERITIES = [
  { value: "low", weight: 3 },
  { value: "moderate", weight: 5 },
  { value: "high", weight: 2.5 },
  { value: "severe", weight: 1 },
];

const CASE_ID = /href="\/cases\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;
const POLICY_ID =
  /href="\/policies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;

/** Sessions last eight hours; re-use one while it is still good for an hour. */
const SESSION_HOURS = 8;
const SESSION_MARGIN_HOURS = 1;

/**
 * A signed-in client for one person at one instant.
 *
 * Sessions last eight simulated hours and a run covers months, so a client
 * cannot simply be held forever -- it would find itself signed out partway
 * through. Nor should every action sign in afresh: verifying an Argon2 hash is
 * deliberately expensive, and a run doing it thousands of times spends most of
 * its wall clock there rather than exercising the workflows.
 *
 * So a session is kept per person and renewed when simulated time has moved far
 * enough to have aged it out. The run still signs in many times over a few
 * simulated months, which is a fair exercise of phase 2's session work.
 */
async function asPerson(world: World, person: Person, at: Date): Promise<Client> {
  const held = world.sessions.get(person.email);
  const stillGood =
    held &&
    at.getTime() >= held.issuedAt.getTime() &&
    at.getTime() < held.issuedAt.getTime() + (SESSION_HOURS - SESSION_MARGIN_HOURS) * 3_600_000;

  if (stillGood && held.client.signedIn) {
    held.client.at = at;
    return held.client;
  }

  const client = new Client(world.baseUrl, at);
  await client.login(person.email, world.password);
  world.sessions.set(person.email, { client, issuedAt: at });
  return client;
}

/** A client with nobody signed in, for anonymous reporting. */
function asStranger(world: World, at: Date): Client {
  return new Client(world.baseUrl, at);
}

/**
 * A refusal the simulator did not expect fails the run. The agents only ever
 * choose actions the page offered them, so a refusal means the application and
 * its own interface disagree -- which is a bug worth stopping for.
 */
function expectAccepted(where: string, refusal: string | null): void {
  if (refusal) throw new SimulationError(`${where} was refused unexpectedly: ${refusal}`);
}

function idsIn(html: string, pattern: RegExp): string[] {
  return [...new Set([...html.matchAll(pattern)].map((m) => m[1]))];
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

export async function submitReport(world: World, at: Date, isFollowUp = false): Promise<void> {
  const anonymous = world.rng.bool(ANONYMOUS_SHARE);
  const register = world.rng.pick(REGISTERS);
  const title = isFollowUp ? `Follow-up: ${reportTitle(world.rng)}` : reportTitle(world.rng);
  const description = isFollowUp
    ? followUpStatement(world.rng, world.faker)
    : reportDescription(world.rng, world.faker, register);
  const severity = world.rng.weighted(SEVERITIES);

  const reporter = world.rng.pick(world.roster.reporters);
  const client = anonymous ? asStranger(world, at) : await asPerson(world, reporter, at);

  const page = await client.get("/report");
  const form = formWith(page.body, "title", "description", "severity");

  const values: Record<string, string> = {
    title,
    description,
    severity,
    categoryId: "",
    locationId: "",
    occurredAt: "",
  };
  // The anonymous form asks which institution; a signed-in reporter's is known.
  if (form.fields.has("institutionId")) values.institutionId = world.roster.institutionId;

  const reply = await client.submit("/report", form, values);
  expectAccepted("report submission", reply.refusal);

  if (isFollowUp) world.tally.followUps += 1;
  else if (anonymous) world.tally.reportsAnonymous += 1;
  else world.tally.reportsAttributed += 1;

  // Some reporters come back days later with more; most never return.
  if (!isFollowUp && world.rng.bool(0.18)) {
    const later = noLaterThan(plusHours(at, world.rng.int(36, 24 * 9)), world.anchor);
    world.scheduler.schedule(later, "reporter follow-up", () => submitReport(world, later, true));
  }
}

// ---------------------------------------------------------------------------
// Officers
// ---------------------------------------------------------------------------

/** The per-report triage forms on the queue page. */
function triageFormsOn(html: string): Form[] {
  const forms: Form[] = [];
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
    if (!match[0].includes('name="reportId"')) continue;
    const found = optionalFormWith(match[0], "reportId", "severity", "confidentiality");
    if (found) forms.push(found);
  }
  return forms;
}

/**
 * One officer shift: clear some of the untriaged pile, then pick up cases that
 * are already open.
 *
 * The queue is served oldest first because that is the order the application
 * itself presents -- listUntriagedReports orders by submitted_at and the case
 * queue by SLA date. An agent reading the page from the top is preferring older
 * and more urgent work without having to be told to.
 */
export async function officerShift(world: World, at: Date, howMany: number): Promise<void> {
  const officer = world.rng.pick(world.roster.officers);
  const client = await asPerson(world, officer, at);

  const queue = await client.get("/cases");

  for (const form of triageFormsOn(queue.body).slice(0, howMany)) {
    const severity = world.rng.weighted(SEVERITIES);
    const confidentiality = world.rng.weighted([
      { value: "standard", weight: 20 },
      { value: "restricted", weight: 3 },
      { value: "sealed", weight: 1 },
    ]);

    const reply = await client.submit("/cases", form, {
      reportId: form.hidden.get("reportId") ?? "",
      title: (form.hidden.get("title") ?? reportTitle(world.rng)).slice(0, 120),
      severity,
      confidentiality,
    });
    expectAccepted("triage", reply.refusal);
    world.tally.casesOpened += 1;
  }

  // Then work what is already open.
  const open = idsIn(queue.body, CASE_ID).filter((id) => !world.finished.has(id));
  for (const caseId of world.rng.sample(open, Math.min(howMany, open.length))) {
    await advanceCase(world, client, caseId, at);
  }
}

/**
 * Move one case along by whatever the page offers.
 *
 * The agent chooses among the transitions the case detail page renders, which
 * are exactly the ones the state machine permits from the current status. It
 * cannot invent a path, which is the point: anything it produces is something a
 * person could have produced through the same screen.
 */
async function advanceCase(
  world: World,
  client: Client,
  caseId: string,
  at: Date,
): Promise<void> {
  const page = await client.get(`/cases/${caseId}`);
  // A sealed case is refused to anyone but a dpo; that is the seal working.
  if (page.body.includes("not permitted to access this record")) return;

  // Assign, or occasionally reassign mid-investigation.
  const assign = optionalFormWith(page.body, "officerAccountId");
  const alreadyAssigned = !page.body.includes("Unassigned</option>\n");
  if (assign) {
    const candidates = assign.options.get("officerAccountId") ?? [];
    if (candidates.length > 0 && world.rng.bool(alreadyAssigned ? 0.75 : 0.15)) {
      const reply = await client.submit(`/cases/${caseId}`, assign, {
        caseId,
        officerAccountId: world.rng.pick(candidates),
      });
      expectAccepted("assignment", reply.refusal);
      world.tally.assignments += 1;
      if (world.rng.bool(0.25)) world.tally.reassignments += 1;
    }
  }

  // A note, most of the time.
  if (world.rng.bool(0.55)) {
    const noteForm = optionalFormWith(page.body, "body", "visibility");
    if (noteForm) {
      const visibility = world.rng.weighted([
        { value: "internal" as const, weight: 5 },
        { value: "shared_with_parties" as const, weight: 2 },
        { value: "reporter_visible" as const, weight: 3 },
      ]);
      const reply = await client.submit(`/cases/${caseId}`, noteForm, {
        caseId,
        body: noteBody(world.rng, world.faker, visibility),
        visibility,
      });
      expectAccepted("note", reply.refusal);
      world.tally.notes += 1;
    }
  }

  // Record an outcome when the case is awaiting a decision.
  const outcomeForm = optionalFormWith(page.body, "finding", "rationale");
  if (outcomeForm) {
    const finding = world.rng.weighted([
      { value: "upheld", weight: 4 },
      { value: "partially_upheld", weight: 3 },
      { value: "not_upheld", weight: 3 },
      { value: "inconclusive", weight: 2 },
    ]);
    const reply = await client.submit(`/cases/${caseId}`, outcomeForm, {
      caseId,
      finding,
      rationale: outcomeRationale(world.rng, world.faker, finding),
    });
    expectAccepted("outcome", reply.refusal);
    world.tally.outcomes += 1;

    scheduleNext(world, caseId, at, 0.75);
    return;
  }

  // Otherwise take one of the transitions the page offers.
  const statusForm = optionalFormWith(page.body, "to", "reason");
  const offered = statusForm?.options.get("to") ?? [];
  if (!statusForm || offered.length === 0) {
    world.finished.add(caseId);
    return;
  }

  // Mostly forward. Dismissal and appeal are deliberate minorities: a dataset
  // in which every case flows cleanly to closed makes the dashboards lie.
  const choice = world.rng.weighted(
    offered.map((value) => ({
      value,
      weight: value === "dismissed" ? 1 : value === "appealed" ? 0.6 : 6,
    })),
  );

  const reply = await client.submit(`/cases/${caseId}`, statusForm, {
    caseId,
    to: choice,
    reason: world.rng.bool(0.4) ? world.faker.lorem.sentence({ min: 5, max: 12 }) : "",
  });
  expectAccepted(`status change to ${choice}`, reply.refusal);
  world.tally.statusChanges += 1;
  if (choice === "dismissed") world.tally.dismissals += 1;
  if (choice === "appealed") world.tally.appeals += 1;

  if (choice === "dismissed") {
    world.finished.add(caseId);
    return;
  }

  // A closed case is usually done with, but a minority are appealed later.
  if (choice === "closed") {
    if (world.rng.bool(0.12)) scheduleNext(world, caseId, at, 1, 24 * 21);
    else world.finished.add(caseId);
    return;
  }

  scheduleNext(world, caseId, at, 1);
}

/**
 * Put this case back in front of an officer after a latency drawn from a
 * distribution. Officers do not act instantly, and uniform latency is what
 * makes SLA analytics meaningless -- every case would breach, or none would.
 */
function scheduleNext(
  world: World,
  caseId: string,
  at: Date,
  probability: number,
  meanHours = 30,
): void {
  if (!world.rng.bool(probability)) {
    world.finished.add(caseId);
    return;
  }

  const next = plusHours(at, Math.max(0.5, world.rng.exponential(meanHours)));
  // Past the anchor the case is simply still in flight, which is what an open
  // queue looks like on any real day.
  if (next.getTime() > world.anchor.getTime()) return;

  world.scheduler.schedule(next, `officer works ${caseId.slice(0, 8)}`, async () => {
    if (world.finished.has(caseId)) return;
    const officer = world.rng.pick(world.roster.officers);
    const client = await asPerson(world, officer, next);
    await advanceCase(world, client, caseId, next);
  });
}

// ---------------------------------------------------------------------------
// Investigators
// ---------------------------------------------------------------------------

/** Investigators add notes and upload evidence across a case's life. */
export async function investigatorPass(world: World, at: Date, howMany: number): Promise<void> {
  const investigator = world.rng.pick(world.roster.investigators);
  const client = await asPerson(world, investigator, at);

  const queue = await client.get("/cases");
  const open = idsIn(queue.body, CASE_ID);
  if (open.length === 0) return;

  for (const caseId of world.rng.sample(open, Math.min(howMany, open.length))) {
    const page = await client.get(`/cases/${caseId}`);
    if (page.body.includes("not permitted to access this record")) continue;

    const noteForm = optionalFormWith(page.body, "body", "visibility");
    if (noteForm && world.rng.bool(0.8)) {
      const visibility = world.rng.weighted([
        { value: "internal" as const, weight: 6 },
        { value: "shared_with_parties" as const, weight: 2 },
        { value: "reporter_visible" as const, weight: 1 },
      ]);
      const reply = await client.submit(`/cases/${caseId}`, noteForm, {
        caseId,
        body: noteBody(world.rng, world.faker, visibility),
        visibility,
      });
      expectAccepted("investigator note", reply.refusal);
      world.tally.notes += 1;
    }

    const uploadForm = optionalFormWith(page.body, "file");
    if (uploadForm && world.rng.bool(0.35)) {
      const file = evidenceFile(world.rng, world.faker);
      const reply = await client.submit(`/cases/${caseId}`, uploadForm, {
        caseId,
        file: new File([new Uint8Array(file.bytes)], file.name, { type: "text/plain" }),
      });
      expectAccepted("evidence upload", reply.refusal);
      world.tally.evidence += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Everyone: policy acknowledgement
// ---------------------------------------------------------------------------

export async function acknowledgePolicies(
  world: World,
  at: Date,
  person: Person,
  howMany: number,
): Promise<void> {
  const client = await asPerson(world, person, at);
  const library = await client.get("/policies");

  const policyIds = idsIn(library.body, POLICY_ID);
  if (policyIds.length === 0) return;

  for (const policyId of world.rng.sample(policyIds, howMany)) {
    const page = await client.get(`/policies/${policyId}`);
    const form = optionalFormWith(page.body, "versionId");
    if (!form) continue; // already acknowledged, or nothing in force

    const reply = await client.submit(`/policies/${policyId}`, form, {
      policyId,
      versionId: form.hidden.get("versionId") ?? "",
    });
    expectAccepted("acknowledgement", reply.refusal);
    world.tally.acknowledgements += 1;
  }
}
