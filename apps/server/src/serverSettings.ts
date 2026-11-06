/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  ACP_REGISTRY_DRIVER_KIND,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  isProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@threadlines/contracts";
import * as Cache from "effect/Cache";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Equal from "effect/Equal";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { type DeepPartial, deepMerge } from "@threadlines/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@threadlines/shared/schemaJson";
import { isAntigravityKeyEnvName } from "@threadlines/shared/antigravitySignIn";
import {
  CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
  CLAUDE_OAUTH_TOKEN_PATTERN,
} from "@threadlines/shared/providerAuthCommands";
import { isPiKeyEnvName } from "./provider/pi/PiBinary.ts";
import { applyServerSettingsPatch } from "@threadlines/shared/serverSettings";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
          cause,
        }),
    ),
  );

const PROVIDER_ENVIRONMENT_SECRET_PREFIX = "provider-env-";

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `${PROVIDER_ENVIRONMENT_SECRET_PREFIX}${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

/** Ends the stored secret of a `CLAUDE_CODE_OAUTH_TOKEN`, whatever instance it belonged to. */
const CLAUDE_TOKEN_SECRET_SUFFIX = `-${Buffer.from(CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV, "utf8").toString("base64url")}`;

/** Why a settings write that would save a Claude token is refused. */
export const CLAUDE_TOKEN_REFUSED_DETAIL =
  "Threadlines no longer saves Claude tokens. Sign in to Claude instead.";

/**
 * Whether a provider variable holds a Claude sign-in token, which Threadlines
 * never keeps (Anthropic's Claude Code terms don't let apps collect or store
 * one): any value that is a Claude token, under any name, and any
 * `CLAUDE_CODE_OAUTH_TOKEN` except the empty mask "Use Claude sign-in" writes
 * against one in the user's own environment. A sensitive value is checked
 * where its secret is read (`isClaudeTokenSecret`). A token the user sets in
 * the environment Threadlines starts from is theirs, and never passes here.
 */
function holdsClaudeToken(variable: {
  readonly name: string;
  readonly value: string;
  readonly valueRedacted?: boolean | undefined;
}): boolean {
  if (CLAUDE_OAUTH_TOKEN_PATTERN.test(variable.value)) return true;
  return (
    variable.name === CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV &&
    (variable.valueRedacted === true || variable.value.trim().length > 0)
  );
}

/** Whether a stored secret is a Claude token, whatever variable it belongs to. */
const isClaudeTokenSecret = (secret: Uint8Array | null): boolean =>
  secret !== null && CLAUDE_OAUTH_TOKEN_PATTERN.test(textDecoder.decode(secret));

/** Settings without any Claude token, and the instances that had one. */
export function withoutClaudeTokens(settings: ServerSettings): {
  readonly settings: ServerSettings;
  readonly instanceIds: ReadonlyArray<string>;
} {
  const instanceIds: string[] = [];
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (!instance.environment?.some(holdsClaudeToken)) {
      providerInstances[instanceId] = instance;
      continue;
    }
    instanceIds.push(instanceId);
    providerInstances[instanceId] = {
      ...instance,
      environment: instance.environment.filter((variable) => !holdsClaudeToken(variable)),
    };
  }
  return instanceIds.length === 0
    ? { settings, instanceIds }
    : {
        settings: {
          ...settings,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        },
        instanceIds,
      };
}

/**
 * Whether a write brings in a Claude token of its own. A stored one an older
 * client sends back redacted (no value) is not new: it is dropped, not refused.
 */
function bringsClaudeToken(settings: ServerSettings): boolean {
  return Object.values(settings.providerInstances).some((instance) =>
    (instance.environment ?? []).some(
      (variable) =>
        CLAUDE_OAUTH_TOKEN_PATTERN.test(variable.value) ||
        (variable.name === CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV && variable.value.trim().length > 0),
    ),
  );
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Key for one provider variable in `alsoDrop`. */
const variableKey = (instanceId: string, name: string) => `${instanceId}\u0000${name}`;

/**
 * The settings file as written, before decoding drops what this version
 * doesn't know: strict JSON (what Threadlines writes) read exactly, else the
 * lenient reader a hand-edited file needs. Undefined when neither reads it.
 */
const decodeStrictSettingsDocument = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);
const decodeLenientSettingsDocument = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
function parseSettingsDocument(raw: string): unknown {
  const strict = decodeStrictSettingsDocument(raw);
  if (strict._tag === "Success") return strict.value;
  const lenient = decodeLenientSettingsDocument(raw);
  return lenient._tag === "Success" ? lenient.value : undefined;
}
const encodeRawSettingsDocument = Schema.encodeUnknownEffect(fromJsonStringPretty(Schema.Unknown));

/** The sensitive variables a settings document points at the secret store for. */
function storedVariablesOf(document: unknown): ReadonlyArray<readonly [string, string]> {
  if (!isJsonRecord(document) || !isJsonRecord(document.providerInstances)) return [];
  return Object.entries(document.providerInstances).flatMap(([instanceId, instance]) =>
    isJsonRecord(instance) && Array.isArray(instance.environment)
      ? instance.environment.flatMap((entry: unknown) =>
          isJsonRecord(entry) &&
          entry.sensitive === true &&
          entry.valueRedacted === true &&
          typeof entry.name === "string"
            ? [[instanceId, entry.name] as const]
            : [],
        )
      : [],
  );
}

/**
 * The settings file's own document without its Claude tokens (and without
 * the variables in `alsoDrop`), or undefined when nothing changes. Edits the
 * parsed file rather than writing the decoded settings back, so a field this
 * version does not know survives.
 */
function settingsDocumentWithoutClaudeTokens(
  document: unknown,
  alsoDrop: ReadonlySet<string>,
): unknown {
  if (!isJsonRecord(document) || !isJsonRecord(document.providerInstances)) return undefined;
  let changed = false;
  const providerInstances: Record<string, unknown> = {};
  for (const [instanceId, instance] of Object.entries(document.providerInstances)) {
    if (!isJsonRecord(instance) || !Array.isArray(instance.environment)) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const environment = instance.environment.filter((entry: unknown) => {
      if (!isJsonRecord(entry)) return true;
      const name = typeof entry.name === "string" ? entry.name : "";
      return !(
        alsoDrop.has(variableKey(instanceId, name)) ||
        holdsClaudeToken({
          name,
          value: typeof entry.value === "string" ? entry.value : "",
          valueRedacted: entry.valueRedacted === true,
        })
      );
    });
    changed ||= environment.length !== instance.environment.length;
    providerInstances[instanceId] = { ...instance, environment };
  }
  return changed ? { ...document, providerInstances } : undefined;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

/**
 * Variables that always hold credentials for their driver: stored in the
 * secret store and redacted for clients whatever a client sent, so a write
 * that forgets `sensitive` can't put a key in settings or send it back.
 */
function isAlwaysSensitive(driver: string, name: string): boolean {
  return (
    (driver === "antigravity" && isAntigravityKeyEnvName(name)) ||
    (driver === "grok" && name === "XAI_API_KEY") ||
    (driver === "pi" && isPiKeyEnvName(name))
  );
}

function withEnforcedSensitivity(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  if (!instance.environment) return instance;
  const driver = String(instance.driver);
  if (!instance.environment.some((variable) => isAlwaysSensitive(driver, variable.name))) {
    return instance;
  }
  return {
    ...instance,
    environment: instance.environment.map((variable) =>
      isAlwaysSensitive(driver, variable.name) && !variable.sensitive
        ? { ...variable, sensitive: true }
        : variable,
    ),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, rawInstance]) => {
      const instance = withEnforcedSensitivity(rawInstance);
      return [
        instanceId,
        instance.environment
          ? {
              ...instance,
              environment: instance.environment.map(redactProviderEnvironmentVariable),
            }
          : instance,
      ];
    }),
  );
  return { ...settings, providerInstances };
}

/** A settings write that failed, and whether the file was written before it did. */
export interface ServerSettingsWriteFailure<E> {
  readonly cause: E;
  readonly written: boolean;
}

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /**
   * The stored settings, without filling in provider secrets: for readers of
   * plain settings that must not fail when the secret store does.
   */
  readonly readStored: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /**
   * Patch settings computed from the current settings, inside the same write
   * lock as the write itself, so no other write can land between the read
   * and the write. `current` is the stored form: sensitive environment
   * values are references, not secrets.
   */
  readonly updateSettingsWith: <E>(
    makePatch: (current: ServerSettings) => Effect.Effect<ServerSettingsPatch, E>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError | E>;

  /**
   * `updateSettingsWith` that says whether its write landed: a failure
   * carries `written`, true once the settings file was written even if a
   * step after it (filling in provider secrets) failed. For a caller that
   * has to tell someone truthfully what changed (an agent's settings change).
   */
  readonly updateSettingsChecked: <E>(
    makePatch: (current: ServerSettings) => Effect.Effect<ServerSettingsPatch, E>,
  ) => Effect.Effect<ServerSettings, ServerSettingsWriteFailure<ServerSettingsError | E>>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;

  /**
   * `streamChanges`, subscribed now: for a reader that reads the settings and
   * then follows them, so a change landing in between is in the stream
   * instead of lost. The subscription lasts as long as the scope.
   */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("threadlines/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const { automaticGitFetchInterval, ...overridesForMerge } = overrides;
        const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
        const initialSettings = yield* normalizeServerSettings({
          ...merged,
          ...(automaticGitFetchInterval !== undefined
            ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
            : {}),
        });
        const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
        // One write at a time, like the live service.
        const writeLock = yield* Semaphore.make(1);
        const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
        const publish = (settings: ServerSettings) =>
          PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          readStored: Ref.get(currentSettingsRef),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
              Effect.flatMap(normalizeServerSettings),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              Effect.tap(publish),
              writeLock.withPermits(1),
            ),
          updateSettingsWith: (makePatch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.flatMap((currentSettings) =>
                makePatch(currentSettings).pipe(
                  Effect.map((patch) => applyServerSettingsPatch(currentSettings, patch)),
                ),
              ),
              Effect.flatMap(normalizeServerSettings),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              Effect.tap(publish),
              writeLock.withPermits(1),
            ),
          // Nothing fails after the write here, so a failure never wrote.
          updateSettingsChecked: (makePatch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.flatMap((currentSettings) =>
                makePatch(currentSettings).pipe(
                  Effect.map((patch) => applyServerSettingsPatch(currentSettings, patch)),
                ),
              ),
              Effect.flatMap(normalizeServerSettings),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              Effect.tap(publish),
              writeLock.withPermits(1),
              Effect.mapError((cause) => ({ cause, written: false })),
            ),
          get streamChanges() {
            return Stream.fromPubSub(changesPubSub);
          },
          subscribeChanges: PubSub.subscribe(changesPubSub).pipe(
            Effect.map(Stream.fromSubscription),
          ),
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

/**
 * The driver an instance runs on, or null when it is turned off or unknown.
 * An instance envelope decides when one exists (the UI turns providers off
 * there); otherwise the legacy `providers.<kind>` blob does.
 */
function resolveEnabledInstanceDriver(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderDriverKind | null {
  const instanceConfig = settings.providerInstances[instanceId];
  if (instanceConfig !== undefined) {
    return (instanceConfig.enabled ?? true) ? instanceConfig.driver : null;
  }

  if (
    isProviderDriverKind(instanceId) &&
    getLegacyProviderSettings(settings, instanceId)?.enabled
  ) {
    return ProviderDriverKind.make(instanceId);
  }

  return null;
}

/**
 * The driver that would write text for a selection, or null when it can't:
 * turned off, unknown, or a community agent. What an agent Threadlines
 * hasn't tested would write is not known, so one is never the writing model.
 */
function resolveTextGenerationDriver(
  settings: ServerSettings,
  selection: ModelSelection,
): ProviderDriverKind | null {
  const driver = resolveEnabledInstanceDriver(settings, selection.instanceId);
  return driver === ACP_REGISTRY_DRIVER_KIND ? null : driver;
}

function textGenerationSelectionIsEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return resolveTextGenerationDriver(settings, selection) !== null;
}

/**
 * The first turned-on instance: built-in default instances in settings order,
 * then custom instances (a second account can serve when every default is off).
 */
function fallbackTextGenerationSelection(
  settings: ServerSettings,
  options: { readonly excludeDriver?: ProviderDriverKind | null } = {},
): ModelSelection | null {
  const defaultIds = Object.keys(settings.providers);
  const customIds = Object.keys(settings.providerInstances).filter(
    (key) => !defaultIds.includes(key),
  );
  for (const key of [...defaultIds, ...customIds]) {
    const instanceId = ProviderInstanceId.make(key);
    const driver = resolveEnabledInstanceDriver(settings, instanceId);
    if (driver === null || driver === ACP_REGISTRY_DRIVER_KIND) continue;
    if (options.excludeDriver !== undefined && driver === options.excludeDriver) continue;
    return {
      instanceId,
      model:
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection;
  }
  return null;
}

/**
 * Ensure text generation selections point at enabled providers. The primary
 * selection falls back to the first enabled provider. A configured backup is
 * kept only when it resolves to a different provider driver than the primary.
 * This is applied at read-time so persisted preferences are preserved for
 * when a provider is re-enabled.
 */
function resolveTextGenerationProviders(settings: ServerSettings): ServerSettings {
  let resolved = settings;
  if (!textGenerationSelectionIsEnabled(settings, settings.textGenerationModelSelection)) {
    const fallback = fallbackTextGenerationSelection(settings);
    if (fallback) {
      resolved = {
        ...resolved,
        textGenerationModelSelection: fallback,
      };
    }
  }

  // A writer selection pointing at a provider that is gone (uninstalled,
  // disabled, instance deleted) resolves to null so source control text falls
  // back to the primary selection instead of failing every generation.
  const writerSelection = resolved.sourceControlWriterModelSelection;
  if (writerSelection !== null && !textGenerationSelectionIsEnabled(resolved, writerSelection)) {
    resolved = {
      ...resolved,
      sourceControlWriterModelSelection: null,
    };
  }

  const backupSelection = resolved.textGenerationBackupModelSelection;
  if (backupSelection === null) {
    return resolved;
  }

  const primaryDriver = resolveTextGenerationDriver(
    resolved,
    resolved.textGenerationModelSelection,
  );
  const backupDriver = resolveTextGenerationDriver(resolved, backupSelection);
  if (backupDriver !== null && backupDriver !== primaryDriver) {
    return resolved;
  }

  return {
    ...resolved,
    textGenerationBackupModelSelection:
      fallbackTextGenerationSelection(resolved, { excludeDriver: primaryDriver }) ?? null,
  };
}

/**
 * The model selection used for source control text (commit messages, PR
 * titles and bodies, branch names). Thread titles always use the primary
 * text generation selection.
 */
export function resolveSourceControlWriterModelSelection(settings: ServerSettings): ModelSelection {
  return settings.sourceControlWriterModelSelection ?? settings.textGenerationModelSelection;
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "automaticGitFetchInterval",
  "textGenerationModelSelection",
  "textGenerationBackupModelSelection",
  "sourceControlWriterModelSelection",
  "newThreadModelSelection",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath, secretsDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = decodeServerSettingsJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    // Every read, so a token in the file (an older version's, or a hand edit)
    // never reaches a provider, a client or a write.
    const cleaned = withoutClaudeTokens(decoded.value);
    if (cleaned.instanceIds.length > 0) {
      yield* Effect.logInfo("settings.claude-token.dropped", {
        instances: cleaned.instanceIds.length,
      });
    }
    return cleaned.settings;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const toSettingsError = (detail: string, cause: unknown) =>
    new ServerSettingsError({
      settingsPath,
      detail,
      cause,
    });

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError(
                  `failed to read sensitive environment variable ${variable.name}`,
                  cause,
                ),
              ),
            );
          // A Claude token saved under another name before this version
          // never reaches a provider; start-up removes it.
          if (isClaudeTokenSecret(secret)) continue;
          environment.push({
            ...variable,
            value: secret ? textDecoder.decode(secret) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  /**
   * Moves sensitive values into the secret store and returns the settings to
   * write, plus the secret removals to run once that write has landed: a
   * failed settings write must not leave an account configured with its keys
   * already deleted. New values are stored first, since the written settings
   * point at them.
   */
  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<
    {
      readonly settings: ServerSettings;
      readonly removeStale: Effect.Effect<void, ServerSettingsError>;
    },
    ServerSettingsError
  > =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const removals: Array<{ readonly secretName: string; readonly label: string }> = [];

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, rawInstance] of Object.entries(next.providerInstances)) {
        const instance = withEnforcedSensitivity(rawInstance);
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!variable.sensitive) {
            removals.push({ secretName, label: variable.name });
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!variable.valueRedacted) {
            if (variable.value.length > 0) {
              yield* secretStore
                .set(secretName, textEncoder.encode(variable.value))
                .pipe(
                  Effect.mapError((cause) =>
                    toSettingsError(`failed to persist environment secret ${variable.name}`, cause),
                  ),
                );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              removals.push({ secretName, label: variable.name });
              nextSecretKeys.delete(secretName);
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, rawInstance] of Object.entries(current.providerInstances)) {
        const instance = withEnforcedSensitivity(rawInstance);
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          removals.push({ secretName, label: variable.name });
        }
      }

      const removeStale = Effect.forEach(
        // A secret the written settings still use is never removed.
        removals.filter((removal) => !nextSecretKeys.has(removal.secretName)),
        ({ secretName, label }) =>
          secretStore
            .remove(secretName)
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError(`failed to remove stale environment secret ${label}`, cause),
              ),
            ),
        { discard: true },
      );

      return {
        settings: {
          ...next,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        },
        removeStale,
      };
    });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to write settings file",
          cause,
        }),
    ),
  );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  /** One settings write; callers hold `writeSemaphore`. `onWritten` runs the moment the file lands. */
  const applyPatchLocked = <E>(
    makePatch: (current: ServerSettings) => Effect.Effect<ServerSettingsPatch, E>,
    onWritten: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.gen(function* () {
      const current = yield* getSettingsFromCache;
      const patch = yield* makePatch(current);
      const proposed = applyServerSettingsPatch(current, patch);
      if (bringsClaudeToken(proposed)) {
        return yield* new ServerSettingsError({
          settingsPath,
          detail: CLAUDE_TOKEN_REFUSED_DETAIL,
        });
      }
      const persisted = yield* persistProviderEnvironmentSecrets(
        current,
        withoutClaudeTokens(proposed).settings,
      );
      const next = yield* normalizeServerSettings(persisted.settings);
      yield* writeSettingsAtomically(next);
      yield* onWritten;
      // Only now that the write landed: a stale secret is truly unused. A
      // failed removal leaves an orphan file, never a missing key.
      yield* persisted.removeStale.pipe(
        Effect.catch((error) =>
          Effect.logWarning("stale provider secret was not removed", { detail: error.detail }),
        ),
      );
      yield* Cache.set(settingsCache, cacheKey, next);
      yield* emitChange(next);
      const materialized = yield* materializeProviderEnvironmentSecrets(next);
      return resolveTextGenerationProviders(materialized);
    });

  /** Raw published settings as readers get them: secrets filled in, providers resolved. */
  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeProviderEnvironmentSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize provider environment secrets", {
              detail: error.detail,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProviders),
    );

  /** A secret file a crash left half-written (`<name>.bin.<id>.tmp`), and its secret's name. */
  const leftoverSecretName = (entry: string): string | undefined => {
    const bin = entry.indexOf(".bin.");
    return entry.startsWith(PROVIDER_ENVIRONMENT_SECRET_PREFIX) &&
      entry.endsWith(".tmp") &&
      bin !== -1
      ? entry.slice(0, bin)
      : undefined;
  };

  /**
   * Takes Claude tokens off disk, holding the settings lock throughout so no
   * save lands between a check and what it decides, in an order a crash
   * can't undo:
   * 1. reads the settings file as written and finds sensitive variables
   *    whose stored secret is a Claude token (only the secret tells, for a
   *    name other than `CLAUDE_CODE_OAUTH_TOKEN`);
   * 2. edits that document to drop them and every other Claude token,
   *    keeping everything else, including fields this version doesn't know
   *    and a file it can't otherwise read;
   * 3. removes every stored secret that is a Claude token or a
   *    `CLAUDE_CODE_OAUTH_TOKEN`, and the half-written ones a crash left.
   * Runs on each start, so whatever a failure left is finished next time.
   * Never fails start-up: a token left on disk is still never used.
   */
  const removeClaudeTokens = writeSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const readSecret = (secretName: string) =>
          secretStore.get(secretName).pipe(Effect.orElseSucceed(() => null));
        const document = yield* Effect.gen(function* () {
          if (!(yield* readConfigExists)) return undefined;
          return parseSettingsDocument(yield* readRawConfig);
        }).pipe(Effect.orElseSucceed(() => undefined));

        const alsoDrop = new Set<string>();
        for (const [instanceId, name] of storedVariablesOf(document)) {
          const secret = yield* readSecret(providerEnvironmentSecretName({ instanceId, name }));
          if (isClaudeTokenSecret(secret)) alsoDrop.add(variableKey(instanceId, name));
        }

        const cleaned = settingsDocumentWithoutClaudeTokens(document, alsoDrop);
        if (cleaned !== undefined) {
          const contents = yield* encodeRawSettingsDocument(cleaned).pipe(
            Effect.mapError((cause) => toSettingsError("failed to encode settings", cause)),
          );
          yield* writeFileStringAtomically({
            filePath: settingsPath,
            contents: `${contents}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
            Effect.mapError((cause) => toSettingsError("failed to write settings file", cause)),
          );
          yield* Cache.invalidate(settingsCache, cacheKey);
          yield* Effect.logInfo("settings.claude-token.removed-from-file");
        }

        const secretNames = yield* secretStore
          .list(PROVIDER_ENVIRONMENT_SECRET_PREFIX)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const secretName of secretNames) {
          const isToken =
            secretName.endsWith(CLAUDE_TOKEN_SECRET_SUFFIX) ||
            isClaudeTokenSecret(yield* readSecret(secretName));
          if (!isToken) continue;
          yield* secretStore
            .remove(secretName)
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError("failed to remove a stored Claude token", cause),
              ),
            );
          yield* Effect.logInfo("settings.claude-token.secret-removed");
        }
        const entries = yield* fs.readDirectory(secretsDir).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          const secretName = leftoverSecretName(entry);
          if (secretName === undefined) continue;
          const entryPath = pathService.join(secretsDir, entry);
          const isToken =
            secretName.endsWith(CLAUDE_TOKEN_SECRET_SUFFIX) ||
            isClaudeTokenSecret(
              yield* fs.readFile(entryPath).pipe(Effect.orElseSucceed(() => null)),
            );
          if (!isToken) continue;
          yield* fs
            .remove(entryPath)
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError("failed to remove a half-written Claude token", cause),
              ),
            );
        }
      }),
    )
    .pipe(
      Effect.catch((error: ServerSettingsError) =>
        Effect.logWarning("Claude token cleanup did not finish", { detail: error.detail }),
      ),
    );

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
      yield* removeClaudeTokens;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.map(resolveTextGenerationProviders),
    ),
    readStored: getSettingsFromCache,
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(applyPatchLocked(() => Effect.succeed(patch))),
    updateSettingsWith: (makePatch) => writeSemaphore.withPermits(1)(applyPatchLocked(makePatch)),
    updateSettingsChecked: (makePatch) =>
      Effect.gen(function* () {
        const written = yield* Ref.make(false);
        return yield* writeSemaphore
          .withPermits(1)(applyPatchLocked(makePatch, Ref.set(written, true)))
          .pipe(
            Effect.catch((cause) =>
              Ref.get(written).pipe(
                Effect.flatMap((landed) => Effect.fail({ cause, written: landed })),
              ),
            ),
          );
      }),
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    subscribeChanges: PubSub.subscribe(changesPubSub).pipe(
      Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
    ),
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings).pipe(
  Layer.provide(ServerSecretStoreLive),
);
