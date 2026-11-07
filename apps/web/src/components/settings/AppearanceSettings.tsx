import {
  ThemeActions,
  ThemeArtStrip,
  ThemeGallery,
  ThemeStatusLines,
} from "../theme/ui/ThemeSettingsRows";
import { SettingsPageContainer, SettingsPageHeader, SettingsSection } from "./settingsLayout";

/**
 * Settings › Appearance: the theme this device wears and how its art shows
 * (docs/design/custom-themes.md). One section: New theme and Import on its
 * title line, Glass and Motion side by side, a line on the art, then the
 * gallery under its filters. Every setting here is this device's own, so a
 * phone draws the same page.
 */
export function AppearanceSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/appearance" />
      <SettingsSection
        place="appearance.themes"
        bare
        headerAction={<ThemeActions />}
        contentClassName="flex flex-col gap-3"
      >
        <ThemeArtStrip />
        <ThemeStatusLines />
        <ThemeGallery />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
