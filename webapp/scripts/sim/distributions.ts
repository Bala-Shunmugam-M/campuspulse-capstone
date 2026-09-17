/**
 * Seeded randomness and the arrival model.
 *
 * One generator drives every draw in a run, so `--seed 7` twice produces the
 * same dataset twice. Nothing here calls Math.random.
 */

/** mulberry32: small, fast, and good enough for behaviour that is not cryptographic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** [0, 1) */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[Math.floor(this.next() * items.length)];
  }

  /** Several distinct members, or all of them when there are too few. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const taken: T[] = [];
    while (taken.length < count && pool.length > 0) {
      taken.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    }
    return taken;
  }

  /** One index, chosen in proportion to the weights. */
  weightedIndex(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  weighted<T>(options: readonly { value: T; weight: number }[]): T {
    return options[this.weightedIndex(options.map((o) => o.weight))].value;
  }

  /**
   * An exponential draw. Officer response latency is drawn from this rather
   * than being uniform, because uniform latency is what makes SLA analytics
   * meaningless -- every case would breach or none would.
   */
  exponential(meanHours: number): number {
    return -Math.log(1 - this.next()) * meanHours;
  }

  /** A positive normal-ish draw, clamped so it cannot run backwards. */
  aroundHours(meanHours: number, spreadHours: number): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0.25, meanHours + normal * spreadHours);
  }
}

/**
 * Relative volume by hour of day. Campus life is not uniform: nothing much is
 * reported at 04:00, and reports cluster at class-change times when corridors
 * fill. The shape reuses the model 02_Insert_Data.py already validated.
 */
const HOUR_WEIGHTS = [
  0.2, 0.15, 0.1, 0.1, 0.1, 0.2, // 00-05
  0.6, 1.2, 2.0, 4.5, 2.6, 4.2, // 06-11  peaks at the 09:00 and 11:00 changes
  3.0, 4.4, 2.8, 4.0, 3.0, 3.6, // 12-17  and at 13:00, 15:00, 17:00
  2.4, 2.0, 1.8, 1.6, 1.0, 0.5, // 18-23
];

/** Monday through Sunday. Weekday activity exceeds weekend, substantially. */
const WEEKDAY_WEIGHTS = [1.0, 1.05, 1.05, 1.0, 0.85, 0.35, 0.3];

/** Roughly a third of reports arrive without a reporter identity (spec 8.2). */
export const ANONYMOUS_SHARE = 0.34;

/**
 * `count` arrival instants spread over `days` ending at `anchor`, sorted
 * earliest first so a run can walk forward through simulated time.
 */
export function arrivalTimes(rng: Rng, anchor: Date, days: number, count: number): Date[] {
  const times: Date[] = [];
  const startMs = anchor.getTime() - days * 24 * 3_600_000;

  for (let i = 0; i < count; i++) {
    // Pick a day, then weight it again by which weekday it landed on. Drawing
    // the day first and rejecting keeps the calendar honest: a run that starts
    // on a Wednesday still gets quiet weekends in the right places.
    let dayOffset = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      dayOffset = rng.int(0, days - 1);
      const candidate = new Date(startMs + dayOffset * 24 * 3_600_000);
      // getUTCDay is Sunday-based; shift so Monday is 0.
      const weekday = (candidate.getUTCDay() + 6) % 7;
      if (rng.float() < WEEKDAY_WEIGHTS[weekday]) break;
    }

    const hour = rng.weightedIndex(HOUR_WEIGHTS);
    const at = new Date(startMs + dayOffset * 24 * 3_600_000);
    at.setUTCHours(hour, rng.int(0, 59), rng.int(0, 59), 0);
    times.push(at);
  }

  return times.sort((a, b) => a.getTime() - b.getTime());
}

/** Add hours to an instant without mutating it. */
export function plusHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

/** The earlier of two instants. Keeps simulated time from running past the anchor. */
export function noLaterThan(at: Date, ceiling: Date): Date {
  return at.getTime() > ceiling.getTime() ? ceiling : at;
}
