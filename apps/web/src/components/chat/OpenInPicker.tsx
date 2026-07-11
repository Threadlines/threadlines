import { EditorId, type ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

type PickableEditorId = Exclude<EditorId, "file-manager">;

const EDITOR_OPTIONS: ReadonlyArray<{ label: string; Icon: Icon; value: PickableEditorId }> = [
  {
    label: "Cursor",
    Icon: CursorIcon,
    value: "cursor",
  },
  {
    label: "Trae",
    Icon: TraeIcon,
    value: "trae",
  },
  {
    label: "Kiro",
    Icon: KiroIcon,
    value: "kiro",
  },
  {
    label: "VS Code",
    Icon: VisualStudioCode,
    value: "vscode",
  },
  {
    label: "VS Code Insiders",
    Icon: VisualStudioCodeInsiders,
    value: "vscode-insiders",
  },
  {
    label: "VSCodium",
    Icon: VSCodium,
    value: "vscodium",
  },
  {
    label: "Zed",
    Icon: Zed,
    value: "zed",
  },
  {
    label: "Antigravity",
    Icon: AntigravityIcon,
    value: "antigravity",
  },
  {
    label: "IntelliJ IDEA",
    Icon: IntelliJIdeaIcon,
    value: "idea",
  },
  {
    label: "Aqua",
    Icon: AquaIcon,
    value: "aqua",
  },
  {
    label: "CLion",
    Icon: CLionIcon,
    value: "clion",
  },
  {
    label: "DataGrip",
    Icon: DataGripIcon,
    value: "datagrip",
  },
  {
    label: "DataSpell",
    Icon: DataSpellIcon,
    value: "dataspell",
  },
  {
    label: "GoLand",
    Icon: GoLandIcon,
    value: "goland",
  },
  {
    label: "PhpStorm",
    Icon: PhpStormIcon,
    value: "phpstorm",
  },
  {
    label: "PyCharm",
    Icon: PyCharmIcon,
    value: "pycharm",
  },
  {
    label: "Rider",
    Icon: RiderIcon,
    value: "rider",
  },
  {
    label: "RubyMine",
    Icon: RubyMineIcon,
    value: "rubymine",
  },
  {
    label: "RustRover",
    Icon: RustRoverIcon,
    value: "rustrover",
  },
  {
    label: "WebStorm",
    Icon: WebStormIcon,
    value: "webstorm",
  },
];

function fileManagerLabel(platform: string): string {
  return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
}

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const availableEditorIds = useMemo(
    () => availableEditors.filter((editorId) => editorId !== "file-manager"),
    [availableEditors],
  );
  const fileManagerAvailable = availableEditors.includes("file-manager");
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditorIds);
  const options = useMemo(
    () => EDITOR_OPTIONS.filter((option) => availableEditorIds.includes(option.value)),
    [availableEditorIds],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openPreferredEditor = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openInCwd || !preferredEditor) return;
    void api.shell.openInEditor(openInCwd, preferredEditor);
  }, [preferredEditor, openInCwd]);

  const openFileManager = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openInCwd) return;
    void api.shell.openInEditor(openInCwd, "file-manager");
  }, [openInCwd]);

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
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          <MenuRadioGroup
            value={preferredEditor}
            onValueChange={(value) => {
              const next = options.find((option) => option.value === value);
              if (next) setPreferredEditor(next.value);
            }}
          >
            {options.map(({ label, Icon, value }) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                <span className="flex items-center gap-2">
                  <Icon aria-hidden="true" className="text-muted-foreground" />
                  {label}
                  {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                    <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                  )}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {fileManagerAvailable && (
            <>
              <MenuSeparator />
              <MenuItem disabled={!openInCwd} onClick={openFileManager}>
                <FolderClosedIcon aria-hidden="true" className="text-muted-foreground" />
                Open in {fileManagerLabel(navigator.platform)}
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
