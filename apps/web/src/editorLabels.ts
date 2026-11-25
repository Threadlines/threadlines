import type { EditorId } from "@threadlines/contracts";

import { readPrimaryEnvironmentDescriptor } from "~/environments/primary/context";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";

export const EDITOR_LABELS: Readonly<Record<Exclude<EditorId, "file-manager">, string>> = {
  cursor: "Cursor",
  trae: "Trae",
  kiro: "Kiro",
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  vscodium: "VSCodium",
  zed: "Zed",
  antigravity: "Antigravity",
  idea: "IntelliJ IDEA",
  aqua: "Aqua",
  clion: "CLion",
  datagrip: "DataGrip",
  dataspell: "DataSpell",
  goland: "GoLand",
  phpstorm: "PhpStorm",
  pycharm: "PyCharm",
  rider: "Rider",
  rubymine: "RubyMine",
  rustrover: "RustRover",
  webstorm: "WebStorm",
};

function fileManagerLabel(platform: string): string {
  return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
}

/**
 * The file manager's name on the computer that opens it: the primary
 * server's, which is not this device's when a browser on a Mac is paired with
 * a Windows PC. This device's platform stands in until the server says.
 */
export function hostFileManagerLabel(): string {
  switch (readPrimaryEnvironmentDescriptor()?.platform.os) {
    case "darwin":
      return "Finder";
    case "windows":
      return "Explorer";
    case "linux":
      return "Files";
    default:
      return fileManagerLabel(navigator.platform);
  }
}

/** The name an editor goes by in menus ("Cursor", "Finder"). */
export function editorLabel(editor: EditorId): string {
  if (editor === "file-manager") return hostFileManagerLabel();
  return EDITOR_LABELS[editor] ?? editor;
}
