/**
 * Recognizing "your plan doesn't include this" replies.
 *
 * Multi-provider harnesses (Cursor, fx/Gateway) advertise their full model
 * catalog over ACP regardless of the account's plan and reject a gated model
 * only at prompt time, as a short plain-text reply or billing error. This is
 * the one signal that exists, so the ACP adapter matches it to end the turn
 * with a typed reason and the chat offers the provider's upgrade page.
 *
 * @module providerPlan
 */

const PLAN_GATE_PATTERNS = [
  // Cursor Free: "Upgrade your plan to continue"
  /\bupgrade (?:your |to a )?(?:plan|subscription)\b/iu,
  // HTTP 402-style billing errors (Gateway and friends)
  /\bpayment required\b/iu,
  /\brequires (?:a |an )?(?:pro|plus|paid|premium|team|max) (?:plan|subscription)\b/iu,
  /\b(?:plan|subscription) does not include\b/iu,
  /\binsufficient (?:credits|balance|funds)\b/iu,
  // Gateway free tier: "Upgrade to paid credits at https://… for unrestricted access."
  /\bupgrade to paid credits\b/iu,
  /\bfree tier requests\b.{0,40}\brate-?limited\b/iu,
] as const;

/** A gate reply is short; long texts merely mentioning upgrades are content. */
const PLAN_GATE_MAX_CHARS = 400;

export function isProviderPlanGateMessage(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed || trimmed.length > PLAN_GATE_MAX_CHARS) {
    return false;
  }
  return PLAN_GATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}
