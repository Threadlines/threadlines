import {
  SourceControlToolUpdateError,
  type SourceControlDiscoveryResult,
  type SourceControlToolUpdateInput,
  type SourceControlToolUpdateTarget,
} from "@threadlines/contracts";
import { isCommandAvailable } from "@threadlines/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseGitHubCliVersion, parseGitVersion } from "./SourceControlToolVersionAdvisory.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

const WINGET_PACKAGE_IDS = {
  "github-cli": "GitHub.cli",
  git: "Git.Git",
} as const satisfies Record<SourceControlToolUpdateTarget, string>;

const WINGET_UPDATE_SUFFIX = [
  "--exact",
  "--source",
  "winget",
  "--silent",
  "--accept-source-agreements",
  "--accept-package-agreements",
  "--disable-interactivity",
] as const;

export interface SourceControlToolMaintenanceShape {
  readonly update: (
    input: SourceControlToolUpdateInput,
  ) => Effect.Effect<void, SourceControlToolUpdateError>;
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

export function currentSourceControlToolVersion(
  discovery: SourceControlDiscoveryResult,
  target: SourceControlToolUpdateTarget,
): string | null {
  const item =
    target === "git"
      ? discovery.versionControlSystems.find((candidate) => candidate.kind === "git")
      : discovery.sourceControlProviders.find((candidate) => candidate.kind === "github");
  if (!item) return null;
  const rawVersion = Option.getOrNull(item.version);
  const detectedVersion = rawVersion
    ? target === "git"
      ? parseGitVersion(rawVersion)
      : parseGitHubCliVersion(rawVersion)
    : null;
  return detectedVersion ?? item.versionAdvisory?.currentVersion ?? null;
}

export function hasVerifiedSourceControlToolUpdateAction(
  discovery: SourceControlDiscoveryResult,
  target: SourceControlToolUpdateTarget,
): boolean {
  const item =
    target === "git"
      ? discovery.versionControlSystems.find((candidate) => candidate.kind === "git")
      : discovery.sourceControlProviders.find((candidate) => candidate.kind === "github");
  return (
    item?.versionAdvisory?.actions.some(
      (action) => action.kind === "runUpdate" && action.target === target,
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
    if (platform !== "win32") {
      return yield* updateError(
        target,
        "One-click source control updates are currently available only for verified WinGet installations on Windows.",
      );
    }
    if (!commandAvailable("winget")) {
      return yield* updateError(
        target,
        "WinGet is not available on this server, so Threadlines cannot run a verified update command.",
      );
    }

    const acquired = yield* Ref.modify(updateActive, (active) => [!active, true] as const);
    if (!acquired) {
      return yield* updateError(target, "Another source control tool update is already running.");
    }

    return yield* Effect.gen(function* () {
      const packageId = WINGET_PACKAGE_IDS[target];

      yield* vcsProcess
        .run({
          operation: "source-control.tool.update",
          command: "winget",
          args: ["upgrade", "--id", packageId, ...WINGET_UPDATE_SUFFIX],
          cwd: config.cwd,
          timeoutMs: UPDATE_TIMEOUT_MS,
          maxOutputBytes: UPDATE_OUTPUT_MAX_BYTES,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.mapError((cause) =>
            updateError(
              target,
              `The verified WinGet update failed: ${cause.message || "unknown process error"}`,
            ),
          ),
        );
    }).pipe(Effect.ensuring(Ref.set(updateActive, false)));
  });

  return SourceControlToolMaintenance.of({ update });
});

export const layer = Layer.effect(SourceControlToolMaintenance, make());
