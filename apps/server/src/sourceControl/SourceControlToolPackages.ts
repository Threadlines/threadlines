import * as path from "node:path";

import type {
  SourceControlToolUpdateOperation,
  SourceControlToolUpdateTarget,
} from "@threadlines/contracts";

export type SourceControlToolPackageManager = "homebrew" | "winget";

export interface SourceControlToolPackageStep {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface SourceControlToolUpdateRecipe {
  readonly steps: ReadonlyArray<SourceControlToolPackageStep>;
  readonly copyCommand: string;
  readonly copyLabel: string;
}

export interface SourceControlToolPackageRecipe {
  readonly manager: SourceControlToolPackageManager;
  readonly steps: ReadonlyArray<SourceControlToolPackageStep>;
  readonly copyCommand: string;
  readonly copyLabel: string;
}

const TOOL_LABELS = {
  "azure-cli": "Azure CLI",
  git: "Git",
  "github-cli": "GitHub CLI",
  "gitlab-cli": "GitLab CLI",
} as const satisfies Record<SourceControlToolUpdateTarget, string>;

const HOMEBREW_FORMULAE = {
  "azure-cli": "azure-cli",
  git: "git",
  "github-cli": "gh",
  "gitlab-cli": "glab",
} as const satisfies Record<SourceControlToolUpdateTarget, string>;

const WINGET_PACKAGE_IDS = {
  "azure-cli": "Microsoft.AzureCLI",
  git: "Git.Git",
  "github-cli": "GitHub.cli",
  "gitlab-cli": "GLab.GLab",
} as const satisfies Record<SourceControlToolUpdateTarget, string>;

export const TOOL_RELEASE_URLS = {
  "azure-cli": "https://learn.microsoft.com/cli/azure/install-azure-cli",
  git: "https://git-scm.com/downloads",
  "github-cli": "https://cli.github.com/",
  "gitlab-cli": "https://gitlab.com/gitlab-org/cli#installation",
} as const satisfies Record<SourceControlToolUpdateTarget, string>;

export function sourceControlToolLabel(target: SourceControlToolUpdateTarget): string {
  return TOOL_LABELS[target];
}

export function winGetPackageId(target: SourceControlToolUpdateTarget): string {
  return WINGET_PACKAGE_IDS[target];
}

/** Git for Windows ships its own architecture-aware updater. It follows the
 *  official release directly, so it remains useful while WinGet's catalog is
 *  still catching up. Exit code 2 means the updater launched the installer. */
export function gitForWindowsUpdateRecipe(): SourceControlToolUpdateRecipe {
  const step = {
    command: "git",
    args: ["update-git-for-windows", "--yes"],
  } as const;
  return {
    steps: [step],
    copyCommand: commandLine(step),
    copyLabel: "Copy Git for Windows update command",
  };
}

/**
 * Whether an executable on the PATH is actually a Homebrew keg. `brew upgrade`
 * only works on formulae Homebrew itself installed; a tool that merely shares
 * the PATH (Apple's `/usr/bin/git`, a `gh` from its own installer under
 * `~/.local`) makes it fail with "Error: <formula> not installed". Homebrew
 * links every keg's binaries out of `<prefix>/Cellar`, and the prefix is where
 * the `brew` command itself lives (`<prefix>/bin/brew`), so the check is: does
 * the executable's real path (symlinks resolved) live under that Cellar.
 */
export function isHomebrewCellarExecutable(input: {
  readonly executableRealPath: string | null;
  readonly brewCommandPath: string | null;
}): boolean {
  if (!input.executableRealPath || !input.brewCommandPath) return false;
  const brewPrefix = path.posix.dirname(path.posix.dirname(input.brewCommandPath));
  const cellar = path.posix.join(brewPrefix, "Cellar") + path.posix.sep;
  return input.executableRealPath.startsWith(cellar);
}

export function selectSourceControlToolPackageManager(input: {
  readonly platform: NodeJS.Platform;
  readonly commandAvailable: (command: string) => boolean;
}): SourceControlToolPackageManager | null {
  if (input.platform === "win32" && input.commandAvailable("winget")) return "winget";
  if (
    (input.platform === "darwin" || input.platform === "linux") &&
    input.commandAvailable("brew")
  ) {
    return "homebrew";
  }
  return null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function commandLine(step: SourceControlToolPackageStep): string {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

function azureDevOpsExtensionStep(): SourceControlToolPackageStep {
  return {
    command: "az",
    args: ["extension", "add", "--name", "azure-devops"],
  };
}

export function sourceControlToolPackageRecipe(input: {
  readonly manager: SourceControlToolPackageManager;
  readonly target: SourceControlToolUpdateTarget;
  readonly operation: SourceControlToolUpdateOperation;
}): SourceControlToolPackageRecipe | null {
  if (input.operation === "update" && input.target !== "git" && input.target !== "github-cli") {
    return null;
  }

  const primaryStep: SourceControlToolPackageStep =
    input.manager === "winget"
      ? {
          command: "winget",
          args: [
            input.operation === "install" ? "install" : "upgrade",
            "--id",
            WINGET_PACKAGE_IDS[input.target],
            "--exact",
            "--source",
            "winget",
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
          ],
        }
      : {
          command: "brew",
          args: [
            input.operation === "install" ? "install" : "upgrade",
            HOMEBREW_FORMULAE[input.target],
          ],
        };
  const steps =
    input.operation === "install" && input.target === "azure-cli"
      ? [primaryStep, azureDevOpsExtensionStep()]
      : [primaryStep];

  return {
    manager: input.manager,
    steps,
    copyCommand: steps.map(commandLine).join(" && "),
    copyLabel: input.manager === "winget" ? "Copy WinGet command" : "Copy Homebrew command",
  };
}
