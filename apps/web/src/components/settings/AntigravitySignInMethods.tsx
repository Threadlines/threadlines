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
import { LoaderIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
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
import { useProviderConnectFlow } from "./useProviderConnectFlow";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useProviderConnectFlow({ instanceId: props.instanceId, flow: "login" });

  const info = antigravityAuthMethodInfo(draft.method);
  const switching = draft.method !== setup.method;
  const keySaved = antigravityKeySaved(props.instance, draft.method);
  const showKeyInput = info.keyEnvName !== null && (!keySaved || replacingKey);
  const changed = antigravityDraftChanged(setup, draft);
  const ready = antigravityDraftReady(props.instance, draft);

  const pick = (method: AntigravityAuthMethod) => {
    setDraft(antigravityDraftFor(setup, method));
    setReplacingKey(false);
    setError(null);
  };

  const save = async (next: ProviderInstanceConfig, runAfter: boolean) => {
    setSaving(true);
    setError(null);
    try {
      // A sign-in still running belongs to the settings being replaced; it
      // must be over before the new settings reach the profile.
      await login.stopAnyRun();
      await props.onSave(next);
      setReplacingKey(false);
      setDraft((current) => ({ ...current, key: "" }));
      // The server waits for the instance to pick up the save before it runs.
      if (runAfter) login.start();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the sign-in method.");
    } finally {
      setSaving(false);
    }
  };

  const fieldId = (name: string) => `${props.idPrefix}-antigravity-${name}`;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="text-xs font-semibold text-foreground">Sign-in method</p>
        <div role="radiogroup" aria-label="Sign-in method" className="grid">
          {ANTIGRAVITY_AUTH_METHODS.map((method) => {
            const selected = draft.method === method.id;
            return (
              <button
                key={method.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pick(method.id)}
                className={cn(
                  "flex min-w-0 items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted/40",
                  selected && "bg-muted/50",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-3 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary" : "border-border",
                  )}
                >
                  {selected ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="font-medium text-foreground">{method.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {method.billing === "perUse" ? "Per use" : "Plan"}
                    </span>
                    {method.id === setup.method ? (
                      <span className="text-[10px] text-success-foreground">Current</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{method.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

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
        <div className="grid gap-1.5">
          {showKeyInput ? (
            <label className="grid gap-1" htmlFor={fieldId("key")}>
              <span className="text-xs text-muted-foreground">
                {draft.method === "gemini-api-key" ? "Gemini API key" : "Vertex AI key (optional)"}
              </span>
              <Input
                id={fieldId("key")}
                size="sm"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.key}
                onChange={(event) => setDraft({ ...draft, key: event.currentTarget.value })}
              />
            </label>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Key saved.</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                onClick={() => setReplacingKey(true)}
              >
                Replace key
              </Button>
              {!switching ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  disabled={saving}
                  onClick={() =>
                    void save(removeAntigravityKey(props.instance, draft.method), false)
                  }
                >
                  Remove key
                </Button>
              ) : null}
            </div>
          )}
          {draft.method === "gemini-api-key" ? (
            <button
              type="button"
              className="w-fit text-xs text-primary-readable hover:text-foreground"
              onClick={() => void ensureLocalApi().shell.openExternal(GEMINI_API_KEY_PAGE)}
            >
              Get a key in Google AI Studio
            </button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Keys are saved in a private file on the computer that runs Threadlines, never in
            settings, and never shown again.
          </p>
        </div>
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

      {changed ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            disabled={!ready || saving}
            onClick={() =>
              void save(
                applyAntigravityDraft(props.instance, draft),
                antigravityRunsAfterSave(setup, draft),
              )
            }
          >
            {saving ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
            {antigravityApplyLabel(setup, draft)}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={saving}
            onClick={() => pick(setup.method)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
