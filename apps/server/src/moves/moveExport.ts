// @effect-diagnostics nodeBuiltinImport:off
/**
 * Packing a thread to move it to a linked computer (docs/design/fleet.md,
 * Part 3, "Export on A"): what its checkout holds that the other computer
 * can't get from the remote (unpushed commits as a git bundle, tracked
 * changes as a binary diff, untracked files byte for byte), its messages'
 * attachments, and its history, as one payload file with a part table and a
 * manifest. Written once to temp names and renamed, so a finished export is
 * whole; a resumed move re-reads it and checks its hash.
 */
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationThread,
  OrchestrationThreadActivity,
  PeerMoveManifest,
  PeerMovePart,
  ThreadId,
  ThreadImportMessage,
  ThreadMoveId,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

/** A move that can't go on, with the reason in words for the user. */
export class ThreadMoveFailure extends Data.TaggedError("ThreadMoveFailure")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/** The checkout changed while it was being packed. */
class CheckoutChanged extends Data.TaggedError("CheckoutChanged")<{}> {}

/** The most a move carries in v1. */
export const MOVE_MAX_BYTES = 100 * 1024 * 1024;
/** At most this many tool steps travel with the history (the newest). */
const MOVE_MAX_ACTIVITIES = 300;
/** A tool step's details bigger than this travel without them. */
const MOVE_MAX_ACTIVITY_PAYLOAD_CHARS = 16_000;

const fail = (reason: string) => Effect.fail(new ThreadMoveFailure({ reason }));

const fsCall = <A>(reason: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new ThreadMoveFailure({ reason }) });

/** Runs git in `cwd`; a non-zero exit fails with `reason`. */
function gitOk(
  git: GitVcsDriverShape,
  cwd: string,
  args: ReadonlyArray<string>,
  reason: string,
  maxOutputBytes?: number,
) {
  return git
    .execute({
      operation: "thread-move",
      cwd,
      args,
      allowNonZeroExit: true,
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    })
    .pipe(
      Effect.mapError(() => new ThreadMoveFailure({ reason })),
      Effect.flatMap((result) =>
        result.exitCode === 0 ? Effect.succeed(result.stdout) : fail(reason),
      ),
    );
}

/** Runs git in `cwd`; null when it exits non-zero. */
function gitMaybe(git: GitVcsDriverShape, cwd: string, args: ReadonlyArray<string>) {
  return git.execute({ operation: "thread-move", cwd, args, allowNonZeroExit: true }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  );
}

const splitZ = (stdout: string) => stdout.split("\0").filter((entry) => entry.length > 0);

/** Where a thread's checkout stands, as the move needs it. */
export interface MoveCheckout {
  readonly root: string;
  readonly headSha: string;
  /** Null: a detached head. */
  readonly branch: string | null;
  readonly remoteName: string;
  /** The last commit the remote has; null when the head itself is there (nothing unpushed). */
  readonly baseSha: string | null;
  readonly unpushedCommits: number;
}

/**
 * The checkout's root, head, branch, and the commit the remote already has
 * (the merge base with the upstream, else with the remote's default branch):
 * the bundle carries only what comes after it.
 */
export function inspectMoveCheckout(
  git: GitVcsDriverShape,
  cwd: string,
  remoteName: string,
): Effect.Effect<MoveCheckout, ThreadMoveFailure> {
  return Effect.gen(function* () {
    const root = (yield* gitOk(
      git,
      cwd,
      ["rev-parse", "--show-toplevel"],
      "This thread's folder isn't a git checkout.",
    )).trim();
    const headSha = (yield* gitOk(
      git,
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "This thread's checkout has no commits yet.",
    )).trim();
    const branch = yield* gitMaybe(git, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream =
      branch === null
        ? null
        : yield* gitMaybe(git, root, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            `${branch}@{upstream}`,
          ]);
    const candidates = [
      ...(upstream !== null && upstream.startsWith(`${remoteName}/`) ? [upstream] : []),
      `${remoteName}/HEAD`,
      `${remoteName}/main`,
      `${remoteName}/master`,
    ];
    let baseSha: string | null = null;
    for (const ref of candidates) {
      baseSha = yield* gitMaybe(git, root, ["merge-base", headSha, ref]);
      if (baseSha !== null && baseSha.length > 0) break;
      baseSha = null;
    }
    if (baseSha === null) {
      return yield* fail(
        `Can't tell which commits ${remoteName} already has. Fetch or push this branch, then try again.`,
      );
    }
    const unpushed =
      baseSha === headSha
        ? 0
        : Number.parseInt(
            (yield* gitOk(
              git,
              root,
              ["rev-list", "--count", `${baseSha}..${headSha}`],
              "Couldn't count this branch's commits.",
            )).trim(),
            10,
          ) || 0;
    return {
      root,
      headSha,
      branch,
      remoteName,
      baseSha: baseSha === headSha ? null : baseSha,
      unpushedCommits: unpushed,
    };
  });
}

