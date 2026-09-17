"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { newRequestMeta } from "@/server/accounts";
import { acknowledge } from "@/server/acknowledgements";
import { DomainError } from "@/lib/errors";

/**
 * A domain error is a message for the person and comes back on the query
 * string; anything else is a bug and rethrows rather than being flattened into
 * "something went wrong".
 */
export async function acknowledgeAction(formData: FormData) {
  const policyId = String(formData.get("policyId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");

  try {
    const actor = await currentActor();
    if (!actor) redirect("/login");
    await acknowledge(actor, versionId, newRequestMeta(await headers()));
  } catch (thrown) {
    if (thrown instanceof DomainError) {
      redirect(`/policies/${policyId}?error=${encodeURIComponent(thrown.message)}`);
    }
    throw thrown;
  }

  revalidatePath(`/policies/${policyId}`);
  redirect(`/policies/${policyId}`);
}
