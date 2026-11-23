import { useCommandPaletteStore } from "../commandPaletteStore";
import { useAddProjectStore } from "../components/addProject/addProjectStore";
import { useCodexImportStore } from "../components/codexImport/codexImportStore";

/**
 * Add project or Bring in Codex conversation is open. The palette's own
 * shortcut stands down for these, so it never opens over a clone in progress.
 */
export function isPaletteLaunchedDialogOpen(): boolean {
  return (
    useAddProjectStore.getState().session !== null ||
    useCodexImportStore.getState().session !== null
  );
}

/**
 * A dialog that owns the keyboard is open: the command palette, Add project or
 * Bring in Codex conversation. App-wide shortcut listeners stand down while it
 * is, so a key pressed in the dialog never acts on the page behind it. Read it
 * when the key lands.
 */
export function isKeyboardOwnedByDialog(): boolean {
  return useCommandPaletteStore.getState().open || isPaletteLaunchedDialogOpen();
}
