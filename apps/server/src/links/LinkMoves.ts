// @effect-diagnostics nodeBuiltinImport:off
/**
 * Threads linked computers move here (docs/design/fleet.md, Part 3, "Import
 * on B"). A move is offered (`prepare`), held for this computer's user under
 * Ask first, received in chunks, checked, and imported in stages: fetch the
 * commits, make its own worktree, apply the changes and new files, then one
 * `thread.import` that creates the thread with its history. The thread
 * existing is the commit. Commit and abort run under one lock per transfer,
 * and the commit waits for the engine's answer without letting go, so an
 * abort that was confirmed can never be followed by a thread appearing.
 *
 * Every resource a move makes here is named from its transfer key (a hash of
 * the link and the transfer id): the staging folder, the git ref, the
 * worktree, the thread and its message ids. Nothing a peer sends is used as a
 * path without checking it against this computer's filesystem rules.
 */
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  CommandId,
  type ComputerLinkPendingRequest,
  ComputerLinkError,
  EventId,
  type LinksRespondRequestInput,
  MessageId,
  type PeerMoveChunkInput,
  type PeerMoveInput,
  type PeerMoveManifest,
  type PeerMovePart,
  type PeerMovePrepareInput,
  type PeerMoveState,
  PEER_MOVE_CHUNK_MAX_BYTES,
  PeerRpcError,
  ThreadId,
  type ThreadImportMessage,
  TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { MOVE_MAX_BYTES } from "../moves/moveExport.ts";
import { derivedUuid } from "../orchestration/childRequestIds.ts";
import { clampLaunchToCeiling } from "../orchestration/childThreadDecisions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeKeyedLock } from "./keyedLock.ts";
import { LinkMoveRepository, type LinkMoveRow } from "./LinkMoveRepository.ts";
import { LinkRequests, linkIdentityRefusal, type PeerLink } from "./LinkRequests.ts";

/** A move nobody allowed, or that stopped arriving, ends after a day. */
export const LINK_MOVE_TTL_MS = 24 * 60 * 60 * 1000;
/** Unfinished moves one link may have here at once, and all links together. */
const MAX_OPEN_MOVES_PER_LINK = 2;
const MAX_OPEN_MOVES = 4;
const MAX_MOVE_PARTS = 20_000;
/**
 * The most a move may unpack to here: new objects its commits bring, binary
 * patch literals, and new files. A small compressed payload can't grow past it.
 */
const MOVE_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const SWEEP_EVERY = "1 hour";
const GIT_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;

