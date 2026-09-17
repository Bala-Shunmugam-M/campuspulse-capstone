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
 * A callback-scoped instant, for tests and for scripts that call the services
 * directly. Always entered with run(), never with enterWith().
 *
 * A request does NOT use this. It carries its instant explicitly on RequestMeta
 * instead, and there is a scar behind that choice: the first version of this
 * seam kept the request's clock in ambient storage entered with
 * AsyncLocalStorage.enterWith, which mutates the *current* async context rather
 * than opening a new one. On a long-lived server the value outlived the request
 * that set it, and a later request read an earlier request's clock. The
 * simulator duly produced a case closed nine days before it was investigated,
 * and its own audit trail said so. Ambient state that leaks between requests is
 * not worth the convenience of a zero-argument now().
 */
const scoped = new AsyncLocalStorage<Date>();

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

/** The current moment: the scoped one when a script or test set one, otherwise the real one. */
export function now(): Date {
  if (!simulationEnabled()) return new Date();
  const at = scoped.getStore();
  return at ? new Date(at.getTime()) : new Date();
}

/**
 * The instant this request says it is happening at: the X-Simulated-Now header
 * when both gates are open, and the real clock otherwise.
 *
 * Returned rather than stashed, so the caller carries it explicitly on
 * RequestMeta and every stamp in the request can be traced back to this one
 * decision. A missing or malformed value falls back to the real clock rather
 * than raising: the header comes from a trusted local script, and a typo in it
 * should produce ordinary behaviour rather than a broken request.
 */
export function requestNow(headers: Headers): Date {
  if (!simulationEnabled()) return new Date();

  const raw = headers.get(SIMULATED_NOW_HEADER);
  if (!raw) return now();

  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? now() : at;
}

/** Run `fn` at a given instant. For tests and for scripts that do not go over HTTP. */
export function withSimulatedTime<T>(at: Date, fn: () => T): T {
  if (!simulationEnabled()) return fn();
  return scoped.run(at, fn);
}
