import Link from "next/link";
import { signOut } from "@/lib/auth/config";
import { currentActor } from "@/lib/auth/actor";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * Who is signed in, and the way out, on every page. Renders nothing when
 * signed out, so the anonymous reporting pages stay exactly as they were.
 *
 * Signing out goes through Auth.js, whose signOut event revokes the session
 * row: clearing the cookie alone would leave a token that still works.
 */
export async function AccountBar() {
  const actor = await currentActor();
  if (!actor) return null;

  async function signOutAction() {
    "use server";
    // No redirect here: SignOutButton reloads "/" itself once this returns.
    await signOut({ redirect: false });
  }

  return (
    <div className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
        <Link href="/" className="font-medium text-slate-900 underline-offset-2 hover:underline">
          Campus Compliance
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{actor.email}</span>
          </span>
          <SignOutButton signOutAction={signOutAction} />
        </div>
      </div>
    </div>
  );
}
