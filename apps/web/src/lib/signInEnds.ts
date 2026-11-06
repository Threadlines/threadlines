/**
 * When to warn that a provider's saved sign-in is about to end, and how to
 * say it. The provider reports a window (`ServerProviderSignInEnds`): the
 * sign-in stops working somewhere between `earliest` and `latest`, however
 * often it renews, and only signing in again moves it.
 *
 * @module signInEnds
 */
import type { ServerProviderSignInEnds } from "@threadlines/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Warn this long before the latest end, as Claude Code itself does. */
export const SIGN_IN_ENDS_WARNING_MS = 10 * DAY_MS;

export type SignInEndsPhase =
  /** Ends between two dates, the first still ahead. */
  | "upcoming"
  /** Past the earliest end: it can stop any day until the latest. */
  | "any-day"
  /** Past the latest end, yet the provider still read it as signed in. */
  | "ended";

export interface SignInEndsWarning {
  readonly phase: SignInEndsPhase;
  /** "Nov 17" */
  readonly earliest: string;
  /** "Nov 20" */
  readonly latest: string;
  /** Hides this warning for this sign-in only: signing in again brings a new key. */
  readonly dismissalKey: string;
}

const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** The warning for a sign-in's end, or null while it is more than 10 days away. */
export function resolveSignInEndsWarning(input: {
  readonly instanceId: string;
  readonly signInEnds: ServerProviderSignInEnds | undefined;
  readonly nowMs: number;
}): SignInEndsWarning | null {
  const { signInEnds, nowMs } = input;
  if (!signInEnds) return null;
  const earliestMs = Date.parse(signInEnds.earliest);
  const latestMs = Date.parse(signInEnds.latest);
  if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs)) return null;
  if (latestMs - nowMs > SIGN_IN_ENDS_WARNING_MS) return null;
  return {
    phase: nowMs >= latestMs ? "ended" : nowMs >= earliestMs ? "any-day" : "upcoming",
    earliest: SHORT_DAY.format(earliestMs),
    latest: SHORT_DAY.format(latestMs),
    dismissalKey: `${input.instanceId}:${signInEnds.latest}`,
  };
}

/** The warning in words, naming the account ("Claude", "Claude · Work"). */
export function signInEndsCopy(
  warning: SignInEndsWarning,
  accountLabel: string,
): { readonly lead: string; readonly detail: string } {
  switch (warning.phase) {
    case "upcoming":
      return {
        lead: `${accountLabel} sign-in ends between ${warning.earliest} and ${warning.latest}`,
        detail: "Sign in again to keep it working.",
      };
    case "any-day":
      return {
        lead: `${accountLabel} sign-in can end any day`,
        detail: `It ends by ${warning.latest}. Sign in again to keep it working.`,
      };
    case "ended":
      return {
        lead: `${accountLabel} sign-in may have ended`,
        detail: `It was due to end by ${warning.latest}. Sign in again if it stops answering.`,
      };
  }
}

/** The short form for a settings row: "Sign-in ends Nov 17 to Nov 20". */
export function signInEndsShortText(warning: SignInEndsWarning): string {
  switch (warning.phase) {
    case "upcoming":
      return `Sign-in ends ${warning.earliest} to ${warning.latest}`;
    case "any-day":
      return `Sign-in ends by ${warning.latest}`;
    case "ended":
      return `Sign-in may have ended ${warning.latest}`;
  }
}
