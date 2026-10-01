import { InferenceClient } from "@huggingface/inference";

/**
 * Null rather than throwing when no token is configured: the AI helper is
 * optional, and every caller has to cope with "not available" anyway (timeouts,
 * refusals), so a missing token is just the earliest form of that.
 */
export function getAiClient(): InferenceClient | null {
  const token = process.env.HF_TOKEN;
  if (!token) return null;
  // No retry on a cold model: a person is waiting on the form, and the form
  // works without the draft.
  return new InferenceClient(token, { retry_on_error: false });
}

/**
 * Model and provider are chosen as a pair: structured output support varies by
 * provider, and Qwen3-32B on Cerebras is the pairing Hugging Face documents for
 * JSON-schema output. Change both together.
 */
export function aiModel(): string {
  return process.env.HF_MODEL || "Qwen/Qwen3-32B";
}

export function aiProvider(): string {
  return process.env.HF_PROVIDER || "cerebras";
}

export function isAiEnabled(): boolean {
  return Boolean(process.env.HF_TOKEN);
}
