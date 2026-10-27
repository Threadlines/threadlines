/**
 * The tail every file's right-click menu ends with: open it in the user's
 * editor (named, so it is no mystery which one launches), reveal it in the
 * file manager, copy its path. Chat file chips, the file viewer's tree and
 * tabs, the diff panel and the source control panel all build from here, so a
 * file offers the same things wherever it is right-clicked. Each surface puts
 * its own actions (open in the viewer, stage, close tab) ahead of these.
 */
import type { ContextMenuItem, EditorId, EnvironmentId } from "@threadlines/contracts";

import { useMemo } from "react";

import { readPreferredEditor, usePreferredEditor } from "../editorPreferences";
import {
  readPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../environments/primary/context";
import { readLocalApi } from "../localApi";
import { getServerConfig, useServerAvailableEditors } from "../rpc/serverState";
import { editorLabel } from "./EditorOpenOptions";
import { copyWithNotice } from "./ui/copyWithNotice";
import { failureNotice, toastManager } from "./ui/toast";

export type FileActionId = "open-in-editor" | "reveal" | "copy-path" | "copy-relative-path";

/** A file or folder as the file actions see it. */
export interface FileActionTarget {
  /** Absolute path, without a `:line` suffix: what "Copy path" copies. */
  readonly path: string;
  readonly kind: "file" | "directory";
  /** The path inside the project, or null for one outside it. */
  readonly relativePath: string | null;
  /** The project folder, so an editor shows the file inside its project. */
  readonly workspaceRoot: string | undefined;
  /** Where an editor puts the cursor. */
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

/** What can open a file from here. */
export interface FileActionLaunchers {
  /** The editor "Open in" names. Null when none is installed, or when the
   *  preferred one is the file manager, which the reveal entry covers. */
  readonly editor: EditorId | null;
  readonly canReveal: boolean;
  /** False for a thread on another computer, whose files this one can't open. */
  readonly launchesHere: boolean;
}

const NO_LAUNCHERS: FileActionLaunchers = { editor: null, canReveal: false, launchesHere: false };

/**
 * Editors and the file manager run on the computer hosting the primary
 * server. A thread on another computer names files over there, so it gets
 * neither (the chat header's Open-in menu follows the same rule). A document
 * outside any thread (`environmentId` absent) is this computer's.
 */
function launchesOn(
  environmentId: EnvironmentId | null | undefined,
  primaryEnvironmentId: EnvironmentId | null | undefined,
): boolean {
  return !environmentId || environmentId === primaryEnvironmentId;
}

function launchersFor(
  canLaunch: boolean,
  availableEditors: ReadonlyArray<EditorId>,
  preferredEditor: EditorId | null,
): FileActionLaunchers {
  if (!canLaunch) return NO_LAUNCHERS;
  return {
    editor: preferredEditor === "file-manager" ? null : preferredEditor,
    canReveal: availableEditors.includes("file-manager"),
    launchesHere: true,
  };
}

export function canLaunchFilesFor(environmentId: EnvironmentId | null | undefined): boolean {
  return launchesOn(environmentId, readPrimaryEnvironmentDescriptor()?.environmentId);
}

/** The launchers as they stand, read once when a menu opens. */
export function readFileActionLaunchers(
  environmentId: EnvironmentId | null | undefined,
): FileActionLaunchers {
  const availableEditors = getServerConfig()?.availableEditors ?? [];
  return launchersFor(
    canLaunchFilesFor(environmentId),
    availableEditors,
    readPreferredEditor(availableEditors),
  );
}

/** The launchers, kept current, for something on screen that names them. */
export function useFileActionLaunchers(
  environmentId: EnvironmentId | null | undefined,
): FileActionLaunchers {
  const availableEditors = useServerAvailableEditors();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const canLaunch = launchesOn(environmentId, usePrimaryEnvironmentId());
  return useMemo(
    () => launchersFor(canLaunch, availableEditors, preferredEditor),
    [availableEditors, canLaunch, preferredEditor],
  );
}

/**
 * The menu for a target: `openItems` (the surface's own ways to open it) lead
 * the opening group, then the editor and file manager, then the copy group.
 * Both groups start with a divider, which a menu drops at its top, so a
 * surface with its own groups above (a tab's Close entries) passes none here.
 */
export function fileActionMenuItems<T extends string = never>(
  target: FileActionTarget,
  launchers: FileActionLaunchers,
  openItems: ReadonlyArray<ContextMenuItem<T>> = [],
): ContextMenuItem<T | FileActionId>[] {
  const fileManager = editorLabel("file-manager");
  const openGroup: ContextMenuItem<T | FileActionId>[] = [
    ...openItems,
    ...(launchers.editor
      ? [{ id: "open-in-editor" as const, label: `Open in ${editorLabel(launchers.editor)}` }]
      : []),
    ...(launchers.canReveal
      ? [
          {
            id: "reveal" as const,
            // A folder opens; a file is shown selected in its folder.
            label:
              target.kind === "directory" ? `Open in ${fileManager}` : `Reveal in ${fileManager}`,
          },
        ]
      : []),
  ];
  return [
    ...openGroup.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
    { id: "copy-path", label: "Copy path", separatorBefore: true },
    ...(target.relativePath
      ? [{ id: "copy-relative-path" as const, label: "Copy relative path" }]
      : []),
  ];
}

/**
 * Carries out a file action the menu returned. False when `clicked` is not
 * one of them, so the surface can handle its own entries.
 */
export function runFileAction(
  clicked: string | null,
  target: FileActionTarget,
  launchers: FileActionLaunchers,
): boolean {
  switch (clicked) {
    case "open-in-editor":
      if (launchers.editor) launchFileTarget(target, launchers.editor);
      return true;
    case "reveal":
      launchFileTarget(target, "file-manager");
      return true;
    case "copy-path":
      void copyWithNotice(target.path, "path");
      return true;
    case "copy-relative-path":
      if (target.relativePath) void copyWithNotice(target.relativePath, "relative path");
      return true;
    default:
      return false;
  }
}

function launchFileTarget(target: FileActionTarget, editor: EditorId): void {
  const name = editorLabel(editor);
  const api = readLocalApi();
  if (!api) {
    toastManager.add({ type: "error", title: `Can't open ${name} here` });
    return;
  }
  // Editors take `path:line[:column]`; the file manager only wants the path.
  const position =
    editor !== "file-manager" && target.line !== undefined
      ? `:${target.line}${target.column !== undefined ? `:${target.column}` : ""}`
      : "";
  void api.shell
    .openInEditor(`${target.path}${position}`, editor, target.workspaceRoot)
    .catch((error: unknown) => {
      toastManager.add(
        failureNotice({
          title:
            editor === "file-manager"
              ? `Couldn't show it in ${name}`
              : `Couldn't open it in ${name}`,
          error,
        }),
      );
    });
}
