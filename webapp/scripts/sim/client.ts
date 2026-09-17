import { SIMULATED_NOW_HEADER } from "../../src/lib/clock";

/**
 * An HTTP client that drives the application the way a browser does.
 *
 * The simulator does not write to the database (spec 8.1). It signs in over
 * HTTP and submits the same forms a browser submits, so that everything it
 * produces is by construction data the application could have produced -- with
 * the audit rows, status history and notifications a real action leaves. A
 * script that inserted rows could produce a case with no audit trail and a
 * status no transition allows: plausible-looking and structurally impossible.
 *
 * Server actions are reached exactly as a browser with JavaScript disabled
 * reaches them: Next renders each one as a POST to the page's own URL carrying
 * a hidden $ACTION_ID_<hash> field, and that is what this posts.
 */

export class SimulationError extends Error {}

export type Reply = {
  status: number;
  location: string | null;
  body: string;
  /** The ?error= message the action redirected with, if it refused. */
  refusal: string | null;
};

export type Form = {
  actionId: string;
  fields: Set<string>;
  /** Values already filled in, by field name: the hidden caseId, reportId and so on. */
  hidden: Map<string, string>;
  /**
   * The choices a select offers, by field name. The case page renders only the
   * transitions the state machine actually permits, so an agent that picks from
   * here is choosing exactly what a person looking at the page could choose.
   */
  options: Map<string, string[]>;
};

/** Statuses an ordinary page load or form post may legitimately produce. */
const OK = new Set([200, 302, 303, 307]);

/**
 * Every form on a page, with its action id and the names of its fields. Forms
 * do not nest, so one pass is enough. The field names are how a caller picks
 * the form it wants: the case page carries eight of them, and "the one with a
 * `visibility` field" is a more durable way to name the note form than its
 * position.
 */
export function parseForms(html: string): Form[] {
  const forms: Form[] = [];

  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const inner = match[1];
    const names = [...inner.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    const actionId = names.find((n) => n.startsWith("$ACTION_ID_"));
    if (!actionId) continue;

    const hidden = new Map<string, string>();
    for (const input of inner.matchAll(/<input\b[^>]*>/g)) {
      const tag = input[0];
      const name = /\bname="([^"]+)"/.exec(tag)?.[1];
      const value = /\bvalue="([^"]*)"/.exec(tag)?.[1];
      if (name && value !== undefined && !name.startsWith("$ACTION_ID_")) hidden.set(name, value);
    }

    // Options belong to the select that encloses them, so walk select by select
    // rather than scanning the whole form for <option>.
    const options = new Map<string, string[]>();
    for (const select of inner.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const values = [...select[2].matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)]
        .map((o) => o[1])
        .filter((v) => v !== "");
      options.set(select[1], values);
    }

    forms.push({
      actionId,
      fields: new Set(names.filter((n) => !n.startsWith("$ACTION_ID_"))),
      hidden,
      options,
    });
  }

  return forms;
}

