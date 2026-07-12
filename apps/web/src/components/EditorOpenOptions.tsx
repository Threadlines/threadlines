/**
 * Shared "open in editor" option list and picker menu content.
 *
 * Every surface that launches an external editor (chat header's Open-in
 * picker, the file viewer's open-in control) renders from this single
 * icon/label mapping and radio-group so the detected editors, the
 * file-manager entry, and the persisted preference read identically
 * everywhere.
 */
import type { EditorId } from "@threadlines/contracts";
import { FolderClosedIcon } from "lucide-react";
import { useMemo } from "react";

import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
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
} from "./Icons";
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
} from "./JetBrainsIcons";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuShortcut } from "./ui/menu";

export interface EditorOpenOption {
  readonly label: string;
  readonly Icon: Icon;
  readonly value: EditorId;
}

const EDITOR_OPTIONS: ReadonlyArray<EditorOpenOption> = [
  { label: "Cursor", Icon: CursorIcon, value: "cursor" },
  { label: "Trae", Icon: TraeIcon, value: "trae" },
  { label: "Kiro", Icon: KiroIcon, value: "kiro" },
  { label: "VS Code", Icon: VisualStudioCode, value: "vscode" },
  { label: "VS Code Insiders", Icon: VisualStudioCodeInsiders, value: "vscode-insiders" },
  { label: "VSCodium", Icon: VSCodium, value: "vscodium" },
  { label: "Zed", Icon: Zed, value: "zed" },
  { label: "Antigravity", Icon: AntigravityIcon, value: "antigravity" },
  { label: "IntelliJ IDEA", Icon: IntelliJIdeaIcon, value: "idea" },
  { label: "Aqua", Icon: AquaIcon, value: "aqua" },
  { label: "CLion", Icon: CLionIcon, value: "clion" },
  { label: "DataGrip", Icon: DataGripIcon, value: "datagrip" },
  { label: "DataSpell", Icon: DataSpellIcon, value: "dataspell" },
  { label: "GoLand", Icon: GoLandIcon, value: "goland" },
  { label: "PhpStorm", Icon: PhpStormIcon, value: "phpstorm" },
  { label: "PyCharm", Icon: PyCharmIcon, value: "pycharm" },
  { label: "Rider", Icon: RiderIcon, value: "rider" },
  { label: "RubyMine", Icon: RubyMineIcon, value: "rubymine" },
  { label: "RustRover", Icon: RustRoverIcon, value: "rustrover" },
  { label: "WebStorm", Icon: WebStormIcon, value: "webstorm" },
];

export function fileManagerLabel(platform: string): string {
  return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
}

/**
 * Action label for an option: the file manager reveals a target rather than
 * opening it in an editor, so its label reads as the action it performs.
 */
export function editorOpenActionLabel(option: EditorOpenOption): string {
  return option.value === "file-manager" ? `Reveal in ${option.label}` : `Open in ${option.label}`;
}

/**
 * The subset of editor options detected on the server, with the platform's
 * file manager appended when available.
 */
export function useEditorOpenOptions(
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<EditorOpenOption> {
  return useMemo(
    () => [
      ...EDITOR_OPTIONS.filter((option) => availableEditors.includes(option.value)),
      ...(availableEditors.includes("file-manager")
        ? [
            {
              label: fileManagerLabel(navigator.platform),
              Icon: FolderClosedIcon,
              value: "file-manager" as const,
            },
          ]
        : []),
    ],
    [availableEditors],
  );
}

/**
 * Radio-group body of an editor picker menu: selecting an option persists it
 * as the preferred editor (it does not launch anything). Render inside a
 * MenuPopup.
 */
export function EditorOpenRadioGroup({
  options,
  preferredEditor,
  onSelect,
  preferredShortcutLabel,
}: {
  options: ReadonlyArray<EditorOpenOption>;
  preferredEditor: EditorId | null;
  onSelect: (editor: EditorId) => void;
  /** Keyboard-shortcut hint shown beside the preferred entry, when bound. */
  preferredShortcutLabel?: string | null;
}) {
  return (
    <>
      {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
      <MenuRadioGroup
        value={preferredEditor}
        onValueChange={(value) => {
          const next = options.find((option) => option.value === value);
          if (next) onSelect(next.value);
        }}
      >
        {options.map(({ label, Icon: OptionIcon, value }) => (
          <MenuRadioItem key={value} value={value} closeOnClick>
            <span className="flex items-center gap-2">
              <OptionIcon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === preferredEditor && preferredShortcutLabel && (
                <MenuShortcut>{preferredShortcutLabel}</MenuShortcut>
              )}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
