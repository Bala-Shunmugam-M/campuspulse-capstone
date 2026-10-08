import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { Icon } from "@/components/Icon";

export default async function Home() {
  const actor = await currentActor();
  if (
    actor?.roles.some((r) =>
      ["admin", "officer", "investigator", "dpo"].includes(r),
    )
  )
    redirect("/dashboard");
  return (
    <main className="landing">
      <div className="landing-hero">
        <section>
          <p className="eyebrow">A safer campus starts with a voice</p>
          <h1>
            Every concern.
            <br />A clear <em>way forward.</em>
          </h1>
          <p className="landing-lead">
            Report an incident, follow its progress, and understand the policies
            that support your campus community.
          </p>
          <div className="landing-actions">
            <Link href="/report" className="button button-primary">
              Report an incident <Icon name="arrow" />
            </Link>
            <Link href="/report/status" className="button button-secondary">
              Track a report
            </Link>
          </div>
          <p className="landing-note">
            <Icon name="shield" />
            Anonymous reporting is available without an account.
          </p>
        </section>
        <section className="journey" aria-label="How reporting works">
          <p className="eyebrow">Clarity at every step</p>
          <div className="journey-step">
            <span>
              <Icon name="plus" />
            </span>
            <div>
              <h2>01 · Share your concern</h2>
              <p>
                Tell us what happened, in your own words. Choose to report
                anonymously or sign in.
              </p>
            </div>
          </div>
          <div className="journey-step">
            <span>
              <Icon name="cases" />
            </span>
            <div>
              <h2>02 · Your report is reviewed</h2>
              <p>
                A compliance officer reviews the report and takes the next
                appropriate steps.
              </p>
            </div>
          </div>
          <div className="journey-step">
            <span>
              <Icon name="check" />
            </span>
            <div>
              <h2>03 · Stay informed</h2>
              <p>
                Use your reference and access code to check the progress of an
                anonymous report.
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="landing-bottom">
        <article>
          <h2>Your voice. Your choice.</h2>
          <p>
            Anonymous reports come with a reference code and a one-time access
            secret. Save both when you submit: the secret is shown only once and
            cannot be recovered.
          </p>
          <Link href="/report/status" className="text-link">
            Check a report I filed <Icon name="arrow" />
          </Link>
        </article>
        <article>
          <h2>
            {actor
              ? "Know your campus policies"
              : "One workspace for your campus"}
          </h2>
          <p>
            {actor
              ? "Read the rules currently in force at your institution, explore version history, and acknowledge the policies you have read."
              : "Staff and students can sign in to file attributed reports and read campus policies. Staff also have a dedicated case-management workspace."}
          </p>
          <Link href={actor ? "/policies" : "/login"} className="text-link">
            {actor ? "Explore the policy library" : "Sign in to your workspace"}{" "}
            <Icon name="arrow" />
          </Link>
        </article>
      </div>
    </main>
  );
}
