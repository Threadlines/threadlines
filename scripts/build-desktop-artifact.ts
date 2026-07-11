#!/usr/bin/env node

import { stringify as stringifyYamlValue } from "yaml";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import rootPackageJson from "../package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import {
  MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME,
  MAC_ADAPTIVE_ICON_NAME,
  buildMacAdaptiveIconSync,
} from "./lib/mac-adaptive-icon.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { DESKTOP_RELEASE_APP_ID } from "@threadlines/shared/desktopIdentity";
import { fromYaml } from "@threadlines/shared/schemaYaml";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly macDarkIconPng: string;
  readonly macLightIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return getDefaultBuildArch(platform, process.arch, process.env, config);
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  replay?: (chunk: string) => void,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => {
        replay?.(chunk);
        return acc + chunk;
      },
    ),
  );

function resolveWorkspaceVpBinary(repoRoot: string, path: Path.Path): string {
  return path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vp.cmd" : "vp",
  );
}

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout, (chunk) => {
        process.stdout.write(chunk);
      }),
      collectStreamAsString(child.stderr, (chunk) => {
        process.stderr.write(chunk);
      }),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 1,
      }),
    ),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && (yield* fs.exists(configured))) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if (yield* fs.exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  for (const command of ["python", "python3"]) {
    const probe = yield* spawnAndCollectOutput(
      ChildProcess.make(command, ["-c", "import sys;print(sys.executable)"]),
    ).pipe(
      Effect.catch(() =>
        Effect.succeed({
          stdout: "",
          stderr: "",
          exitCode: 1,
        }),
      ),
    );

    if (probe.exitCode !== 0) {
      continue;
    }

    const executable = probe.stdout.trim();
    if (executable && (yield* fs.exists(executable))) {
      return executable;
    }
  }

  return undefined;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly threadlinesCommitHash: string;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly packageManager: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
}

interface StagePackageJsonInput {
  readonly appVersion: string;
  readonly commitHash: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly electronVersion: string;
  readonly overrides: Record<string, unknown>;
}

interface EnvAlias<A> {
  readonly threadlines: Option.Option<A>;
  readonly badcode: Option.Option<A>;
  readonly legacyT3Code: Option.Option<A>;
}

const desktopEnvAlias = <A>(
  threadlinesConfig: Config.Config<A>,
  badcodeConfig: Config.Config<A>,
  legacyT3CodeConfig: Config.Config<A>,
): Config.Config<EnvAlias<A>> =>
  Config.all({
    threadlines: threadlinesConfig.pipe(Config.option),
    badcode: badcodeConfig.pipe(Config.option),
    legacyT3Code: legacyT3CodeConfig.pipe(Config.option),
  });

const resolveEnvAlias = <A>(alias: EnvAlias<A>): Option.Option<A> =>
  alias.threadlines.pipe(
    Option.orElse(() => alias.badcode),
    Option.orElse(() => alias.legacyT3Code),
  );

