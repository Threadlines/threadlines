// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { ProviderDriverKind, type CodexSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { deleteEnvVars, readEnvVar } from "../ProviderInstanceEnvironment.ts";
import {
  AccountOverlayError,
  type AccountOverlayResult,
  isPathWithinOverlayDir,
  isSameOverlayDirectory,
  isSharedHardLink,
  materializeAccountOverlay,
  normalizeOverlayPath,
  OVERLAY_STATE_FILE,
  readLinkState,
} from "../accountOverlay.ts";

const isAccountOverlayError = Schema.is(AccountOverlayError);

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

/**
 * Shared directories linked from the shadow home back to the shared Codex home.
 * An allowlist rather than a denylist because Codex writes ephemeral runtime
 * state, locks, and SQLite databases directly in `$CODEX_HOME`, and symlinking
 * individual SQLite files splits WAL/SHM sidecars across folders.
 */
const SHARED_DIRECTORIES = [
  // Conversation history, session artifacts, and the desktop SQLite directory.
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "visualizations",
  "generated_images",
  // Instructions, rules, extensions, themes, and shared caches/logs.
  "skills",
  "plugins",
  "rules",
  "agents",
  "prompts",
  "themes",
  "vendor_imports",
  "cache",
  "logs",
] as const;

const SHARED_FILES = [
  "config.toml",
  "AGENTS.md",
  "AGENTS.override.md",
  "hooks.json",
  "requirements.toml",
  "managed_config.toml",
  "history.jsonl",
  "session_index.jsonl",
] as const;

// Account login and auth-lock files must never link into the shared home.
// `secrets` holds Codex's encrypted credential store (`codex_auth.age`, keyed
// to the home it lives in).
const PRIVATE_FILES = [
  "auth.json",
  "auth.json.lock",
  "auth.lock",
  ".login.lock",
  "models_cache.json",
  "secrets",
] as const;

const ALLOWED_SHARED_ENTRIES = new Set<string>([...SHARED_DIRECTORIES, ...SHARED_FILES]);
const OVERLAY_METADATA_FILES = new Set<string>([OVERLAY_STATE_FILE, ".threadlines-account"]);
const PRIVATE_ENTRY_SET = new Set<string>(PRIVATE_FILES);

function isUnsafeSharedLinkEntry(entryName: string): boolean {
  if (PRIVATE_ENTRY_SET.has(entryName)) return true;
  if (entryName.endsWith(".lock")) return true;
  return /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(entryName);
}

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

export class CodexShadowHomeError extends Schema.TaggedError<CodexShadowHomeError>()(
  "CodexShadowHomeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
const isCodexShadowHomeError = Schema.is(CodexShadowHomeError);

function toShadowHomeError(cause: unknown): CodexShadowHomeError {
  if (isCodexShadowHomeError(cause)) return cause;
  return new CodexShadowHomeError({
    detail: isAccountOverlayError(cause)
      ? cause.detail
      : "Failed to materialize Codex shadow home.",
    cause,
  });
}

function normalizeShadowHomeError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexShadowHomeError, R> {
  return effect.pipe(Effect.mapError(toShadowHomeError));
}

function isSqliteMainDatabaseEntry(entryName: string): boolean {
  return /\.(?:sqlite3?|db)$/i.test(entryName);
}

const logPreservedWalIfNonEmpty = Effect.fn("CodexHomeLayout.logPreservedWalIfNonEmpty")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly effectiveHomePath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void> {
    if (!isSqliteMainDatabaseEntry(input.entryName)) return;
    const walPath = input.path.join(input.effectiveHomePath, `${input.entryName}-wal`);
    const walState = yield* readLinkState(input.fileSystem, walPath).pipe(
      Effect.orElseSucceed(() => ({ _tag: "Missing" }) as const),
    );
    if (walState._tag !== "NotSymlink") return;
    const stat = yield* input.fileSystem.stat(walPath).pipe(Effect.orElseSucceed(() => undefined));
    if (stat && Number(stat.size) > 0) {
      yield* Effect.logWarning(
        "Unlinked legacy shared Codex SQLite file while preserving a non-empty shadow-local WAL file",
        {
          effectiveHomePath: input.effectiveHomePath,
          entryName: input.entryName,
          walPath,
          walBytes: Number(stat.size),
        },
      );
    }
  },
);

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  for (const entryName of ["auth.json", "secrets"] as const) {
    const entryPath = path.join(shadowPath, entryName);
    const state = yield* normalizeShadowHomeError(readLinkState(fileSystem, entryPath));
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomeError({
        detail:
          entryName === "auth.json"
            ? `Codex shadow auth file '${entryPath}' must be a real file, not a symlink.`
            : `Codex shadow credentials folder '${entryPath}' must be a real directory, not a symlink.`,
      });
    }
  }
});

/**
 * Unlinks links inside a shadow home that point back into `sharedHomePath` for
 * entries that must not be shared as individual links (SQLite databases and
 * sidecars, lock files, private login files). On the first run before
 * `.threadlines-overlay.json` exists, also cleans up exact `<shared>/<name>`
 * links left behind by the previous denylist layout. Real files and links
 * pointing elsewhere are never touched.
 */