/** Tracked files with changes, and untracked files, from the checkout's root. */
export function summarizeMoveChanges(git: GitVcsDriverShape, root: string) {
  return Effect.gen(function* () {
    const tracked = splitZ(
      yield* gitOk(
        git,
        root,
        ["diff", "--name-only", "-z", "--no-renames", "HEAD"],
        "Couldn't read this thread's changes.",
        8_000_000,
      ),
    );
    const untracked = splitZ(
      yield* gitOk(
        git,
        root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        "Couldn't list this thread's new files.",
        8_000_000,
      ),
    );
    return { tracked, untracked };
  });
}

/** The flags that make `git diff` a faithful, applicable patch whatever the checkout's config says. */
const TRANSPORT_DIFF_FLAGS = [
  "diff",
  "--binary",
  "--full-index",
  "--no-textconv",
  "--no-ext-diff",
  "--no-color",
  "--no-relative",
  "--no-renames",
];

/**
 * What the checkout looks like right now: its head, the hash of its tracked
 * changes as they would be packed, its status, and each untracked file's size
 * and time. Equal before and after packing means nothing changed meanwhile.
 */
function checkoutFingerprint(
  git: GitVcsDriverShape,
  root: string,
  untracked: ReadonlyArray<string>,
  scratch: string,
) {
  return Effect.gen(function* () {
    const head = yield* gitOk(
      git,
      root,
      ["rev-parse", "HEAD"],
      "Couldn't read this thread's checkout.",
    );
    yield* gitOk(
      git,
      root,
      [...TRANSPORT_DIFF_FLAGS, `--output=${scratch}`, "HEAD"],
      "Couldn't read this thread's changes.",
    );
    const diffHash = yield* sha256OfFile(scratch);
    yield* fsCall("Couldn't tidy up.", () => NodeFs.rm(scratch, { force: true }));
    const status = yield* gitOk(
      git,
      root,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      "Couldn't read this thread's checkout.",
      8_000_000,
    );
    const stats = yield* Effect.forEach(untracked, (path) =>
      fsCall("Couldn't read a new file.", () => NodeFs.lstat(NodePath.join(root, path))).pipe(
        Effect.map((stat) => `${path}:${stat.size}:${stat.mtimeMs}`),
      ),
    );
    return { head: head.trim(), key: `${head}\n${diffHash}\n${status}\n${stats.join("\n")}` };
  });
}

/**
 * One part of the payload, known by its size before any of it is read, so a
 * move over the limit is refused without loading it; read one at a time.
 */
interface PendingPart {
  readonly kind: PeerMovePart["kind"];
  readonly size: number;
  readonly read: () => Promise<Buffer>;
  readonly path?: string;
  readonly mode?: NonNullable<PeerMovePart["mode"]>;
  readonly attachmentId?: string;
}

/** The thread's history, as the move carries it: finished messages and its newest tool steps. */
export function exportThreadHistory(thread: OrchestrationThread): {
  readonly messages: ReadonlyArray<ThreadImportMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
} {
  const messages = thread.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.sideTurnId === undefined &&
        (message.text.length > 0 || (message.attachments?.length ?? 0) > 0),
    )
    .map((message): ThreadImportMessage => ({
      messageId: message.id,
      role: message.role === "assistant" ? "assistant" : "user",
      text: message.text,
      ...(message.attachments !== undefined && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      turnId: message.turnId,
      createdAt: message.createdAt,
    }));
  const activities = thread.activities
    .filter((activity) => activity.tone === "tool" && activity.sideTurnId === undefined)
    .slice(-MOVE_MAX_ACTIVITIES)
    .map((activity) => {
      const payloadSize = JSON.stringify(activity.payload ?? null)?.length ?? 0;
      return {
        id: activity.id,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: payloadSize > MOVE_MAX_ACTIVITY_PAYLOAD_CHARS ? {} : activity.payload,
        turnId: null,
        createdAt: activity.createdAt,
      } satisfies OrchestrationThreadActivity;
    });
  return { messages, activities };
}