const resolveEnvAliasWithDefault = <A>(alias: EnvAlias<A>, defaultValue: A): A =>
  Option.getOrElse(resolveEnvAlias(alias), () => defaultValue);

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: desktopEnvAlias(
    Config.schema(BuildPlatform, "THREADLINES_DESKTOP_PLATFORM"),
    Config.schema(BuildPlatform, "BADCODE_DESKTOP_PLATFORM"),
    Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM"),
  ),
  target: desktopEnvAlias(
    Config.string("THREADLINES_DESKTOP_TARGET"),
    Config.string("BADCODE_DESKTOP_TARGET"),
    Config.string("T3CODE_DESKTOP_TARGET"),
  ),
  arch: desktopEnvAlias(
    Config.schema(BuildArch, "THREADLINES_DESKTOP_ARCH"),
    Config.schema(BuildArch, "BADCODE_DESKTOP_ARCH"),
    Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH"),
  ),
  version: desktopEnvAlias(
    Config.string("THREADLINES_DESKTOP_VERSION"),
    Config.string("BADCODE_DESKTOP_VERSION"),
    Config.string("T3CODE_DESKTOP_VERSION"),
  ),
  outputDir: desktopEnvAlias(
    Config.string("THREADLINES_DESKTOP_OUTPUT_DIR"),
    Config.string("BADCODE_DESKTOP_OUTPUT_DIR"),
    Config.string("T3CODE_DESKTOP_OUTPUT_DIR"),
  ),
  skipBuild: desktopEnvAlias(
    Config.boolean("THREADLINES_DESKTOP_SKIP_BUILD"),
    Config.boolean("BADCODE_DESKTOP_SKIP_BUILD"),
    Config.boolean("T3CODE_DESKTOP_SKIP_BUILD"),
  ),
  keepStage: desktopEnvAlias(
    Config.boolean("THREADLINES_DESKTOP_KEEP_STAGE"),
    Config.boolean("BADCODE_DESKTOP_KEEP_STAGE"),
    Config.boolean("T3CODE_DESKTOP_KEEP_STAGE"),
  ),
  signed: desktopEnvAlias(
    Config.boolean("THREADLINES_DESKTOP_SIGNED"),
    Config.boolean("BADCODE_DESKTOP_SIGNED"),
    Config.boolean("T3CODE_DESKTOP_SIGNED"),
  ),
  verbose: desktopEnvAlias(
    Config.boolean("THREADLINES_DESKTOP_VERBOSE"),
    Config.boolean("BADCODE_DESKTOP_VERBOSE"),
    Config.boolean("T3CODE_DESKTOP_VERBOSE"),
  ),
  mockUpdates: desktopEnvAlias(
    Config.boolean("THREADLINES_DESKTOP_MOCK_UPDATES"),
    Config.boolean("BADCODE_DESKTOP_MOCK_UPDATES"),
    Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  ),
  mockUpdateServerPort: desktopEnvAlias(
    Config.string("THREADLINES_DESKTOP_MOCK_UPDATE_SERVER_PORT"),
    Config.string("BADCODE_DESKTOP_MOCK_UPDATE_SERVER_PORT"),
    Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT"),
  ),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;

  const platform = mergeOptions(
    input.platform,
    resolveEnvAlias(env.platform),
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(
    input.target,
    resolveEnvAlias(env.target),
    PLATFORM_CONFIG[platform].defaultTarget,
  );
  const arch = mergeOptions(input.arch, resolveEnvAlias(env.arch), getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, resolveEnvAlias(env.version), undefined);
  const releaseDir = resolveBooleanFlag(
    input.mockUpdates,
    resolveEnvAliasWithDefault(env.mockUpdates, false),
  )
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, resolveEnvAlias(env.outputDir), releaseDir),
  );

  const skipBuild = resolveBooleanFlag(
    input.skipBuild,
    resolveEnvAliasWithDefault(env.skipBuild, false),
  );
  const keepStage = resolveBooleanFlag(
    input.keepStage,
    resolveEnvAliasWithDefault(env.keepStage, false),
  );
  const signed = resolveBooleanFlag(input.signed, resolveEnvAliasWithDefault(env.signed, false));
  const verbose = resolveBooleanFlag(input.verbose, resolveEnvAliasWithDefault(env.verbose, false));

  const mockUpdates = resolveBooleanFlag(
    input.mockUpdates,
    resolveEnvAliasWithDefault(env.mockUpdates, false),
  );
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (yield* resolveMockUpdateServerPort(
      Option.getOrUndefined(resolveEnvAlias(env.mockUpdateServerPort)),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message: "Invalid mock update server port.",
            cause,
          }),
      ),
    ));

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (_verbose: boolean) =>
  ({
    stdout: "pipe",
    stderr: "pipe",
  }) as const;

const MAX_COMMAND_OUTPUT_CHARS = 20_000;

function formatCommand(command: ChildProcess.Command): string {
  if (command._tag === "StandardCommand") {
    return [command.command, ...command.args].join(" ");
  }

  return "<piped command>";
}

