import { spawnSync } from "node:child_process";
import { faker } from "@faker-js/faker";
import { prisma } from "../src/lib/db";
import { SEED_PASSWORD } from "../prisma/seed-data";
import { Rng, arrivalTimes, noLaterThan, plusHours } from "./sim/distributions";
import { SimulationError } from "./sim/client";
import {
  Scheduler,
  acknowledgePolicies,
  emptyTally,
  investigatorPass,
  officerShift,
  submitReport,
  type Person,
  type Roster,
  type World,
} from "./sim/agents";

/**
 * Produces activity by driving the running application over HTTP (spec 8.1).
 *
 * It does not write to the database. It signs in as seeded users and submits
 * the same forms a browser submits, so everything it produces is by
 * construction data the application could have produced -- with the audit rows,
 * status history and notifications a real action leaves. A script that inserted
 * rows directly could manufacture a case with no audit trail, an SLA that was
 * never computed and a status no transition allows: data that looks plausible
 * and is structurally impossible.
 *
 * The run is also the integration test. Any non-2xx that is not an expected
 * refusal fails it loudly, printing the request, and it finishes by running the
 * verification suite.
 *
 *   npm run simulate -- --seed 7 --anchor 2026-09-17 --days 120 --reports 400
 */

type Options = {
  seed: number;
  anchor: Date;
  days: number;
  reports: number;
  baseUrl: string;
  institution: string;
  verify: boolean;
};

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, "true");
    else {
      flags.set(key, next);
      i += 1;
    }
  }

  const anchorRaw = flags.get("anchor");
  const anchor = anchorRaw ? new Date(anchorRaw) : new Date();
  if (Number.isNaN(anchor.getTime())) {
    throw new SimulationError(`--anchor ${anchorRaw} is not a date`);
  }

  return {
    seed: Number(flags.get("seed") ?? 1),
    anchor,
    days: Number(flags.get("days") ?? 90),
    reports: Number(flags.get("reports") ?? 200),
    baseUrl: flags.get("base-url") ?? "http://localhost:3100",
    institution: flags.get("institution") ?? "NGU",
    verify: flags.get("verify") !== "false",
  };
}

/**
 * Who exists, read straight from the seeded world.
 *
 * Reading the roster is not the same as writing data: the simulator has to know
 * whom to sign in as, and deriving the emails from the seed's naming convention
 * instead would silently break the moment the seed changed.
 */
