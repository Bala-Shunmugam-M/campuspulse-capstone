"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth/config";
import { RateLimitedError } from "@/lib/errors";
import { newRequestMeta } from "@/server/accounts";
import { draftReport } from "@/server/reportDraft";

export type ReportDraft = Awaited<ReturnType<typeof draftReport>>;
export type DraftResult = { ok: true; draft: ReportDraft } | { ok: false; message: string };

const RATE_LIMITED =
  "You've used the AI helper a lot just now. Try again in a few minutes, or fill in the form yourself.";
const FAILED = "We couldn't draft it — please fill in the form yourself.";

/**
 * Only a fixed message ever goes back: error internals (model output, SDK
 * errors) stay on the server. The text is validated inside draftReport.
 */
export async function draftReportAction(text: string): Promise<DraftResult> {
  if (typeof text !== "string") return { ok: false, message: FAILED };
  try {
    const session = await auth();
    const draft = await draftReport(
      // A signed-out session carries institutionId "" — treat it as none.
      { text, institutionId: session?.user?.institutionId || null },
      newRequestMeta(await headers()),
    );
    return { ok: true, draft };
  } catch (error) {
    return { ok: false, message: error instanceof RateLimitedError ? RATE_LIMITED : FAILED };
  }
}
