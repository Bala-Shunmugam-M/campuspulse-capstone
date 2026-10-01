import Anthropic from "@anthropic-ai/sdk";

/**
 * Null rather than throwing when no key is configured: the AI helper is
 * optional, and every caller has to cope with "not available" anyway (timeouts,
 * refusals), so a missing key is just the earliest form of that.
 *
 * The SDK reads ANTHROPIC_API_KEY itself; it is checked here only so an unset
 * or empty key yields null instead of a client that fails on first use.
 */
export function getAiClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // One retry, short timeout: a person is waiting on the form, and the form
  // works without the draft.
  return new Anthropic({ timeout: 20_000, maxRetries: 1 });
}

export function aiModel(): string {
  return process.env.AI_MODEL || "claude-opus-5-5";
}

export function isAiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
