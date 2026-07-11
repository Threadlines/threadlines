import type { ComponentType } from "react";
import {
  ArchiveIcon,
  BotIcon,
  FileTextIcon,
  KeyboardIcon,
  PlugIcon,
  Settings2Icon,
  SmartphoneIcon,
} from "lucide-react";

import { SourceControlIcon } from "../Icons";

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

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Plugins", to: "/settings/plugins", icon: PlugIcon },
  { label: "Agent Instructions", to: "/settings/instructions", icon: FileTextIcon },
  { label: "Source Control", to: "/settings/source-control", icon: SourceControlIcon },
  { label: "Devices", to: "/settings/connections", icon: SmartphoneIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Archives", to: "/settings/archived", icon: ArchiveIcon },
];

export const HOSTED_STATIC_SETTINGS_NAV_ITEMS = SETTINGS_NAV_ITEMS.filter((item) =>
  (HOSTED_STATIC_SETTINGS_SECTION_PATHS as readonly string[]).includes(item.to),
);

export function settingsSectionLabelForPath(pathname: string): string | null {
  return SETTINGS_NAV_ITEMS.find((item) => item.to === pathname)?.label ?? null;
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
