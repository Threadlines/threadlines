import * as NetService from "@t3tools/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

export const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription(
    "Base directory path (equivalent to BADCODE_HOME; legacy T3CODE_HOME is still accepted).",
  ),
  Flag.optional,
);
export const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
export const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
export const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
export const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to BADCODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
export const tailscaleServeFlag = Flag.boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
export const tailscaleServePortFlag = Flag.integer("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);

const aliasedConfigOption = <A>(
  badcodeConfig: Config.Config<A>,
  legacyT3CodeConfig: Config.Config<A>,
) =>
  Config.all({
    badcode: badcodeConfig.pipe(Config.option),
    legacyT3Code: legacyT3CodeConfig.pipe(Config.option),
  }).pipe(
    Config.map(({ badcode, legacyT3Code }) =>
      Option.getOrUndefined(Option.isSome(badcode) ? badcode : legacyT3Code),
    ),
  );

const aliasedConfigWithDefault = <A>(
  badcodeConfig: Config.Config<A>,
  legacyT3CodeConfig: Config.Config<A>,
  defaultValue: A,
) =>
  aliasedConfigOption(badcodeConfig, legacyT3CodeConfig).pipe(
    Config.map((value) => value ?? defaultValue),
  );

const EnvServerConfig = Config.all({
  logLevel: aliasedConfigWithDefault(
    Config.logLevel("BADCODE_LOG_LEVEL"),
    Config.logLevel("T3CODE_LOG_LEVEL"),
    "Info",
  ),
  traceMinLevel: aliasedConfigWithDefault(
    Config.logLevel("BADCODE_TRACE_MIN_LEVEL"),
    Config.logLevel("T3CODE_TRACE_MIN_LEVEL"),
    "Info",
  ),
  traceTimingEnabled: aliasedConfigWithDefault(
    Config.boolean("BADCODE_TRACE_TIMING_ENABLED"),
    Config.boolean("T3CODE_TRACE_TIMING_ENABLED"),
    true,
  ),
  traceFile: aliasedConfigOption(
    Config.string("BADCODE_TRACE_FILE"),
    Config.string("T3CODE_TRACE_FILE"),
  ),
  traceMaxBytes: aliasedConfigWithDefault(
    Config.int("BADCODE_TRACE_MAX_BYTES"),
    Config.int("T3CODE_TRACE_MAX_BYTES"),
    10 * 1024 * 1024,
  ),
  traceMaxFiles: aliasedConfigWithDefault(
    Config.int("BADCODE_TRACE_MAX_FILES"),
    Config.int("T3CODE_TRACE_MAX_FILES"),
    10,
  ),
  traceBatchWindowMs: aliasedConfigWithDefault(
    Config.int("BADCODE_TRACE_BATCH_WINDOW_MS"),
    Config.int("T3CODE_TRACE_BATCH_WINDOW_MS"),
    200,
  ),
  otlpTracesUrl: aliasedConfigOption(
    Config.string("BADCODE_OTLP_TRACES_URL"),
    Config.string("T3CODE_OTLP_TRACES_URL"),
  ),
  otlpMetricsUrl: aliasedConfigOption(
    Config.string("BADCODE_OTLP_METRICS_URL"),
    Config.string("T3CODE_OTLP_METRICS_URL"),
  ),
  otlpExportIntervalMs: aliasedConfigWithDefault(
    Config.int("BADCODE_OTLP_EXPORT_INTERVAL_MS"),
    Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS"),
    10_000,
  ),
  otlpServiceName: aliasedConfigWithDefault(
    Config.string("BADCODE_OTLP_SERVICE_NAME"),
    Config.string("T3CODE_OTLP_SERVICE_NAME"),
    "badcode-server",
  ),
  mode: aliasedConfigOption(
    Config.schema(RuntimeMode, "BADCODE_MODE"),
    Config.schema(RuntimeMode, "T3CODE_MODE"),
  ),
  port: aliasedConfigOption(Config.port("BADCODE_PORT"), Config.port("T3CODE_PORT")),
  host: aliasedConfigOption(Config.string("BADCODE_HOST"), Config.string("T3CODE_HOST")),
  t3Home: aliasedConfigOption(Config.string("BADCODE_HOME"), Config.string("T3CODE_HOME")),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: aliasedConfigOption(
    Config.boolean("BADCODE_NO_BROWSER"),
    Config.boolean("T3CODE_NO_BROWSER"),
  ),
  bootstrapFd: aliasedConfigOption(
    Config.int("BADCODE_BOOTSTRAP_FD"),
    Config.int("T3CODE_BOOTSTRAP_FD"),
  ),
  autoBootstrapProjectFromCwd: aliasedConfigOption(
    Config.boolean("BADCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
    Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
  ),
  logWebSocketEvents: aliasedConfigOption(
    Config.boolean("BADCODE_LOG_WS_EVENTS"),
    Config.boolean("T3CODE_LOG_WS_EVENTS"),
  ),
  tailscaleServeEnabled: aliasedConfigOption(
    Config.boolean("BADCODE_TAILSCALE_SERVE"),
    Config.boolean("T3CODE_TAILSCALE_SERVE"),
  ),
  tailscaleServePort: aliasedConfigOption(
    Config.port("BADCODE_TAILSCALE_SERVE_PORT"),
    Config.port("T3CODE_TAILSCALE_SERVE_PORT"),
  ),
});

export interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
} as const;

export const authLocationFlags = sharedServerLocationFlags;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.t3Home),
          Option.fromUndefinedOr(bootstrap?.t3Home),
        ),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
      ),
      () => 443,
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
