/**
 * Settings pages' paths, the search params they keep, and where /settings
 * goes. Apart from the menu (settingsNavigation.ts), which names pages from
 * the app guide's catalog: the routes and the connection notices load these
 * at startup, and the catalog waits until Settings opens.
 */

export const DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;
/** Where pairing lives, for surfaces that need to route a user to it. */
export const CONNECTIONS_SETTINGS_SECTION_PATH = "/settings/connections" as const;
export const HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;

export const VISIBLE_SETTINGS_SECTION_PATHS = [
  DEFAULT_SETTINGS_SECTION_PATH,
  "/settings/appearance",
  "/settings/threads",
  "/settings/archived",
  "/settings/providers",
  "/settings/plugins",
  "/settings/instructions",
  "/settings/source-control",
  "/settings/connections",
  "/settings/keybindings",
] as const;

export type SettingsSectionPath = (typeof VISIBLE_SETTINGS_SECTION_PATHS)[number];

export const HOSTED_STATIC_SETTINGS_SECTION_PATHS = [
  HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH,
  "/settings/appearance",
  "/settings/threads",
  "/settings/archived",
  "/settings/providers",
  "/settings/plugins",
  "/settings/instructions",
  "/settings/source-control",
  "/settings/connections",
] as const satisfies ReadonlyArray<SettingsSectionPath>;

export type HostedStaticSettingsSectionPath = (typeof HOSTED_STATIC_SETTINGS_SECTION_PATHS)[number];

/**
 * `?instance=` on the providers page names the card to open on arrival. It is
 * how a surface elsewhere in the app hands a half-finished provider sign-in
 * over to the settings panel, which owns the interactive terminal.
 *
 * `?section=community` brings the Community agents group into view: the
 * list of agents to add sits below every agent already in use.
 */
export interface ProviderSettingsSearch {
  readonly instance?: string;
  readonly section?: "community";
}

export function parseProviderSettingsSearch(
  search: Record<string, unknown>,
): ProviderSettingsSearch {
  const instance = search["instance"];
  return {
    ...(typeof instance === "string" && instance.length > 0 ? { instance } : {}),
    ...(search["section"] === "community" ? { section: "community" as const } : {}),
  };
}

/**
 * `?section=agents` on the connections page brings its Agents group into
 * view, `?section=assistants` its Assistants group: the command palette's
 * "Connect an agent" and "Connect an assistant" open them there.
 */
export interface ConnectionsSettingsSearch {
  readonly section?: "agents" | "assistants";
}

export function parseConnectionsSettingsSearch(
  search: Record<string, unknown>,
): ConnectionsSettingsSearch {
  const section = search["section"];
  return section === "agents" || section === "assistants" ? { section } : {};
}

/**
 * Resolves where the settings `beforeLoad` guard should redirect, or null to
 * render the requested path. Mobile viewports render a full-page section
 * index at `/settings` (drill-in navigation) instead of teleporting to a
 * section; desktop keeps the persistent sidebar nav plus section redirect.
 */
export function resolveSettingsEntryRedirect(input: {
  pathname: string;
  isHostedStatic: boolean;
  isMobileViewport: boolean;
}): SettingsSectionPath | null {
  if (input.pathname === "/settings" || input.pathname === "/settings/") {
    if (input.isMobileViewport) {
      return null;
    }
    return input.isHostedStatic
      ? HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH
      : resolveSettingsEntryPath();
  }
  if (input.isHostedStatic && !isHostedStaticSettingsSectionPath(input.pathname)) {
    return HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH;
  }
  return null;
}

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
