import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The single source of "now".
 *
 * Every timestamp this application writes goes through now(), so that a
 * simulated run can produce a dataset spread over months rather than one
 * stamped entirely with the moment the simulator happened to run. A dataset
 * with no ageing queue has no overdue cases and no SLA history, and the
 * dashboards built on it would be uniformly, falsely green.
 *
 * ---------------------------------------------------------------------------
 * A clock an HTTP header can move is a serious thing to ship, so it is gated
 * twice and both gates must open:
 *
 *   1. SIMULATION_MODE=1 must be set in the environment, and
 *   2. NODE_ENV must not be "production".
 *
 * The second is not a fallback for the first. It is a refusal: with
 * NODE_ENV=production this module ignores SIMULATION_MODE entirely and says so
 * loudly, so that a stray flag in a deployed environment cannot hand a request
 * the ability to date its own writes. Nothing in the application reads
 * X-Simulated-Now unless both gates are open.
 * ---------------------------------------------------------------------------
 */

export const SIMULATED_NOW_HEADER = "x-simulated-now";

/**
 * The simulated instant for the current request, if one was adopted. Request
 * scoped: two concurrent simulated agents at different points in time must not
 * see each other's clock.
 */
const simulated = new AsyncLocalStorage<Date>();

let warned = false;

/** Whether the clock may be moved at all. Both gates, every time it is asked. */
export function simulationEnabled(): boolean {
  const requested = process.env.SIMULATION_MODE === "1";
  if (!requested) return false;

  if (process.env.NODE_ENV === "production") {
    if (!warned) {
      warned = true;
      console.error(
        "SIMULATION_MODE is set but NODE_ENV is production: refusing to let any request " +
          "move the clock. Unset SIMULATION_MODE.",
      );
    }
    return false;
  }

  return true;
}

/** The current moment: the simulated one when there is one, otherwise the real one. */
export function now(): Date {
  if (!simulationEnabled()) return new Date();
  const at = simulated.getStore();
  return at ? new Date(at.getTime()) : new Date();
}

/**
 * Adopt the instant carried by this request's X-Simulated-Now header, for the
 * remainder of the current execution context.
 *
 * A missing or malformed value is ignored rather than raising: the header is an
 * instruction from a trusted local script, and a typo in it should produce
 * ordinary real-time behaviour rather than a broken request.
 */
export function adoptSimulatedTime(headers: Headers): void {
  if (!simulationEnabled()) return;

  const raw = headers.get(SIMULATED_NOW_HEADER);
  if (!raw) return;

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return;

  simulated.enterWith(at);
}

/** Run `fn` at a given instant. For tests and for scripts that do not go over HTTP. */
export function withSimulatedTime<T>(at: Date, fn: () => T): T {
  if (!simulationEnabled()) return fn();
  return simulated.run(at, fn);
}
