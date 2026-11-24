import { type FilesystemBrowseEntry } from "@threadlines/contracts";
import { type ReactNode } from "react";

import { type CommandPaletteActionItem, type CommandPaletteGroup } from "../CommandPalette.logic";
import {
  CONNECTIONS_SETTINGS_SECTION_PATH,
  type SettingsSectionPath,
} from "../settings/settingsPaths";

/** What the Add project field asks for while it browses folders. */
export const ADD_PROJECT_PATH_PLACEHOLDER = "Enter path (e.g. ~/projects/my-app)";

export function filterBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseFilterQuery: string;
  highlightedItemValue: string | null;
}): {
  filteredEntries: FilesystemBrowseEntry[];
  highlightedEntry: FilesystemBrowseEntry | null;
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerFilter = input.browseFilterQuery.toLowerCase();
  const showHidden = input.browseFilterQuery.startsWith(".");

  const filteredEntries = input.browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  let highlightedEntry: FilesystemBrowseEntry | null = null;
  if (input.highlightedItemValue?.startsWith("browse:")) {
    const highlightedPath = input.highlightedItemValue.slice("browse:".length);
    highlightedEntry = filteredEntries.find((entry) => entry.fullPath === highlightedPath) ?? null;
  }

  const exactEntry =
    input.browseFilterQuery.length > 0
      ? (filteredEntries.find((entry) => entry.name === input.browseFilterQuery) ?? null)
      : null;

  return { filteredEntries, highlightedEntry, exactEntry };
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void;
  browseTo: (name: string) => void;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

/**
 * Copy for the add-project action when there is no environment to browse.
 *
 * In the hosted browser that state is not a failure, it is the setup step the
 * visitor has not done yet: projects live on the paired computer, so there is
 * nothing to browse until one exists. Say that and point at pairing instead of
 * reporting a bare "no environment" error. A desktop session that somehow has
 * no environment is a real fault, so it keeps the error wording.
 */
export function resolveAddProjectUnavailableGuidance(input: { readonly isHostedStatic: boolean }): {
  readonly type: "error" | "warning";
  readonly title: string;
  readonly description: string;
  readonly action: { readonly label: string; readonly to: SettingsSectionPath } | null;
} {
  if (!input.isHostedStatic) {
    return {
      type: "error",
      title: "Can't browse projects",
      description: "No computer is available.",
      action: null,
    };
  }

  return {
    type: "warning",
    title: "Pair a computer to add projects",
    description:
      "Threadlines browses projects on the computer running the desktop app. Pair one from Connections, then add a project.",
    action: { label: "Open Connections", to: CONNECTIONS_SETTINGS_SECTION_PATH },
  };
}