const removeLegacySharedLinks = Effect.fn("CodexHomeLayout.removeLegacySharedLinks")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly platform: NodeJS.Platform;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryNames = yield* input.fileSystem
      .readDirectory(input.effectiveHomePath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<Array<string>>([])
            : Effect.fail(toShadowHomeError(error)),
        ),
      );
    if (entryNames.length === 0) return;

    const hasOverlayState = entryNames.includes(OVERLAY_STATE_FILE);
    for (const entryName of entryNames) {
      if (ALLOWED_SHARED_ENTRIES.has(entryName) || OVERLAY_METADATA_FILES.has(entryName)) {
        continue;
      }
      if (hasOverlayState && !isUnsafeSharedLinkEntry(entryName)) {
        continue;
      }

      const linkPath = path.join(input.effectiveHomePath, entryName);
      const sharedTarget = path.join(input.sharedHomePath, entryName);
      const state = yield* normalizeShadowHomeError(readLinkState(input.fileSystem, linkPath));
      if (state._tag === "Symlink") {
        const resolvedTarget = path.resolve(input.effectiveHomePath, state.target);
        const matchesLegacyTarget = PRIVATE_ENTRY_SET.has(entryName)
          ? isPathWithinOverlayDir({
              path,
              dir: input.sharedHomePath,
              candidate: resolvedTarget,
              platform: input.platform,
            })
          : normalizeOverlayPath(resolvedTarget, input.platform) ===
            normalizeOverlayPath(sharedTarget, input.platform);
        if (matchesLegacyTarget) {
          yield* logPreservedWalIfNonEmpty({
            fileSystem: input.fileSystem,
            path,
            effectiveHomePath: input.effectiveHomePath,
            entryName,
          });
          yield* normalizeShadowHomeError(input.fileSystem.remove(linkPath));
        }
        continue;
      }

      if (
        state._tag === "NotSymlink" &&
        input.platform === "win32" &&
        (yield* isSharedHardLink({
          target: sharedTarget,
          link: linkPath,
          platform: input.platform,
        }))
      ) {
        yield* logPreservedWalIfNonEmpty({
          fileSystem: input.fileSystem,
          path,
          effectiveHomePath: input.effectiveHomePath,
          entryName,
        });
        yield* normalizeShadowHomeError(input.fileSystem.remove(linkPath));
      }
    }
  },
);

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options?: { readonly platform?: NodeJS.Platform },
): Effect.fn.Return<AccountOverlayResult, CodexShadowHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "authOverlay") return { sharesMainHistory: true };
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return { sharesMainHistory: true };

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = options?.platform ?? process.platform;

  if (
    yield* isSameOverlayDirectory({
      fileSystem,
      path,
      dirA: layout.sharedHomePath,
      dirB: effectiveHomePath,
      platform,
    })
  ) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  yield* removeLegacySharedLinks({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
    platform,
  });

  const result = yield* normalizeShadowHomeError(
    materializeAccountOverlay({
      agent: "Codex",
      mainDir: layout.sharedHomePath,
      accountDir: effectiveHomePath,
      sharedDirectories: SHARED_DIRECTORIES,
      sharedFiles: SHARED_FILES,
      privateFiles: PRIVATE_FILES,
      historyEntry: "sessions",
      platform,
    }),
  );

  yield* ensureShadowAuthIsPrivate(fileSystem, effectiveHomePath);
  return result;
});

/**
 * Directory to pass as `CODEX_SQLITE_HOME` for a shadow home so Codex opens
 * the shared SQLite databases (`state_5.sqlite`, `logs_2.sqlite`, etc.)
 * directly in the shared home with their `-wal`/`-shm` sidecars beside them,
 * instead of symlinking individual database files.
 */
export function codexSqliteHomePath(
  layout: CodexHomeLayout,
  options?: { readonly sharesMainHistory?: boolean },
): string | undefined {
  if (layout.mode !== "authOverlay") return undefined;
  if (options?.sharesMainHistory === false) return undefined;
  return layout.sharedHomePath;
}

const CODEX_SQLITE_HOME_ENV_VAR = "CODEX_SQLITE_HOME";

/**
 * Returns a shallow copy of `environment` with `CODEX_SQLITE_HOME` defaulted
 * to `sqliteHomePath` when not already set. `sqlite_home` in `config.toml`
 * still takes precedence inside Codex itself.
 */
export function withCodexSqliteHome(
  environment: NodeJS.ProcessEnv,
  sqliteHomePath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!sqliteHomePath) return { ...environment };
  if (readEnvVar(environment, CODEX_SQLITE_HOME_ENV_VAR, platform)?.trim()) {
    return { ...environment };
  }
  return { ...environment, [CODEX_SQLITE_HOME_ENV_VAR]: sqliteHomePath };
}

/**
 * Returns a shallow copy of `environment` with `CODEX_SQLITE_HOME` removed
 * (including case variants on Windows), for isolated temporary Codex homes.
 */
export function withoutCodexSqliteHome(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environment };
  deleteEnvVars(next, [CODEX_SQLITE_HOME_ENV_VAR], platform);
  return next;
}

export function codexContinuationIdentity(
  layout: CodexHomeLayout,
  options?: { readonly sharesMainHistory?: boolean },
) {
  const continuationKey =
    layout.mode === "authOverlay" &&
    options?.sharesMainHistory === false &&
    layout.effectiveHomePath
      ? `codex:home:${layout.effectiveHomePath}`
      : layout.continuationKey;
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey,
  };
}
