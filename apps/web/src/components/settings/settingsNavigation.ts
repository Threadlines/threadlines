import type { ComponentType } from "react";
import { type PlaceId, placeById } from "@threadlines/shared/appPlaces";
import {
  ArchiveIcon,
  BotIcon,
  FileTextIcon,
  KeyboardIcon,
  MessagesSquareIcon,
  PlugIcon,
  Settings2Icon,
  SmartphoneIcon,
} from "lucide-react";

import { SourceControlIcon } from "../Icons";

export const DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;
/** Where pairing lives, for surfaces that need to route a user to it. */
export const CONNECTIONS_SETTINGS_SECTION_PATH = "/settings/connections" as const;
export const HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH = "/settings/general" as const;

export const VISIBLE_SETTINGS_SECTION_PATHS = [
  DEFAULT_SETTINGS_SECTION_PATH,
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
  "/settings/threads",
  "/settings/archived",
  "/settings/providers",
  "/settings/plugins",
  "/settings/instructions",
  "/settings/source-control",
  "/settings/connections",
] as const satisfies ReadonlyArray<SettingsSectionPath>;

export type HostedStaticSettingsSectionPath = (typeof HOSTED_STATIC_SETTINGS_SECTION_PATHS)[number];

export interface SettingsNavItem {
  /** The page place's title (`@threadlines/shared/appPlaces`). */
  readonly label: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
  /**
   * Which cluster of the menu it sits in: you and your threads, what agents
   * can use, then this computer's tools. A thin line separates clusters.
   */
  readonly group: "threads" | "agents" | "computer";
  /**
   * One line under the page title (and under the label in the phone index):
   * the page place's `about`.
   */
  readonly description: string;
}

/** A menu entry for a page place: its label and description are the catalog's. */
function settingsNavItem(
  place: PlaceId,
  item: Omit<SettingsNavItem, "label" | "description">,
): SettingsNavItem {
  const page = placeById(place);
  return { ...item, label: page.title, description: page.about };
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  settingsNavItem("settings.general", {
    to: "/settings/general",
    icon: Settings2Icon,
    group: "threads",
  }),
  settingsNavItem("settings.threads", {
    to: "/settings/threads",
    icon: MessagesSquareIcon,
    group: "threads",
  }),
  settingsNavItem("settings.archived", {
    to: "/settings/archived",
    icon: ArchiveIcon,
    group: "threads",
  }),
  settingsNavItem("settings.providers", {
    to: "/settings/providers",
    icon: BotIcon,
    group: "agents",
  }),
  // The route stays /settings/plugins: links, panel memory, and the tab search param all key off it.
  settingsNavItem("settings.plugins", {
    to: "/settings/plugins",
    icon: PlugIcon,
    group: "agents",
  }),
  settingsNavItem("settings.instructions", {
    to: "/settings/instructions",
    icon: FileTextIcon,
    group: "agents",
  }),
  settingsNavItem("settings.sourceControl", {
    to: "/settings/source-control",
    icon: SourceControlIcon,
    group: "computer",
  }),
  settingsNavItem("settings.connections", {
    to: CONNECTIONS_SETTINGS_SECTION_PATH,
    icon: SmartphoneIcon,
    group: "computer",
  }),
  settingsNavItem("settings.keybindings", {
    to: "/settings/keybindings",
    icon: KeyboardIcon,
    group: "computer",
  }),
];

/** Whether a menu item opens a new cluster, so a line goes above it. */
export function startsSettingsNavGroup(
  items: ReadonlyArray<SettingsNavItem>,
  index: number,
): boolean {
  return index > 0 && items[index - 1]?.group !== items[index]?.group;
}

export const HOSTED_STATIC_SETTINGS_NAV_ITEMS = SETTINGS_NAV_ITEMS.filter((item) =>
  (HOSTED_STATIC_SETTINGS_SECTION_PATHS as readonly string[]).includes(item.to),
);

export function settingsSectionLabelForPath(pathname: string): string | null {
  return settingsNavItemForPath(pathname)?.label ?? null;
}

export function settingsNavItemForPath(pathname: string): SettingsNavItem | null {
  return SETTINGS_NAV_ITEMS.find((item) => item.to === pathname) ?? null;
}

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
 * view: the command palette's "Connect an agent" opens it there.
 */
export interface ConnectionsSettingsSearch {
  readonly section?: "agents";
}

export function parseConnectionsSettingsSearch(
  search: Record<string, unknown>,
): ConnectionsSettingsSearch {
  return search["section"] === "agents" ? { section: "agents" } : {};
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
