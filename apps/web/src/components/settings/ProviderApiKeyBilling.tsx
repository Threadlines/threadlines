/**
 * The per-use opt-in for providers that put an API key ahead of the plan's
 * sign-in (Muse Code): off, the provider refuses to run on a key, so a key
 * saved long ago never bills by surprise. Lives on the Account tab, next to
 * the sign-in it competes with.
 *
 * @module ProviderApiKeyBilling
 */
import type { ProviderInstanceConfig } from "@threadlines/contracts";
import { useState } from "react";

import { readProviderConfigBoolean } from "./ProviderSettingsForm";
import { Switch } from "../ui/switch";

const LABEL = "Allow API key billing";

export function ProviderApiKeyBillingSwitch({
  instance,
  usingApiKey,
  onSave,
}: {
  readonly instance: ProviderInstanceConfig;
  /** The provider reports it is set up with an API key right now. */
  readonly usingApiKey: boolean;
  readonly onSave: (next: ProviderInstanceConfig) => Promise<void>;
}) {
  const saved = readProviderConfigBoolean(instance.config, "allowApiKeyBilling", false);
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? saved;
  const save = async (next: boolean) => {
    setPending(next);
    try {
      const config =
        instance.config !== null && typeof instance.config === "object" ? instance.config : {};
      await onSave({ ...instance, config: { ...config, allowApiKeyBilling: next } });
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{LABEL}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {usingApiKey
            ? "Muse is set up with an API key, which Meta bills per use. Off, Muse won't run on it; sign in with your Meta account to use your plan."
            : "Lets Muse run on an API key, which Meta bills per use. Off, Muse only runs on your Meta account's plan."}
        </span>
      </div>
      <Switch
        checked={checked}
        disabled={pending !== null}
        onCheckedChange={(next) => void save(Boolean(next))}
        aria-label={LABEL}
      />
    </div>
  );
}
