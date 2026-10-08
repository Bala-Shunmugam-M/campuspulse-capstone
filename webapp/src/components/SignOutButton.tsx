"use client";

import { useTransition } from "react";

/**
 * Signs out, then reloads the front door as a fresh request. Letting the
 * server action redirect instead rendered "/" in the same round trip, before
 * the cleared cookie took effect, so the page still read "Signed in as …"
 * until the next navigation -- a sign-out that looked as if it had failed.
 */
export function SignOutButton({ signOutAction }: { signOutAction: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOutAction();
          window.location.assign("/");
        })
      }
      className="rounded border border-slate-300 bg-white px-3 py-1 text-slate-900 hover:bg-slate-100 disabled:opacity-60"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