export interface MoveExportInput {
  readonly git: GitVcsDriverShape;
  readonly checkout: MoveCheckout;
  readonly transferId: ThreadMoveId;
  /** `<stateDir>/moves/<transferId>`. */
  readonly dir: string;
  readonly attachmentsDir: string;
  readonly thread: OrchestrationThread;
  readonly projectTitle: string;
  readonly canonicalKey: string;
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly threadId: ThreadId;
  };
  readonly agent: ModelSelection;
}

/** Where the export lives: `payload.bin` and `manifest.json` in the transfer's folder. */
export const movePayloadPath = (dir: string) => NodePath.join(dir, "payload.bin");
const moveManifestPath = (dir: string) => NodePath.join(dir, "manifest.json");

/** The manifest of an export finished earlier, or null when there is none. */
export function readMoveExport(dir: string) {
  return Effect.tryPromise({
    try: async () => JSON.parse(await NodeFs.readFile(moveManifestPath(dir), "utf8")) as unknown,
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
}

/** sha256 of a file, hex. */
export function sha256OfFile(path: string) {
  return fsCall("Couldn't read the packed thread.", async () => {
    const hash = createHash("sha256");
    const handle = await NodeFs.open(path, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  });
}

/**
 * Packs the thread. The checkout is read twice around the packing; if it
 * changed meanwhile (a terminal, another writer, a new commit), the packing
 * runs once more, then gives up. Sizes are checked before anything is read,
 * and parts are written one at a time.
 */
export function writeMoveExport(
  input: MoveExportInput,
): Effect.Effect<PeerMoveManifest, ThreadMoveFailure> {
  const { git, checkout, dir } = input;
  const root = checkout.root;
  const attempt = Effect.gen(function* () {
    yield* fsCall("Couldn't make room to pack this thread.", () =>
      NodeFs.mkdir(dir, { recursive: true }),
    );
    const scratch = NodePath.join(dir, "fingerprint.tmp");
    const { tracked, untracked } = yield* summarizeMoveChanges(git, root);
    const before = yield* checkoutFingerprint(git, root, untracked, scratch);
    if (before.head !== checkout.headSha) return yield* new CheckoutChanged();

    // Submodule and Git LFS changes can't travel as a diff.
    const raw = yield* gitOk(
      git,
      root,
      ["diff", "--raw", "-z", "--no-renames", "HEAD"],
      "Couldn't read this thread's changes.",
      8_000_000,
    );
    if (/(^|\0):?160000 |:\d{6} 160000 /.test(raw)) {
      return yield* fail("Changed submodules can't move yet.");
    }
    const changedPaths = [...tracked, ...untracked];
    if (changedPaths.length > 0) {
      const attributes = yield* git
        .execute({
          operation: "thread-move",
          cwd: root,
          args: ["check-attr", "-z", "--stdin", "filter"],
          stdin: `${changedPaths.join("\0")}\0`,
          allowNonZeroExit: true,
          maxOutputBytes: 8_000_000,
        })
        .pipe(
          Effect.mapError(
            () => new ThreadMoveFailure({ reason: "Couldn't read this thread's file attributes." }),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : fail("Couldn't read this thread's file attributes."),
          ),
        );
      const fields = attributes.split("\0");
      for (let index = 0; index + 2 < fields.length; index += 3) {
        if (fields[index + 2] === "lfs") {
          return yield* fail(
            `${fields[index]} is a Git LFS file. Changed LFS files can't move yet.`,
          );
        }
      }
    }

    const parts: PendingPart[] = [];
    const fileSize = (path: string) =>
      fsCall("Couldn't read the packed thread.", () => NodeFs.stat(path)).pipe(
        Effect.map((stat) => stat.size),
      );
    if (checkout.baseSha !== null) {
      const ref = `refs/threadlines/move/${input.transferId}`;
      const bundlePath = NodePath.join(dir, "bundle.tmp");
      yield* gitOk(
        git,
        root,
        ["update-ref", ref, checkout.headSha],
        "Couldn't mark this branch's commits.",
      );
      yield* gitOk(
        git,
        root,
        ["bundle", "create", bundlePath, ref, `^${checkout.baseSha}`],
        "Couldn't pack this branch's commits.",
      ).pipe(Effect.ensuring(gitMaybe(git, root, ["update-ref", "-d", ref])));
      parts.push({
        kind: "bundle",
        size: yield* fileSize(bundlePath),
        read: () => NodeFs.readFile(bundlePath),
      });
    }
    if (tracked.length > 0) {
      const diffPath = NodePath.join(dir, "diff.tmp");
      yield* gitOk(
        git,
        root,
        [...TRANSPORT_DIFF_FLAGS, `--output=${diffPath}`, "HEAD"],
        "Couldn't pack this thread's changes.",
      );
      parts.push({
        kind: "diff",
        size: yield* fileSize(diffPath),
        read: () => NodeFs.readFile(diffPath),
      });
    }
    for (const path of untracked) {
      const absolute = NodePath.join(root, path);
      const stat = yield* fsCall(`Couldn't read ${path}.`, () => NodeFs.lstat(absolute));
      if (stat.isSymbolicLink()) {
        const target = yield* fsCall(`Couldn't read ${path}.`, () => NodeFs.readlink(absolute));
        const bytes = Buffer.from(target, "utf8");
        parts.push({
          kind: "file",
          path,
          mode: "symlink",
          size: bytes.length,
          read: async () => bytes,
        });
      } else if (stat.isFile()) {
        parts.push({
          kind: "file",
          path,
          mode: (stat.mode & 0o111) !== 0 ? "executable" : "file",
          size: stat.size,
          read: () => NodeFs.readFile(absolute),
        });
      } else {
        return yield* fail(`${path} isn't a regular file, so it can't move.`);
      }
    }
    const history = exportThreadHistory(input.thread);
    const attachmentIds = new Set<string>();
    for (const message of history.messages) {
      for (const attachment of message.attachments ?? []) {
        if (attachmentIds.has(attachment.id)) continue;
        attachmentIds.add(attachment.id);
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        // A missing attachment travels as its name alone.
        const size =
          path === null ? null : yield* fileSize(path).pipe(Effect.orElseSucceed(() => null));
        if (path !== null && size !== null) {
          parts.push({
            kind: "attachment",
            attachmentId: attachment.id,
            size,
            read: () => NodeFs.readFile(path),
          });
        }
      }
    }

    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (totalBytes > MOVE_MAX_BYTES) {
      return yield* fail(
        `This thread's changes come to ${Math.ceil(totalBytes / (1024 * 1024))} MB. Moves carry at most 100 MB.`,
      );
    }

    const payloadTemp = NodePath.join(dir, "payload.bin.tmp");
    const whole = createHash("sha256");
    let offset = 0;
    const table: PeerMovePart[] = [];
    let resized = false;
    yield* fsCall("Couldn't write the packed thread.", async () => {
      const handle = await NodeFs.open(payloadTemp, "w");
      try {
        for (const part of parts) {
          const bytes = await part.read();
          // Changed since it was sized: pack it again.
          if (bytes.length !== part.size) {
            resized = true;
            break;
          }
          await handle.write(bytes);
          whole.update(bytes);
          table.push({
            kind: part.kind,
            offset,
            length: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            ...(part.path !== undefined ? { path: part.path } : {}),
            ...(part.mode !== undefined ? { mode: part.mode } : {}),
            ...(part.attachmentId !== undefined ? { attachmentId: part.attachmentId } : {}),
          });
          offset += bytes.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    yield* fsCall("Couldn't tidy up.", async () => {
      await NodeFs.rm(NodePath.join(dir, "bundle.tmp"), { force: true });
      await NodeFs.rm(NodePath.join(dir, "diff.tmp"), { force: true });
    });
    if (resized) return yield* new CheckoutChanged();

    const after = yield* checkoutFingerprint(git, root, untracked, scratch);
    if (after.key !== before.key) return yield* new CheckoutChanged();

    const manifest: PeerMoveManifest = {
      totalBytes,
      sha256: whole.digest("hex"),
      parts: table,
      source: input.source,
      project: { canonicalKey: input.canonicalKey, title: input.projectTitle },
      git: { headSha: checkout.headSha, branch: checkout.branch, baseSha: checkout.baseSha },
      thread: {
        title: input.thread.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        messages: history.messages,
        activities: history.activities,
      },
      agent: input.agent,
      summary: {
        messageCount: history.messages.length,
        trackedFiles: tracked.length,
        untrackedFiles: untracked.length,
        unpushedCommits: checkout.unpushedCommits,
      },
    };
    const manifestTemp = `${moveManifestPath(dir)}.tmp`;
    yield* fsCall("Couldn't write the packed thread.", async () => {
      await NodeFs.writeFile(manifestTemp, JSON.stringify(manifest));
      await NodeFs.rename(payloadTemp, movePayloadPath(dir));
      await NodeFs.rename(manifestTemp, moveManifestPath(dir));
    });
    return manifest;
  });
  const changedReason = "The checkout changed while this thread was being packed. Try again.";
  return attempt.pipe(
    Effect.catchTag("CheckoutChanged", () => attempt),
    Effect.catchTag("CheckoutChanged", () => fail(changedReason)),
  );
}
