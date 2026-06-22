export const DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;
export const HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;

export const VISIBLE_SETTINGS_SECTION_PATHS = [
  DEFAULT_SETTINGS_SECTION_PATH,
  "/settings/providers",
  "/settings/plugins",
  "/settings/instructions",
  "/settings/source-control",
  "/settings/connections",
  "/settings/keybindings",
  "/settings/archived",
] as const;

export type SettingsSectionPath = (typeof VISIBLE_SETTINGS_SECTION_PATHS)[number];

export const HOSTED_STATIC_SETTINGS_SECTION_PATHS = [
  HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH,
  "/settings/connections",
  "/settings/archived",
] as const satisfies ReadonlyArray<SettingsSectionPath>;

export type HostedStaticSettingsSectionPath = (typeof HOSTED_STATIC_SETTINGS_SECTION_PATHS)[number];

let lastVisibleSettingsSectionPath: SettingsSectionPath | null = null;

export function isVisibleSettingsSectionPath(pathname: string): pathname is SettingsSectionPath {
  return (VISIBLE_SETTINGS_SECTION_PATHS as readonly string[]).includes(pathname);
}

export function isHostedStaticSettingsSectionPath(
  pathname: string,
): pathname is HostedStaticSettingsSectionPath {
  return (HOSTED_STATIC_SETTINGS_SECTION_PATHS as readonly string[]).includes(pathname);
}

export function rememberVisibleSettingsSection(pathname: string) {
  if (isVisibleSettingsSectionPath(pathname)) {
    lastVisibleSettingsSectionPath = pathname;
  }
}

export function resolveSettingsEntryPath(): SettingsSectionPath {
  return lastVisibleSettingsSectionPath ?? DEFAULT_SETTINGS_SECTION_PATH;
}

export function resetRememberedSettingsSectionForTest() {
  lastVisibleSettingsSectionPath = null;
}