async function loadRoster(institutionCode: string): Promise<Roster> {
  const institution = await prisma.institution.findFirstOrThrow({
    where: { code: institutionCode },
  });

  const accounts = await prisma.userAccount.findMany({
    where: { institutionId: institution.id, deletedAt: null },
    include: { roles: { where: { revokedAt: null } } },
    orderBy: { email: "asc" },
  });

  /**
   * Only the seeded people, whose emails follow the seed's own convention.
   *
   * A development database accumulates accounts that tests created, and those
   * carry deliberately unusable password hashes. Signing in as one would fail
   * for a reason that has nothing to do with the application being wrong, so
   * the simulator declines to try.
   */
  const SEEDED = /^(admin|dpo|officer|investigator|reporter)\d+@/;

  const withRole = (role: string): Person[] =>
    accounts
      .filter((a) => SEEDED.test(a.email) && a.roles.some((r) => r.role === role))
      .map((a) => ({ accountId: a.id, email: a.email }));

  const roster: Roster = {
    institutionId: institution.id,
    officers: withRole("officer"),
    investigators: withRole("investigator"),
    reporters: withRole("reporter"),
    governance: [...withRole("admin"), ...withRole("dpo")],
  };

  for (const [name, people] of Object.entries(roster)) {
    if (Array.isArray(people) && people.length === 0) {
      throw new SimulationError(`the seeded world has no ${name}; run \`npm run seed\` first`);
    }
  }

  return roster;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.env.SIMULATION_MODE !== "1") {
    throw new SimulationError(
      "SIMULATION_MODE=1 must be set on BOTH this process and the server being driven, " +
        "or every action will be stamped with the moment this ran instead of the moment " +
        "it is meant to represent.",
    );
  }

  // One generator drives every draw, and Faker takes the same seed, so a run is
  // reproducible from --seed alone.
  const rng = new Rng(options.seed);
  faker.seed(options.seed);

  const roster = await loadRoster(options.institution);
  const scheduler = new Scheduler();

  const world: World = {
    baseUrl: options.baseUrl,
    rng,
    faker,
    roster,
    anchor: options.anchor,
    scheduler,
    tally: emptyTally(),
    password: SEED_PASSWORD,
    finished: new Set(),
    sessions: new Map(),
  };

  console.log(
    `simulating ${options.reports} reports over ${options.days} days to ` +
      `${options.anchor.toISOString().slice(0, 10)}  seed ${options.seed}  ${options.baseUrl}`,
  );

  // Intake, spread by the arrival model.
  const arrivals = arrivalTimes(rng, options.anchor, options.days, options.reports);
  for (const at of arrivals) {
    scheduler.schedule(at, "report submitted", () => submitReport(world, at));
  }

  // Officer shifts, on most weekday mornings and afternoons.
  const start = plusHours(options.anchor, -options.days * 24);
  for (let day = 0; day < options.days; day++) {
    const morning = new Date(start.getTime() + day * 24 * 3_600_000);
    morning.setUTCHours(9, rng.int(0, 45), 0, 0);
    const weekday = (morning.getUTCDay() + 6) % 7;
    if (weekday >= 5 && !rng.bool(0.15)) continue; // weekends are quiet, not empty

    const afternoon = plusHours(morning, 5 + rng.float() * 2);
    for (const at of [morning, afternoon]) {
      if (at.getTime() > options.anchor.getTime()) continue;
      scheduler.schedule(at, "officer shift", () => officerShift(world, at, rng.int(2, 5)));
    }

    // Investigators work across a case's life rather than in shifts.
    if (rng.bool(0.5)) {
      const when = plusHours(morning, 2 + rng.float() * 8);
      if (when.getTime() <= options.anchor.getTime()) {
        scheduler.schedule(when, "investigator pass", () =>
          investigatorPass(world, when, rng.int(1, 3)),
        );
      }
    }
  }

  // People read the policies, mostly early on, a few stragglers later.
  const everyone = [
    ...roster.officers,
    ...roster.investigators,
    ...roster.governance,
    ...rng.sample(roster.reporters, Math.ceil(roster.reporters.length * 0.7)),
  ];
  for (const person of everyone) {
    const when = noLaterThan(
      plusHours(start, rng.bool(0.75) ? rng.int(1, 24 * 21) : rng.int(24 * 21, options.days * 24)),
      options.anchor,
    );
    scheduler.schedule(when, `${person.email} reads the policies`, () =>
      acknowledgePolicies(world, when, person, rng.int(1, 4)),
    );
  }

  const began = Date.now();
  const planned = scheduler.size;
  let lastReport = Date.now();

  const performed = await scheduler.drain((done) => {
    if (Date.now() - lastReport < 4000) return;
    lastReport = Date.now();
    console.log(`  ${done} actions performed, ${scheduler.size} pending`);
  });

  const seconds = (Date.now() - began) / 1000;

  console.log("");
  console.log(`${performed} actions in ${seconds.toFixed(1)}s (${planned} planned up front)`);
  console.log("");
  for (const [name, count] of Object.entries(world.tally)) {
    console.log(`  ${name.padEnd(20)} ${count}`);
  }
  console.log("");

  await summarise(roster.institutionId);

  if (options.verify) {
    console.log("running verification over what the run produced...");
    const result = spawnSync("npm", ["run", "verify"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      // A run that leaves the database failing its checks has found a bug.
      throw new SimulationError("verification failed after the run");
    }
  }
}

/** What the database now holds for this institution. */
async function summarise(institutionId: string): Promise<void> {
  const [row] = await prisma.$queryRaw<
    {
      reports: bigint;
      anonymous: bigint;
      cases: bigint;
      history: bigint;
      notes: bigint;
      evidence: bigint;
      outcomes: bigint;
      notifications: bigint;
      acknowledgements: bigint;
      audit: bigint;
    }[]
  >`
    SELECT
      (SELECT count(*) FROM compliance.reports WHERE institution_id = ${institutionId}::uuid) AS reports,
      (SELECT count(*) FROM compliance.reports WHERE institution_id = ${institutionId}::uuid AND is_anonymous) AS anonymous,
      (SELECT count(*) FROM compliance.cases WHERE institution_id = ${institutionId}::uuid) AS cases,
      (SELECT count(*) FROM compliance.case_status_history h
        JOIN compliance.cases c ON c.id = h.case_id WHERE c.institution_id = ${institutionId}::uuid) AS history,
      (SELECT count(*) FROM compliance.case_notes n
        JOIN compliance.cases c ON c.id = n.case_id WHERE c.institution_id = ${institutionId}::uuid) AS notes,
      (SELECT count(*) FROM compliance.evidence_files WHERE institution_id = ${institutionId}::uuid) AS evidence,
      (SELECT count(*) FROM compliance.outcomes o
        JOIN compliance.cases c ON c.id = o.case_id WHERE c.institution_id = ${institutionId}::uuid) AS outcomes,
      (SELECT count(*) FROM compliance.notifications n
        JOIN compliance.user_accounts ua ON ua.id = n.recipient_id
        WHERE ua.institution_id = ${institutionId}::uuid) AS notifications,
      (SELECT count(*) FROM compliance.policy_acknowledgements a
        JOIN compliance.user_accounts ua ON ua.id = a.user_account_id
        WHERE ua.institution_id = ${institutionId}::uuid) AS acknowledgements,
      (SELECT count(*) FROM compliance.audit_events WHERE institution_id = ${institutionId}::uuid) AS audit`;

  console.log("the database now holds, for this institution:");
  for (const [name, count] of Object.entries(row)) {
    console.log(`  ${name.padEnd(20)} ${Number(count)}`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error("");
    console.error(error instanceof SimulationError ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
