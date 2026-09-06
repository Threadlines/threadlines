import type { SourceControlToolUpdateTarget, VcsError } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { winGetPackageId } from "./SourceControlToolPackages.ts";

const VERSION_LOOKUP_TIMEOUT_MS = 15_000;
const VERSION_LOOKUP_OUTPUT_MAX_BYTES = 20_000;
const VERSION_CACHE_TTL_MS = 5 * 60_000;
const VERSION_FAILURE_CACHE_TTL_MS = 60_000;

const WINGET_UPDATE_NOT_APPLICABLE_EXIT_CODES = new Set([0x8a15002b, -1_978_335_189]);

interface CachedVersion {
  readonly expiresAt: number;
  readonly version: string | null;
}

export type LatestWinGetVersionResolver = (
  target: SourceControlToolUpdateTarget,
) => Effect.Effect<string | null>;

export function winGetUpdateArgs(target: SourceControlToolUpdateTarget): ReadonlyArray<string> {
  return [
    "upgrade",
    "--id",
    winGetPackageId(target),
    "--exact",
    "--source",
    "winget",
    "--silent",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--disable-interactivity",
  ];
}

export function winGetShowVersionsArgs(
  target: SourceControlToolUpdateTarget,
): ReadonlyArray<string> {
  return [
    "show",
    "--id",
    winGetPackageId(target),
    "--exact",
    "--source",
    "winget",
    "--versions",
    "--accept-source-agreements",
    "--disable-interactivity",
  ];
}

function normalizeWinGetVersion(target: SourceControlToolUpdateTarget, version: string): string {
  if (target !== "git") return version;

  const gitForWindowsVersion = version.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/u);
  if (!gitForWindowsVersion) return version;
  return `${gitForWindowsVersion[1]}.windows.${gitForWindowsVersion[2] ?? "1"}`;
}

export function parseLatestWinGetVersion(
  target: SourceControlToolUpdateTarget,
  output: string,
): string | null {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const separatorIndex = lines.findIndex((line) => /^-{3,}$/u.test(line));
  if (separatorIndex < 0) return null;

  const version = lines
    .slice(separatorIndex + 1)
    .find((line) => /^v?\d+(?:\.[0-9A-Za-z]+)+(?:[-+][0-9A-Za-z.-]+)?$/u.test(line));
  return version ? normalizeWinGetVersion(target, version.replace(/^v/iu, "")) : null;
}

export function isWinGetUpdateNotApplicable(cause: VcsError): boolean {
  return (
    cause._tag === "VcsProcessExitError" &&
    WINGET_UPDATE_NOT_APPLICABLE_EXIT_CODES.has(cause.exitCode)
  );
}

export function isWinGetInstallCancelled(cause: VcsError): boolean {
  // APPINSTALLER_CLI_ERROR_INSTALL_CANCELLED_BY_USER may be signed by the process bridge.
  return cause._tag === "VcsProcessExitError" && cause.exitCode >>> 0 === 0x8a15010c;
}

export function makeLatestWinGetVersionResolver(input: {
  readonly cwd: string;
  readonly vcsProcess: VcsProcess.VcsProcessShape;
}): LatestWinGetVersionResolver {
  const cache = new Map<SourceControlToolUpdateTarget, CachedVersion>();

  return (target) => {
    const now = Date.now();
    const cached = cache.get(target);
    if (cached && cached.expiresAt > now) {
      return Effect.succeed(cached.version);
    }

    return input.vcsProcess
      .run({
        operation: "source-control.tool.winget-version",
        command: "winget",
        args: winGetShowVersionsArgs(target),
        cwd: input.cwd,
        timeoutMs: VERSION_LOOKUP_TIMEOUT_MS,
        maxOutputBytes: VERSION_LOOKUP_OUTPUT_MAX_BYTES,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.map((result) => parseLatestWinGetVersion(target, result.stdout)),
        Effect.catch(() => Effect.succeed(null)),
        Effect.tap((version) =>
          Effect.sync(() => {
            cache.set(target, {
              expiresAt:
                now + (version === null ? VERSION_FAILURE_CACHE_TTL_MS : VERSION_CACHE_TTL_MS),
              version,
            });
          }),
        ),
      );
  };
}
