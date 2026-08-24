import {
  SourceControlToolUpdateError,
  type SourceControlDiscoveryResult,
  type SourceControlToolUpdateInput,
  type SourceControlToolUpdateTarget,
  type VcsError,
} from "@threadlines/contracts";
import { isCommandAvailable } from "@threadlines/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  gitForWindowsUpdateRecipe,
  selectSourceControlToolPackageManager,
  sourceControlToolLabel,
  sourceControlToolPackageRecipe,
} from "./SourceControlToolPackages.ts";
import { parseGitHubCliVersion, parseGitVersion } from "./SourceControlToolVersionAdvisory.ts";
import { isWinGetUpdateNotApplicable } from "./SourceControlWinGet.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface SourceControlToolMaintenanceShape {
  readonly update: (
    input: SourceControlToolUpdateInput,
  ) => Effect.Effect<SourceControlToolMaintenanceResult, SourceControlToolUpdateError>;
}

export interface SourceControlToolMaintenanceResult {
  readonly status: "completed" | "started";
}

export interface SourceControlToolMaintenanceOptions {
  readonly commandAvailable?: (command: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

export class SourceControlToolMaintenance extends Context.Service<
  SourceControlToolMaintenance,
  SourceControlToolMaintenanceShape
>()("threadlines/source-control/SourceControlToolMaintenance") {}

function updateError(target: SourceControlToolUpdateTarget, reason: string) {
  return new SourceControlToolUpdateError({ target, reason });
}

/** `brew upgrade <formula>` on a tool Homebrew never installed — the binary on
 *  the PATH came from somewhere else — fails with "Error: <formula> not
 *  installed". Discovery normally filters these out before offering an update,
 *  so this classifier only catches the race where the environment changed in
 *  between. */
function isHomebrewFormulaNotInstalled(cause: VcsError): boolean {
  return cause._tag === "VcsProcessExitError" && /Error: \S+ not installed/u.test(cause.detail);
}

function packageManagerFailureReason(input: {
  readonly target: SourceControlToolUpdateTarget;
  readonly operation: "install" | "update";
  readonly manager: "homebrew" | "winget";
  readonly cause: VcsError;
}): string {
  if (
    input.manager === "winget" &&
    input.operation === "update" &&
    isWinGetUpdateNotApplicable(input.cause)
  ) {
    const label = sourceControlToolLabel(input.target);
    return `WinGet does not currently offer a newer compatible ${label} package. Its catalog may still be behind the latest official release; use the official release link or check again later.`;
  }
  if (
    input.manager === "homebrew" &&
    input.operation === "update" &&
    isHomebrewFormulaNotInstalled(input.cause)
  ) {
    const label = sourceControlToolLabel(input.target);
    return `The ${label} on this server was not installed with Homebrew, so \`brew upgrade\` cannot update it. Update it with the tool that installed it, or use the official release link.`;
  }

  const managerLabel = input.manager === "winget" ? "WinGet" : "Homebrew";
  return `The verified ${managerLabel} ${input.operation} failed: ${input.cause.message || "unknown process error"}`;
}

export function currentSourceControlToolVersion(
  discovery: SourceControlDiscoveryResult,
  target: SourceControlToolUpdateTarget,
): string | null {
  const item =
    target === "git"
      ? discovery.versionControlSystems.find((candidate) => candidate.kind === "git")
      : discovery.sourceControlProviders.find((candidate) => {
          switch (target) {
            case "github-cli":
              return candidate.kind === "github";
            case "gitlab-cli":
              return candidate.kind === "gitlab";
            case "azure-cli":
              return candidate.kind === "azure-devops";
          }
        });
  if (!item) return null;
  const rawVersion = Option.getOrNull(item.version);
  const detectedVersion = rawVersion
    ? target === "git"
      ? parseGitVersion(rawVersion)
      : target === "github-cli"
        ? parseGitHubCliVersion(rawVersion)
        : rawVersion
    : null;
  return detectedVersion ?? item.versionAdvisory?.currentVersion ?? null;
}

export function hasVerifiedSourceControlToolUpdateAction(
  discovery: SourceControlDiscoveryResult,
  target: SourceControlToolUpdateTarget,
  operation: NonNullable<SourceControlToolUpdateInput["operation"]> = "update",
): boolean {
  const item =
    target === "git"
      ? discovery.versionControlSystems.find((candidate) => candidate.kind === "git")
      : discovery.sourceControlProviders.find((candidate) => {
          switch (target) {
            case "github-cli":
              return candidate.kind === "github";
            case "gitlab-cli":
              return candidate.kind === "gitlab";
            case "azure-cli":
              return candidate.kind === "azure-devops";
          }
        });
  return (
    item?.versionAdvisory?.actions.some(
      (action) =>
        action.kind === "runUpdate" &&
        action.target === target &&
        (action.operation ?? "update") === operation,
    ) === true
  );
}

export const make = Effect.fn("makeSourceControlToolMaintenance")(function* (
  options?: SourceControlToolMaintenanceOptions,
) {
  const config = yield* ServerConfig;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const platform = options?.platform ?? process.platform;
  const commandAvailable =
    options?.commandAvailable ?? ((command: string) => isCommandAvailable(command, { platform }));
  const updateActive = yield* Ref.make(false);

  const update: SourceControlToolMaintenanceShape["update"] = Effect.fn(
    "SourceControlToolMaintenance.update",
  )(function* (input) {
    const { target } = input;
    const operation = input.operation ?? "update";
    const useGitForWindowsUpdater =
      platform === "win32" && operation === "update" && target === "git";
    if (useGitForWindowsUpdater && !commandAvailable("git")) {
      return yield* updateError(
        target,
        "The official Git for Windows updater is not available on this server.",
      );
    }
    const packageManager = useGitForWindowsUpdater
      ? null
      : selectSourceControlToolPackageManager({ platform, commandAvailable });
    if (!useGitForWindowsUpdater && packageManager === null) {
      return yield* updateError(
        target,
        "No supported package manager is available on this server for one-click source control tool maintenance.",
      );
    }
    const recipe = useGitForWindowsUpdater
      ? gitForWindowsUpdateRecipe()
      : sourceControlToolPackageRecipe({
          manager: packageManager!,
          target,
          operation,
        });
    if (recipe === null) {
      return yield* updateError(
        target,
        `${sourceControlToolLabel(target)} does not have a verified ${packageManager ?? "official"} update recipe yet.`,
      );
    }

    const acquired = yield* Ref.modify(updateActive, (active) => [!active, true] as const);
    if (!acquired) {
      return yield* updateError(target, "Another source control tool update is already running.");
    }

    return yield* Effect.gen(function* () {
      let updaterStarted = false;
      for (const step of recipe.steps) {
        const output = yield* vcsProcess
          .run({
            operation: `source-control.tool.${operation}`,
            command: step.command,
            args: step.args,
            cwd: config.cwd,
            timeoutMs: UPDATE_TIMEOUT_MS,
            maxOutputBytes: UPDATE_OUTPUT_MAX_BYTES,
            appendTruncationMarker: true,
            ...(useGitForWindowsUpdater ? { allowNonZeroExit: true } : {}),
          })
          .pipe(
            Effect.mapError((cause) =>
              useGitForWindowsUpdater
                ? updateError(
                    target,
                    `The official Git for Windows updater failed: ${cause.message || "unknown process error"}`,
                  )
                : updateError(
                    target,
                    packageManagerFailureReason({
                      target,
                      operation,
                      manager: packageManager!,
                      cause,
                    }),
                  ),
            ),
          );

        if (useGitForWindowsUpdater) {
          if (output.exitCode !== 0 && output.exitCode !== 2) {
            const detail = output.stderr.trim() || output.stdout.trim();
            return yield* updateError(
              target,
              `The official Git for Windows updater exited with code ${output.exitCode}${detail ? `: ${detail}` : "."}`,
            );
          }
          updaterStarted ||= output.exitCode === 2;
        }
      }
      return { status: updaterStarted ? "started" : "completed" } as const;
    }).pipe(Effect.ensuring(Ref.set(updateActive, false)));
  });

  return SourceControlToolMaintenance.of({ update });
});

export const layer = Layer.effect(SourceControlToolMaintenance, make());
