import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth/config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(formData.get("email") ?? "").toLowerCase(),
        password: String(formData.get("password") ?? ""),
        redirectTo: "/cases",
      });
    } catch (thrown) {
      if ((thrown as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw thrown;
      redirect("/login?error=1");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Campus Compliance</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in to continue.</p>
      </header>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Invalid email or password.
        </p>
      ) : null}

      <form action={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input name="email" type="email" required autoComplete="username"
                 className="rounded border border-slate-300 px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input name="password" type="password" required autoComplete="current-password"
                 className="rounded border border-slate-300 px-3 py-2" />
        </label>
        <button type="submit"
                className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800">
          Sign in
        </button>
      </form>

      <p className="text-sm text-slate-600">
        <a className="underline" href="/report">Report an incident without signing in</a>
      </p>
    </main>
  );
}
