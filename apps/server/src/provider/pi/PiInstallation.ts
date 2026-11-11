/**
 * PiInstallation — which Pi Threadlines runs, and how to start it.
 *
 * The user's own `pi` comes first when it is 1.3.0 or newer. With the
 * default setting (`pi`), Threadlines' own copy (`PiRuntime`) stands in when
 * there is no usable `pi`; a path or another name in the setting means that
 * program and nothing else.
 *
 * @module provider/pi/PiInstallation
 */
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { planCliSpawn } from "../../cliSpawn.ts";
import {
  type CliStartFailure,
  cliStartFailureFrom,
  isCommandMissingCause,
  spawnAndCollect,
  withStartFailureReason,
} from "../providerSnapshot.ts";
import {
  findUserPi,
  isDefaultPiCommand,
  isSupportedPiVersion,
  MINIMUM_PI_VERSION,
  parsePiVersion,
  piCommandSetting,
} from "./PiBinary.ts";
import { type PiLaunch, PiLaunchUnavailable } from "./PiLaunch.ts";
import type { PiManagedRuntime } from "./PiRuntime.ts";

const VERSION_TIMEOUT = Duration.seconds(10);

export type PiInstallation =
  /** The user's own Pi, new enough to run. */
  | { readonly kind: "user"; readonly command: string; readonly version: string }
  /** Threadlines' own copy. */
  | { readonly kind: "managed"; readonly version: string }
  /** The user's Pi is there but can't run here: too old, or its version unreadable. */
  | {
      readonly kind: "unusable";
      readonly command: string;
      readonly version: string | null;
      readonly message: string;
      /** Set when it cannot start at all, so a reinstall is the fix. */
      readonly startFailure?: CliStartFailure;
    }
  /** No Pi at all. */
  | { readonly kind: "missing"; readonly message: string };

type PiVersionRead =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "missing" }
  /** `startFailure` when Pi itself would not start, rather than answering oddly or late. */
  | {
      readonly kind: "failed";
      readonly detail: string;
      readonly startFailure: CliStartFailure | null;
    };

/** `pi --version`: the version, or why there is none. */
const readVersion = (
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<PiVersionRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const plan = planCliSpawn(command, ["--version"], env);
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(
        plan.command,
        [...plan.args],
        hideWindowsConsole({ env, cwd, ...plan.options }),
      ),
    ).pipe(Effect.timeoutOption(VERSION_TIMEOUT), Effect.result);
    if (result._tag === "Failure") {
      return isCommandMissingCause(result.failure)
        ? { kind: "missing" }
        : { kind: "failed", detail: result.failure.message, startFailure: null };
    }
    if (Option.isNone(result.success)) {
      return {
        kind: "failed",
        detail: "it did not answer `--version` in time",
        startFailure: null,
      };
    }
    const output = result.success.value;
    const version = parsePiVersion(`${output.stdout}\n${output.stderr}`);
    if (output.code === 0 && version) {
      return { kind: "version", version };
    }
    // The exit code decides: a crash's stack trace can end in a line that
    // reads like a version (`Node.js v22.23.4`).
    return {
      kind: "failed",
      detail: `\`${command} --version\` printed no version`,
      startFailure: cliStartFailureFrom(output),
    };
  });

const MISSING_MESSAGE = "Pi is not installed. Install it to use it in Threadlines.";
const NO_MANAGED_MESSAGE =
  "Pi is not installed. Install it from pi.dev (Threadlines can't install it on this computer), then check again.";

/** Looks for the user's Pi, then Threadlines' copy. Never fails. */
export const findPiInstallation = (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Undefined where Threadlines can't install Pi (no Node.js for this computer). */
  readonly managed: PiManagedRuntime | undefined;
}): Effect.Effect<PiInstallation, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const setting = piCommandSetting(input.binaryPath);
    const standIn = isDefaultPiCommand(input.binaryPath) ? input.managed : undefined;
    const managedVersion = standIn ? yield* standIn.installed : undefined;
    const managed = managedVersion
      ? ({ kind: "managed", version: managedVersion } as const)
      : undefined;

    const command = findUserPi(input.binaryPath, input.environment);
    const read = command
      ? yield* readVersion(command, input.environment, input.cwd)
      : ({ kind: "missing" } satisfies PiVersionRead);
    if (read.kind === "version" && isSupportedPiVersion(read.version)) {
      return { kind: "user", command: command!, version: read.version };
    }
    if (managed) return managed;
    if (read.kind === "missing") {
      return {
        kind: "missing",
        message: /[\\/]/u.test(setting)
          ? `Pi was not found at ${setting}.`
          : !isDefaultPiCommand(input.binaryPath)
            ? `\`${setting}\` was not found.`
            : input.managed
              ? MISSING_MESSAGE
              : NO_MANAGED_MESSAGE,
      };
    }
    if (read.kind === "version") {
      return {
        kind: "unusable",
        command: command!,
        version: read.version,
        message: `Pi ${read.version} is too old for Threadlines. Update it to ${MINIMUM_PI_VERSION} or newer.`,
      };
    }
    const startFailure = read.kind === "failed" ? read.startFailure : null;
    return {
      kind: "unusable",
      command: command!,
      version: null,
      message: startFailure
        ? withStartFailureReason("Pi is installed but cannot start.", startFailure)
        : `Could not run Pi (${command}): ${read.detail}.`,
      ...(startFailure ? { startFailure } : {}),
    };
  });

/** How to start the Pi an installation names, holding Threadlines' copy for the caller's scope. */
export function piLaunchFor(
  installation: PiInstallation,
  managed: PiManagedRuntime | undefined,
): PiLaunch {
  switch (installation.kind) {
    case "user":
      return Effect.succeed({ command: installation.command, prefixArgs: [] });
    case "managed":
      return managed
        ? managed.acquire.pipe(
            Effect.map(({ launcher }) => launcher),
            Effect.mapError((error) => new PiLaunchUnavailable({ message: error.message })),
          )
        : Effect.fail(new PiLaunchUnavailable({ message: MISSING_MESSAGE }));
    case "unusable":
    case "missing":
      return Effect.fail(new PiLaunchUnavailable({ message: installation.message }));
  }
}
