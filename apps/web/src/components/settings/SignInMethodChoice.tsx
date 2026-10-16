/**
 * The pieces of an agent's sign-in method choice on its Account tab, shared
 * by agents that offer more than one way to sign in (Antigravity, Grok): the
 * list of methods, the field for a method's API key, the Apply and Cancel
 * pair, and the save itself.
 *
 * @module SignInMethodChoice
 */
import type { ProviderInstanceConfig, ProviderInstanceId } from "@threadlines/contracts";
import { LoaderIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useProviderConnectFlow } from "./useProviderConnectFlow";

export interface SignInMethodOption<Id extends string> {
  readonly id: Id;
  readonly name: string;
  readonly description: string;
  /** "plan": a subscription the user pays for already. "perUse": billed per request. */
  readonly billing: "plan" | "perUse";
}

/** One radio row per method; `current` is the saved one, `selected` the one being looked at. */
export function SignInMethodChoice<Id extends string>(props: {
  readonly methods: ReadonlyArray<SignInMethodOption<Id>>;
  readonly selected: Id;
  readonly current: Id;
  readonly onPick: (method: Id) => void;
}) {
  return (
    <div className="grid gap-1">
      <p className="text-xs font-semibold text-foreground">Sign-in method</p>
      <div role="radiogroup" aria-label="Sign-in method" className="grid">
        {props.methods.map((method) => {
          const selected = props.selected === method.id;
          return (
            <button
              key={method.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onPick(method.id)}
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
                  {method.id === props.current ? (
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
  );
}

/**
 * A method's API key: a password field while there is none (or it is being
 * replaced), otherwise "Key saved" with Replace and, when `onRemove` is given,
 * Remove. `children` sits under it (a link to get a key); the line about
 * where keys are kept closes it.
 */
export function SignInKeyField(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Show the field: no key is saved, or the saved one is being replaced. */
  readonly editing: boolean;
  readonly onReplace: () => void;
  readonly onRemove?: (() => void) | undefined;
  readonly busy: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      {props.editing ? (
        <label className="grid gap-1" htmlFor={props.id}>
          <span className="text-xs text-muted-foreground">{props.label}</span>
          <Input
            id={props.id}
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={props.value}
            onChange={(event) => props.onChange(event.currentTarget.value)}
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
            onClick={props.onReplace}
          >
            Replace key
          </Button>
          {props.onRemove ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-xs text-muted-foreground"
              disabled={props.busy}
              onClick={props.onRemove}
            >
              Remove key
            </Button>
          ) : null}
        </div>
      )}
      {props.children}
      <p className="text-xs text-muted-foreground">
        Keys are saved in a private file on the computer that runs Threadlines, never in settings,
        and never shown again.
      </p>
    </div>
  );
}

/**
 * Saving a method choice: stops any sign-in in progress (it belongs to the
 * settings being replaced and must be over before the new ones reach the
 * agent), saves, then starts the method's sign-in or check when `runAfter`
 * asks for it. The server waits for the instance to pick up the save first.
 */
export function useSignInMethodSave(props: {
  readonly instanceId: ProviderInstanceId;
  /** Saves the instance; resolves once the server has stored it. */
  readonly onSave: (next: ProviderInstanceConfig) => Promise<void>;
  /** After a save that landed, before any run starts: clear the drafts. */
  readonly onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useProviderConnectFlow({ instanceId: props.instanceId, flow: "login" });

  const save = async (next: ProviderInstanceConfig, runAfter: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await login.stopAnyRun();
      await props.onSave(next);
      props.onSaved();
      if (runAfter) login.start();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the sign-in method.");
    } finally {
      setSaving(false);
    }
  };

  return { saving, error, clearError: () => setError(null), save };
}

/** Apply and Cancel for a changed method choice, and the save's error. */
export function SignInMethodActions(props: {
  readonly changed: boolean;
  readonly ready: boolean;
  readonly saving: boolean;
  readonly applyLabel: string;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly error: string | null;
}) {
  return (
    <>
      {props.changed ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            disabled={!props.ready || props.saving}
            onClick={props.onApply}
          >
            {props.saving ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
            {props.applyLabel}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={props.saving}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
    </>
  );
}
