import type { EditorId, ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { ChevronDownIcon, CopyIcon } from "lucide-react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  EditorOpenRadioGroup,
  editorOpenActionLabel,
  useEditorOpenOptions,
} from "../EditorOpenOptions";
import { readLocalApi } from "~/localApi";

/**
 * The project crumb in the chat header, and everything that acts on the
 * project folder behind it: open it in an installed editor or reveal it in the
 * file manager, copy its path, and pick the default editor the open-favorite
 * shortcut launches. Owns that shortcut, so it stays mounted wherever a crumb
 * could be, including the phone layout that hides the crumb itself.
 */
export const ProjectCrumbMenu = memo(function ProjectCrumbMenu({
  projectName,
  cwd,
  canOpenInEditor,
  keybindings,
  availableEditors,
}: {
  projectName: string;
  /** The folder the thread works in: its worktree when it has one. */
  cwd: string;
  /** Editors run on the machine hosting the server, so only the primary
   *  environment can launch them; elsewhere the menu only copies the path. */
  canOpenInEditor: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useEditorOpenOptions(availableEditors);
  const openFavoriteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const openIn = useCallback(
    (editor: EditorId) => {
      const api = readLocalApi();
      if (!api) return;
      void api.shell.openInEditor(cwd, editor);
    },
    [cwd],
  );

  useEffect(() => {
    if (!canOpenInEditor) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!preferredEditor || !readLocalApi()) return;
      event.preventDefault();
      openIn(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canOpenInEditor, keybindings, openIn, preferredEditor]);

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="-ms-1 inline-flex min-w-0 max-w-48 items-center gap-0.5 rounded-md px-1 py-0.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
            aria-label={`${projectName}, project options`}
            title={projectName}
          />
        }
      >
        <span className="truncate">{projectName}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        {canOpenInEditor ? (
          options.length === 0 ? (
            <MenuItem disabled>No installed editors found</MenuItem>
          ) : (
            options.map((option) => (
              <MenuItem key={option.value} onClick={() => openIn(option.value)}>
                <option.Icon aria-hidden="true" className="text-muted-foreground" />
                {editorOpenActionLabel(option)}
                {option.value === preferredEditor && openFavoriteShortcutLabel ? (
                  <MenuShortcut>{openFavoriteShortcutLabel}</MenuShortcut>
                ) : null}
              </MenuItem>
            ))
          )
        ) : null}
        <MenuItem onClick={() => copyToClipboard(cwd, { path: cwd })}>
          <CopyIcon aria-hidden="true" className="text-muted-foreground" />
          Copy path
        </MenuItem>
        {canOpenInEditor && options.length > 0 ? (
          <>
            <MenuSeparator />
            {/* Picking here only changes what the shortcut opens; it launches
                nothing. */}
            <MenuSub>
              <MenuSubTrigger>
                {openFavoriteShortcutLabel
                  ? `Default for ${openFavoriteShortcutLabel}`
                  : "Default editor"}
              </MenuSubTrigger>
              <MenuSubPopup>
                <EditorOpenRadioGroup
                  options={options}
                  preferredEditor={preferredEditor}
                  onSelect={setPreferredEditor}
                />
              </MenuSubPopup>
            </MenuSub>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
