import type { ProviderDriverKind } from "@threadlines/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export type SuggestionDriverKind = "claudeAgent" | "codex" | "antigravity";

type SuggestionSettingKey = "claudeSuggestions" | "codexSuggestions" | "antigravitySuggestions";

type SuggestionPlaceId =
  | "providers.claudeSuggestions"
  | "providers.codexSuggestions"
  | "providers.antigravitySuggestions";

interface ProviderSuggestionConfig {
  readonly settingKey: SuggestionSettingKey;
  readonly place: SuggestionPlaceId;
  readonly label: string;
  readonly providerName: string;
  readonly description: string;
}

const PROVIDER_SUGGESTION_CONFIG: Record<SuggestionDriverKind, ProviderSuggestionConfig> = {
  claudeAgent: {
    settingKey: "claudeSuggestions",
    place: "providers.claudeSuggestions",
    label: "Claude suggestions",
    providerName: "Claude",
    description:
      "After a reply to your message, Claude suggests what you might send next (the gray text you can take with Tab). Stays on until a usage limit is reached.",
  },
  codex: {
    settingKey: "codexSuggestions",
    place: "providers.codexSuggestions",
    label: "Codex suggestions",
    providerName: "Codex",
    description:
      "After a reply to your message, Codex suggests what you might send next (the gray text you can take with Tab). Each one is a short Codex answer, paused when a usage limit is reached.",
  },
  antigravity: {
    settingKey: "antigravitySuggestions",
    place: "providers.antigravitySuggestions",
    label: "Antigravity suggestions",
    providerName: "Antigravity",
    description:
      "After a reply to your message, Antigravity suggests what you might send next (the gray text you can take with Tab) using a fast Gemini model. Paused when that model's quota is reached.",
  },
};

export const SUGGESTION_PLACE_DRIVER: Readonly<Record<SuggestionPlaceId, SuggestionDriverKind>> = {
  "providers.claudeSuggestions": "claudeAgent",
  "providers.codexSuggestions": "codex",
  "providers.antigravitySuggestions": "antigravity",
};

export function isSuggestionDriverKind(
  driver: ProviderDriverKind | string | null | undefined,
): driver is SuggestionDriverKind {
  return driver === "claudeAgent" || driver === "codex" || driver === "antigravity";
}

function ProviderSuggestionsRow({ driverKind }: { readonly driverKind: SuggestionDriverKind }) {
  const config = PROVIDER_SUGGESTION_CONFIG[driverKind];
  const on = useSettings((settings) => settings[config.settingKey]);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place={config.place}
      description={config.description}
      resetAction={
        on ? null : (
          <SettingResetButton
            label={config.label}
            onClick={() => updateSettings({ [config.settingKey]: true })}
          />
        )
      }
      control={
        <Switch
          checked={on}
          onCheckedChange={(checked) => updateSettings({ [config.settingKey]: Boolean(checked) })}
          aria-label={config.label}
        />
      }
    />
  );
}

/** Live settings-search row for Claude next-message suggestions. */
export function ClaudeSuggestionsRow() {
  return <ProviderSuggestionsRow driverKind="claudeAgent" />;
}

/** Live settings-search row for Codex next-message suggestions. */
export function CodexSuggestionsRow() {
  return <ProviderSuggestionsRow driverKind="codex" />;
}

/** Live settings-search row for Antigravity next-message suggestions. */
export function AntigravitySuggestionsRow() {
  return <ProviderSuggestionsRow driverKind="antigravity" />;
}

/**
 * Next-message suggestions toggle drawn at the top of a provider's
 * Configuration tab on Settings › Providers. Shared across accounts of the
 * same provider; notes that scope when more than one account exists.
 */
export function ProviderConfigurationSuggestionsSection({
  driverKind,
  sharedAcrossAccounts = false,
  includePlaceAnchor = true,
}: {
  readonly driverKind: SuggestionDriverKind;
  readonly sharedAcrossAccounts?: boolean;
  readonly includePlaceAnchor?: boolean;
}) {
  const config = PROVIDER_SUGGESTION_CONFIG[driverKind];
  const on = useSettings((settings) => settings[config.settingKey]);
  const { updateSettings } = useUpdateSettings();
  const description = sharedAcrossAccounts
    ? `${config.description} Applies to all ${config.providerName} accounts.`
    : config.description;

  return (
    <section className="px-3.5 py-3.5" data-place={includePlaceAnchor ? config.place : undefined}>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-[13px] font-medium text-foreground">Suggestions</h4>
          <p className="text-[12.5px] text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {on ? null : (
            <SettingResetButton
              label={config.label}
              onClick={() => updateSettings({ [config.settingKey]: true })}
            />
          )}
          <Switch
            checked={on}
            onCheckedChange={(checked) => updateSettings({ [config.settingKey]: Boolean(checked) })}
            aria-label={config.label}
          />
        </div>
      </div>
    </section>
  );
}
