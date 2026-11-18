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
import { createHash, randomUUID } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as os from "node:os";
import * as NodePath from "node:path";

import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationOutsideWork,
  OrchestrationThread,
  OrchestrationThreadActivity,
  PeerMoveFamily,
  PeerMoveLinkLineage,
  PeerMoveGitManifest,
  PeerMoveManifest,
  PeerMovePart,
  PeerMoveRoom,
  PeerMoveRoomParticipant,
  PeerMoveScratchManifest,
  PeerMoveThreadState,
  ThreadId,
  ThreadImportMessage,
  ThreadMoveId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { ThreadMoveCarry } from "../orchestration/threadMoveCarry.ts";
import { NATIVE_SESSION_MAX_BYTES, type NativeSessionExport } from "../provider/nativeSession.ts";
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
  /** The branch on the remote that `branch` tracks; null: none, or another remote's. */
  readonly upstreamBranch: string | null;
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
      upstreamBranch:
        upstream !== null && upstream.startsWith(`${remoteName}/`)
          ? upstream.slice(remoteName.length + 1)
          : null,
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
 * What the checkout looks like right now: its head, which files changed and
 * which are new, its tracked changes as they would be packed (written to
 * `diffPath`, and hashed), its status, and each new file's size and time.
 * The packing uses this snapshot's own lists and diff, so a snapshot taken
 * after packing that equals it means what was packed is what's there.
 */
