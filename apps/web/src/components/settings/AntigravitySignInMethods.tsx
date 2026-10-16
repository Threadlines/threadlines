import type {
  AntigravityAuthMethod,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@threadlines/contracts";
import {
  ANTIGRAVITY_AUTH_METHODS,
  antigravityAuthMethodInfo,
  GEMINI_API_KEY_PAGE,
  readAntigravitySignInSetup,
} from "@threadlines/shared/antigravitySignIn";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Input } from "../ui/input";
import {
  antigravityApplyLabel,
  antigravityDraftChanged,
  antigravityDraftFor,
  antigravityDraftReady,
  antigravityKeySaved,
  antigravityRunsAfterSave,
  type AntigravityMethodDraft,
  applyAntigravityDraft,
  removeAntigravityKey,
} from "./antigravitySignIn.logic";
import {
  SignInKeyField,
  SignInMethodActions,
  SignInMethodChoice,
  useSignInMethodSave,
} from "./SignInMethodChoice";

const LOCATION_PLACEHOLDER: Partial<Record<AntigravityAuthMethod, string>> = {
  "oauth-business": "global",
  "agent-platform": "us-central1",
};

/**
 * Antigravity's sign-in method, on its Account tab: Google account, Gemini
 * Enterprise, Gemini API key or Vertex AI. Picking another method shows its
 * fields and a Switch button; the current one keeps its own fields and key
 * actions. Saving stops any sign-in in progress, then starts the method's
 * sign-in or check once the server has the new settings.
 */
export function AntigravitySignInMethods(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly idPrefix: string;
  /** Saves the instance; resolves once the server has stored it. */
  readonly onSave: (next: ProviderInstanceConfig) => Promise<void>;
}) {
  const setup = readAntigravitySignInSetup(props.instance);
  const [draft, setDraft] = useState<AntigravityMethodDraft>(() =>
    antigravityDraftFor(setup, setup.method),
  );
  const [replacingKey, setReplacingKey] = useState(false);
  const { saving, error, clearError, save } = useSignInMethodSave({
    instanceId: props.instanceId,
    onSave: props.onSave,
    onSaved: () => {
      setReplacingKey(false);
      setDraft((current) => ({ ...current, key: "" }));
    },
  });

  const info = antigravityAuthMethodInfo(draft.method);
  const switching = draft.method !== setup.method;
  const keySaved = antigravityKeySaved(props.instance, draft.method);
  const showKeyInput = info.keyEnvName !== null && (!keySaved || replacingKey);
  const changed = antigravityDraftChanged(setup, draft);
  const ready = antigravityDraftReady(props.instance, draft);

  const pick = (method: AntigravityAuthMethod) => {
    setDraft(antigravityDraftFor(setup, method));
    setReplacingKey(false);
    clearError();
  };

  const fieldId = (name: string) => `${props.idPrefix}-antigravity-${name}`;

  return (
    <div className="grid gap-3">
      <SignInMethodChoice
        methods={ANTIGRAVITY_AUTH_METHODS}
        selected={draft.method}
        current={setup.method}
        onPick={pick}
      />

      {info.project !== "none" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1" htmlFor={fieldId("project")}>
            <span className="text-xs text-muted-foreground">
              Google Cloud project{info.project === "withoutKey" ? " (without a key)" : ""}
            </span>
            <Input
              id={fieldId("project")}
              size="sm"
              value={draft.project}
              placeholder="my-project"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, project: event.currentTarget.value })}
            />
          </label>
          <label className="grid gap-1" htmlFor={fieldId("location")}>
            <span className="text-xs text-muted-foreground">Location</span>
            <Input
              id={fieldId("location")}
              size="sm"
              value={draft.location}
              placeholder={LOCATION_PLACEHOLDER[draft.method]}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, location: event.currentTarget.value })}
            />
          </label>
        </div>
      ) : null}

      {info.keyEnvName !== null ? (
        <SignInKeyField
          id={fieldId("key")}
          label={draft.method === "gemini-api-key" ? "Gemini API key" : "Vertex AI key (optional)"}
          value={draft.key}
          onChange={(key) => setDraft({ ...draft, key })}
          editing={showKeyInput}
          onReplace={() => setReplacingKey(true)}
          onRemove={
            switching
              ? undefined
              : () => void save(removeAntigravityKey(props.instance, draft.method), false)
          }
          busy={saving}
        >
          {draft.method === "gemini-api-key" ? (
            <button
              type="button"
              className="w-fit text-xs text-primary-readable hover:text-foreground"
              onClick={() => void ensureLocalApi().shell.openExternal(GEMINI_API_KEY_PAGE)}
            >
              Get a key in Google AI Studio
            </button>
          ) : null}
        </SignInKeyField>
      ) : null}

      {draft.method === "agent-platform" ? (
        <p className="text-xs text-muted-foreground">
          Without a key, Vertex AI uses the Google Cloud sign-in on the computer that runs
          Threadlines (<code className="font-mono">gcloud auth application-default login</code>).
        </p>
      ) : null}
      {info.billing === "perUse" ? (
        <p className="text-xs text-muted-foreground">
          Google bills each request to you. These requests don't show on the Usage page.
        </p>
      ) : null}

      <SignInMethodActions
        changed={changed}
        ready={ready}
        saving={saving}
        applyLabel={antigravityApplyLabel(setup, draft)}
        onApply={() =>
          void save(
            applyAntigravityDraft(props.instance, draft),
            antigravityRunsAfterSave(setup, draft),
          )
        }
        onCancel={() => pick(setup.method)}
        error={error}
      />
    </div>
  );
}
