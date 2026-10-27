import { EDITORS, EditorId, LocalApi } from "@threadlines/contracts";
import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "threadlines:last-editor";
const LEGACY_LAST_EDITOR_KEYS = ["t3code:last-editor"] as const;

/** The stored choice while it is still installed, else the first installed editor. */
function pickPreferredEditor(
  stored: EditorId | null,
  availableEditors: ReadonlyArray<EditorId>,
): EditorId | null {
  if (stored && availableEditors.includes(stored)) return stored;
  return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
}

function readStoredEditor(): EditorId | null {
  return getLocalStorageItemWithLegacyKeys(LAST_EDITOR_KEY, LEGACY_LAST_EDITOR_KEYS, EditorId);
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId, {
    legacyKeys: LEGACY_LAST_EDITOR_KEYS,
  });

  const effectiveEditor = useMemo(
    () => pickPreferredEditor(lastEditor, availableEditors),
    [lastEditor, availableEditors],
  );

  return [effectiveEditor, setLastEditor] as const;
}

/**
 * The editor {@link openInPreferredEditor} would launch, for a menu that names
 * it before the user picks it. Unlike that, it never saves a fallback choice
 * (reading still moves a pre-rename stored choice to the current key).
 */
export function readPreferredEditor(availableEditors: ReadonlyArray<EditorId>): EditorId | null {
  return pickPreferredEditor(readStoredEditor(), availableEditors);
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const stored = readStoredEditor();
  const editor = pickPreferredEditor(stored, availableEditors);
  if (editor && editor !== stored) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor;
}

/**
 * Opens a path in the user's editor. Give the project folder for a file that
 * belongs to one, so the editor shows the file inside that project rather
 * than on its own.
 */
export async function openInPreferredEditor(
  api: LocalApi,
  targetPath: string,
  workspaceRoot?: string,
): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor, workspaceRoot);
  return editor;
}
