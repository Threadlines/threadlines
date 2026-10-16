import type {
  GrokAuthMethod,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@threadlines/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  applyGrokDraft,
  GROK_AUTH_METHODS,
  grokApplyLabel,
  grokDraftChanged,
  grokDraftReady,
  type GrokMethodDraft,
  grokRunsAfterSave,
  readGrokSignInSetup,
  removeGrokKey,
  XAI_API_KEY_PAGE,
} from "./grokSignIn.logic";
import {
  SignInKeyField,
  SignInMethodActions,
  SignInMethodChoice,
  useSignInMethodSave,
} from "./SignInMethodChoice";

/**
 * Grok's sign-in method, on its Account tab: a Grok subscription (xAI's own
 * sign-in) or an xAI API key. Picking the key shows its field. Saving stops
 * any sign-in in progress; a saved key is checked right away, and a switch
 * back to the subscription keeps its saved sign-in.
 */
export function GrokSignInMethods(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly idPrefix: string;
  /** Saves the instance; resolves once the server has stored it. */
  readonly onSave: (next: ProviderInstanceConfig) => Promise<void>;
}) {
  const setup = readGrokSignInSetup(props.instance);
  const [draft, setDraft] = useState<GrokMethodDraft>(() => ({ method: setup.method, key: "" }));
  const [replacingKey, setReplacingKey] = useState(false);
  const { saving, error, clearError, save } = useSignInMethodSave({
    instanceId: props.instanceId,
    onSave: props.onSave,
    onSaved: () => {
      setReplacingKey(false);
      setDraft((current) => ({ ...current, key: "" }));
    },
  });

  const pick = (method: GrokAuthMethod) => {
    setDraft({ method, key: "" });
    setReplacingKey(false);
    clearError();
  };

  return (
    <div className="grid gap-3">
      <SignInMethodChoice
        methods={GROK_AUTH_METHODS}
        selected={draft.method}
        current={setup.method}
        onPick={pick}
      />

      {draft.method === "api-key" ? (
        <SignInKeyField
          id={`${props.idPrefix}-grok-key`}
          label="xAI API key"
          value={draft.key}
          onChange={(key) => setDraft({ ...draft, key })}
          editing={!setup.hasKey || replacingKey}
          onReplace={() => setReplacingKey(true)}
          onRemove={
            draft.method === setup.method
              ? () => void save(removeGrokKey(props.instance), false)
              : undefined
          }
          busy={saving}
        >
          <button
            type="button"
            className="w-fit text-xs text-primary-readable hover:text-foreground"
            onClick={() => void ensureLocalApi().shell.openExternal(XAI_API_KEY_PAGE)}
          >
            Get a key in the xAI console
          </button>
        </SignInKeyField>
      ) : null}

      <SignInMethodActions
        changed={grokDraftChanged(setup, draft)}
        ready={grokDraftReady(setup, draft)}
        saving={saving}
        applyLabel={grokApplyLabel(setup, draft)}
        onApply={() => void save(applyGrokDraft(props.instance, draft), grokRunsAfterSave(draft))}
        onCancel={() => pick(setup.method)}
        error={error}
      />
    </div>
  );
}
