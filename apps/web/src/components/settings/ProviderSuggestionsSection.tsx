import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { ShownPlace } from "./settingsPlaceAvailability";

/**
 * Claude skips suggesting the user's next message while the user is on track
 * to run out of usage early; on keeps the suggestions coming. For every Claude
 * account, read before each message, so running threads follow it from their
 * next message.
 */
export function ClaudeSuggestionsRow() {
  const on = useSettings((settings) => settings.claudeSuggestionsWhenUsageRunsFast);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="providers.claudeSuggestions"
      description="Claude stops suggesting your next message (the gray text you can take with Tab) when you're on track to run out of usage early. Turn this on to keep them. Each one uses a little usage."
      resetAction={
        on ? (
          <SettingResetButton
            label="Keep Claude's suggestions when you're using a lot"
            onClick={() => updateSettings({ claudeSuggestionsWhenUsageRunsFast: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={on}
          onCheckedChange={(checked) =>
            updateSettings({ claudeSuggestionsWhenUsageRunsFast: Boolean(checked) })
          }
          aria-label="Keep Claude's suggestions when you're using a lot"
        />
      }
    />
  );
}

/**
 * Codex suggests the user's next message after replying to them: one extra
 * answer from the thread's cached context each time. Read by the thread's
 * computer before each suggestion; off also hides Codex suggestions already
 * made.
 */
export function CodexSuggestionsRow() {
  const on = useSettings((settings) => settings.codexSuggestions);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="providers.codexSuggestions"
      description="After a reply to your message, Codex suggests what you might send next (the gray text you can take with Tab). Each one uses a little Codex usage, and none come while a usage limit is 90% used."
      resetAction={
        on ? null : (
          <SettingResetButton
            label="Codex suggestions"
            onClick={() => updateSettings({ codexSuggestions: true })}
          />
        )
      }
      control={
        <Switch
          checked={on}
          onCheckedChange={(checked) => updateSettings({ codexSuggestions: Boolean(checked) })}
          aria-label="Codex suggestions"
        />
      }
    />
  );
}

/**
 * Antigravity suggests the user's next message after replying to them: one
 * short isolated answer on a fast Gemini model (preferring Hydrogen, then
 * Flash, at low thinking). Read before each suggestion; off also hides
 * Antigravity suggestions already made.
 */
export function AntigravitySuggestionsRow() {
  const on = useSettings((settings) => settings.antigravitySuggestions);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="providers.antigravitySuggestions"
      description="After a reply to your message, Antigravity suggests your next message (taken with Tab) using a fast Gemini model. Stops while that model's quota is 90% used."
      resetAction={
        on ? null : (
          <SettingResetButton
            label="Antigravity suggestions"
            onClick={() => updateSettings({ antigravitySuggestions: true })}
          />
        )
      }
      control={
        <Switch
          checked={on}
          onCheckedChange={(checked) =>
            updateSettings({ antigravitySuggestions: Boolean(checked) })
          }
          aria-label="Antigravity suggestions"
        />
      }
    />
  );
}

/**
 * Per-provider next-message suggestion toggles on Settings › Providers,
 * showing only providers the user currently has turned on.
 */
export function ProviderSuggestionsSection() {
  return (
    <ShownPlace place="providers.suggestions">
      <SettingsSection place="providers.suggestions">
        <ShownPlace place="providers.claudeSuggestions">
          <ClaudeSuggestionsRow />
        </ShownPlace>
        <ShownPlace place="providers.codexSuggestions">
          <CodexSuggestionsRow />
        </ShownPlace>
        <ShownPlace place="providers.antigravitySuggestions">
          <AntigravitySuggestionsRow />
        </ShownPlace>
      </SettingsSection>
    </ShownPlace>
  );
}