export class Client {
  /**
   * One cookie jar per client, so each simulated person holds their own
   * session. This is also the first real test of phase 2's session work under
   * many concurrent sessions.
   */
  private jar = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    /** The instant this agent believes it is. Sent on every request. */
    public at: Date,
  ) {}

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const cookie = this.cookieHeader();
    return {
      [SIMULATED_NOW_HEADER]: this.at.toISOString(),
      "user-agent": "campuspulse-simulator/1.0",
      ...(cookie ? { cookie } : {}),
      ...extra,
    };
  }

  /**
   * Any status outside the ordinary set fails the run loudly, printing the
   * request that caused it. A run that completes has exercised every workflow
   * end to end; a run that swallowed a 500 would have proved nothing.
   */
  private check(method: string, path: string, response: Response, body: string): void {
    // Next renders an unhandled server error as a 200 carrying its error
    // document, so status alone is not enough to tell a working page from a
    // broken one. A run that swallowed that would prove nothing.
    if (body.includes('id="__next_error__"')) {
      throw new SimulationError(
        `${method} ${path} rendered the Next.js error page (status ${response.status})\n` +
          `  as of ${this.at.toISOString()}\n` +
          "  the server log carries the stack trace",
      );
    }

    if (OK.has(response.status)) return;
    throw new SimulationError(
      `${method} ${path} -> ${response.status} ${response.statusText}\n` +
        `  as of ${this.at.toISOString()}\n` +
        `  body: ${body.slice(0, 600)}`,
    );
  }

  private static refusalIn(location: string | null): string | null {
    if (!location) return null;
    const match = /[?&]error=([^&]*)/.exec(location);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async get(path: string): Promise<Reply> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      redirect: "manual",
    });
    this.absorb(response);
    const body = await response.text();
    this.check("GET", path, response, body);

    const location = response.headers.get("location");
    // Being bounced to the sign-in page means the session did not hold. That is
    // a failure worth stopping for rather than an empty page to carry on from:
    // it is how a clock that reached the action but not the page render showed
    // up, as agents that silently did nothing at all.
    if (this.signedIn && location?.includes("/login")) {
      throw new SimulationError(
        `GET ${path} redirected to the sign-in page while holding a session cookie\n` +
          `  as of ${this.at.toISOString()}`,
      );
    }

    return { status: response.status, location, body, refusal: Client.refusalIn(location) };
  }

  /** POST a server action, exactly as a browser without JavaScript would. */
  async submit(path: string, form: Form, values: Record<string, string | Blob>): Promise<Reply> {
    const body = new FormData();
    body.set(form.actionId, "");
    for (const [key, value] of Object.entries(values)) body.set(key, value);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body,
      redirect: "manual",
    });
    this.absorb(response);
    const text = await response.text();
    this.check("POST", path, response, text);

    const location = response.headers.get("location");
    return { status: response.status, location, body: text, refusal: Client.refusalIn(location) };
  }

  /**
   * Auth.js credentials sign-in. The CSRF token must be fetched first and sent
   * back with the cookie that accompanied it, which is why this needs a jar at
   * all rather than a bare header.
   */
  async login(email: string, password: string): Promise<void> {
    const csrfPage = await this.get("/api/auth/csrf");
    const token = (JSON.parse(csrfPage.body) as { csrfToken: string }).csrfToken;

    const body = new URLSearchParams({
      csrfToken: token,
      email,
      password,
      callbackUrl: `${this.baseUrl}/cases`,
      json: "true",
    });

    const response = await fetch(`${this.baseUrl}/api/auth/callback/credentials`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded" }),
      body,
      redirect: "manual",
    });
    this.absorb(response);
    const text = await response.text();
    this.check("POST", "/api/auth/callback/credentials", response, text);

    if (!this.signedIn) {
      throw new SimulationError(
        `sign-in as ${email} left no session cookie; the credentials were refused`,
      );
    }
  }

  /** Whether this client currently holds a session cookie. */
  get signedIn(): boolean {
    return [...this.jar.keys()].some((k) => k.includes("session-token"));
  }

  forget(): void {
    this.jar.clear();
  }
}

/** The one form on `html` carrying every named field. */
export function formWith(html: string, ...required: string[]): Form {
  const forms = parseForms(html);
  const found = forms.find((f) => required.every((name) => f.fields.has(name)));
  if (!found) {
    throw new SimulationError(
      `no form on the page carries [${required.join(", ")}]; ` +
        `saw ${forms.length} form(s): ${forms.map((f) => [...f.fields].join("+")).join(" | ")}`,
    );
  }
  return found;
}

/** The same, but absent rather than fatal when the page does not offer it. */
export function optionalFormWith(html: string, ...required: string[]): Form | null {
  return parseForms(html).find((f) => required.every((name) => f.fields.has(name))) ?? null;
}
