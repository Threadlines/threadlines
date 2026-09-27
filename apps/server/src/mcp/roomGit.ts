/**
 * `room_diff` and an independent review's captured basis: fixed, read-only
 * git views of a room's checkout.
 *
 * Nothing here takes a command from the model. The views are a fixed set of
 * git invocations, run without a shell. The model supplies at most a
 * revision and a path, and neither reaches git as an option: a revision is
 * resolved to a commit id with `rev-parse --verify --end-of-options` first
 * and only the id is used after; a path must be repo-relative, cannot climb
 * out with `..`, is taken literally (no pathspec magic), and always follows
 * `--`. No external diff or text conversion runs (`--no-ext-diff
 * --no-textconv`), the fsmonitor hook is off, and git takes no optional
 * locks, so a reader never writes the index under the agent that is working.
 * Output is bounded.
 *
 * The uncommitted view (untracked files included) goes through the git
 * driver's temp-index helper, the same capture checkpoints use. It runs the
 * repository's own clean filters, as every checkpoint already does.
 */
import type { RoomReviewInput } from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

export const ROOM_DIFF_VIEWS = ["status", "diff", "diff_stat", "log", "show"] as const;
export type RoomDiffView = (typeof ROOM_DIFF_VIEWS)[number];

/** What `room_diff` returns at most, in characters. */
export const ROOM_DIFF_CHAR_LIMIT = 40_000;
/** What a review is handed at most, in characters. */
export const ROOM_REVIEW_DIFF_CHAR_LIMIT = 40_000;
const LOG_ENTRIES = 20;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_OUTPUT_BYTES = 512 * 1024;
const REVISION_MAX_LENGTH = 256;
const PATH_MAX_LENGTH = 1_024;

/** Every command runs with these: no fsmonitor hook, no untracked cache writes. */
const GIT_PROFILE = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"] as const;
/** No optional index writes; paths are literal, never pathspec magic. */
const GIT_ENV: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
const NO_CONVERSION = ["--no-color", "--no-ext-diff", "--no-textconv"] as const;

/**
 * Why a view could not be given: `refused` when the input was not something
 * this tool runs (an option-shaped revision, a path out of the checkout),
 * `failed` when the command itself failed.
 */
export class RoomGitError extends Error {
  override readonly name = "RoomGitError";
  readonly outcome: "refused" | "failed";
  constructor(message: string, outcome: "refused" | "failed" = "failed") {
    super(message);
    this.outcome = outcome;
  }
}

const fail = (message: string) => Effect.fail(new RoomGitError(message));
const refuse = (message: string) => new RoomGitError(message, "refused");

/**
 * A path as the model gave it, if it is a plain repo-relative path: not
 * absolute, not climbing out, no pathspec magic, no control characters.
 */
export function repoRelativePath(input: string): string | RoomGitError {
  const trimmed = input.trim().replace(/^(\.\/)+/, "");
  if (trimmed.length === 0 || trimmed === ".") {
    return refuse("Give a file or folder path relative to the checkout.");
  }
  if (trimmed.length > PATH_MAX_LENGTH || /\p{Cc}/u.test(trimmed)) {
    return refuse("That path is not a usable file path.");
  }
  if (/^([/\\]|[A-Za-z]:)/.test(trimmed) || trimmed.startsWith(":")) {
    return refuse("Paths must be relative to the checkout, like src/app.ts.");
  }
  if (trimmed.split(/[/\\]+/).includes("..")) {
    return refuse("Paths cannot leave the checkout (`..`).");
  }
  return trimmed;
}

/** Whether a revision is worth handing to `rev-parse` at all. */
function plausibleRevision(input: string): string | RoomGitError {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > REVISION_MAX_LENGTH ||
    trimmed.startsWith("-") ||
    /[\p{Cc}\s]/u.test(trimmed)
  ) {
    return refuse(`"${trimmed.slice(0, 80)}" is not a revision. Use a branch, tag or commit id.`);
  }
  return trimmed;
}