function checkoutFingerprint(git: GitVcsDriverShape, root: string, diffPath: string) {
  return Effect.gen(function* () {
    const head = yield* gitOk(
      git,
      root,
      ["rev-parse", "HEAD"],
      "Couldn't read this thread's checkout.",
    );
    const { tracked, untracked } = yield* summarizeMoveChanges(git, root);
    yield* gitOk(
      git,
      root,
      [...TRANSPORT_DIFF_FLAGS, `--output=${diffPath}`, "HEAD"],
      "Couldn't read this thread's changes.",
    );
    const diffHash = yield* sha256OfFile(diffPath);
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
    return {
      head: head.trim(),
      tracked,
      untracked,
      key: [head, tracked.join("\0"), untracked.join("\0"), diffHash, status, ...stats].join("\n"),
    };
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
  readonly participantId?: ThreadParticipantId;
}

/**
 * The thread's history, as the move carries it: finished messages and its
 * newest tool steps. `room`: for a computer that takes rooms (Part 3f, (i)),
 * each message keeps the agent it was to or from and the request it made or
 * answered; an older one gets them as plain messages.
 */
export function exportThreadHistory(
  thread: OrchestrationThread,
  options: {
    readonly room?: boolean;
    /**
     * A family's members (Part 3f, (g)): a request or report between them
     * keeps where it came from; one naming any other thread goes plain.
     */
    readonly familyThreadIds?: ReadonlySet<string> | undefined;
  } = {},
): {
  readonly messages: ReadonlyArray<ThreadImportMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
} {
  // An agent's message still waiting in the queue is written into the chat
  // but never ran here, and only the user's own queued messages move: it
  // arrives as never sent (reachedAgent), so no history there carries it.
  const queuedIds = new Set((thread.queuedFollowUps ?? []).map((queued) => queued.messageId));
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
      ...(message.agentModels !== undefined ? { agentModels: message.agentModels } : {}),
      // Who wrote it only; the thread's own outsideOrigin stays here.
      ...(message.fromOutside !== undefined ? { fromOutside: message.fromOutside } : {}),
      ...(message.sentFrom !== undefined ? { sentFrom: message.sentFrom } : {}),
      ...(message.trigger !== undefined ? { trigger: message.trigger } : {}),
      ...(message.notSent === true || queuedIds.has(message.id) ? { notSent: true as const } : {}),
      ...(options.room === true ? roomFieldsOf(message) : {}),
      ...familyFieldsOf(message, options.familyThreadIds),
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

/**
 * Where a family's message came from (a request or report between members),
 * as the move carries it: only between threads that move together on this
 * computer, never a lead chat's pass or a thread on another computer.
 */
function familyFieldsOf(
  message: OrchestrationThread["messages"][number],
  familyThreadIds: ReadonlySet<string> | undefined,
) {
  const origin = message.fromThread;
  if (
    familyThreadIds === undefined ||
    origin === undefined ||
    origin.environmentId !== undefined ||
    origin.ceiling !== undefined ||
    !familyThreadIds.has(origin.threadId)
  ) {
    return {};
  }
  return {
    fromThread: { threadId: origin.threadId, requestId: origin.requestId, kind: origin.kind },
  };
}

/** A room message's own fields, as the move carries them. */
function roomFieldsOf(message: OrchestrationThread["messages"][number]) {
  return {
    ...(message.participantId !== undefined && message.participantId !== null
      ? { participantId: message.participantId }
      : {}),
    ...(message.fromAgent !== undefined ? { fromAgent: message.fromAgent } : {}),
    ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
    ...(message.requestKind !== undefined ? { requestKind: message.requestKind } : {}),
    ...(message.requestOutcome !== undefined ? { requestOutcome: message.requestOutcome } : {}),
    ...(message.requestError !== undefined ? { requestError: message.requestError } : {}),
  };
}

/**
 * About how many bytes a move of this thread carries besides its agent's
 * session, without packing it: the commits the remote lacks (their objects'
 * size on disk), the tracked changes as the export writes them, the new
 * files and the attachments. The preview weighs a session against it as the
 * export does (nativeSessionFits). A part it can't read counts nothing.
 */
export function estimateMoveOtherBytes(input: {
  readonly git: GitVcsDriverShape;
  readonly checkout: MoveCheckout;
  readonly thread: OrchestrationThread;
  readonly attachmentsDir: string;
}) {
  const { git, checkout } = input;
  const sizeOf = (path: string) =>
    Effect.promise(() =>
      NodeFs.stat(path)
        .then((stat) => stat.size)
        .catch(() => 0),
    );
  return Effect.gen(function* () {
    let bytes = 0;
    if (checkout.baseSha !== null) {
      const used = yield* gitMaybe(git, checkout.root, [
        "rev-list",
        "--objects",
        "--disk-usage",
        `${checkout.baseSha}..${checkout.headSha}`,
      ]);
      bytes += Number.parseInt(used ?? "", 10) || 0;
    }
    // The diff holds the checkout's private changes: it is written inside a
    // folder only this user can open (mkdtemp makes it 0700), and the folder
    // goes however the estimate ends.
    bytes += yield* Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(os.tmpdir(), "threadlines-move-estimate-")),
      ),
      (dir) =>
        Effect.gen(function* () {
          const diffPath = NodePath.join(dir, "changes.diff");
          const diffed = yield* gitMaybe(git, checkout.root, [
            ...TRANSPORT_DIFF_FLAGS,
            `--output=${diffPath}`,
            "HEAD",
          ]);
          return diffed === null ? 0 : yield* sizeOf(diffPath);
        }),
      (dir) => Effect.promise(() => NodeFs.rm(dir, { recursive: true, force: true })),
    );
    const { untracked } = yield* summarizeMoveChanges(git, checkout.root).pipe(
      Effect.orElseSucceed(() => ({ untracked: [] as ReadonlyArray<string> })),
    );
    for (const path of untracked) bytes += yield* sizeOf(NodePath.join(checkout.root, path));
    const seen = new Set<string>();
    for (const message of exportThreadHistory(input.thread).messages) {
      for (const attachment of message.attachments ?? []) {
        if (seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        if (path !== null) bytes += yield* sizeOf(path);
      }
    }
    return bytes;
  });
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
  /** The project's folder in the repository ("" at the root). */
  readonly subdirectory: string;
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly threadId: ThreadId;
  };
  readonly agent: ModelSelection;
  /**
   * The agent session to carry (docs/design/fleet.md, Part 3d), when the
   * other computer takes it and its agent is the same driver. It goes only
   * within both caps; past either, the move goes without it and says why.
   */
  readonly nativeSession?: NativeSessionExport | null | undefined;
  /**
   * What the thread had going (moveThreadStateOf), for a computer that takes
   * it; its queued messages' attachments travel as parts.
   */
  readonly state?: PeerMoveThreadState | undefined;
  /** What a room carries besides its history (Part 3f, (i)): see MoveRoomExport. */
  readonly room?: MoveRoomExport | undefined;
  /** The outside-work marks, for a computer that takes them. */
  readonly outsideWork?: ReadonlyArray<OrchestrationOutsideWork> | undefined;
  /**
   * Its family (Part 3f, (g)), for a computer that takes families. With
   * `sharesCheckoutOf`, the folder is another member's to send: this one
   * carries none of its files.
   */
  readonly family?: PeerMoveFamily | undefined;
  /** The family's members here, whose requests and reports keep their origin. */
  readonly familyThreadIds?: ReadonlySet<string> | undefined;
  /** It moves across the link its work came over (Part 3f, (h)): see PeerMoveLinkLineage. */
  readonly linkLineage?: PeerMoveLinkLineage | undefined;
}

