import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { prisma } from "@/lib/db";
import { newRequestMeta } from "@/server/accounts";
import { submitAnonymousReport, submitReport } from "@/server/reports";
import { reportInputSchema } from "@/lib/validation/report";

type Option = { id: string; name: string };

async function optionsFor(institutionId: string | null) {
  if (!institutionId) return { categories: [] as Option[], locations: [] as Option[] };
  const [categories, locations] = await Promise.all([
    prisma.$queryRaw<Option[]>`
      SELECT id, name FROM campuspulse.categories
      WHERE institution_id = ${institutionId}::uuid AND category_type = 'issue_category'
      ORDER BY name`,
    prisma.$queryRaw<Option[]>`
      SELECT id, name FROM campuspulse.locations
      WHERE institution_id = ${institutionId}::uuid ORDER BY location_type, name`,
  ]);
  return { categories, locations };
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await auth();
  const signedIn = Boolean(session?.user?.accountId);

  const institutions = signedIn
    ? []
    : await prisma.institution.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });

  const { categories, locations } = await optionsFor(session?.user?.institutionId ?? null);

  async function submit(formData: FormData) {
    "use server";

    const raw = {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      severitySelfReported: String(formData.get("severity") ?? "moderate"),
      categoryId: (formData.get("categoryId") as string) || null,
      locationId: (formData.get("locationId") as string) || null,
      occurredAt: (formData.get("occurredAt") as string) || null,
    };

    const parsed = reportInputSchema.safeParse(raw);
    if (!parsed.success) {
      redirect(`/report?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
    }

    const active = await auth();
    const meta = newRequestMeta(await headers());
    const jar = await cookies();

    if (active?.user?.accountId) {
      const { referenceCode } = await submitReport(
        {
          accountId: active.user.accountId,
          institutionId: active.user.institutionId,
          email: active.user.email ?? active.user.accountId,
          roles: active.user.roles as never,
        },
        parsed.data,
        meta,
      );
      // Only an identifier, and it is stored in clear anyway.
      jar.set("cp_ref", referenceCode, { httpOnly: true, sameSite: "lax", maxAge: 300, path: "/" });
    } else {
      const institutionId = String(formData.get("institutionId") ?? "");
      if (!institutionId) redirect("/report?error=Choose%20your%20institution.");

      const { referenceCode, accessSecret } = await submitAnonymousReport(
        institutionId,
        parsed.data,
        meta,
      );
      jar.set("cp_ref", referenceCode, { httpOnly: true, sameSite: "lax", maxAge: 300, path: "/" });
      // Carried in an httpOnly cookie rather than the URL: a query string lands
      // in browser history, referrer headers and access logs, and this value is
      // the only thing standing between the report and anyone who finds it.
      jar.set("cp_secret", accessSecret, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 300,
        path: "/",
      });
    }

    redirect("/report/submitted");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Report an incident</h1>
        <p className="mt-1 text-sm text-slate-600">
          {signedIn
            ? "This report will be attributed to your account."
            : "You are not signed in. This report will be anonymous, and you will be given a code to check its progress."}
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <form action={submit} className="flex flex-col gap-4">
        {!signedIn ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Institution</span>
            <select name="institutionId" required className="rounded border border-slate-300 px-3 py-2">
              <option value="">Choose…</option>
              {institutions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Title</span>
          <input name="title" required minLength={8} maxLength={200}
                 className="rounded border border-slate-300 px-3 py-2" />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">What happened</span>
          <textarea name="description" required minLength={40} maxLength={10000} rows={8}
                    className="rounded border border-slate-300 px-3 py-2" />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">How serious is it?</span>
          <select name="severity" defaultValue="moderate"
                  className="rounded border border-slate-300 px-3 py-2">
            <option value="low">Low</option>
            <option value="moderate">Moderate</option>
            <option value="high">High</option>
            <option value="severe">Severe</option>
          </select>
        </label>

        {signedIn && categories.length > 0 ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Category (optional)</span>
            <select name="categoryId" className="rounded border border-slate-300 px-3 py-2">
              <option value="">Not sure</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {signedIn && locations.length > 0 ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Where (optional)</span>
            <select name="locationId" className="rounded border border-slate-300 px-3 py-2">
              <option value="">Not sure</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">When did it happen? (optional)</span>
          <input name="occurredAt" type="date" className="rounded border border-slate-300 px-3 py-2" />
        </label>

        <button type="submit"
                className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800">
          Submit report
        </button>
      </form>
    </main>
  );
}
