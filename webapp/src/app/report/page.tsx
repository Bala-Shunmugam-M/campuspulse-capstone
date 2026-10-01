import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { prisma } from "@/lib/db";
import { newRequestMeta } from "@/server/accounts";
import { submitAnonymousReport, submitReport } from "@/server/reports";
import { reportInputSchema } from "@/lib/validation/report";
import { RateLimitedError } from "@/lib/errors";
import { isAiEnabled } from "@/lib/ai/client";
import { ReportForm } from "./ReportForm";

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

    try {
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
    } catch (e) {
      // redirect() works by throwing; only the rate limit is turned into a message.
      if (e instanceof RateLimitedError) {
        redirect(`/report?error=${encodeURIComponent("Too many reports from this connection. Try again later.")}`);
      }
      throw e;
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

      <ReportForm
        institutions={institutions}
        categories={categories}
        locations={locations}
        signedIn={signedIn}
        aiEnabled={isAiEnabled()}
        action={submit}
      />
    </main>
  );
}
