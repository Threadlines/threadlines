import { EditorId, type ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { EditorOpenRadioGroup, useEditorOpenOptions } from "../EditorOpenOptions";
import { readLocalApi } from "~/localApi";

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useEditorOpenOptions(availableEditors);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openPreferredEditor = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openInCwd || !preferredEditor) return;
    void api.shell.openInEditor(openInCwd, preferredEditor);
  }, [preferredEditor, openInCwd]);

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readLocalApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Open project in editor">
      <Button
        size="icon-xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd}
        onClick={openPreferredEditor}
        aria-label={primaryOption ? `Open in ${primaryOption.label}` : "Open in editor"}
        tooltip={primaryOption ? `Open in ${primaryOption.label}` : "Open in editor"}
      >
        {primaryOption ? (
          <primaryOption.Icon aria-hidden="true" className="size-3.5" />
        ) : (
          <FolderClosedIcon aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Open project options" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EditorOpenRadioGroup
            options={options}
            preferredEditor={preferredEditor}
            onSelect={setPreferredEditor}
            preferredShortcutLabel={openFavoriteEditorShortcutLabel}
          />
        </MenuPopup>
      </Menu>
    </Group>
  );
});