const clipOutput = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}\n[clipped at ${limit} characters]`, truncated: true }
    : { text, truncated: false };

export interface RoomDiffInput {
  readonly cwd: string;
  readonly view: RoomDiffView;
  /** `diff`, `diff_stat`, `log`: from this revision to HEAD. `show`: the revision. */
  readonly base?: string | undefined;
  readonly path?: string | undefined;
}

export interface RoomDiffResult {
  readonly view: RoomDiffView;
  /** The resolved revisions the view used. */
  readonly base?: string;
  readonly head?: string;
  readonly output: string;
  readonly truncated: boolean;
}

export type RoomReviewBasisRequest = "uncommitted" | { readonly base: string };

export function makeRoomGit(git: Pick<GitVcsDriverShape, "execute" | "workingTreeDiff">) {
  const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `RoomGit.${operation}`,
        cwd,
        args: [...GIT_PROFILE, ...args],
        env: GIT_ENV,
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.mapError((error) => new RoomGitError(error.detail)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : fail(
                result.stderr.trim().slice(0, 500) ||
                  `git ${operation} failed with exit code ${result.exitCode}.`,
              ),
        ),
      );

  /** A revision's commit id, or a refusal naming what was asked. */
  const resolveCommit = (cwd: string, revision: string) =>
    Effect.gen(function* () {
      const plausible = plausibleRevision(revision);
      if (plausible instanceof RoomGitError) {
        return yield* Effect.fail(plausible);
      }
      const result = yield* git
        .execute({
          operation: "RoomGit.resolveCommit",
          cwd,
          args: [
            ...GIT_PROFILE,
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `${plausible}^{commit}`,
          ],
          env: GIT_ENV,
          allowNonZeroExit: true,
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        })
        .pipe(Effect.mapError((error) => new RoomGitError(error.detail)));
      const commit = result.stdout.trim();
      if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
        return yield* Effect.fail(
          refuse(`"${plausible.slice(0, 80)}" is not a commit in this checkout.`),
        );
      }
      return commit;
    });

  const pathArgs = (path: string | undefined) =>
    Effect.gen(function* () {
      if (path === undefined) {
        return [] as ReadonlyArray<string>;
      }
      const relative = repoRelativePath(path);
      if (relative instanceof RoomGitError) {
        return yield* Effect.fail(relative);
      }
      return ["--", relative] as ReadonlyArray<string>;
    });

  /** The uncommitted changes, untracked files included, via the temp index. */
  const uncommittedDiff = (cwd: string, path: string | undefined) =>
    Effect.gen(function* () {
      const paths = yield* pathArgs(path);
      const { diff } = yield* git
        .workingTreeDiff({ cwd, ...(paths.length > 0 ? { filePaths: [paths[1]!] } : {}) })
        .pipe(Effect.mapError((error) => new RoomGitError(error.detail)));
      return diff;
    });

  const view = (input: RoomDiffInput) =>
    Effect.gen(function* () {
      const paths = yield* pathArgs(input.path);
      const clipped = (text: string, extra?: { base?: string; head?: string }) => {
        const bounded = clipOutput(text, ROOM_DIFF_CHAR_LIMIT);
        return {
          view: input.view,
          ...extra,
          output: bounded.text.length > 0 ? bounded.text : "(nothing)",
          truncated: bounded.truncated,
        } satisfies RoomDiffResult;
      };
      switch (input.view) {
        case "status":
          return clipped(
            yield* run(input.cwd, "status", [
              "status",
              "--short",
              "--branch",
              "--untracked-files=all",
              ...paths,
            ]),
          );
        case "show": {
          const commit = yield* resolveCommit(input.cwd, input.base ?? "HEAD");
          return clipped(
            yield* run(input.cwd, "show", [
              "show",
              ...NO_CONVERSION,
              "--format=fuller",
              "--stat",
              "--patch",
              commit,
              ...paths,
            ]),
            { head: commit },
          );
        }
        case "log": {
          const base =
            input.base !== undefined ? yield* resolveCommit(input.cwd, input.base) : undefined;
          const head = base !== undefined ? yield* resolveCommit(input.cwd, "HEAD") : undefined;
          return clipped(
            yield* run(input.cwd, "log", [
              "log",
              "--no-color",
              "-n",
              String(LOG_ENTRIES),
              "--date=iso-strict",
              "--format=%H %ad %an%n    %s",
              ...(base !== undefined && head !== undefined ? [`${base}..${head}`] : []),
              ...paths,
            ]),
            base !== undefined && head !== undefined ? { base, head } : undefined,
          );
        }
        case "diff":
        case "diff_stat": {
          const stat = input.view === "diff_stat" ? ["--stat=200"] : ["--patch"];
          if (input.base !== undefined) {
            const base = yield* resolveCommit(input.cwd, input.base);
            const head = yield* resolveCommit(input.cwd, "HEAD");
            return clipped(
              yield* run(input.cwd, input.view, [
                "diff",
                ...NO_CONVERSION,
                ...stat,
                base,
                head,
                ...paths,
              ]),
              { base, head },
            );
          }
          if (input.view === "diff") {
            return clipped(yield* uncommittedDiff(input.cwd, input.path));
          }
          // Tracked changes against HEAD, then the untracked files by name.
          const head = yield* resolveCommit(input.cwd, "HEAD").pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const tracked =
            head !== undefined
              ? yield* run(input.cwd, "diff_stat", [
                  "diff",
                  ...NO_CONVERSION,
                  ...stat,
                  head,
                  ...paths,
                ])
              : "The checkout has no commits yet.\n";
          const untracked = (yield* run(input.cwd, "untracked", [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            ...paths,
          ]))
            .split("\0")
            .filter((entry) => entry.length > 0);
          return clipped(
            [
              tracked.trimEnd(),
              ...(untracked.length > 0
                ? [`Untracked files (${untracked.length}):`, ...untracked.map((f) => `  ${f}`)]
                : []),
            ]
              .filter((part) => part.length > 0)
              .join("\n"),
            head !== undefined ? { head } : undefined,
          );
        }
      }
    });

  /**
   * What an independent review is handed besides its request: the diff it
   * is asked to review, captured once, now, and bounded.
   */
  const captureReviewBasis = (cwd: string, request: RoomReviewBasisRequest) =>
    Effect.gen(function* () {
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      if (request === "uncommitted") {
        const head = yield* resolveCommit(cwd, "HEAD").pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const diff = yield* uncommittedDiff(cwd, undefined);
        const bounded = clipOutput(diff, ROOM_REVIEW_DIFF_CHAR_LIMIT);
        return {
          basis: {
            kind: "uncommitted",
            ...(head !== undefined ? { base: head } : {}),
            files: countDiffFiles(diff),
            truncated: bounded.truncated || diff.includes("\n\n[truncated]"),
            capturedAt,
          },
          diff: bounded.text,
        } satisfies RoomReviewInput;
      }
      const base = yield* resolveCommit(cwd, request.base);
      const head = yield* resolveCommit(cwd, "HEAD");
      const diff = yield* run(cwd, "reviewDiff", ["diff", ...NO_CONVERSION, "--patch", base, head]);
      const names = yield* run(cwd, "reviewFiles", [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "-z",
        base,
        head,
      ]);
      const bounded = clipOutput(diff, ROOM_REVIEW_DIFF_CHAR_LIMIT);
      return {
        basis: {
          kind: "range",
          base,
          head,
          files: names.split("\0").filter((entry) => entry.length > 0).length,
          truncated: bounded.truncated || diff.includes("\n\n[truncated]"),
          capturedAt,
        },
        diff: bounded.text,
      } satisfies RoomReviewInput;
    });

  return { view, captureReviewBasis };
}

/** Files in a unified diff, counted by their headers. */
const countDiffFiles = (diff: string) => diff.match(/^diff --git /gm)?.length ?? 0;
