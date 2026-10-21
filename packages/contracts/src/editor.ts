import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  /**
   * The same command-line tool inside the macOS app, relative to an
   * Applications folder. Found there when the command was never put on PATH,
   * which VS Code leaves as a manual step.
   */
  readonly macAppCommands?: readonly string[];
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    launchStyle: "goto",
    macAppCommands: ["Cursor.app/Contents/Resources/app/bin/cursor"],
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    macAppCommands: ["Visual Studio Code.app/Contents/Resources/app/bin/code"],
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    macAppCommands: [
      "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
      "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
    ],
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    launchStyle: "goto",
    macAppCommands: [
      "VSCodium.app/Contents/Resources/app/bin/codium",
      "VSCodium.app/Contents/Resources/app/bin/code",
    ],
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    macAppCommands: ["Zed.app/Contents/MacOS/cli"],
  },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], launchStyle: "goto" },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], launchStyle: "line-column" },
  { id: "clion", label: "CLion", commands: ["clion"], launchStyle: "line-column" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], launchStyle: "line-column" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], launchStyle: "line-column" },
  { id: "goland", label: "GoLand", commands: ["goland"], launchStyle: "line-column" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], launchStyle: "line-column" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], launchStyle: "line-column" },
  { id: "rider", label: "Rider", commands: ["rider"], launchStyle: "line-column" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], launchStyle: "line-column" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], launchStyle: "line-column" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], launchStyle: "line-column" },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const LaunchEditorInput = Schema.Struct({
  /** What to open: a folder or a file, optionally with `:line[:column]`. */
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
  /**
   * The project folder a file target belongs to. Editors that take a folder
   * and a file together open the file inside this folder, in the window that
   * already shows it when there is one, instead of on its own. Ignored for
   * folder targets and for files outside it.
   */
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

export class ExternalLauncherError extends Schema.TaggedError<ExternalLauncherError>()(
  "ExternalLauncherError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
