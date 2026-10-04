// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { ProviderDriverKind, type CodexSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  AccountOverlayError,
  linkSharedEntry,
  readLinkState,
  removeLinkIfPresent,
} from "../accountOverlay.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
] as const;

// `secrets` holds Codex's encrypted credential store (`codex_auth.age`, keyed
// to the home it lives in), so an account's login must never land in the
// shared one.
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json", "secrets"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp"]);

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
    detail:
      cause instanceof AccountOverlayError
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

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const authPath = path.join(shadowPath, "auth.json");
  const state = yield* normalizeShadowHomeError(readLinkState(fileSystem, authPath));
  if (state._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow auth file '${authPath}' must be a real file, not a symlink.`,
    });
  }
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* normalizeShadowHomeError(
    Effect.all(
      [
        fileSystem.makeDirectory(layout.sharedHomePath, { recursive: true }),
        fileSystem.makeDirectory(effectiveHomePath, { recursive: true }),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          fileSystem.makeDirectory(path.join(layout.sharedHomePath, directory), {
            recursive: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );

  const sharedEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(layout.sharedHomePath),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : normalizeShadowHomeError(
            removeLinkIfPresent({ fileSystem, accountPath: effectiveHomePath, entryName }),
          ),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) =>
      Effect.gen(function* () {
        if (PRIVATE_ENTRY_NAMES.has(entryName)) return;
        const result = yield* normalizeShadowHomeError(
          linkSharedEntry({
            fileSystem,
            sharedPath: layout.sharedHomePath,
            accountPath: effectiveHomePath,
            entryName,
            platform: process.platform,
            // The shadow home is Codex's own layout; stale links are ours to fix.
            foreignLink: "replace",
          }),
        );
        if (result._tag === "Conflict") {
          return yield* new CodexShadowHomeError({
            detail: `Cannot create Codex shadow home because '${path.join(effectiveHomePath, entryName)}' already exists and is not a symlink.`,
          });
        }
      }),
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate(fileSystem, effectiveHomePath);
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
