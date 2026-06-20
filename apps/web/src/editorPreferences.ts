import { EDITORS, EditorId, LocalApi } from "@threadlines/contracts";
import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "threadlines:last-editor";
const LEGACY_LAST_EDITOR_KEYS = ["t3code:last-editor"] as const;

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId, {
    legacyKeys: LEGACY_LAST_EDITOR_KEYS,
  });

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItemWithLegacyKeys(
    LAST_EDITOR_KEY,
    LEGACY_LAST_EDITOR_KEYS,
    EditorId,
  );
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: LocalApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
