"use server";

import { headers } from "next/headers";
import { newRequestMeta } from "@/server/accounts";
import { lookupAnonymousReport } from "@/server/reports";

export type StatusResult =
  | { state: "idle" }
  | { state: "found"; referenceCode: string; status: string; submittedAt: string; title: string }
  | { state: "denied" };

/**
 * Every failure returns the same "denied" state: an unknown code, a wrong
 * access code and a rate-limited attempt are indistinguishable to the caller,
 * because saying which one it was confirms whether a guessed code exists.
 */
export async function checkStatus(
  _previous: StatusResult,
  formData: FormData,
): Promise<StatusResult> {
  const referenceCode = String(formData.get("referenceCode") ?? "");
  const accessSecret = String(formData.get("accessSecret") ?? "");

  try {
    const view = await lookupAnonymousReport(
      referenceCode,
      accessSecret,
      newRequestMeta(await headers()),
    );
    return {
      state: "found",
      referenceCode: view.referenceCode,
      status: view.status,
      submittedAt: view.submittedAt.toISOString(),
      title: view.title,
    };
  } catch {
    return { state: "denied" };
  }
}
