/**
 * The composer notice that a provider's saved sign-in is about to end (see
 * `lib/signInEnds`). Shown from 10 days before, for the thread's own agent,
 * with Sign in again; hiding it lasts until the next sign-in, whose end date
 * is a new key.
 *
 * @module providerSignInEndsNotice
 */
import type { ServerProvider } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useSignInEndsWarning } from "../../hooks/useSignInEndsWarning";
import { signInEndsCopy } from "../../lib/signInEnds";
import { formatProviderDriverKindLabel } from "../../providerModels";
import type { ComposerNotice } from "./composerNotices";
import { ProviderSignInButton, type ProviderSignInFlowView } from "./providerSignIn";

const SIGN_IN_ENDS_DISMISSALS_STORAGE_KEY = "threadlines:sign-in-ends-dismissals:v1";
/** Hidden warnings to remember; older ones belong to sign-ins long replaced. */
const MAX_REMEMBERED_DISMISSALS = 20;
const SignInEndsDismissals = Schema.Struct({ keys: Schema.Array(Schema.String) });
const NO_DISMISSALS: typeof SignInEndsDismissals.Type = { keys: [] };

export function useProviderSignInEndsNotice(input: {
  readonly status: ServerProvider | null;
  /** This instance's sign-in flow, from the surface that owns it. */
  readonly signIn?: ProviderSignInFlowView | undefined;
}): ComposerNotice | null {
  const { signIn, status } = input;
  const [dismissals, setDismissals] = useLocalStorage(
    SIGN_IN_ENDS_DISMISSALS_STORAGE_KEY,
    NO_DISMISSALS,
    SignInEndsDismissals,
  );
  const warning = useSignInEndsWarning(status);
  const dismissalKey = warning?.dismissalKey;
  const dismiss = useCallback(() => {
    if (!dismissalKey) return;
    setDismissals((current) => ({
      keys: [...current.keys.filter((key) => key !== dismissalKey), dismissalKey].slice(
        -MAX_REMEMBERED_DISMISSALS,
      ),
    }));
  }, [dismissalKey, setDismissals]);

  return useMemo(() => {
    if (!status || !warning || dismissals.keys.includes(warning.dismissalKey)) return null;
    const accountLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
    const copy = signInEndsCopy(warning, accountLabel);
    return {
      id: `sign-in-ends:${status.instanceId}`,
      severity: warning.phase === "upcoming" ? "info" : "warning",
      lead: copy.lead,
      detail: copy.detail,
      actions:
        signIn && signIn.instanceId === status.instanceId ? (
          <ProviderSignInButton view={signIn} label="Sign in again" variant="outline" />
        ) : undefined,
      dismissLabel: "Hide",
      onDismiss: dismiss,
    } satisfies ComposerNotice;
  }, [dismiss, dismissals.keys, signIn, status, warning]);
}
