"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type CSSProperties } from "react";
import type {
  AdminDashboard,
  OfficerDashboard,
  Share,
} from "@/server/dashboards";
import { Icon, type IconName } from "./Icon";

export type DashboardAdmin = Omit<AdminDashboard, "intakeByWeek"> & {
  intakeByWeek: { weekStarting: string; reports: number }[];
};
type PreviewCase = {
  id: string;
  caseNumber: string;
  title: string;
  status: string;
  severity: string;
  slaDueAt: string;
  overdue: boolean;
};
const colors = [
  "#078b80",
  "#64b7ac",
  "#8d83d5",
  "#e0ac58",
  "#4d94c7",
  "#aab6be",
  "#d5878b",
  "#79aa80",
];
function label(text: string) {
  return text.replaceAll("_", " ");
}
function ShareValue({ value, noun }: { value: Share; noun: string }) {
  return (
    <>
      <strong className="stat-value">
        {value.percent === null ? "—" : `${value.percent.toFixed(1)}%`}
      </strong>
      <p className="muted">
        {value.total
          ? `${value.count} of ${value.total} ${noun}`
          : `No ${noun} yet`}
      </p>
    </>
  );
}
function Kpi({
  title,
  value,
  description,
  icon,
  href,
  tone = "teal",
}: {
  title: string;
  value: number;
  description: string;
  icon: IconName;
  href?: string;
  tone?: string;
}) {
  const content = (
    <>
      <div className="kpi-heading">
        <span>{title}</span>
        <span className={`metric-icon tone-${tone}`}>
          <Icon name={icon} />
        </span>
      </div>
      <strong className="kpi-value">{value.toLocaleString()}</strong>
      <div className="kpi-caption">
        <span className={tone === "red" && value ? "text-danger" : "muted"}>
          {description}
        </span>
        {href && <Icon name="arrow" />}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="metric-card">
      {content}
    </Link>
  ) : (
    <div className="metric-card">{content}</div>
  );
}
function IntakeChart({
  rows,
  asOf,
}: {
  rows: DashboardAdmin["intakeByWeek"];
  asOf: string;
}) {
  const [weeks, setWeeks] = useState(12);
  const [active, setActive] = useState<number | null>(null);
  // The service omits empty buckets; render real zeroes in the calendar gaps.
  const monday = new Date(asOf);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const cutoff = monday.getTime() - (weeks - 1) * 7 * 86400000;
  const start = new Date(cutoff);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const series = [];
  for (
    let stamp = start.getTime();
    stamp <= monday.getTime();
    stamp += 7 * 86400000
  ) {
    const key = new Date(stamp).toISOString().slice(0, 10);
    series.push({
      key,
      reports:
        rows.find((r) => r.weekStarting.slice(0, 10) === key)?.reports ?? 0,
    });
  }
  const max = Math.max(4, ...series.map((r) => r.reports));
  const total = series.reduce((sum, r) => sum + r.reports, 0);
  return (
    <section className="panel intake-panel">
      <div className="panel-heading">
        <div>
          <h2>Report intake</h2>
          <p>Reports received by week</p>
        </div>
        <div className="segmented" aria-label="Intake time range">
          {[4, 8, 12].map((w) => (
            <button
              key={w}
              aria-pressed={weeks === w}
              onClick={() => {
                setWeeks(w);
                setActive(null);
              }}
            >
              {w} weeks
            </button>
          ))}
        </div>
      </div>
      <div className="chart-summary">
        <strong>{total.toLocaleString()}</strong>
        <span>reports in displayed weeks</span>
        <span className="chart-legend">
          <i />
          Report intake
        </span>
      </div>
      <div className="chart-wrap">
        <div className="chart-y">
          <span>{max}</span>
          <span>{Math.round(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="intake-chart">
          <div className="chart-grid">
            <i />
            <i />
            <i />
          </div>
          <div className="chart-bars">
            {series.map((r, i) => (
              <button
                key={r.key}
                className={`chart-column ${active === i ? "selected" : ""}`}
                aria-label={`Week of ${r.key}: ${r.reports} reports`}
                aria-pressed={active === i}
                onClick={() => setActive(active === i ? null : i)}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <span
                  className="chart-bar"
                  style={{
                    height: `${r.reports === 0 ? 1 : Math.max(3, (r.reports / max) * 100)}%`,
                    opacity: r.reports === 0 ? 0.25 : 1,
                  }}
                />
                <span className="chart-date">
                  {new Date(r.key).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  })}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="chart-detail" aria-live="polite">
        {active !== null ? (
          <>
            <strong>{series[active].reports} reports</strong> · Week of{" "}
            {series[active].key}
          </>
        ) : (
          "Hover, focus or tap a bar to inspect a week. Boundary weeks may be partial."
        )}
      </div>
    </section>
  );
}
function StatusChart({
  rows,
  canQueue,
}: {
  rows: OfficerDashboard["byStatus"];
  canQueue: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  let offset = 0;
  const gradient = rows
    .map((r, i) => {
      const from = offset;
      offset += total ? (r.count / total) * 100 : 0;
      return `${colors[i % colors.length]} ${from}% ${offset}%`;
    })
    .join(",");
  const focused = rows.find((r) => r.status === selected);
  return (
    <section className="panel status-panel">
      <div className="panel-heading">
        <div>
          <h2>Case distribution</h2>
          <p>All visible cases · all time</p>
        </div>
        <Icon name="cases" />
      </div>
      <div className="status-chart-body">
        <div
          className="donut"
          style={{
            background: total ? `conic-gradient(${gradient})` : "var(--line)",
          }}
          role="img"
          aria-label={`${total} cases; ${rows.map((r) => `${label(r.status)}: ${r.count}`).join(", ")}`}
        >
          <div>
            <strong>{focused?.count ?? total}</strong>
            <span>{focused ? label(focused.status) : "total cases"}</span>
          </div>
        </div>
        <div className="status-legend">
          {rows.map((r, i) => (
            <button
              key={r.status}
              className={selected === r.status ? "selected" : ""}
              aria-pressed={selected === r.status}
              onClick={() =>
                setSelected(selected === r.status ? null : r.status)
              }
            >
              <i style={{ background: colors[i % colors.length] }} />
              <span>{label(r.status)}</span>
              <strong>{r.count}</strong>
            </button>
          ))}
        </div>
      </div>
      {!total && (
        <p className="muted">
          Your case distribution will appear after the first case is opened.
        </p>
      )}
      {selected && canQueue && (
        <Link className="text-link" href={`/cases?status=${selected}`}>
          View {label(selected)} cases <Icon name="arrow" />
        </Link>
      )}
    </section>
  );
}
function Workload({
  rows,
  canQueue,
}: {
  rows: AdminDashboard["officerWorkload"];
  canQueue: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"open" | "overdue" | "email">("open");
  const [page, setPage] = useState(0);
  const sorted = rows
    .filter((r) => r.email.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === "email"
        ? a.email.localeCompare(b.email)
        : b[sort] - a[sort] || a.email.localeCompare(b.email),
    );
  const max = Math.max(1, ...rows.map((r) => r.open));
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Team workload</h2>
          <p>Balance ownership across your officers</p>
        </div>
        <span className="count-badge">{rows.length} officers</span>
      </div>
      <div className="table-tools">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="Find an officer"
            placeholder="Find an officer…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {(
                [
                  ["email", "Officer"],
                  ["open", "Open cases"],
                  ["overdue", "Overdue"],
                ] as const
              ).map(([key, name]) => (
                <th
                  key={key}
                  aria-sort={
                    sort === key
                      ? key === "email"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    onClick={() => {
                      setSort(key);
                      setPage(0);
                    }}
                  >
                    {name}
                    <Icon name="sort" width={13} height={13} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(page * 5, page * 5 + 5).map((r) => (
              <tr key={r.accountId}>
                <td>
                  <span className="officer-cell">
                    <span className="avatar avatar-small">
                      {r.email.slice(0, 2).toUpperCase()}
                    </span>
                    {canQueue ? (
                      <Link href={`/cases?assignedTo=${r.accountId}`}>
                        {r.email}
                      </Link>
                    ) : (
                      r.email
                    )}
                  </span>
                </td>
                <td>
                  <div className="workload-bar">
                    <span>{r.open}</span>
                    <i
                      style={
                        {
                          "--fill": `${(r.open / max) * 100}%`,
                        } as CSSProperties
                      }
                    />
                  </div>
                </td>
                <td>
                  <span
                    className={`badge ${r.overdue ? "badge-red" : "badge-neutral"}`}
                  >
                    {r.overdue}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!sorted.length && (
        <p className="empty-inline">No officers match your search.</p>
      )}
      <div className="table-footer">
        <span>
          {sorted.length} officers
          {sorted.length
            ? ` · Page ${page + 1} of ${Math.ceil(sorted.length / 5)}`
            : ""}
        </span>
        <div>
          <button
            className="button button-small"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <button
            className="button button-small"
            disabled={(page + 1) * 5 >= sorted.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
export function DashboardView({
  dash,
  admin,
  cases,
  canQueue,
  asOf,
}: {
  dash: OfficerDashboard;
  admin: DashboardAdmin | null;
  cases: PreviewCase[];
  canQueue: boolean;
  asOf: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [auto, setAuto] = useState(false);
  const refresh = () => startTransition(() => router.refresh());
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible")
        startTransition(() => router.refresh());
    }, 60000);
    return () => clearInterval(id);
  }, [auto, router]);
  return (
    <main className="dashboard-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Your campus, in focus</p>
          <h1>
            Compliance overview<span className="heading-dot">.</span>
          </h1>
          <p>Stay ahead of deadlines. Keep every case moving.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-secondary"
            disabled={pending}
            onClick={refresh}
          >
            <Icon name="refresh" className={pending ? "spinning" : ""} />
            {pending ? "Refreshing…" : "Refresh"}
          </button>
          {canQueue && (
            <Link className="button button-primary" href="/cases">
              Open case queue <Icon name="arrow" />
            </Link>
          )}
        </div>
      </header>
      <div className="dashboard-meta">
        <div className="dashboard-tabs">
          <span className="active">Overview</span>
          {canQueue && <Link href="/cases?assignedTo=me">My cases</Link>}
          <Link href="/policies">Policies</Link>
        </div>
        <label className="auto-refresh">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          Auto-refresh · 1 min
        </label>
      </div>
      <section className="kpi-grid" aria-label="Workload metrics">
        <Kpi
          title="Assigned to you"
          value={dash.mine}
          description="Your active caseload"
          icon="cases"
          href={canQueue ? "/cases?assignedTo=me&deadline=open" : undefined}
        />
        <Kpi
          title="Overdue cases"
          value={dash.overdue}
          description={
            dash.overdue ? "Needs your team’s attention" : "No missed deadlines"
          }
          icon="alert"
          tone="red"
          href={canQueue ? "/cases?deadline=overdue" : undefined}
        />
        <Kpi
          title="Due in 24 hours"
          value={dash.dueSoon}
          description="Coming up next"
          icon="clock"
          tone="amber"
          href={canQueue ? "/cases?deadline=soon" : undefined}
        />
        <Kpi
          title="Unassigned"
          value={dash.unassigned}
          description="Ready for an owner"
          icon="users"
          tone="violet"
          href={
            canQueue ? "/cases?assignedTo=unassigned&deadline=open" : undefined
          }
        />
      </section>
      <div className="dashboard-grid">
        {admin ? (
          <IntakeChart rows={admin.intakeByWeek} asOf={asOf} />
        ) : (
          <section className="panel focus-panel">
            <span className="metric-icon tone-teal">
              <Icon name="shield" />
            </span>
            <p className="eyebrow">Make the next action count</p>
            <h2>
              A clear view.
              <br />A considered response.
            </h2>
            <p>
              Review approaching deadlines, pick up unassigned cases, and keep
              your investigations moving.
            </p>
            {canQueue && (
              <Link
                href="/cases?deadline=soon"
                className="button button-primary"
              >
                Review upcoming deadlines <Icon name="arrow" />
              </Link>
            )}
          </section>
        )}
        <StatusChart rows={dash.byStatus} canQueue={canQueue} />
      </div>
      <div className="insight-strip">
        <span className="metric-icon tone-teal">
          <Icon name="clock" />
        </span>
        <div>
          <strong>
            {dash.medianFirstResponseHours === null
              ? "No first response recorded yet"
              : `${dash.medianFirstResponseHours.toFixed(1)}h median first response`}
          </strong>
          <p>From case opening to the first officer action · all time</p>
        </div>
        <details>
          <summary>How it’s measured</summary>
          <p>
            The median measures the middle response time across visible cases
            with a recorded first response. Sealed cases are excluded.
          </p>
        </details>
      </div>
      {canQueue && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Needs attention</h2>
              <p>Active cases with the earliest deadlines</p>
            </div>
            <Link className="text-link" href="/cases?deadline=open">
              View queue <Icon name="arrow" />
            </Link>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Deadline</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="case-title" href={`/cases/${c.id}`}>
                        <small>{c.caseNumber}</small>
                        <strong>{c.title}</strong>
                      </Link>
                    </td>
                    <td>
                      <span className={`badge badge-${c.severity}`}>
                        {c.severity}
                      </span>
                    </td>
                    <td>
                      <span className="status-label">
                        <i />
                        {label(c.status)}
                      </span>
                    </td>
                    <td>
                      <span className={c.overdue ? "text-danger" : "muted"}>
                        {new Date(c.slaDueAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </span>
                      {c.overdue && (
                        <small className="deadline-caption">Overdue</small>
                      )}
                    </td>
                    <td>
                      <details className="row-menu">
                        <summary
                          className="icon-button"
                          aria-label={`Actions for ${c.caseNumber}`}
                        >
                          <Icon name="dots" />
                        </summary>
                        <div>
                          <Link href={`/cases/${c.id}`}>
                            Open case <Icon name="arrow" />
                          </Link>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!cases.length && (
            <div className="empty-state">
              <Icon name="check" />
              <h3>No active cases</h3>
              <p>
                New cases will appear here when they’re ready for your team.
              </p>
            </div>
          )}
        </section>
      )}
      {admin && (
        <>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Institution insights</p>
              <h2>The bigger picture</h2>
            </div>
            <span className="muted">All-time performance</span>
          </div>
          <div className="insights-grid">
            <section className="panel compact-insight">
              <div className="panel-heading">
                <h2>SLA breach rate</h2>
                <Icon name="clock" />
              </div>
              <ShareValue value={admin.slaBreachRate} noun="resolved cases" />
              <div className="progress-track">
                <i
                  className="danger-fill"
                  style={{ width: `${admin.slaBreachRate.percent ?? 0}%` }}
                />
              </div>
              <details>
                <summary>About this metric</summary>
                <p>
                  Compares each stored due date with its resolution time. Later
                  policy changes do not rewrite past results.
                </p>
              </details>
            </section>
            <section className="panel compact-insight">
              <div className="panel-heading">
                <h2>Anonymous reports</h2>
                <Icon name="shield" />
              </div>
              <ShareValue value={admin.anonymousShare} noun="reports" />
              <div className="progress-track">
                <i style={{ width: `${admin.anonymousShare.percent ?? 0}%` }} />
              </div>
              <p className="muted">
                Intake submitted without a reporter identity.
              </p>
            </section>
            <section className="panel compact-insight">
              <div className="panel-heading">
                <h2>Outcome mix</h2>
                <Icon name="check" />
              </div>
              {admin.outcomeMix.length ? (
                admin.outcomeMix.map((o) => (
                  <div className="outcome-row" key={o.finding}>
                    <span>{label(o.finding)}</span>
                    <strong>{o.percent?.toFixed(0) ?? "—"}%</strong>
                    <small>
                      {o.count} of {o.total}
                    </small>
                  </div>
                ))
              ) : (
                <p className="empty-inline">No recorded outcomes yet.</p>
              )}
            </section>
          </div>
          <div className="dashboard-grid lower-grid">
            <Workload rows={admin.officerWorkload} canQueue={canQueue} />
            <PolicyCoverage rows={admin.policyCoverage} />
          </div>
        </>
      )}
      <div className="dashboard-footnote">
        <span>
          <Icon name="shield" /> Sealed cases are excluded from case metrics and
          queues.
        </span>
        <span role="status">
          Updated{" "}
          {new Date(asOf).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          })}{" "}
          UTC
        </span>
      </div>
    </main>
  );
}

function PolicyCoverage({ rows }: { rows: AdminDashboard["policyCoverage"] }) {
  const [page, setPage] = useState(0);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Policy coverage</h2>
          <p>Acknowledgements for versions in force</p>
        </div>
        <Link
          className="icon-button"
          href="/policies"
          aria-label="Open policy library"
        >
          <Icon name="arrow" />
        </Link>
      </div>
      <div className="policy-coverage">
        {rows.length ? (
          rows.slice(page * 5, page * 5 + 5).map((p) => (
            <Link
              key={p.policyId}
              href={`/policies/${p.policyId}`}
              className="policy-progress"
            >
              <div>
                <span>
                  <small>
                    {p.code} · v{p.versionNo}
                  </small>
                  <strong>{p.title}</strong>
                </span>
                <b>{p.percent === null ? "—" : `${p.percent.toFixed(0)}%`}</b>
              </div>
              <div className="progress-track">
                <i style={{ width: `${p.percent ?? 0}%` }} />
              </div>
              <small>
                {p.done} of {p.required} accounts
              </small>
            </Link>
          ))
        ) : (
          <p className="empty-inline">No policy is currently in force.</p>
        )}
      </div>
      <div className="table-footer">
        <span>
          {rows.length} policies · Page {page + 1} of{" "}
          {Math.max(1, Math.ceil(rows.length / 5))}
        </span>
        <div>
          <button
            className="button button-small"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <button
            className="button button-small"
            disabled={(page + 1) * 5 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
