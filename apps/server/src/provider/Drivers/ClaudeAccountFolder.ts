/**
 * ClaudeAccountFolder — a second Claude account's `CLAUDE_CONFIG_DIR`, laid
 * over the main Claude folder.
 *
 * The account keeps its login and account state to itself
 * (`.credentials.json`, `.claude.json` with `oauthAccount`, org policy,
 * caches) and links an allowlist of entries back to the main folder: the
 * user's instructions and extensions, and the conversation state that resume
 * and revert read. An allowlist rather than a denylist because Claude keeps
 * account state beside config, and a file it starts writing in a future
 * version is safer private than shared. The names come from the folders
 * Claude Code 2.1.289 reads from its config folder.
 *
 * Nothing real is ever moved or overwritten: an entry the account already has
 * stays its own (and is logged), so pointing an account at an existing Claude
 * folder only adds links for what it lacks. Shared directories are created in
 * the main folder first, so an account never starts a private copy of one.
 *
 * @module provider/Drivers/ClaudeAccountFolder
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  AccountOverlayError,
  linkSharedEntry,
  readLinkState,
  relinkSplitHardLink,
  removeLinkIfPresent,
} from "../accountOverlay.ts";

const SHARED_DIRECTORIES = [
  // Conversation state: resume, checkpoints (revert), todos, plans, uploads.
  "projects",
  "file-history",
  "todos",
  "tasks",
  "plans",
  "shell-snapshots",
  "session-env",
  "uploads",
  // Instructions and extensions.
  "rules",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "plugins",
  "workflows",
  "themes",
  "agent-memory",
  "memory",
] as const;

const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "history.jsonl"] as const;

/** Must be the account's own: a link here would share or leak a login. */
const PRIVATE_FILES = [".credentials.json", ".claude.json"] as const;

/**
 * What this overlay made: every link (so a link the user made in a folder
 * they chose is never replaced) and which of them are Windows hard links
 * (re-linked after an atomic save splits them).
 */
const OVERLAY_STATE_FILE = ".threadlines-overlay.json";
const OverlayState = Schema.Struct({
  linked: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  hardLinked: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
const decodeOverlayState = Schema.decodeUnknownOption(Schema.fromJsonString(OverlayState));

export interface ClaudeAccountFolderResult {
  /** `projects` links to the main folder, so threads resume across the two. */
  readonly sharesMainHistory: boolean;
}

export const materializeClaudeAccountFolder = Effect.fn("materializeClaudeAccountFolder")(
  function* (input: {
    readonly mainDir: string;
    readonly accountDir: string;
    readonly platform?: NodeJS.Platform;
  }): Effect.fn.Return<
    ClaudeAccountFolderResult,
    AccountOverlayError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = input.platform ?? process.platform;
    const mainDir = path.resolve(input.mainDir);
    const accountDir = path.resolve(input.accountDir);
    if (mainDir === accountDir) {
      return yield* new AccountOverlayError({
        detail: "A Claude account folder must be different from the main Claude folder.",
      });
    }

    const mapFsError = (detail: string) =>
      Effect.mapError((cause: unknown) => new AccountOverlayError({ detail, cause }));

    yield* fileSystem
      .makeDirectory(accountDir, { recursive: true, mode: 0o700 })
      .pipe(mapFsError(`Could not create the Claude account folder '${accountDir}'.`));
    yield* Effect.forEach(
      SHARED_DIRECTORIES,
      (name) =>
        fileSystem
          .makeDirectory(path.join(mainDir, name), { recursive: true })
          .pipe(mapFsError(`Could not create '${path.join(mainDir, name)}'.`)),
      { concurrency: "unbounded", discard: true },
    );

    // A login file that links into the main folder would share the
    // terminal's login: removed. One that points elsewhere is the user's own
    // arrangement in a folder they chose, and stays.
    for (const entryName of PRIVATE_FILES) {
      const state = yield* readLinkState(fileSystem, path.join(accountDir, entryName));
      if (state._tag !== "Symlink") continue;
      const target = path.resolve(accountDir, state.target);
      const relative = path.relative(mainDir, target);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        yield* removeLinkIfPresent({ fileSystem, accountPath: accountDir, entryName });
      } else {
        yield* Effect.logWarning("Claude account folder keeps a login link of its own", {
          accountDir,
          entryName,
        });
      }
    }

    const statePath = path.join(accountDir, OVERLAY_STATE_FILE);
    const previousState = yield* fileSystem.readFileString(statePath).pipe(
      Effect.map((raw) => decodeOverlayState(raw)),
      Effect.orElseSucceed(() => undefined),
    );
    const previouslyLinked = new Set(
      previousState?._tag === "Some" ? previousState.value.linked : [],
    );
    const previouslyHardLinked = new Set(
      previousState?._tag === "Some" ? previousState.value.hardLinked : [],
    );
    const linked = new Set<string>();
    const hardLinked = new Set<string>();
    const kept: string[] = [];
    let sharesMainHistory = false;

    for (const entryName of SHARED_DIRECTORIES) {
      const result = yield* linkSharedEntry({
        fileSystem,
        sharedPath: mainDir,
        accountPath: accountDir,
        entryName,
        platform,
        foreignLink: previouslyLinked.has(entryName) ? "replace" : "keep",
      });
      if (result._tag === "Conflict") {
        kept.push(entryName);
        continue;
      }
      linked.add(entryName);
      if (entryName === "projects") sharesMainHistory = true;
    }

    for (const entryName of SHARED_FILES) {
      const mainHasFile = yield* fileSystem
        .exists(path.join(mainDir, entryName))
        .pipe(Effect.orElseSucceed(() => false));
      if (!mainHasFile) continue;
      if (platform === "win32" && previouslyHardLinked.has(entryName)) {
        yield* relinkSplitHardLink({
          fileSystem,
          sharedPath: mainDir,
          accountPath: accountDir,
          entryName,
        });
      }
      const result = yield* linkSharedEntry({
        fileSystem,
        sharedPath: mainDir,
        accountPath: accountDir,
        entryName,
        platform,
        foreignLink: previouslyLinked.has(entryName) ? "replace" : "keep",
      });
      if (result._tag === "Conflict") {
        kept.push(entryName);
        continue;
      }
      linked.add(entryName);
      if (result.kind === "hardLink") hardLinked.add(entryName);
    }

    if (kept.length > 0) {
      yield* Effect.logWarning("Claude account folder keeps its own copies", {
        accountDir,
        entries: kept,
      });
    }
    const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
      a.size === b.size && [...a].every((name) => b.has(name));
    if (!sameSet(linked, previouslyLinked) || !sameSet(hardLinked, previouslyHardLinked)) {
      yield* fileSystem
        .writeFileString(
          statePath,
          JSON.stringify({
            linked: [...linked].toSorted(),
            hardLinked: [...hardLinked].toSorted(),
          }),
        )
        .pipe(mapFsError(`Could not write '${statePath}'.`));
    }
    return { sharesMainHistory };
  },
);
