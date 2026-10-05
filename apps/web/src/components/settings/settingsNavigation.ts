import type { ComponentType } from "react";
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
  readonly label: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
  /**
   * Which cluster of the menu it sits in: you and your threads, what agents
   * can use, then this computer's tools. A thin line separates clusters.
   */
  readonly group: "threads" | "agents" | "computer";
  /** One line under the page title (and under the label in the phone index). */
  readonly description: string;
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  {
    label: "General",
    to: "/settings/general",
    icon: Settings2Icon,
    group: "threads",
    description: "How Threadlines looks, how chats show, and this computer.",
  },
  {
    label: "Threads",
    to: "/settings/threads",
    icon: MessagesSquareIcon,
    group: "threads",
    description: "How new threads start, who's in them, and what happens when they're done.",
  },
  {
    label: "Archives",
    to: "/settings/archived",
    icon: ArchiveIcon,
    group: "threads",
    description: "Threads you've put away, and when old ones get archived for you.",
  },
  {
    label: "Providers",
    to: "/settings/providers",
    icon: BotIcon,
    group: "agents",
    description: "The agents you can run, their accounts and their models.",
  },
  // The route stays /settings/plugins: links, panel memory, and the tab search param all key off it.
  {
    label: "Plugins & Skills",
    to: "/settings/plugins",
    icon: PlugIcon,
    group: "agents",
    description: "Plugins, skills and connections your agents can use.",
  },
  {
    label: "Agent Instructions",
    to: "/settings/instructions",
    icon: FileTextIcon,
    group: "agents",
    description: "The instruction files agents read before they start work.",
  },
  {
    label: "Source Control",
    to: "/settings/source-control",
    icon: SourceControlIcon,
    group: "computer",
    description: "How Threadlines works with Git and the sites that host your code.",
  },
  {
    label: "Connections",
    to: CONNECTIONS_SETTINGS_SECTION_PATH,
    icon: SmartphoneIcon,
    group: "computer",
    description: "Use this computer from your phone, or other computers from here.",
  },
  {
    label: "Keybindings",
    to: "/settings/keybindings",
    icon: KeyboardIcon,
    group: "computer",
    description: "Keyboard shortcuts for commands, and when each one applies.",
  },
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
 */
export interface ProviderSettingsSearch {
  readonly instance?: string;
}

export function parseProviderSettingsSearch(
  search: Record<string, unknown>,
): ProviderSettingsSearch {
  const instance = search["instance"];
  return typeof instance === "string" && instance.length > 0 ? { instance } : {};
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
