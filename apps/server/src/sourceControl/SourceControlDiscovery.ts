import { realpathSync } from "node:fs";

import {
  type SourceControlDiscoveryResult,
  type SourceControlProviderDiscoveryItem,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@threadlines/contracts";
import { isCommandAvailable, resolveCommandPath } from "@threadlines/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import {
  isHomebrewCellarExecutable,
  selectSourceControlToolPackageManager,
} from "./SourceControlToolPackages.ts";
import * as SourceControlToolVersionAdvisory from "./SourceControlToolVersionAdvisory.ts";
import * as SourceControlWinGet from "./SourceControlWinGet.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable?: string;
  readonly versionArgs?: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
};

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable?: string;
  readonly implemented: boolean;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  {
    kind: "jj",
    label: "Jujutsu",
    executable: "jj",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  },
];

export interface SourceControlDiscoveryShape {
  readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
}

export interface SourceControlDiscoveryOptions {
  readonly commandAvailable?: SourceControlProviderDiscovery.CommandAvailability;
  readonly latestVersionResolver?: SourceControlToolVersionAdvisory.LatestVersionResolver;
  readonly winGetVersionResolver?: SourceControlWinGet.LatestWinGetVersionResolver;
  readonly platform?: NodeJS.Platform;
  /** Test seam for the "is this executable a Homebrew keg" check, which
   *  otherwise reads the real filesystem. */
  readonly homebrewManagedExecutable?: (executable: string) => boolean;
}

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  SourceControlDiscoveryShape
>()("threadlines/source-control/SourceControlDiscovery") {}

function missingProbeResult<Kind extends string>(
  input: DiscoveryProbe & { readonly kind: Kind },
  options?: {
    readonly executable?: string;
    readonly detail?: Option.Option<string>;
  },
): DiscoveryProbeResult<Kind> {
  return {
    kind: input.kind,
    label: input.label,
    ...(options?.executable ? { executable: options.executable } : {}),
    implemented: input.implemented,
    status: "missing" as const,
    version: Option.none<string>(),
    installHint: input.installHint,
    detail: options?.detail ?? Option.some(input.installHint),
  } satisfies DiscoveryProbeResult<Kind>;
}

export const make = Effect.fn("makeSourceControlDiscovery")(function* (
  options?: SourceControlDiscoveryOptions,
) {
  const config = yield* ServerConfig;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const platform = options?.platform ?? process.platform;
  const commandAvailable =
    options?.commandAvailable ?? ((command) => isCommandAvailable(command, { platform }));
  const latestVersionResolver =
    options?.latestVersionResolver ?? (() => Effect.succeed<string | null>(null));
  const packageManager = () =>
    selectSourceControlToolPackageManager({ platform, commandAvailable });
  const homebrewManagedExecutable =
    options?.homebrewManagedExecutable ??
    ((executable: string): boolean => {
      const executablePath = resolveCommandPath(executable, { platform });
      let executableRealPath = executablePath;
      if (executablePath !== null) {
        try {
          executableRealPath = realpathSync(executablePath);
        } catch {
          executableRealPath = executablePath;
        }
      }
      return isHomebrewCellarExecutable({
        executableRealPath,
        brewCommandPath: resolveCommandPath("brew", { platform }),
      });
    });
  // Git for Windows has its own official updater, so it does not have to wait
  // for WinGet. Other Windows tools still use WinGet. `brew upgrade` only works
  // on kegs Homebrew itself installed, so the tool in use must resolve
  // into the Cellar — Apple's `/usr/bin/git` or a `gh` from its own installer
  // would make it fail with "Error: <formula> not installed".
  const canRunToolUpdateFor = (
    item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
  ): boolean => {
    if (platform === "win32" && item.status === "available" && item.kind === "git") return true;
    const manager = packageManager();
    if (manager === "winget") return true;
    if (manager !== "homebrew") return false;
    return item.executable !== undefined && homebrewManagedExecutable(item.executable);
  };

  const probe = <Kind extends VcsDriverKind>(
    input: DiscoveryProbe & { readonly kind: Kind },
  ): Effect.Effect<DiscoveryProbeResult<Kind>> => {
    const executable = input.executable;
    const versionArgs = input.versionArgs;

    if (!executable || !versionArgs) {
      return Effect.succeed(missingProbeResult(input));
    }

    if (!commandAvailable(executable)) {
      return Effect.succeed(
        missingProbeResult(input, {
          executable,
          detail: Option.some(`${executable} was not found on the server PATH.`),
        }),
      );
    }

    return vcsProcess
      .run({
        operation: "source-control.discovery.probe",
        command: executable,
        args: versionArgs,
        cwd: config.cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.map(
          (result) =>
            ({
              kind: input.kind,
              label: input.label,
              executable,
              implemented: input.implemented,
              status: "available" as const,
              version: Option.orElse(
                SourceControlProviderDiscovery.firstNonEmptyLine(result.stdout),
                () => SourceControlProviderDiscovery.firstNonEmptyLine(result.stderr),
              ),
              installHint: input.installHint,
              detail: Option.none<string>(),
            }) satisfies DiscoveryProbeResult<Kind>,
        ),
        Effect.catch((cause) =>
          Effect.succeed(
            missingProbeResult(input, {
              executable,
              detail: SourceControlProviderDiscovery.detailFromCause(cause),
            }),
          ),
        ),
      );
  };

  const withVersionAdvisory = <Item extends VcsDiscoveryItem | SourceControlProviderDiscoveryItem>(
    item: Item,
  ): Effect.Effect<Item> => {
    const sourceControlToolPackageManager = packageManager();
    return SourceControlToolVersionAdvisory.withSourceControlToolVersionAdvisory({
      item,
      platform,
      latestVersionResolver,
      ...(options?.winGetVersionResolver
        ? { winGetVersionResolver: options.winGetVersionResolver }
        : {}),
      canRunUpdate: canRunToolUpdateFor(item),
      packageManager: sourceControlToolPackageManager,
      canRunInstall:
        sourceControlToolPackageManager !== null &&
        item.status !== "available" &&
        item.executable !== undefined &&
        !commandAvailable(item.executable),
    });
  };

  return SourceControlDiscovery.of({
    discover: Effect.suspend(() =>
      Effect.all({
        versionControlSystems: Effect.all(
          VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap((items) =>
            Effect.forEach(items, withVersionAdvisory, {
              concurrency: "unbounded",
            }),
          ),
        ),
        sourceControlProviders: sourceControlProviders.discover.pipe(
          Effect.flatMap((items) =>
            Effect.forEach(items, withVersionAdvisory, {
              concurrency: "unbounded",
            }),
          ),
        ),
      }),
    ),
  });
});

export const layer = Layer.effect(
  SourceControlDiscovery,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const config = yield* ServerConfig;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    return yield* make({
      latestVersionResolver: (target) =>
        SourceControlToolVersionAdvisory.resolveLatestToolVersion(target).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      winGetVersionResolver: SourceControlWinGet.makeLatestWinGetVersionResolver({
        cwd: config.cwd,
        vcsProcess,
      }),
    });
  }),
);