export interface LinkMovesShape {
  readonly prepare: (link: PeerLink, input: PeerMovePrepareInput) => Effect.Effect<PeerMoveState>;
  readonly chunk: (
    link: PeerLink,
    input: PeerMoveChunkInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  readonly finish: (
    link: PeerLink,
    input: PeerMoveInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  readonly status: (link: PeerLink, input: PeerMoveInput) => Effect.Effect<PeerMoveState>;
  /** Fails when the outcome couldn't be recorded: the asking computer asks again. */
  readonly abort: (
    link: PeerLink,
    input: PeerMoveInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  /** This computer's user answers a waiting move; false when no move has that id. */
  readonly respond: (input: LinksRespondRequestInput) => Effect.Effect<boolean, ComputerLinkError>;
  readonly pending: Effect.Effect<ReadonlyArray<ComputerLinkPendingRequest>>;
  readonly pendingChanges: Stream.Stream<void>;
  /** An inbound link was removed: its unfinished moves are dropped. */
  readonly dropLink: (deviceId: string) => Effect.Effect<void>;
  /** Settle what the previous process left, and sweep hourly. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LinkMoves extends Context.Service<LinkMoves, LinkMovesShape>()(
  "threadlines/links/LinkMoves",
) {}

/** An import stage that can't go on: the move ends aborted with this reason. */
class ImportStop extends Data.TaggedError("ImportStop")<{ readonly reason: string }> {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** hash(link, transfer): every resource a move makes here is named from it. */
export const linkMoveKey = (linkDeviceId: string, transferId: string) =>
  createHash("sha256").update(`${linkDeviceId}\u0000${transferId}`).digest("hex");

/** The thread a move becomes here. */
export const linkMoveThreadId = (transferKey: string) =>
  ThreadId.make(derivedUuid("link-move-thread", transferKey));

const isWindows = process.platform === "win32";
const isCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
const foldCase = (path: string) => (isCaseInsensitive ? path.toLowerCase() : path);

/**
 * Why `path` (a new file's path from the repository root, `/`-separated, as a
 * peer sent it) can't be written here, or null. Relative, no `.` or `..`
 * segments, nothing under `.git`, no drive, UNC or stream syntax.
 */
export function movePathRefusal(path: string): string | null {
  if (path.length === 0 || path.length > 4096) return "an empty or overlong path";
  if (path.includes("\\") || path.includes("\0")) return `"${path}" has a character paths can't`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `"${path}" isn't relative`;
  if (path.includes(":")) return `"${path}" has a ":"`;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return `"${path}" has an empty, "." or ".." part`;
    }
    if (segment.toLowerCase() === ".git") return `"${path}" is inside .git`;
    if (isWindows && /[<>"|?*]/.test(segment)) return `"${path}" has a character Windows can't`;
    if (isWindows && /[. ]$/.test(segment)) return `"${path}" ends a part with a dot or space`;
  }
  return null;
}

/**
 * Why a peer's manifest can't be taken, or null: within the size limit, its
 * parts contiguous from zero and summing to the total, at most one bundle and
 * one diff, the bundle there exactly when a base is named, every file part
 * with a path this computer can write and no two the same here.
 */
export function moveManifestRefusal(manifest: PeerMoveManifest): string | null {
  if (manifest.totalBytes > MOVE_MAX_BYTES) return "it's bigger than 100 MB";
  if (manifest.parts.length > MAX_MOVE_PARTS) return "it has too many files";
  const sorted = manifest.parts.toSorted((left, right) => left.offset - right.offset);
  let next = 0;
  for (const part of sorted) {
    if (part.offset !== next) return "its parts don't line up";
    next += part.length;
  }
  if (next !== manifest.totalBytes) return "its parts don't add up";
  const count = (kind: PeerMovePart["kind"]) =>
    manifest.parts.filter((part) => part.kind === kind).length;
  if (count("bundle") > 1 || count("diff") > 1) return "it has more than one bundle or diff";
  if ((count("bundle") === 1) !== (manifest.git.baseSha !== null)) {
    return "its commits don't match its base";
  }
  const seen = new Set<string>();
  for (const part of manifest.parts) {
    if (part.kind === "file") {
      if (part.path === undefined || part.mode === undefined) return "a file has no path";
      const refusal = movePathRefusal(part.path);
      if (refusal !== null) return refusal;
      if (part.mode === "symlink" && isWindows) return `"${part.path}" is a symbolic link`;
      const folded = foldCase(part.path);
      if (seen.has(folded)) return `"${part.path}" is there twice`;
      seen.add(folded);
    }
    if (part.kind === "attachment" && part.attachmentId === undefined) {
      return "an attachment has no id";
    }
  }
  return null;
}

const make = Effect.gen(function* () {
  const moves = yield* LinkMoveRepository;
  const requests = yield* LinkRequests;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const config = yield* ServerConfig;
  const devices = yield* RelayDeviceRepository;
  const identities = yield* RepositoryIdentityResolver;
  const environment = yield* ServerEnvironment;
  const ownLabel = (yield* environment.getDescriptor).label;
  const pendingHub = yield* PubSub.sliding<void>(1);
  const announcePending = PubSub.publish(pendingHub, undefined).pipe(Effect.asVoid);
  const lock = makeKeyedLock();
  /** Imports run in the service's own scope, so they end with it. */
  const scope = yield* Effect.scope;
  /** Imports running in this process, so a second `finish` doesn't start another. */
  const importing = new Set<string>();
  const peerFailure = (detail: string) => new PeerRpcError({ detail });

  const stagingDir = (row: Pick<LinkMoveRow, "transferKey">) =>
    NodePath.join(config.stateDir, "link-moves", row.transferKey);
  const payloadPath = (row: Pick<LinkMoveRow, "transferKey">) =>
    NodePath.join(stagingDir(row), "payload.bin");
  const tempRef = (row: Pick<LinkMoveRow, "transferKey">) =>
    `refs/threadlines/move/${row.transferKey}`;

  const stateOf = (row: LinkMoveRow): PeerMoveState => ({
    status: row.status,
    bytesReceived: row.bytesReceived,
    ...(row.status === "committed" ? { threadId: row.threadId } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  });
  const gone = (reason?: string): PeerMoveState => ({
    status: "aborted",
    bytesReceived: 0,
    ...(reason !== undefined ? { reason } : {}),
  });

  const readRow = (linkDeviceId: string, transferId: string) =>
    moves.get(linkDeviceId, transferId).pipe(Effect.orElseSucceed(() => Option.none()));

  const runGit = (cwd: string, args: ReadonlyArray<string>, timeoutMs = GIT_TIMEOUT_MS) =>
    git
      .execute({
        operation: "LinkMoves",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs,
        maxOutputBytes: 4_000_000,
      })
      .pipe(
        Effect.map((result) => ({ ok: result.exitCode === 0, out: result.stdout.trim() })),
        Effect.orElseSucceed(() => ({ ok: false, out: "" })),
      );

  const threadExists = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(() => peerFailure(`${ownLabel} couldn't check its threads.`)),
    );

  /** The project here a move lands in, and the remote it fetches from. */
  const landing = (manifest: PeerMoveManifest) =>
    Effect.gen(function* () {
      const project = yield* requests.projectForKey(manifest.project.canonicalKey);
      if (project === undefined) return null;
      const identity = yield* identities.resolve(project.workspaceRoot);
      return {
        project,
        root: project.workspaceRoot,
        remoteName: identity?.locator.remoteName ?? "origin",
      };
    });

  // ---------------------------------------------------------------------------
  // Clean-up
  // ---------------------------------------------------------------------------

  /**
   * Removes what an aborted move made here: its staging, its worktree and
   * branch, its temp ref. A folder a thread here uses since is left alone,
   * and so is a branch that no longer points at the moved commit (not ours).
   * Recorded only when all of it went, so startup and the sweep retry the rest.
   */
  const cleanUp = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      let clean = yield* Effect.tryPromise(() =>
        NodeFs.rm(stagingDir(row), { recursive: true, force: true }),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const land = yield* landing(row.manifest);
      if (land !== null) {
        if (row.worktreePath !== null) {
          const inUse = yield* pathInUse(row.worktreePath);
          if (inUse === null) {
            clean = false;
          } else if (!inUse) {
            yield* runGit(land.root, ["worktree", "remove", "--force", row.worktreePath]);
            const removed = yield* Effect.tryPromise(async () => {
              await NodeFs.rm(row.worktreePath!, { recursive: true, force: true });
              return NodeFs.access(row.worktreePath!).then(
                () => false,
                () => true,
              );
            }).pipe(Effect.orElseSucceed(() => false));
            if (!removed) clean = false;
            yield* runGit(land.root, ["worktree", "prune"]);
            if (row.branch !== null) {
              const at = yield* runGit(land.root, [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${row.branch}^{commit}`,
              ]);
              if (at.ok && at.out === row.manifest.git.headSha) {
                const deleted = yield* runGit(land.root, ["branch", "-D", row.branch]);
                if (!deleted.ok) clean = false;
              }
            }
          }
        }
        yield* runGit(land.root, ["update-ref", "-d", tempRef(row)]);
      }
      if (!clean) return;
      yield* moves
        .markCleaned({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          now: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  /**
   * Whether any thread here works in `path`: then nothing a move does may
   * touch it. Null when that couldn't be read.
   */
  const pathInUse = (path: string) =>
    snapshots.getCommandReadModel().pipe(
      Effect.map((model): boolean | null =>
        model.threads.some(
          (thread) =>
            thread.deletedAt === null &&
            (thread.worktreePath === path || thread.effectiveCwd === path),
        ),
      ),
      Effect.orElseSucceed((): boolean | null => null),
    );

  /**
   * Ends a move here (unless it committed or ended already) and cleans up
   * after it. True when this call ended it; fails when that couldn't be
   * recorded, so nobody is told it ended.
   */
  const abortRow = (row: LinkMoveRow, reason: string) =>
    Effect.gen(function* () {
      const settled = yield* moves
        .settle({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          status: "aborted",
          reason,
          now: yield* nowIso,
        })
        .pipe(Effect.mapError(() => peerFailure(`${ownLabel} couldn't record that.`)));
      if (settled) {
        if (row.status === "awaiting_approval") yield* announcePending;
        yield* cleanUp({ ...row, status: "aborted", reason });
      }
      return settled;
    });

  // ---------------------------------------------------------------------------
  // Offer, chunks, finish
  // ---------------------------------------------------------------------------

  const prepare: LinkMovesShape["prepare"] = (link, input) =>
    Effect.gen(function* () {
      const { manifest, transferId } = input;
      const transferKey = linkMoveKey(link.deviceId, transferId);
      return yield* lock(transferKey)(
        Effect.gen(function* () {
          const existing = yield* readRow(link.deviceId, transferId);
          if (Option.isSome(existing)) {
            const row = existing.value;
            // The same offer again (a retry): where it stands. Another one
            // under the same id is refused.
            return row.manifest.sha256 === manifest.sha256 &&
              row.manifest.totalBytes === manifest.totalBytes
              ? stateOf(row)
              : gone("That move id is taken.");
          }
          const identity = linkIdentityRefusal(link, manifest.source.environmentId);
          if (identity !== null) return gone(identity);
          const authority = yield* requests.authority(link.deviceId);
          if (!authority.ok) return gone(authority.text);
          const manifestRefusal = moveManifestRefusal(manifest);
          if (manifestRefusal !== null)
            return gone(`${ownLabel} can't take it: ${manifestRefusal}.`);
          const land = yield* landing(manifest);
          if (land === null) return gone(`${ownLabel} doesn't have this project.`);
          const agent = yield* requests.resolveAgentFor({
            agent: {
              instanceId: manifest.agent.instanceId,
              model: manifest.agent.model,
              ...(manifest.agent.options !== undefined ? { options: manifest.agent.options } : {}),
            },
            interactionMode: manifest.thread.interactionMode,
          });
          if ("refused" in agent) return gone(agent.refused);
          // Counting and recording under one lock, so offers made at once
          // can't all fit under the caps.
          const row = yield* lock("admission")(
            Effect.gen(function* () {
              const open = yield* moves.listOpen;
              if (
                open.filter((entry) => entry.linkDeviceId === link.deviceId).length >=
                  MAX_OPEN_MOVES_PER_LINK ||
                open.length >= MAX_OPEN_MOVES
              ) {
                return null;
              }
              return yield* moves.insert({
                linkDeviceId: link.deviceId,
                transferId,
                transferKey,
                status: link.access === "ask" ? "awaiting_approval" : "receiving",
                manifest,
                threadId: linkMoveThreadId(transferKey),
                now: yield* nowIso,
              });
            }),
          ).pipe(Effect.option);
          if (Option.isNone(row)) return gone(`${ownLabel} couldn't record the move.`);
          if (row.value === null) {
            return gone(`${ownLabel} is already taking other moves. Try again once they're done.`);
          }
          if (row.value.status === "awaiting_approval") yield* announcePending;
          return stateOf(row.value);
        }),
      );
    });

  const chunk: LinkMovesShape["chunk"] = (link, input) =>
    Effect.gen(function* () {
      const data = Buffer.from(input.data, "base64");
      if (data.length === 0 || data.length > PEER_MOVE_CHUNK_MAX_BYTES) {
        return yield* new PeerRpcError({ detail: "A chunk must hold 1 byte to 1 MB." });
      }
      const transferKey = linkMoveKey(link.deviceId, input.transferId);
      return yield* lock(transferKey)(
        Effect.gen(function* () {
          const found = yield* readRow(link.deviceId, input.transferId);
          if (Option.isNone(found)) return gone();
          const row = found.value;
          if (row.status !== "receiving" || input.offset !== row.bytesReceived) return stateOf(row);
          if (input.offset + data.length > row.manifest.totalBytes) {
            return yield* new PeerRpcError({ detail: "That chunk goes past the end." });
          }
          const authority = yield* requests.authority(link.deviceId);
          if (!authority.ok) {
            yield* abortRow(row, authority.text);
            return gone(authority.text);
          }
          const written = yield* Effect.tryPromise(async () => {
            await NodeFs.mkdir(stagingDir(row), { recursive: true });
            const handle = await NodeFs.open(payloadPath(row), "a+");
            try {
              // A write cut off before its count was recorded is dropped.
              const { size } = await handle.stat();
              if (size !== row.bytesReceived) await handle.truncate(row.bytesReceived);
              await handle.write(data, 0, data.length, row.bytesReceived);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }).pipe(Effect.option);
          if (Option.isNone(written)) {
            return yield* new PeerRpcError({ detail: `${ownLabel} couldn't save that chunk.` });
          }
          const bytesReceived = row.bytesReceived + data.length;
          yield* moves
            .update({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              patch: { bytesReceived },
              now: yield* nowIso,
            })
            .pipe(Effect.ignore);
          return stateOf({ ...row, bytesReceived });
        }),
      );
    });

  /** Whether the staged payload is whole: every part's hash and the payload's. */
  const verifyPayload = (row: LinkMoveRow) =>
    Effect.tryPromise(async () => {
      // Nothing to carry (a clean, pushed thread): there is no payload file.
      const bytes =
        row.manifest.totalBytes === 0 ? Buffer.alloc(0) : await NodeFs.readFile(payloadPath(row));
      if (bytes.length !== row.manifest.totalBytes) return false;
      if (createHash("sha256").update(bytes).digest("hex") !== row.manifest.sha256) return false;
      return row.manifest.parts.every(
        (part) =>
          createHash("sha256")
            .update(bytes.subarray(part.offset, part.offset + part.length))
            .digest("hex") === part.sha256,
      );
    }).pipe(Effect.orElseSucceed(() => false));

  const finish: LinkMovesShape["finish"] = (link, input) =>
    Effect.gen(function* () {
      const transferKey = linkMoveKey(link.deviceId, input.transferId);
      const answer = yield* lock(transferKey)(
        Effect.gen(function* () {
          const found = yield* readRow(link.deviceId, input.transferId);
          if (Option.isNone(found)) return gone();
          const row = found.value;
          if (row.status !== "receiving") return stateOf(row);
          if (row.bytesReceived !== row.manifest.totalBytes) return stateOf(row);
          if (!(yield* verifyPayload(row))) {
            const reason = `What arrived on ${ownLabel} doesn't match what was sent. Try again.`;
            yield* abortRow(row, reason);
            return gone(reason);
          }
          yield* moves
            .update({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              patch: { status: "importing" },
              now: yield* nowIso,
            })
            .pipe(Effect.ignore);
          return stateOf({ ...row, status: "importing" });
        }),
      );
      if (answer.status === "importing") {
        yield* runImport(link.deviceId, input.transferId).pipe(Effect.forkIn(scope));
      }
      return answer;
    });

  const status: LinkMovesShape["status"] = (link, input) =>
    readRow(link.deviceId, input.transferId).pipe(
      Effect.map((found) => (Option.isSome(found) ? stateOf(found.value) : gone())),
    );

  const abort: LinkMovesShape["abort"] = (link, input) =>
    abortMove(link.deviceId, input.transferId);

  /**
   * Drop a move unless it committed: answers which one it is now. Answers
   * `aborted` only once that is recorded here, and fails when anything it
   * needs to know couldn't be read, so the asking computer asks again rather
   * than unfreezing a thread that may still arrive here.
   */
  const abortMove = (linkDeviceId: string, transferId: string, reason?: string) =>
    lock(linkMoveKey(linkDeviceId, transferId))(
      Effect.gen(function* () {
        const found = yield* moves
          .get(linkDeviceId, transferId)
          .pipe(Effect.mapError(() => peerFailure(`${ownLabel} couldn't read its moves.`)));
        // Never offered here: nothing can arrive without the bytes the asking
        // computer stops sending.
        if (Option.isNone(found)) return gone(reason);
        const row = found.value;
        if (row.status === "committed" || row.status === "aborted") return stateOf(row);
        // The import may have created the thread before it recorded so.
        if (yield* threadExists(row.threadId)) {
          yield* moves
            .settle({ linkDeviceId, transferId, status: "committed", now: yield* nowIso })
            .pipe(Effect.mapError(() => peerFailure(`${ownLabel} couldn't record that.`)));
          return stateOf({ ...row, status: "committed" });
        }
        const why = reason ?? "The move was cancelled.";
        if (!(yield* abortRow(row, why))) {
          const now = yield* moves
            .get(linkDeviceId, transferId)
            .pipe(Effect.mapError(() => peerFailure(`${ownLabel} couldn't read its moves.`)));
          return Option.isSome(now) ? stateOf(now.value) : gone(why);
        }
        return stateOf({ ...row, status: "aborted", reason: why });
      }),
    );

  // ---------------------------------------------------------------------------
  // The import
  // ---------------------------------------------------------------------------

  /** One stage of an import, under the transfer's lock; null when the move is no longer importing. */
  const stage = <A>(
    linkDeviceId: string,
    transferId: string,
    run: (row: LinkMoveRow) => Effect.Effect<A, ImportStop | PeerRpcError>,
  ) =>
    lock(linkMoveKey(linkDeviceId, transferId))(
      Effect.gen(function* () {
        const found = yield* readRow(linkDeviceId, transferId);
        if (Option.isNone(found) || found.value.status !== "importing") return null;
        const authority = yield* requests.authority(linkDeviceId);
        if (!authority.ok) return yield* new ImportStop({ reason: authority.text });
        return { value: yield* run(found.value) };
      }),
    );

  const setStage = (row: LinkMoveRow, patch: Parameters<typeof moves.update>[0]["patch"]) =>
    Effect.gen(function* () {
      yield* moves
        .update({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          patch,
          now: yield* nowIso,
        })
        .pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel} couldn't record its progress.` }),
          ),
        );
    });

  const stop = (reason: string) => Effect.fail(new ImportStop({ reason }));

  const partBytes = (row: LinkMoveRow, part: PeerMovePart) =>
    Effect.tryPromise(async () => {
      const handle = await NodeFs.open(payloadPath(row), "r");
      try {
        const buffer = Buffer.alloc(part.length);
        await handle.read(buffer, 0, part.length, part.offset);
        return buffer;
      } finally {
        await handle.close();
      }
    }).pipe(Effect.mapError(() => new ImportStop({ reason: `${ownLabel} lost the move's data.` })));

  /** Fetches the remote, and takes the bundle's commits into a ref named from the move. */
  const fetchStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel} doesn't have this project anymore.`);
      yield* runGit(land.root, ["fetch", "--quiet", land.remoteName], GIT_FETCH_TIMEOUT_MS);
      const bundle = row.manifest.parts.find((part) => part.kind === "bundle");
      const { headSha, baseSha } = row.manifest.git;
      if (bundle !== undefined) {
        const bundlePath = NodePath.join(stagingDir(row), "commits.bundle");
        const bytes = yield* partBytes(row, bundle);
        yield* Effect.tryPromise(() => NodeFs.writeFile(bundlePath, bytes)).pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel} couldn't unpack the commits.` }),
          ),
        );
        const verified = yield* runGit(land.root, ["bundle", "verify", "--quiet", bundlePath]);
        if (!verified.ok) {
          return yield* stop(
            `${ownLabel} can't find commit ${(baseSha ?? "").slice(0, 7)} on ${land.remoteName}. Push it, or fetch on ${ownLabel}, then try again.`,
          );
        }
        const fetched = yield* runGit(
          land.root,
          [
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            bundlePath,
            `refs/threadlines/move/${row.transferId}:${tempRef(row)}`,
          ],
          GIT_FETCH_TIMEOUT_MS,
        );
        if (!fetched.ok) return yield* stop(`${ownLabel} couldn't take the commits.`);
        const unpacked = yield* newObjectBytes(land.root, tempRef(row), baseSha);
        if (unpacked === null || unpacked > MOVE_MAX_EXPANDED_BYTES) {
          yield* runGit(land.root, ["update-ref", "-d", tempRef(row)]);
          return yield* stop(`The commits it brings are too big for ${ownLabel} to unpack.`);
        }
      }
      const has = yield* runGit(land.root, ["cat-file", "-e", `${headSha}^{commit}`]);
      if (!has.ok) {
        return yield* stop(
          `${ownLabel} can't find commit ${headSha.slice(0, 7)} on ${land.remoteName}. Push it, or fetch on ${ownLabel}, then try again.`,
        );
      }
      yield* setStage(row, { stage: "fetched" });
    });

  /** How many bytes the objects `ref` brings past `base` unpack to; null when that can't be read. */
  const newObjectBytes = (root: string, ref: string, base: string | null) =>
    Effect.gen(function* () {
      const listed = yield* git
        .execute({
          operation: "LinkMoves.sizeObjects",
          cwd: root,
          args: ["rev-list", "--objects", ref, ...(base !== null ? [`^${base}`] : [])],
          allowNonZeroExit: true,
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 64_000_000,
        })
        .pipe(Effect.option);
      if (Option.isNone(listed) || listed.value.exitCode !== 0 || listed.value.stdoutTruncated) {
        return null;
      }
      const ids = listed.value.stdout
        .split("\n")
        .map((line) => line.split(" ")[0] ?? "")
        .filter((id) => id.length > 0);
      if (ids.length === 0) return 0;
      const sized = yield* git
        .execute({
          operation: "LinkMoves.sizeObjects",
          cwd: root,
          args: ["cat-file", "--batch-check=%(objectsize)"],
          stdin: `${ids.join("\n")}\n`,
          allowNonZeroExit: true,
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 64_000_000,
        })
        .pipe(Effect.option);
      if (Option.isNone(sized) || sized.value.exitCode !== 0) return null;
      return sized.value.stdout
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((size) => Number.isFinite(size))
        .reduce((sum, size) => sum + size, 0);
    });

  /** The branch name the move takes here: its own, else one marked with where it came from. */
  const pickBranch = (root: string, row: LinkMoveRow) =>
    Effect.gen(function* () {
      const source = row.manifest.git.branch;
      const from = row.manifest.source.environmentLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      const slug =
        row.manifest.thread.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "thread";
      const valid = (name: string) =>
        runGit(root, ["check-ref-format", "--branch", name]).pipe(
          Effect.map((result) => result.ok),
        );
      const taken = (name: string) =>
        runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).pipe(
          Effect.map((result) => result.ok),
        );
      const base =
        source !== null && (yield* valid(source))
          ? [source, `${source}-from-${from || "elsewhere"}`]
          : [`moved/${slug}`];
      const candidates = [...base];
      for (let suffix = 2; suffix <= 100; suffix += 1) candidates.push(`${base.at(-1)}-${suffix}`);
      for (const name of candidates) {
        if ((yield* valid(name)) && !(yield* taken(name))) return name;
      }
      return yield* stop(`${ownLabel} couldn't find a free branch name.`);
    });

  /** The worktree the moved thread works in, at the moved commit, named from the move. */
  const worktreeStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel} doesn't have this project anymore.`);
      const { headSha } = row.manifest.git;
      const branch = row.branch ?? (yield* pickBranch(land.root, row));
      const path =
        row.worktreePath ??
        NodePath.join(
          config.worktreesDir,
          NodePath.basename(land.root),
          `moved-${row.transferKey.slice(0, 12)}`,
        );
      // Recorded before it is made, so a restart finds what it owns.
      yield* setStage(row, { branch, worktreePath: path });
      const listed = yield* runGit(land.root, ["worktree", "list", "--porcelain"]);
      const registered = listed.out.split("\n").includes(`worktree ${path}`);
      if (registered) {
        const head = yield* runGit(path, ["rev-parse", "HEAD"]);
        if (head.ok && head.out === headSha) {
          yield* setStage(row, { stage: "worktree" });
          return;
        }
        if ((yield* pathInUse(path)) !== false) {
          return yield* stop(`A thread on ${ownLabel} is using that folder.`);
        }
        yield* runGit(land.root, ["worktree", "remove", "--force", path]);
      }
      // The saved name is ours only while it is free or at the moved commit
      // (made before a crash); one taken since gets another name.
      const at = yield* runGit(land.root, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}^{commit}`,
      ]);
      const adopt = at.ok && at.out === headSha;
      let name = branch;
      if (at.ok && !adopt) {
        name = yield* pickBranch(land.root, row);
        yield* setStage(row, { branch: name });
      }
      const created = adopt
        ? yield* runGit(land.root, ["worktree", "add", path, name])
        : yield* runGit(land.root, ["worktree", "add", "--no-track", "-b", name, path, headSha]);
      if (!created.ok) return yield* stop(`${ownLabel} couldn't make a worktree for it.`);
      const head = yield* runGit(path, ["rev-parse", "HEAD"]);
      if (!head.ok || head.out !== headSha) {
        return yield* stop(`${ownLabel}'s worktree for it isn't at the moved commit.`);
      }
      yield* runGit(land.root, ["update-ref", "-d", tempRef(row)]);
      yield* setStage(row, { stage: "worktree" });
    });

  /** Writes one new file, refusing any parent that is a symbolic link. */
  const writeNewFile = (root: string, part: PeerMovePart, bytes: Buffer) =>
    Effect.tryPromise(async () => {
      const segments = part.path!.split("/");
      let current = root;
      for (const segment of segments.slice(0, -1)) {
        current = NodePath.join(current, segment);
        const stat = await NodeFs.lstat(current).catch(() => null);
        if (stat === null) {
          await NodeFs.mkdir(current);
        } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("parent");
        }
      }
      const target = NodePath.join(root, ...segments);
      if (part.mode === "symlink") {
        await NodeFs.symlink(bytes.toString("utf8"), target);
      } else {
        await NodeFs.writeFile(target, bytes, {
          flag: "wx",
          mode: part.mode === "executable" ? 0o755 : 0o644,
        });
      }
    }).pipe(
      Effect.mapError(
        () => new ImportStop({ reason: `${ownLabel} couldn't write ${part.path} safely.` }),
      ),
    );

  /** The changes and new files, in the move's own worktree. A crashed apply starts again clean. */
  const applyStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const path = row.worktreePath;
      if (path === null) return yield* stop(`${ownLabel} lost track of the move's worktree.`);
      const { headSha } = row.manifest.git;
      const status = yield* runGit(path, ["status", "--porcelain"]);
      if (status.out.length > 0) {
        // Ours, uncommitted, never handed to a thread: back to the moved commit.
        if ((yield* pathInUse(path)) !== false) {
          return yield* stop(`A thread on ${ownLabel} is using that folder.`);
        }
        yield* runGit(path, ["reset", "--hard", headSha]);
        yield* runGit(path, ["clean", "-fdx"]);
      }
      const diff = row.manifest.parts.find((part) => part.kind === "diff");
      const files = row.manifest.parts.filter((part) => part.kind === "file");
      const diffBytes = diff !== undefined && diff.length > 0 ? yield* partBytes(row, diff) : null;
      // What the changes unpack to: a binary patch states each literal's
      // size, so a small compressed patch can't grow past the budget.
      const literalBytes =
        diffBytes === null
          ? 0
          : [...diffBytes.toString("latin1").matchAll(/^(?:literal|delta) (\d+)$/gm)].reduce(
              (sum, match) => sum + Number.parseInt(match[1]!, 10),
              0,
            );
      const fileBytes = files.reduce((sum, part) => sum + part.length, 0);
      if (literalBytes + fileBytes > MOVE_MAX_EXPANDED_BYTES) {
        return yield* stop(`Its changes are too big for ${ownLabel} to unpack.`);
      }
      if (diffBytes !== null) {
        const diffPath = NodePath.join(stagingDir(row), "changes.diff");
        const bytes = diffBytes;
        yield* Effect.tryPromise(() => NodeFs.writeFile(diffPath, bytes)).pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel} couldn't unpack the changes.` }),
          ),
        );
        const applied = yield* runGit(path, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
        if (!applied.ok) return yield* stop(`${ownLabel} couldn't apply the changes.`);
      }
      if (files.length > 0) {
        const tracked = yield* runGit(path, ["ls-files", "-z"]);
        const trackedFolded = new Set(
          tracked.out
            .split("\0")
            .filter((entry) => entry.length > 0)
            .map(foldCase),
        );
        for (const part of files) {
          const refusal = movePathRefusal(part.path ?? "");
          if (refusal !== null) return yield* stop(`${ownLabel} can't take it: ${refusal}.`);
          if (trackedFolded.has(foldCase(part.path!))) {
            return yield* stop(`"${part.path}" clashes with a file ${ownLabel} already tracks.`);
          }
          yield* writeNewFile(path, part, yield* partBytes(row, part));
        }
      }
      yield* setStage(row, { stage: "applied" });
    });

  /** The new attachment a moved one becomes here: an id of this thread, written beside the others. */
  const importAttachments = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const segment = toSafeThreadAttachmentSegment(row.threadId);
      const remapped = new Map<string, ChatAttachment>();
      if (segment === null) return remapped;
      const byOldId = new Map(
        row.manifest.parts
          .filter((part) => part.kind === "attachment")
          .map((part) => [part.attachmentId!, part] as const),
      );
      for (const message of row.manifest.thread.messages) {
        for (const attachment of message.attachments ?? []) {
          if (remapped.has(attachment.id)) continue;
          const id = `${segment}-${derivedUuid("link-move-attachment", row.transferKey, attachment.id)}`;
          const next = { ...attachment, id } as ChatAttachment;
          const part = byOldId.get(attachment.id);
          const target = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: next,
          });
          if (part !== undefined && target !== null) {
            const bytes = yield* partBytes(row, part);
            yield* Effect.tryPromise(async () => {
              await NodeFs.mkdir(NodePath.dirname(target), { recursive: true });
              await NodeFs.writeFile(target, bytes);
            }).pipe(
              Effect.mapError(
                () => new ImportStop({ reason: `${ownLabel} couldn't save an attachment.` }),
              ),
            );
          }
          // An attachment that didn't travel keeps its name; its bytes are just missing.
          remapped.set(attachment.id, next);
        }
      }
      return remapped;
    });

  /** The thread itself, and with it the commit. Waits for the engine's answer without letting go. */
  const commitStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel} doesn't have this project anymore.`);
      const authority = yield* requests.authority(row.linkDeviceId);
      if (!authority.ok) return yield* stop(authority.text);
      const agent = yield* requests.resolveAgentFor({
        agent: {
          instanceId: row.manifest.agent.instanceId,
          model: row.manifest.agent.model,
          ...(row.manifest.agent.options !== undefined
            ? { options: row.manifest.agent.options }
            : {}),
        },
        interactionMode: row.manifest.thread.interactionMode,
      });
      if ("refused" in agent) return yield* stop(agent.refused);
      const capped = clampLaunchToCeiling(
        {
          runtimeMode: row.manifest.thread.runtimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
        {
          runtimeMode: authority.maxRuntimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
      );
      const attachments = yield* importAttachments(row);
      const key = row.transferKey;
      const messages = row.manifest.thread.messages.map((message): ThreadImportMessage => ({
        messageId: MessageId.make(derivedUuid("link-move-message", key, message.messageId)),
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined
          ? {
              attachments: message.attachments.map(
                (attachment) => attachments.get(attachment.id) ?? attachment,
              ),
            }
          : {}),
        turnId:
          message.turnId === null
            ? null
            : TurnId.make(derivedUuid("link-move-turn", key, message.turnId)),
        ...(message.completesTurn !== undefined ? { completesTurn: message.completesTurn } : {}),
        ...(message.agentModels !== undefined ? { agentModels: message.agentModels } : {}),
        createdAt: message.createdAt,
      }));
      const activities = row.manifest.thread.activities.map((activity) => ({
        ...activity,
        id: EventId.make(derivedUuid("link-move-activity", key, activity.id)),
        turnId: null,
      }));
      const device = yield* devices
        .getDevice(row.linkDeviceId)
        .pipe(Effect.orElseSucceed(Option.none));
      const now = yield* nowIso;
      const dispatched = yield* engine
        .dispatch({
          type: "thread.import",
          commandId: CommandId.make(`server:link-move:${key}:import`),
          threadId: row.threadId,
          projectId: land.project.id,
          title: row.manifest.thread.title,
          modelSelection: agent.selection,
          runtimeMode: capped.runtimeMode,
          interactionMode: capped.interactionMode,
          branch: row.branch,
          worktreePath: row.worktreePath,
          movedFrom: {
            environmentId: row.manifest.source.environmentId,
            label: Option.isSome(device)
              ? device.value.label
              : row.manifest.source.environmentLabel,
            threadId: row.manifest.source.threadId,
            movedAt: now,
          },
          messages,
          activities,
          createdAt: now,
        })
        .pipe(Effect.uninterruptible, Effect.exit);
      if (Exit.isFailure(dispatched) && !(yield* threadExists(row.threadId))) {
        return yield* stop(`${ownLabel} couldn't create the thread.`);
      }
      yield* moves
        .settle({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          status: "committed",
          now: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  /**
   * Runs an import from where it stopped. Each stage holds the transfer's
   * lock and checks the link again; a stage that can't go on ends the move
   * aborted, with the reason the other computer shows.
   */
  const runImport = (linkDeviceId: string, transferId: string): Effect.Effect<void> => {
    const key = linkMoveKey(linkDeviceId, transferId);
    if (importing.has(key)) return Effect.void;
    importing.add(key);
    const steps = Effect.gen(function* () {
      for (;;) {
        const next = yield* stage(linkDeviceId, transferId, (row) =>
          Effect.gen(function* () {
            switch (row.stage) {
              case null:
                yield* fetchStage(row);
                return false;
              case "fetched":
                yield* worktreeStage(row);
                return false;
              case "worktree":
                yield* applyStage(row);
                return false;
              case "applied":
                yield* commitStage(row);
                return true;
            }
          }),
        );
        if (next === null || next.value) return;
      }
    });
    return steps.pipe(
      // A stage that can't go on ends the move. Anything else (a read that
      // failed) leaves it importing for the sweep to pick up again.
      Effect.catchTag("ImportStop", (failure) =>
        Effect.gen(function* () {
          const found = yield* readRow(linkDeviceId, transferId);
          if (Option.isSome(found)) {
            yield* lock(key)(abortRow(found.value, failure.reason));
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("link move import failed", { transferId, cause }),
      ),
      Effect.ensuring(Effect.sync(() => importing.delete(key))),
    );
  };

  // ---------------------------------------------------------------------------
  // Asking this computer's user
  // ---------------------------------------------------------------------------

  const respond: LinkMovesShape["respond"] = (input) =>
    Effect.gen(function* () {
      const found = yield* readRow(input.deviceId, input.requestId);
      if (Option.isNone(found)) return false;
      const row = found.value;
      if (row.status !== "awaiting_approval") {
        return yield* new ComputerLinkError({ detail: "That move is no longer waiting." });
      }
      yield* lock(row.transferKey)(
        input.allow
          ? Effect.gen(function* () {
              yield* moves
                .update({
                  linkDeviceId: row.linkDeviceId,
                  transferId: row.transferId,
                  patch: { status: "receiving" },
                  now: yield* nowIso,
                })
                .pipe(Effect.ignore);
            })
          : abortRow(row, `${ownLabel} didn't allow the move.`).pipe(
              Effect.mapError(
                () =>
                  new ComputerLinkError({ detail: "That answer couldn't be recorded. Try again." }),
              ),
            ),
      );
      yield* announcePending;
      return true;
    });

  const pending: LinkMovesShape["pending"] = Effect.gen(function* () {
    const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
    const result: Array<ComputerLinkPendingRequest> = [];
    for (const row of open.filter((entry) => entry.status === "awaiting_approval")) {
      const device = yield* devices
        .getDevice(row.linkDeviceId)
        .pipe(Effect.orElseSucceed(Option.none));
      const land = yield* landing(row.manifest);
      const maxRuntimeMode = Option.isSome(device)
        ? (device.value.linkMaxRuntimeMode ?? row.manifest.thread.runtimeMode)
        : row.manifest.thread.runtimeMode;
      const { runtimeMode } = clampLaunchToCeiling(
        {
          runtimeMode: row.manifest.thread.runtimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
        { runtimeMode: maxRuntimeMode, interactionMode: row.manifest.thread.interactionMode },
      );
      const fromLabel = Option.isSome(device)
        ? device.value.label
        : row.manifest.source.environmentLabel;
      result.push({
        deviceId: row.linkDeviceId,
        requestId: row.transferId as unknown as ComputerLinkPendingRequest["requestId"],
        kind: "move",
        move: {
          messageCount: row.manifest.summary.messageCount,
          branch: row.manifest.git.branch,
          trackedFiles: row.manifest.summary.trackedFiles,
          untrackedFiles: row.manifest.summary.untrackedFiles,
          unpushedCommits: row.manifest.summary.unpushedCommits,
        },
        fromLabel,
        parentEnvironmentId: row.manifest.source.environmentId,
        parentThreadId: row.manifest.source.threadId,
        parentThreadTitle: row.manifest.thread.title,
        askedBy: fromLabel,
        title: row.manifest.thread.title,
        prompt: "",
        projectName: land?.project.title ?? row.manifest.project.title,
        agent: {
          instanceId: row.manifest.agent.instanceId,
          model: row.manifest.agent.model,
        },
        runtimeMode,
        createdAt: row.createdAt,
        expiresAt: DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse(row.createdAt) + LINK_MOVE_TTL_MS),
        ),
      });
    }
    return result;
  });

  const dropLink: LinkMovesShape["dropLink"] = (deviceId) =>
    Effect.gen(function* () {
      const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
      // One that can't be dropped now ends anyway: its link is gone, so its
      // next stage refuses it, and the sweep drops it within the day.
      for (const row of open.filter((entry) => entry.linkDeviceId === deviceId)) {
        yield* abortMove(row.linkDeviceId, row.transferId, `${ownLabel} removed the link.`).pipe(
          Effect.catch((error) =>
            Effect.logWarning("link move drop failed", { detail: error.message }),
          ),
        );
      }
    });

  /** Imports to finish, moves gone stale, clean-up owed, staging that can go. */
  const sweep = Effect.gen(function* () {
    const now = Date.now();
    const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
    for (const row of open) {
      if (row.status === "importing") {
        if (yield* threadExists(row.threadId)) {
          yield* moves
            .settle({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              status: "committed",
              now: yield* nowIso,
            })
            .pipe(Effect.ignore);
        } else {
          yield* runImport(row.linkDeviceId, row.transferId).pipe(Effect.forkIn(scope));
        }
      } else if (Date.parse(row.updatedAt) + LINK_MOVE_TTL_MS < now) {
        yield* abortMove(
          row.linkDeviceId,
          row.transferId,
          row.status === "awaiting_approval"
            ? `Nobody on ${ownLabel} allowed the move in time.`
            : "The move stopped arriving.",
        );
      }
    }
    const owed = yield* moves.listCleanupOwed.pipe(Effect.orElseSucceed(() => []));
    for (const row of owed) yield* lock(row.transferKey)(cleanUp(row));
    const settled = yield* moves
      .listSettledBefore(new Date(now - 60 * 60 * 1000).toISOString())
      .pipe(Effect.orElseSucceed(() => []));
    for (const row of settled) {
      yield* Effect.tryPromise(() =>
        NodeFs.rm(stagingDir(row), { recursive: true, force: true }),
      ).pipe(Effect.ignore);
    }
  });

  const startReactor: LinkMovesShape["startReactor"] = () =>
    sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("link move sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      Effect.forkScoped,
      Effect.asVoid,
    );

  return LinkMoves.of({
    prepare,
    chunk,
    finish,
    status,
    abort,
    respond,
    pending,
    pendingChanges: Stream.fromPubSub(pendingHub),
    dropLink,
    startReactor,
  });
});

export const LinkMovesLive = Layer.effect(LinkMoves, make);