/**
 * A room as the move carries it (docs/design/fleet.md, Part 3f, (i)), for a
 * computer that takes rooms: its agents' records (with the agent each moves
 * as) and the sessions to carry, one per agent of the same driver there.
 * Its messages keep their room fields.
 */
export interface MoveRoomExport {
  readonly agentRole?: string | undefined;
  /** The last moved message the thread's own agent's session saw (seenThroughOf). */
  readonly ownAgentSeenThroughMessageId?: MessageId | undefined;
  readonly participants: ReadonlyArray<Omit<PeerMoveRoomParticipant, "session" | "sessionOmitted">>;
  readonly sessions: ReadonlyArray<{
    readonly participantId: ThreadParticipantId;
    readonly session: NativeSessionExport;
  }>;
}

/**
 * Whether a session of `sessionBytes` fits a move whose other parts come to
 * `otherBytes`: at most 50 MB itself, and the move at most its 100 MB.
 */
export const nativeSessionFits = (sessionBytes: number, otherBytes: number) =>
  sessionBytes <= NATIVE_SESSION_MAX_BYTES && otherBytes + sessionBytes <= MOVE_MAX_BYTES;

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
): Effect.Effect<PeerMoveGitManifest, ThreadMoveFailure> {
  if (input.family?.sharesCheckoutOf !== undefined) return writeSharerExport(input);
  const { git, checkout, dir } = input;
  const root = checkout.root;
  const attempt = Effect.gen(function* () {
    yield* fsCall("Couldn't make room to pack this thread.", () =>
      NodeFs.mkdir(dir, { recursive: true }),
    );
    const diffPath = NodePath.join(dir, "diff.tmp");
    const afterDiffPath = NodePath.join(dir, "diff.after.tmp");
    const before = yield* checkoutFingerprint(git, root, diffPath);
    const { tracked, untracked } = before;
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
    // The snapshot's own diff: what the snapshot after packing is checked against.
    const diffSize = yield* fileSize(diffPath);
    if (diffSize > 0) {
      parts.push({ kind: "diff", size: diffSize, read: () => NodeFs.readFile(diffPath) });
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
    const history = exportThreadHistory(input.thread, {
      room: input.room !== undefined,
      familyThreadIds: input.familyThreadIds,
    });
    parts.push(...(yield* attachmentParts(history, input.attachmentsDir, input.state)));
    const otherBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (otherBytes > MOVE_MAX_BYTES) {
      return yield* fail(
        `This thread's changes come to ${Math.ceil(otherBytes / (1024 * 1024))} MB. Moves carry at most 100 MB.`,
      );
    }
    const session = yield* sessionParts(
      input.nativeSession ?? null,
      input.room?.sessions ?? [],
      otherBytes,
    );
    parts.push(...session.parts);

    const payload = yield* writePayload(dir, parts);
    if (payload === null) return yield* new CheckoutChanged();
    const after = yield* checkoutFingerprint(git, root, afterDiffPath);
    yield* fsCall("Couldn't tidy up.", async () => {
      await NodeFs.rm(NodePath.join(dir, "bundle.tmp"), { force: true });
      await NodeFs.rm(diffPath, { force: true });
      await NodeFs.rm(afterDiffPath, { force: true });
    });
    if (after.key !== before.key) return yield* new CheckoutChanged();

    const manifest: PeerMoveGitManifest = {
      totalBytes: payload.totalBytes,
      sha256: payload.sha256,
      parts: payload.table,
      source: input.source,
      project: {
        canonicalKey: input.canonicalKey,
        subdirectory: input.subdirectory,
        title: input.projectTitle,
      },
      git: {
        headSha: checkout.headSha,
        branch: checkout.branch,
        baseSha: checkout.baseSha,
        ...(checkout.upstreamBranch !== null ? { upstreamBranch: checkout.upstreamBranch } : {}),
      },
      thread: {
        title: input.thread.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        messages: history.messages,
        activities: history.activities,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...roomManifestOf(input, session.room),
      },
      agent: input.agent,
      summary: {
        messageCount: history.messages.length,
        trackedFiles: tracked.length,
        untrackedFiles: untracked.length,
        unpushedCommits: checkout.unpushedCommits,
      },
      ...session.manifest,
      ...(input.family !== undefined ? { family: input.family } : {}),
      ...(input.linkLineage !== undefined ? { linkLineage: input.linkLineage } : {}),
    };
    yield* writeManifest(dir, manifest);
    return manifest;
  });
  const changedReason = "The checkout changed while this thread was being packed. Try again.";
  return attempt.pipe(
    Effect.catchTag("CheckoutChanged", () => attempt),
    Effect.catchTag("CheckoutChanged", () => fail(changedReason)),
  );
}

/**
 * Packs a family member that works in another member's folder (docs/design/
 * fleet.md, Part 3f, (g)): its history, attachments, state and session, but
 * none of the folder's files, which the folder's owner sends. The other
 * computer puts it in the folder that owner's move makes. `git` says where
 * the folder stands, for the record; with no commits of its own it names no
 * base.
 */
function writeSharerExport(
  input: MoveExportInput,
): Effect.Effect<PeerMoveGitManifest, ThreadMoveFailure> {
  return Effect.gen(function* () {
    yield* fsCall("Couldn't make room to pack this thread.", () =>
      NodeFs.mkdir(input.dir, { recursive: true }),
    );
    const history = exportThreadHistory(input.thread, {
      room: input.room !== undefined,
      familyThreadIds: input.familyThreadIds,
    });
    const parts = [...(yield* attachmentParts(history, input.attachmentsDir, input.state))];
    const otherBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (otherBytes > MOVE_MAX_BYTES) {
      return yield* fail(
        `This thread's attachments come to ${Math.ceil(otherBytes / (1024 * 1024))} MB. Moves carry at most 100 MB.`,
      );
    }
    const session = yield* sessionParts(
      input.nativeSession ?? null,
      input.room?.sessions ?? [],
      otherBytes,
    );
    parts.push(...session.parts);
    const payload = yield* writePayload(input.dir, parts);
    if (payload === null) {
      return yield* fail("This thread's attachments changed while it was being packed. Try again.");
    }
    const checkout = input.checkout;
    const manifest: PeerMoveGitManifest = {
      totalBytes: payload.totalBytes,
      sha256: payload.sha256,
      parts: payload.table,
      source: input.source,
      project: {
        canonicalKey: input.canonicalKey,
        subdirectory: input.subdirectory,
        title: input.projectTitle,
      },
      git: {
        headSha: checkout.headSha,
        branch: checkout.branch,
        baseSha: null,
        ...(checkout.upstreamBranch !== null ? { upstreamBranch: checkout.upstreamBranch } : {}),
      },
      thread: {
        title: input.thread.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        messages: history.messages,
        activities: history.activities,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...roomManifestOf(input, session.room),
      },
      agent: input.agent,
      summary: {
        messageCount: history.messages.length,
        trackedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 0,
      },
      ...session.manifest,
      ...(input.family !== undefined ? { family: input.family } : {}),
      ...(input.linkLineage !== undefined ? { linkLineage: input.linkLineage } : {}),
    };
    yield* writeManifest(input.dir, manifest);
    return manifest;
  });
}

/**
 * The attachments a move carries, one part each: its history's messages', and
 * its queued messages' (docs/design/fleet.md, Part 3e, (e)). A missing one
 * travels as its name alone.
 */
function attachmentParts(
  history: ReturnType<typeof exportThreadHistory>,
  attachmentsDir: string,
  state: PeerMoveThreadState | undefined,
) {
  return Effect.gen(function* () {
    const parts: PendingPart[] = [];
    const seen = new Set<string>();
    const carriers = [...history.messages, ...(state?.queuedFollowUps ?? [])];
    for (const message of carriers) {
      for (const attachment of message.attachments ?? []) {
        if (seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        const size =
          path === null
            ? null
            : yield* fsCall("Couldn't read the packed thread.", () => NodeFs.stat(path)).pipe(
                Effect.map((stat) => stat.size),
                Effect.orElseSucceed(() => null),
              );
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
    return parts;
  });
}

/**
 * Which agents' sessions fit a move that carries `otherBytes` besides them
 * (Part 3f, (i): they share the move's 100 MB, at most 50 MB each): any
 * over 50 MB stays behind, then the largest go as a summary first until the
 * rest fit. Keys are whatever the caller names the sessions by.
 */
export function sessionsThatFit<Key>(
  sessions: ReadonlyArray<{ readonly key: Key; readonly bytes: number }>,
  otherBytes: number,
): ReadonlySet<Key> {
  const kept = sessions
    .filter((session) => session.bytes <= NATIVE_SESSION_MAX_BYTES)
    .toSorted((left, right) => left.bytes - right.bytes);
  let total = kept.reduce((sum, session) => sum + session.bytes, 0);
  while (kept.length > 0 && otherBytes + total > MOVE_MAX_BYTES) {
    total -= kept.pop()!.bytes;
  }
  return new Set(kept.map((session) => session.key));
}

/**
 * The agents' sessions as parts, last and only within the caps
 * (sessionsThatFit): the thread's own agent's, and a room's agents' (each
 * part naming its agent). One past them goes without, its agent gets a
 * summary, and the manifest says why. A session file that can't be read,
 * or vanished since it was found, leaves that session behind; it never
 * fails the move.
 */
function sessionParts(
  primary: NativeSessionExport | null,
  room: MoveRoomExport["sessions"],
  otherBytes: number,
) {
  return Effect.gen(function* () {
    const all = [
      ...(primary !== null ? [{ key: null, session: primary }] : []),
      ...room.map((entry) => ({ key: entry.participantId, session: entry.session })),
    ];
    const sizeOf = (session: NativeSessionExport) =>
      session.files.reduce((sum, file) => sum + file.size, 0);
    const sized = sessionsThatFit(
      all.map((entry) => ({ key: entry.key, bytes: sizeOf(entry.session) })),
      otherBytes,
    );
    const read = new Map<ThreadParticipantId | null, ReadonlyArray<Buffer>>();
    for (const entry of all) {
      if (!sized.has(entry.key)) continue;
      const bytes = yield* Effect.tryPromise(() =>
        Promise.all(entry.session.files.map((file) => NodeFs.readFile(file.absolutePath))),
      ).pipe(Effect.orElseSucceed(() => null));
      if (bytes !== null) read.set(entry.key, bytes);
    }
    // Weighed again as read: a file that grew since it was sized may tip it over.
    const packed = sessionsThatFit(
      [...read].map(([key, bytes]) => ({
        key,
        bytes: bytes.reduce((sum, chunk) => sum + chunk.length, 0),
      })),
      otherBytes,
    );
    const parts: PendingPart[] = all.flatMap((entry) => {
      const bytes = read.get(entry.key);
      if (bytes === undefined || !packed.has(entry.key)) return [];
      return entry.session.files.map((file, index) => {
        const chunk = bytes[index]!;
        return {
          kind: "session" as const,
          path: file.relPath,
          size: chunk.length,
          read: () => Promise.resolve(chunk),
          ...(entry.key !== null ? { participantId: entry.key } : {}),
        };
      });
    });
    // Too large when it was sized, or when it was read: an unreadable
    // session is simply left behind.
    const outcome = (key: ThreadParticipantId | null, session: NativeSessionExport) =>
      packed.has(key)
        ? {
            session: {
              driver: session.driver,
              ...(session.cliVersion !== undefined ? { cliVersion: session.cliVersion } : {}),
              cursor: session.cursor,
            },
          }
        : !sized.has(key) || read.has(key)
          ? { sessionOmitted: "too_large" as const }
          : {};
    const roomOutcomes = new Map(
      room.map(
        (entry) => [entry.participantId, outcome(entry.participantId, entry.session)] as const,
      ),
    );
    return {
      parts,
      manifest: primary !== null ? outcome(null, primary) : {},
      room: roomOutcomes,
    };
  });
}

/**
 * Writes the parts one after another to a temp payload, with each part's
 * hash and the whole's. Null when a part changed size since it was sized
 * (the packing runs again).
 */
function writePayload(dir: string, parts: ReadonlyArray<PendingPart>) {
  return Effect.gen(function* () {
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
            ...(part.participantId !== undefined ? { participantId: part.participantId } : {}),
          });
          offset += bytes.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    if (resized) return null;
    return { table, totalBytes: offset, sha256: whole.digest("hex") };
  });
}

/** The manifest and the payload under their final names: a finished export is whole. */
function writeManifest(dir: string, manifest: PeerMoveManifest) {
  const manifestTemp = `${moveManifestPath(dir)}.tmp`;
  return fsCall("Couldn't write the packed thread.", async () => {
    await NodeFs.writeFile(manifestTemp, JSON.stringify(manifest));
    await NodeFs.rename(NodePath.join(dir, "payload.bin.tmp"), movePayloadPath(dir));
    await NodeFs.rename(manifestTemp, moveManifestPath(dir));
  });
}

/** At most this many files in a general chat's folder, as in any move. */
const MOVE_MAX_FILES = 20_000;

/** One file of a general chat's folder, as found. */
interface ScratchEntry {
  readonly path: string;
  readonly absolute: string;
  readonly kind: "file" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
  readonly executable: boolean;
}

/**
 * Every file under a general chat's folder (docs/design/fleet.md, Part 3e,
 * (d)), with Part 3's rules for new files: regular files keep their
 * executable bit, symbolic links go as their text, anything else refuses the
 * move. A folder that was never made has no files.
 */
function listScratchFolder(folder: string) {
  return Effect.gen(function* () {
    const found: ScratchEntry[] = [];
    const walk = async (relative: string): Promise<string | null> => {
      const absoluteDir = relative.length === 0 ? folder : NodePath.join(folder, relative);
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await NodeFs.readdir(absoluteDir, { withFileTypes: true });
      } catch (error) {
        if (relative.length === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
        const absolute = NodePath.join(folder, path);
        const stat = await NodeFs.lstat(absolute);
        if (stat.isDirectory()) {
          const refused = await walk(path);
          if (refused !== null) return refused;
        } else if (stat.isSymbolicLink()) {
          const target = await NodeFs.readlink(absolute);
          found.push({
            path,
            absolute,
            kind: "symlink",
            size: Buffer.byteLength(target, "utf8"),
            mtimeMs: stat.mtimeMs,
            executable: false,
          });
        } else if (stat.isFile()) {
          found.push({
            path,
            absolute,
            kind: "file",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            executable: (stat.mode & 0o111) !== 0,
          });
        } else {
          return `${path} isn't a regular file, so this chat can't move.`;
        }
      }
      return null;
    };
    const refused = yield* fsCall("Couldn't read this chat's folder.", () => walk(""));
    if (refused !== null) return yield* fail(refused);
    return found;
  });
}

/** A listing's key: equal before and after packing means what was packed is what's there. */
const scratchKey = (entries: ReadonlyArray<ScratchEntry>) =>
  entries.map((entry) => `${entry.path}:${entry.kind}:${entry.size}:${entry.mtimeMs}`).join("\n");

/** Why a general chat's folder is too big to move, or null. */
function scratchSizeRefusal(entries: ReadonlyArray<ScratchEntry>): string | null {
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (bytes > MOVE_MAX_BYTES) {
    return `This chat's folder is ${Math.ceil(bytes / (1024 * 1024))} MB. Moves take up to 100 MB.`;
  }
  if (entries.length > MOVE_MAX_FILES) {
    return `This chat's folder has ${entries.length.toLocaleString("en-US")} files. Moves take up to ${MOVE_MAX_FILES.toLocaleString("en-US")}.`;
  }
  return null;
}

/**
 * What the move dialog says of a general chat's folder: how many files and
 * bytes, or why it can't move (too big, or a file that isn't one).
 */
export function summarizeScratchFolder(folder: string) {
  return listScratchFolder(folder).pipe(
    Effect.map((entries) => ({
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      refusal: scratchSizeRefusal(entries),
    })),
    Effect.catch((failure) =>
      Effect.succeed({ files: 0, bytes: 0, refusal: failure.reason as string | null }),
    ),
  );
}

export interface ScratchExportInput {
  readonly dir: string;
  /** The chat's own folder (generalChatThreadScratchCwd). */
  readonly folder: string;
  readonly attachmentsDir: string;
  readonly thread: OrchestrationThread;
  readonly source: MoveExportInput["source"];
  readonly agent: ModelSelection;
  readonly nativeSession?: NativeSessionExport | null | undefined;
  readonly state?: PeerMoveThreadState | undefined;
  readonly room?: MoveRoomExport | undefined;
  readonly outsideWork?: ReadonlyArray<OrchestrationOutsideWork> | undefined;
  /** Its family (Part 3f, (g)): a general chat has its own folder, so it shares none. */
  readonly family?: PeerMoveFamily | undefined;
  readonly familyThreadIds?: ReadonlySet<string> | undefined;
  readonly linkLineage?: PeerMoveLinkLineage | undefined;
}

/**
 * The manifest's room and outside marks: each agent's record with the
 * session that went for it (or why none did), for a computer that takes them.
 */
function roomManifestOf(
  input: {
    readonly room?: MoveRoomExport | undefined;
    readonly outsideWork?: ReadonlyArray<OrchestrationOutsideWork> | undefined;
  },
  sessions: ReadonlyMap<
    ThreadParticipantId,
    Pick<PeerMoveRoomParticipant, "session" | "sessionOmitted">
  >,
): {
  readonly room?: PeerMoveRoom;
  readonly outsideWork?: ReadonlyArray<OrchestrationOutsideWork>;
} {
  const room = input.room;
  const outsideWork = input.outsideWork ?? [];
  return {
    ...(room !== undefined
      ? {
          room: {
            ...(room.agentRole !== undefined ? { agentRole: room.agentRole } : {}),
            ...(room.ownAgentSeenThroughMessageId !== undefined
              ? { ownAgentSeenThroughMessageId: room.ownAgentSeenThroughMessageId }
              : {}),
            participants: room.participants.map((participant) => ({
              ...participant,
              ...sessions.get(participant.id),
            })),
          },
        }
      : {}),
    ...(outsideWork.length > 0 ? { outsideWork } : {}),
  };
}

/**
 * Packs a General Chats thread (docs/design/fleet.md, Part 3e, (d)): every
 * file in its folder, its attachments and its history, and its session. No
 * bundle and no diff. The folder is listed before and after packing (path,
 * size, time); a change means it packs once more, then gives up.
 */
export function writeScratchExport(
  input: ScratchExportInput,
): Effect.Effect<PeerMoveScratchManifest, ThreadMoveFailure> {
  const attempt = Effect.gen(function* () {
    yield* fsCall("Couldn't make room to pack this thread.", () =>
      NodeFs.mkdir(input.dir, { recursive: true }),
    );
    const before = yield* listScratchFolder(input.folder);
    const tooBig = scratchSizeRefusal(before);
    if (tooBig !== null) return yield* fail(tooBig);
    const parts: PendingPart[] = before.map((entry) =>
      entry.kind === "symlink"
        ? {
            kind: "file" as const,
            path: entry.path,
            mode: "symlink" as const,
            size: entry.size,
            read: async () => Buffer.from(await NodeFs.readlink(entry.absolute), "utf8"),
          }
        : {
            kind: "file" as const,
            path: entry.path,
            mode: entry.executable ? ("executable" as const) : ("file" as const),
            size: entry.size,
            read: () => NodeFs.readFile(entry.absolute),
          },
    );
    const history = exportThreadHistory(input.thread, {
      room: input.room !== undefined,
      familyThreadIds: input.familyThreadIds,
    });
    parts.push(...(yield* attachmentParts(history, input.attachmentsDir, input.state)));
    const otherBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (otherBytes > MOVE_MAX_BYTES) {
      return yield* fail(
        `This chat comes to ${Math.ceil(otherBytes / (1024 * 1024))} MB with its attachments. Moves carry at most 100 MB.`,
      );
    }
    const session = yield* sessionParts(
      input.nativeSession ?? null,
      input.room?.sessions ?? [],
      otherBytes,
    );
    parts.push(...session.parts);
    const payload = yield* writePayload(input.dir, parts);
    if (payload === null) return yield* new CheckoutChanged();
    const after = yield* listScratchFolder(input.folder);
    if (scratchKey(after) !== scratchKey(before)) return yield* new CheckoutChanged();
    const manifest: PeerMoveScratchManifest = {
      workspace: "scratch",
      totalBytes: payload.totalBytes,
      sha256: payload.sha256,
      parts: payload.table,
      source: input.source,
      project: { title: "General chats" },
      thread: {
        title: input.thread.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        messages: history.messages,
        activities: history.activities,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...roomManifestOf(input, session.room),
      },
      agent: input.agent,
      summary: { messageCount: history.messages.length, files: before.length },
      ...session.manifest,
      ...(input.family !== undefined ? { family: input.family } : {}),
      ...(input.linkLineage !== undefined ? { linkLineage: input.linkLineage } : {}),
    };
    yield* writeManifest(input.dir, manifest);
    return manifest;
  });
  const changedReason = "This chat's files changed while it was being packed. Try again.";
  return attempt.pipe(
    Effect.catchTag("CheckoutChanged", () => attempt),
    Effect.catchTag("CheckoutChanged", () => fail(changedReason)),
  );
}

/**
 * What a moved thread had going, as the manifest carries it (docs/design/
 * fleet.md, Part 3e), from what it carries (threadMoveCarry). Only for a
 * computer that takes it. A goal that finished, or anything but working or
 * paused, is never picked up, whatever the move's stop recorded. In a room
 * (Part 3f, (i)), the goal names the agent that held it (`goalHolder`, the
 * thread's session slot), and check-backs and queued messages their agent.
 */
export function moveThreadStateOf(
  carry: ThreadMoveCarry,
  goalHolder: ThreadParticipantId | null = null,
): PeerMoveThreadState | undefined {
  const goal = carry.goal;
  const state: PeerMoveThreadState = {
    ...(goal !== null
      ? {
          goal: {
            objective: goal.objective,
            status: goal.status,
            tokenBudget: goal.tokenBudget,
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            ...(goal.checks !== undefined ? { checks: goal.checks } : {}),
            ...(goal.lastCheck !== undefined ? { lastCheck: goal.lastCheck } : {}),
            pickUp: carry.goalWorking && (goal.status === "active" || goal.status === "paused"),
            ...(goalHolder !== null ? { participantId: goalHolder } : {}),
          },
        }
      : {}),
    ...(carry.checkBacks.length > 0
      ? {
          checkBacks: carry.checkBacks.map((checkBack) => ({
            scheduledFor: checkBack.scheduledFor,
            recurring: checkBack.recurring,
            exact: checkBack.exact,
            ...(checkBack.schedule !== undefined ? { schedule: checkBack.schedule } : {}),
            ...(checkBack.cron !== undefined ? { cron: checkBack.cron } : {}),
            ...(checkBack.description !== undefined ? { description: checkBack.description } : {}),
            ...(checkBack.prompt !== undefined ? { prompt: checkBack.prompt } : {}),
            durable: checkBack.durable,
            ...(checkBack.participantId !== null ? { participantId: checkBack.participantId } : {}),
          })),
        }
      : {}),
    ...(carry.pullRequests !== null
      ? {
          pullRequests: {
            autoFix: carry.pullRequests.autoFix,
            autoMerge: carry.pullRequests.autoMerge,
            linked: carry.pullRequests.linked.map((entry) => ({
              number: entry.number,
              url: entry.url,
              autoFix: entry.autoFix,
              autoMerge: entry.autoMerge,
            })),
          },
        }
      : {}),
    ...(carry.queuedFollowUps.length > 0
      ? {
          queuedFollowUps: carry.queuedFollowUps.map((entry) => ({
            messageId: entry.messageId,
            text: entry.text,
            attachments: entry.attachments,
            ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
            ...(entry.composer !== undefined ? { composer: entry.composer } : {}),
            ...(entry.sentFrom !== undefined ? { sentFrom: entry.sentFrom } : {}),
            interactionMode: entry.interactionMode,
            createdAt: entry.createdAt,
            ...(entry.participantId !== undefined && entry.participantId !== null
              ? { participantId: entry.participantId }
              : {}),
          })),
        }
      : {}),
    ...(carry.proposedPlans.length > 0
      ? {
          proposedPlans: carry.proposedPlans.map(({ eventSequence: _sequence, ...plan }) => plan),
        }
      : {}),
    ...(carry.plansLeftBehind > 0 ? { plansLeftBehind: carry.plansLeftBehind } : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}
