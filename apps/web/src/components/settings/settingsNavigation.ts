/**
 * The Settings menu: each page's entry, named by its place in the app guide's
 * catalog, with its icon and group. Paths, search params and the entry
 * redirect live in settingsPaths.ts, which the routes load at startup
 * without this catalog.
 */
import type { ComponentType } from "react";
import { placeById } from "@threadlines/shared/appPlaces";
import {
  ArchiveIcon,
  BotIcon,
  FileTextIcon,
  KeyboardIcon,
  MessagesSquareIcon,
  PaletteIcon,
  PlugIcon,
  Settings2Icon,
  SmartphoneIcon,
  TabletSmartphoneIcon,
} from "lucide-react";

import { SourceControlIcon } from "../Icons";
import {
  CONNECTIONS_SETTINGS_SECTION_PATH,
  HOSTED_STATIC_SETTINGS_SECTION_PATHS,
  type SettingsSectionPath,
} from "./settingsPaths";
import type { SettingsPagePlaceId } from "./settingsPlaceAvailability";

export interface SettingsNavItem {
  /** The page's place (`@threadlines/shared/appPlaces`). */
  readonly place: SettingsPagePlaceId;
  /** The page place's title. */
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
  place: SettingsPagePlaceId,
  item: Omit<SettingsNavItem, "place" | "label" | "description">,
): SettingsNavItem {
  const page = placeById(place);
  return { ...item, place, label: page.title, description: page.about };
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  settingsNavItem("settings.general", {
    to: "/settings/general",
    icon: Settings2Icon,
    group: "threads",
  }),
  settingsNavItem("settings.appearance", {
    to: "/settings/appearance",
    icon: PaletteIcon,
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
  settingsNavItem("settings.devices", {
    to: "/settings/devices",
    icon: TabletSmartphoneIcon,
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
