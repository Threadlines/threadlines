/**
 * Muse Code's data-sharing choice (Contributor mode), read from and written
 * to Muse's own `settings.json`, so Threadlines and the terminal `muse` agree.
 *
 * Contributor mode lets Meta train on the content in exchange for more plan
 * usage, and Meta's terms say code that must stay confidential must not be
 * sent in it. Subscribers start with it on. `muse serve` 1.4.6 ignored the
 * saved choice, so every host is launched with `--contributor-mode on|off`
 * read from here.
 *
 * Writes change only Threadlines' two keys: one writer per file in this
 * server, and the file checked again just before it is replaced, so a change
 * Muse saved meanwhile is read and kept rather than overwritten. An
 * unreadable file, or one in a format newer than this writer knows, is never
 * replaced.
 *
 * @module provider/muse/MuseSettingsFile
 */
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os";
import * as NodePath from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";

export const CONTRIBUTOR_MODE_KEY = "contributor_mode_enabled";
export const CONTRIBUTOR_DISCLOSURE_KEY = "contributor_mode_disclosure_acknowledged";
/**
 * The settings format this writer knows. Muse refuses a file without
 * `schema_version`, and one with a version it does not support.
 */
const MUSE_SETTINGS_SCHEMA_VERSION = 1;

export interface MuseDataSharingState {
  /** Chats may be used for training (Contributor mode). */
  readonly enabled: boolean;
  /** The user has seen the choice, here or in Muse's own app. */
  readonly acknowledged: boolean;
  readonly settingsPath: string;
  /** The file could not be read, in plain words. */
  readonly error?: string;
}

/** `$XDG_CONFIG_HOME/muse/settings.json`, else `~/.config/muse/settings.json` (all platforms). */
export function museSettingsPath(environment: NodeJS.ProcessEnv): string {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const root = configHome
    ? configHome
    : NodePath.join(environment.HOME?.trim() || homedir(), ".config");
  return NodePath.join(root, "muse", "settings.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The choice in a parsed settings document. Absent means on: Muse's default for subscribers. */
export function readDataSharing(document: Record<string, unknown>): {
  readonly enabled: boolean;
  readonly acknowledged: boolean;
} {
  return {
    enabled: document[CONTRIBUTOR_MODE_KEY] !== false,
    acknowledged: document[CONTRIBUTOR_DISCLOSURE_KEY] === true,
  };
}

type ParsedSettings =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly document: Record<string, unknown> }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The file's text, `null` when it does not exist. */
const readSettingsText = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.readFileString(path).pipe(
    Effect.map((text): string | null => text),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.fail(`Could not read Muse's settings file: ${error.message}`),
    ),
  );

function parseSettings(text: string | null): ParsedSettings {
  if (text === null) return { kind: "missing" };
  if (text.trim() === "") return { kind: "ok", document: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed)
      ? { kind: "ok", document: parsed }
      : { kind: "unreadable", reason: "Muse's settings file is not a JSON object." };
  } catch {
    return { kind: "unreadable", reason: "Muse's settings file is not valid JSON." };
  }
}

const readSettings = (fileSystem: FileSystem.FileSystem, path: string) =>
  readSettingsText(fileSystem, path).pipe(
    Effect.map(parseSettings),
    Effect.catch((reason) => Effect.succeed<ParsedSettings>({ kind: "unreadable", reason })),
  );

/** Tries before a save gives up on a file that keeps changing under it. */
const WRITE_ATTEMPTS = 3;

/** The current choice. A missing file reads as Muse's default (on, not yet seen). */
export const readMuseDataSharing = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settingsPath = museSettingsPath(environment);
    const parsed = yield* readSettings(fileSystem, settingsPath);
    switch (parsed.kind) {
      case "missing":
        return { enabled: true, acknowledged: false, settingsPath } satisfies MuseDataSharingState;
      case "ok":
        return { ...readDataSharing(parsed.document), settingsPath } satisfies MuseDataSharingState;
      case "unreadable":
        return {
          enabled: true,
          acknowledged: false,
          settingsPath,
          error: parsed.reason,
        } satisfies MuseDataSharingState;
    }
  });

const writers = new Map<string, Semaphore.Semaphore>();
const writerFor = (path: string) =>
  Effect.gen(function* () {
    const existing = writers.get(path);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    writers.set(path, created);
    return created;
  });

export class MuseSettingsWriteError extends Data.TaggedError("MuseSettingsWriteError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Saves the choice, and marks it seen, in Muse's settings file. Other
 * settings are kept as they are; a file that is not valid JSON is left alone
 * and the write fails.
 */
export const writeMuseDataSharing = (environment: NodeJS.ProcessEnv, enabled: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settingsPath = museSettingsPath(environment);
    const writer = yield* writerFor(settingsPath);
    const failure = (cause: { readonly message: string }) =>
      new MuseSettingsWriteError({
        reason: `Could not save Muse's settings file: ${cause.message}`,
      });
    const readText = readSettingsText(fileSystem, settingsPath).pipe(
      Effect.mapError((reason) => new MuseSettingsWriteError({ reason })),
    );
    /** One read-modify-replace; `false` when the file changed before the replace. */
    const attempt = Effect.gen(function* () {
      const before = yield* readText;
      const parsed = parseSettings(before);
      if (parsed.kind === "unreadable") {
        return yield* new MuseSettingsWriteError({ reason: parsed.reason });
      }
      const document = parsed.kind === "ok" ? parsed.document : {};
      const version = document.schema_version;
      if (version !== undefined && version !== MUSE_SETTINGS_SCHEMA_VERSION) {
        return yield* new MuseSettingsWriteError({
          reason:
            "Muse's settings file is in a newer format than Threadlines knows. Change this setting in Muse instead (/settings).",
        });
      }
      const next = {
        schema_version: MUSE_SETTINGS_SCHEMA_VERSION,
        ...document,
        [CONTRIBUTOR_MODE_KEY]: enabled,
        [CONTRIBUTOR_DISCLOSURE_KEY]: true,
      };
      const directory = NodePath.dirname(settingsPath);
      const temporary = NodePath.join(
        directory,
        `.settings.json.threadlines-${process.pid}-${Date.now()}`,
      );
      yield* fileSystem
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failure));
      yield* fileSystem
        .writeFileString(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        .pipe(Effect.mapError(failure));
      const replaced = yield* Effect.gen(function* () {
        // Muse saved something meanwhile: start over from its version.
        if ((yield* readText) !== before) return false;
        yield* fileSystem.rename(temporary, settingsPath).pipe(Effect.mapError(failure));
        return true;
      }).pipe(Effect.onError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
      if (!replaced) yield* fileSystem.remove(temporary).pipe(Effect.ignore);
      return replaced;
    });
    return yield* writer.withPermit(
      Effect.gen(function* () {
        for (let tries = 0; tries < WRITE_ATTEMPTS; tries += 1) {
          if (yield* attempt) {
            return { enabled, acknowledged: true, settingsPath } satisfies MuseDataSharingState;
          }
        }
        return yield* new MuseSettingsWriteError({
          reason: "Muse's settings file kept changing while Threadlines saved it. Try again.",
        });
      }),
    );
  });