function formatCommandOutput(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }

  const omittedChars = trimmed.length - MAX_COMMAND_OUTPUT_CHARS;
  const visibleOutput =
    omittedChars > 0
      ? `[truncated ${omittedChars} chars]\n${trimmed.slice(-MAX_COMMAND_OUTPUT_CHARS)}`
      : trimmed;

  return `${label}:\n${visibleOutput}`;
}

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    const capturedOutput = [
      formatCommandOutput("stdout", stdout),
      formatCommandOutput("stderr", stderr),
    ]
      .filter((section) => section !== undefined)
      .join("\n\n");
    const suffix = capturedOutput ? `\n\n${capturedOutput}` : "";

    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode}): ${formatCommand(command)}${suffix}`,
    });
  }
});

const MAC_ICON_CANVAS_SIZE = 1024;
const MAC_ICON_VISIBLE_SIZE = 824;

function generatePaddedMacIconSource(
  sourcePng: string,
  targetPng: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const scaledIconPath = path.join(tmpRoot, "icon-content.png");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z ${MAC_ICON_VISIBLE_SIZE} ${MAC_ICON_VISIBLE_SIZE} ${sourcePng} --out ${scaledIconPath}`,
    );

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -p ${MAC_ICON_CANVAS_SIZE} ${MAC_ICON_CANVAS_SIZE} ${scaledIconPath} --out ${targetPng}`,
    );
  });
}

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(
  stageResourcesDir: string,
  sourcePng: string,
  darkSourcePng: string,
  lightSourcePng: string,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop macOS icon source is missing at ${sourcePng}`,
      });
    }
    if (!(yield* fs.exists(darkSourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop macOS dark icon source is missing at ${darkSourcePng}`,
      });
    }
    if (!(yield* fs.exists(lightSourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop macOS light icon source is missing at ${lightSourcePng}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "threadlines-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");
    const paddedSourcePng = path.join(tmpRoot, "icon-padded.png");

    yield* generatePaddedMacIconSource(sourcePng, paddedSourcePng, tmpRoot, path, verbose);
    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${paddedSourcePng} --out ${iconPngPath}`,
    );
    yield* generateMacIconSet(paddedSourcePng, iconIcnsPath, tmpRoot, path, verbose);

    // The adaptive Assets.car lets macOS 26+ follow the system icon appearance
    // (light/dark). It requires actool from Xcode 26+, so treat it as optional.
    const adaptiveIconMessages: string[] = [];
    const adaptiveIcon = yield* Effect.sync(() =>
      buildMacAdaptiveIconSync({
        lightSourcePng,
        darkSourcePng,
        outputDir: stageResourcesDir,
        log: (message) => {
          adaptiveIconMessages.push(message);
        },
      }),
    );
    for (const message of adaptiveIconMessages) {
      yield* Effect.log(`[desktop-artifact] ${message}`);
    }
    yield* Effect.log(
      adaptiveIcon
        ? "[desktop-artifact] Staged adaptive macOS icon (Assets.car)."
        : "[desktop-artifact] Building without adaptive macOS icon; the packaged icon will not follow the system icon appearance.",
    );
  });
}

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop Linux icon source is missing at ${sourcePng}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new BuildScriptError({
        message: `Desktop Windows icon source is missing at ${sourceIco}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

export function resolveGitHubPublishConfig(
  updateChannel: "latest" | "nightly",
  env: NodeJS.ProcessEnv = process.env,
):
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly private: true;
      readonly releaseType: "release" | "prerelease";
      readonly channel?: "nightly";
    }
  | undefined {
  const rawRepo =
    env.THREADLINES_DESKTOP_UPDATE_REPOSITORY?.trim() || env.GITHUB_REPOSITORY?.trim() || "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    private: true,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveDesktopBuildIconAssets(_version: string): DesktopBuildIconAssets {
  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    macDarkIconPng: BRAND_ASSET_PATHS.productionMacDarkIconPng,
    macLightIconPng: BRAND_ASSET_PATHS.productionMacLightIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

export function resolveDesktopProductName(_version: string): string {
  return desktopPackageJson.productName ?? "Threadlines";
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  stageResourcesDir?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stageResourcePath = (fileName: string) =>
    stageResourcesDir
      ? path.join(stageResourcesDir, fileName)
      : `apps/desktop/resources/${fileName}`;
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_RELEASE_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: "Threadlines-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  const publishConfig = resolveGitHubPublishConfig(updateChannel);
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: resolveMockUpdateServerUrl(mockUpdateServerPort),
      },
    ];
  }

  if (platform === "mac") {
    const macConfig: Record<string, unknown> = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
    // Ship the adaptive icon when staging produced one: Assets.car must live in
    // Contents/Resources (outside the asar) and CFBundleIconName points macOS
    // at it, letting the OS follow the system icon appearance on macOS 26+.
    const stagedAssetsCarPath = stageResourcePath(MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME);
    const hasStagedAssetsCar = yield* fs
      .exists(stagedAssetsCarPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (hasStagedAssetsCar) {
      macConfig.extraResources = [
        {
          from: stagedAssetsCarPath,
          to: MAC_ADAPTIVE_ICON_ASSETS_CAR_FILE_NAME,
        },
      ];
      macConfig.extendInfo = {
        CFBundleIconName: MAC_ADAPTIVE_ICON_NAME,
      };
    }
    if (signed) {
      macConfig.hardenedRuntime = true;
      macConfig.gatekeeperAssess = true;
      macConfig.entitlements = stageResourcePath("entitlements.mac.plist");
      macConfig.entitlementsInherit = stageResourcePath("entitlements.mac.inherit.plist");
      macConfig.notarize = false;
      buildConfig.afterSign = stageResourcePath("notarize-after-sign.cjs");
    } else {
      macConfig.identity = "-";
      macConfig.hardenedRuntime = false;
      macConfig.gatekeeperAssess = false;
    }
    buildConfig.mac = macConfig;
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      executableName: "threadlines",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "threadlines",
        },
      },
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    buildConfig.extraResources = [
      {
        from: "apps/desktop/resources/icon.ico",
        to: "icon.ico",
      },
    ];
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

export function createStagePackageJson(input: StagePackageJsonInput): StagePackageJson {
  return {
    name: "threadlines",
    version: input.appVersion,
    buildVersion: input.appVersion,
    threadlinesCommitHash: input.commitHash,
    private: true,
    description: "Threadlines desktop build",
    author: "Threadlines",
    main: "apps/desktop/dist-electron/main.cjs",
    packageManager: rootPackageJson.packageManager,
    build: input.build,
    dependencies: input.dependencies,
    devDependencies: {
      electron: input.electronVersion,
    },
    overrides: input.overrides,
  };
}

export function createDesktopArtifactBuildEnv(
  appVersion: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    APP_VERSION: appVersion,
    THREADLINES_APP_VERSION: appVersion,
    VITE_APP_VERSION: appVersion,
  };
}

function resolvePatchedDependencyPackageName(patchedDependencyKey: string): string {
  const versionSeparatorIndex = patchedDependencyKey.lastIndexOf("@");
  if (versionSeparatorIndex <= 0) {
    return patchedDependencyKey;
  }
  return patchedDependencyKey.slice(0, versionSeparatorIndex);
}

export function filterPatchedDependenciesForStage(
  patchedDependencies: Record<string, string>,
  dependencyNames: Iterable<string>,
): Record<string, string> {
  const stageDependencyNames = new Set(dependencyNames);
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([key]) =>
      stageDependencyNames.has(resolvePatchedDependencyPackageName(key)),
    ),
  );
}

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(
      stageResourcesDir,
      iconAssets.macIconPng,
      iconAssets.macDarkIconPng,
      iconAssets.macLightIconPng,
      verbose,
    );
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const vpBinary = resolveWorkspaceVpBinary(repoRoot, path);

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve overrides from pnpm-workspace.yaml.",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `threadlines-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        env: createDesktopArtifactBuildEnv(appVersion),
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims.
        shell: process.platform === "win32",
      })`${vpBinary} run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'vp run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'vp run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      macDarkIconPng: path.join(repoRoot, iconAssets.macDarkIconPng),
      macLightIconPng: path.join(repoRoot, iconAssets.macLightIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const stageDependencies = {
    ...resolvedServerDependencies,
    ...resolvedDesktopRuntimeDependencies,
  };
  const stagePatchedDependencies = filterPatchedDependenciesForStage(workspacePatchedDependencies, [
    ...Object.keys(stageDependencies),
    "electron",
  ]);

  const stagePackageJson = createStagePackageJson({
    appVersion,
    commitHash,
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      stageResourcesDir,
    ),
    dependencies: stageDependencies,
    electronVersion,
    overrides: resolvedOverrides,
  });

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = stringifyYamlValue({
    onlyBuiltDependencies: ["electron", "node-pty"],
    overrides: resolvedOverrides,
    patchedDependencies: stagePatchedDependencies,
  });
  yield* fs.writeFileString(path.join(stageAppDir, "pnpm-workspace.yaml"), stageWorkspaceConfig);
  const patchesDir = path.join(repoRoot, "patches");
  if (Object.keys(stagePatchedDependencies).length > 0 && (yield* fs.exists(patchesDir))) {
    yield* fs.copy(patchesDir, path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    })`${vpBinary} install --prod --no-optional`,
  );

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
    delete buildEnv.THREADLINES_NOTARY_TIMEOUT_SECONDS;
    delete buildEnv.THREADLINES_NOTARY_POLL_SECONDS;
    delete buildEnv.THREADLINES_NOTARY_SUBMIT_ATTEMPTS;
  }

  const python = yield* resolvePythonForNodeGyp();
  if (!python) {
    return yield* new BuildScriptError({
      message:
        "Could not find a usable Python executable for node-gyp. On macOS, make sure the Xcode license has been accepted (`sudo xcodebuild -license`) and rerun the desktop artifact build.",
    });
  }
  buildEnv.PYTHON = python;
  buildEnv.npm_config_python = python;
  buildEnv.NPM_CONFIG_PYTHON = python;
  buildEnv.NODE_GYP_FORCE_PYTHON = python;

  if (process.platform === "win32") {
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: repoRoot,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    })`${vpBinary} exec --filter @threadlines/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: THREADLINES_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: THREADLINES_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription(
      "Build arch, for example arm64/x64/universal (env: THREADLINES_DESKTOP_ARCH).",
    ),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: THREADLINES_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: THREADLINES_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: THREADLINES_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: THREADLINES_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: THREADLINES_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: THREADLINES_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: THREADLINES_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription(
      "Mock update server port (env: THREADLINES_DESKTOP_MOCK_UPDATE_SERVER_PORT).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Threadlines."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
