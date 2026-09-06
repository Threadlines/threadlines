import type {
  SourceControlToolUpdateOperation,
  SourceControlToolUpdateResult,
} from "@threadlines/contracts";

/**
 * Wording for the outcome of a source control tool update, shared by the
 * launch toast and the Settings advisory so both describe a run the same way.
 * Progress wording while the run is active comes from the server's job state.
 */

export interface SourceControlToolUpdateResultCopy {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
}

export function sourceControlToolUpdateResultCopy(input: {
  readonly label: string;
  readonly result: SourceControlToolUpdateResult;
  /** "WinGet", "Homebrew"; falls back to a generic phrase. */
  readonly managerLabel?: string;
}): SourceControlToolUpdateResultCopy {
  const { label, result } = input;
  switch (result.status) {
    case "succeeded":
      return result.operation === "install"
        ? {
            type: "success",
            title: `${label} installed`,
            description: result.currentVersion
              ? `Installed ${result.currentVersion}`
              : "Installed successfully.",
          }
        : {
            type: "success",
            title: `${label} updated`,
            description: `${result.previousVersion ?? "Previous version"} to ${result.currentVersion ?? "updated"}`,
          };
    case "started":
      return {
        type: "info",
        title: `${label} update started`,
        description:
          "The official installer is running. If it isn't showing, click the flashing shield in the taskbar. Check again once it finishes.",
      };
    case "unchanged":
      return {
        type: "info",
        title: `${label} is unchanged`,
        description: `${input.managerLabel ?? "The update command"} completed, but the detected version did not change.`,
      };
  }
}

export function sourceControlToolUpdateErrorCopy(input: {
  readonly label: string;
  readonly operation: SourceControlToolUpdateOperation | undefined;
  readonly error: unknown;
}): { readonly title: string; readonly description: string } {
  return {
    title: `Could not ${input.operation === "install" ? "install" : "update"} ${input.label}`,
    description:
      input.error instanceof Error ? input.error.message : "The verified update command failed.",
  };
}
