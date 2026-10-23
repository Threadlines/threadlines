// @effect-diagnostics nodeBuiltinImport:off
/**
 * Moving a thread to a linked computer, on the computer it leaves
 * (docs/design/fleet.md, Part 3). `preview` says where it could go and what
 * would go with it; `start` checks the target again and freezes the thread
 * (`thread.move.start`); `cancel` asks to stop. The reactor then runs each
 * move to its end: pack it, offer it, wait for the other computer's user
 * when it asks first, send it, wait for the import, and record the outcome.
 * It never unfreezes a thread on its own: only the other computer's word
 * that the move was dropped does, so a thread is never live in two places.
 * A restart picks every unfinished move up again from the other computer's
 * answer to `peer.move.status`.
 */
import { randomUUID } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThread,
  type PeerDescriptor,
  type PeerMoveManifest,
  PeerMoveManifest as PeerMoveManifestSchema,
  type PeerMoveState,
  type PeerRpcError,
  type ThreadId,
  ThreadMoveError,
  ThreadMoveId,
  type ThreadMovePhase,
  type ThreadMovePreview,
  type ThreadMoveStartInput,
  type ThreadMoveTargetPreview,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkClient, type PeerClient } from "../links/ComputerLinkClient.ts";
import { ComputerLinkRepository, isUsableLink } from "../links/ComputerLinkRepository.ts";
import { threadMoveRefusal } from "../orchestration/threadMoveDecisions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { type ProjectPlace, resolveProjectPlace } from "../project/projectPlace.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  inspectMoveCheckout,
  movePayloadPath,
  readMoveExport,
  sha256OfFile,
  summarizeMoveChanges,
  ThreadMoveFailure,
  writeMoveExport,
} from "./moveExport.ts";

export interface ThreadMovesShape {
  readonly preview: (threadId: ThreadId) => Effect.Effect<ThreadMovePreview, ThreadMoveError>;
  readonly start: (
    input: ThreadMoveStartInput,
  ) => Effect.Effect<{ readonly transferId: ThreadMoveId }, ThreadMoveError>;
  readonly cancel: (threadId: ThreadId) => Effect.Effect<void, ThreadMoveError>;
  /** Run unfinished moves to their end, and every move started from now on. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadMoves extends Context.Service<ThreadMoves, ThreadMovesShape>()(
  "threadlines/moves/ThreadMoves",
) {}

/** How long a preview waits for each computer before listing it as unreachable. */
const DESCRIBE_WAIT = Duration.seconds(4);
/** Chunks of this many bytes (before base64). */
const CHUNK_BYTES = 512 * 1024;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeManifest = Schema.decodeUnknownEffect(PeerMoveManifestSchema);

const moveError = (detail: string) => new ThreadMoveError({ detail });

/** The agent to suggest on a target: the thread's own model when it has it, else its default. */
function suggestAgent(
  descriptor: PeerDescriptor,
  thread: OrchestrationThread,
): ModelSelection | undefined {
  for (const agent of descriptor.agents) {
    if (agent.models.some((model) => model.model === thread.modelSelection.model)) {
      return { instanceId: agent.instanceId, model: thread.modelSelection.model } as ModelSelection;
    }
  }
  if (descriptor.defaultAgent !== null) return descriptor.defaultAgent as ModelSelection;
  const first = descriptor.agents[0];
  const model = first?.models[0]?.model;
  return first !== undefined && model !== undefined
    ? ({ instanceId: first.instanceId, model } as ModelSelection)
    : undefined;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const threadRows = yield* ProjectionThreadRepository;
  const links = yield* ComputerLinkRepository;
  const client = yield* ComputerLinkClient;
  const identities = yield* RepositoryIdentityResolver;
  const git = yield* GitVcsDriver;
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;

  const moveDir = (transferId: string) => NodePath.join(config.stateDir, "moves", transferId);

  const readModel = snapshots
    .getCommandReadModel()
    .pipe(Effect.mapError(() => moveError("This computer's threads couldn't be read.")));

  /** Where the thread's code lives and how its project is known everywhere. */
  const whereFrom = (thread: OrchestrationThread, workspaceRoot: string) =>
    Effect.gen(function* () {
      const identity = yield* identities.resolve(workspaceRoot);
      const place = yield* resolveProjectPlace(identities, workspaceRoot);
      if (identity === null || place === null) {
        return yield* new ThreadMoveFailure({
          reason: "This project has no git remote, so the other computer can't find it.",
        });
      }
      const cwd = thread.worktreePath ?? workspaceRoot;
      const checkout = yield* inspectMoveCheckout(git, cwd, identity.locator.remoteName);
      return { identity, place, checkout };
    });

  const describeTarget = (
    environmentId: EnvironmentId,
    label: string,
    thread: OrchestrationThread,
    place: ProjectPlace | null,
  ) =>
    // Fresh: a project just set up there must show at once, not after the
    // five minutes a cached description lives.
    client.describe(environmentId, { fresh: true }).pipe(
      Effect.timeout(DESCRIBE_WAIT),
      Effect.option,
      Effect.map((described): ThreadMoveTargetPreview => {
        if (Option.isNone(described)) {
          return {
            environmentId,
            label,
            refusal: `${label} can't be reached right now.`,
            agents: [],
          };
        }
        const peer = described.value;
        const project =
          place === null
            ? undefined
            : peer.projects.find(
                (entry) =>
                  entry.canonicalKey === place.canonicalKey &&
                  (entry.subdirectory === undefined || entry.subdirectory === place.subdirectory),
              );
        const refusal =
          peer.moves !== true
            ? `${peer.label} needs a newer Threadlines to take moved threads.`
            : peer.access === "off"
              ? `${peer.label} doesn't take work from this computer.`
              : project === undefined
                ? `${peer.label} doesn't have this project.`
                : peer.agents.length === 0
                  ? `${peer.label} has no agent ready.`
                  : undefined;
        const suggested = suggestAgent(peer, thread);
        return {
          environmentId,
          label: peer.label,
          ...(refusal !== undefined ? { refusal } : {}),
          ...(refusal !== undefined &&
          peer.moves === true &&
          peer.access !== "off" &&
          project === undefined
            ? { refusalCode: "no_project" as const }
            : {}),
          ...(project !== undefined ? { projectName: project.name } : {}),
          access: peer.access,
          agents: peer.agents,
          ...(suggested !== undefined ? { suggestedAgent: suggested } : {}),
        };
      }),
    );

  const preview: ThreadMovesShape["preview"] = (threadId) =>
    Effect.gen(function* () {
      const model = yield* readModel;
      const thread = model.threads.find((entry) => entry.id === threadId);
      if (thread === undefined) return yield* moveError("That thread doesn't exist.");
      const project = model.projects.find((entry) => entry.id === thread.projectId);
      let refusal = threadMoveRefusal(model, thread);
      let changes: ThreadMovePreview["changes"];
      let place: ProjectPlace | null = null;
      if (project !== undefined && project.kind !== "general-chat") {
        const source = yield* whereFrom(thread, project.workspaceRoot).pipe(Effect.result);
        if (source._tag === "Success") {
          place = source.success.place;
          const { tracked, untracked } = yield* summarizeMoveChanges(
            git,
            source.success.checkout.root,
          ).pipe(Effect.orElseSucceed(() => ({ tracked: [], untracked: [] })));
          changes = {
            branch: source.success.checkout.branch,
            trackedFiles: tracked.length,
            untrackedFiles: untracked.length,
            unpushedCommits: source.success.checkout.unpushedCommits,
            messageCount: thread.messages.length,
          };
        } else {
          refusal ??= source.failure.reason;
        }
      }
      const rows = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).filter(isUsableLink);
      const targets = yield* Effect.forEach(
        rows,
        (row) => describeTarget(row.remoteEnvironmentId, row.remoteLabel, thread, place),
        { concurrency: "unbounded" },
      );
      return {
        ...(refusal !== null ? { refusal } : {}),
        ...(changes !== undefined ? { changes } : {}),
        targets,
      };
    });

  const start: ThreadMovesShape["start"] = (input) =>
    Effect.gen(function* () {
      const shown = yield* preview(input.threadId);
      if (shown.refusal !== undefined) return yield* moveError(shown.refusal);
      const target = shown.targets.find(
        (entry) => entry.environmentId === input.targetEnvironmentId,
      );
      if (target === undefined) return yield* moveError("This computer isn't linked to that one.");
      if (target.refusal !== undefined) return yield* moveError(target.refusal);
      const agent = target.agents.find((entry) => entry.instanceId === input.agent.instanceId);
      if (agent === undefined || !agent.models.some((model) => model.model === input.agent.model)) {
        return yield* moveError(`${target.label} has no such agent or model.`);
      }
      const transferId = ThreadMoveId.make(randomUUID());
      yield* engine
        .dispatch({
          type: "thread.move.start",
          commandId: CommandId.make(`server:thread-move:${transferId}:start`),
          threadId: input.threadId,
          transferId,
          target: { environmentId: target.environmentId, label: target.label },
          agent: input.agent,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((error) => moveError(error.message)));
      return { transferId };
    });

  /**
   * A thread's move, read from its row so an archived thread's move runs
   * on; none for a deleted thread. Fails when it couldn't be read.
   */
  const moveOf = (threadId: ThreadId) =>
    threadRows
      .getById({ threadId })
      .pipe(
        Effect.map((row) =>
          Option.isSome(row) && row.value.deletedAt === null ? (row.value.move ?? null) : null,
        ),
      );

  const cancel: ThreadMovesShape["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const move = yield* moveOf(threadId).pipe(
        Effect.mapError(() => moveError("That thread couldn't be read.")),
      );
      if (move === null) return yield* moveError("This thread isn't moving.");
      if (move.movedAway !== undefined) {
        return yield* moveError(`This thread already moved to ${move.target.label}.`);
      }
      yield* engine
        .dispatch({
          type: "thread.move.cancel",
          commandId: CommandId.make(`server:thread-move:${move.transferId}:cancel`),
          threadId,
          transferId: move.transferId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((error) => moveError(error.message)));
    });

  // ---------------------------------------------------------------------------
  // Running a move
  // ---------------------------------------------------------------------------

  /** Moves this process is running, so a second start of the same one does nothing. */
  const running = new Set<string>();

  /** The thread's move as it stands now, if it is still `transferId` and unfinished. Fails when it couldn't be read. */
  const currentMove = (threadId: ThreadId, transferId: string) =>
    moveOf(threadId).pipe(
      Effect.map((move) =>
        move !== null && move.transferId === transferId && move.movedAway === undefined
          ? move
          : null,
      ),
    );

  const dispatchStep = (
    threadId: ThreadId,
    transferId: ThreadMoveId,
    step:
      | {
          readonly kind: "progress";
          readonly phase: ThreadMovePhase;
          readonly sentBytes?: number;
          readonly totalBytes?: number;
        }
      | { readonly kind: "abort"; readonly reason: string }
      | { readonly kind: "complete"; readonly movedThreadId: ThreadId },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const commandId = CommandId.make(
        `server:thread-move:${transferId}:${step.kind}:${
          step.kind === "progress" ? `${step.phase}:${step.sentBytes ?? 0}` : "final"
        }`,
      );
      const dispatched = engine.dispatch(
        step.kind === "progress"
          ? {
              type: "thread.move.progress",
              commandId,
              threadId,
              transferId,
              phase: step.phase,
              ...(step.sentBytes !== undefined ? { sentBytes: step.sentBytes } : {}),
              ...(step.totalBytes !== undefined ? { totalBytes: step.totalBytes } : {}),
              createdAt,
            }
          : step.kind === "abort"
            ? {
                type: "thread.move.abort",
                commandId,
                threadId,
                transferId,
                reason: step.reason,
                createdAt,
              }
            : {
                type: "thread.move.complete",
                commandId,
                threadId,
                transferId,
                movedThreadId: step.movedThreadId,
                createdAt,
              },
      );
      // Progress is best effort. The outcome must be recorded: failing here
      // keeps the packed copy, and the worker tries again.
      if (step.kind === "progress") return yield* Effect.ignore(dispatched);
      yield* dispatched.pipe(
        Effect.mapError(
          () => new ThreadMoveFailure({ reason: "The move's outcome couldn't be recorded." }),
        ),
      );
    });

  /**
   * Calls the other computer for a thread's move, waiting through outages
   * (every 15 seconds) for as long as the thread is here: a move never gives
   * up on its own, so the thread stays frozen until that computer answers.
   * Deleting the thread ends the wait. An answer that refuses the call
   * (PeerRpcError) is final and fails the call.
   */
  const peerCall = <A>(
    threadId: ThreadId,
    environmentId: EnvironmentId,
    call: (peer: PeerClient) => Effect.Effect<A, PeerRpcError | RpcClientError.RpcClientError>,
  ) =>
    client.withPeer(environmentId, call).pipe(
      Effect.tapError((error) =>
        Effect.logInfo("thread move waits for the other computer", { detail: error.message }),
      ),
      Effect.retry({
        schedule: Schedule.spaced(Duration.seconds(15)),
        while: (error) =>
          error._tag === "ComputerLinkUnavailableError"
            ? threadRows.getById({ threadId }).pipe(
                Effect.map((row) => Option.isSome(row) && row.value.deletedAt === null),
                Effect.orElseSucceed(() => true),
              )
            : Effect.succeed(false),
      }),
    );

  /** Waits while the other computer is at `while`, backing off; a cancel asked meanwhile is honoured. */
  const awaitStatus = (
    threadId: ThreadId,
    transferId: ThreadMoveId,
    environmentId: EnvironmentId,
    waitingWhile: PeerMoveState["status"],
  ) =>
    Effect.gen(function* () {
      let delay = 2_000;
      for (;;) {
        const move = yield* currentMove(threadId, transferId);
        if (move === null) return null;
        if (move.cancelRequested) {
          return yield* peerCall(threadId, environmentId, (peer) =>
            peer["peer.move.abort"]({ transferId }),
          );
        }
        const state = yield* peerCall(threadId, environmentId, (peer) =>
          peer["peer.move.status"]({ transferId }),
        );
        if (state.status !== waitingWhile) return state;
        yield* Effect.sleep(Duration.millis(delay));
        delay = Math.min(delay * 2, 15_000);
      }
    });

  /** Records the other computer's final word, and tidies the export away. */
  const settle = (
    threadId: ThreadId,
    transferId: ThreadMoveId,
    state: PeerMoveState,
    fallbackReason: string,
  ) =>
    Effect.gen(function* () {
      if (state.status === "committed" && state.threadId !== undefined) {
        yield* dispatchStep(threadId, transferId, {
          kind: "complete",
          movedThreadId: state.threadId,
        });
      } else if (state.status === "aborted") {
        yield* dispatchStep(threadId, transferId, {
          kind: "abort",
          reason: state.reason ?? fallbackReason,
        });
      } else {
        return false;
      }
      yield* Effect.tryPromise(() =>
        NodeFs.rm(moveDir(transferId), { recursive: true, force: true }),
      ).pipe(Effect.ignore);
      return true;
    });

  /**
   * The export to send: the one made earlier when it is whole. A new one is
   * made only before the offer (`offered: false`); once the other computer
   * has the manifest, a lost or damaged export can't be rebuilt (it would
   * differ), and the move is dropped there instead.
   */
  const exportFor = (
    thread: OrchestrationThread,
    agent: ModelSelection,
    transferId: ThreadMoveId,
    offered: boolean,
  ) =>
    Effect.gen(function* () {
      const dir = moveDir(transferId);
      const earlier = yield* readMoveExport(dir);
      if (earlier !== null) {
        const manifest = yield* decodeManifest(earlier).pipe(Effect.option);
        if (Option.isSome(manifest)) {
          const hash = yield* sha256OfFile(movePayloadPath(dir)).pipe(Effect.option);
          if (Option.isSome(hash) && hash.value === manifest.value.sha256) return manifest.value;
        }
      }
      if (offered) {
        return yield* new ThreadMoveFailure({
          reason: "This computer lost the packed thread. Start the move again.",
        });
      }
      const model = yield* readModel.pipe(
        Effect.mapError(() => new ThreadMoveFailure({ reason: "This thread couldn't be read." })),
      );
      const project = model.projects.find((entry) => entry.id === thread.projectId);
      if (project === undefined) {
        return yield* new ThreadMoveFailure({ reason: "This thread's project is gone." });
      }
      const detail = yield* snapshots
        .getThreadDetailById(thread.id, { includeArchived: true })
        .pipe(
          Effect.mapError(() => new ThreadMoveFailure({ reason: "This thread couldn't be read." })),
        );
      if (Option.isNone(detail)) {
        return yield* new ThreadMoveFailure({ reason: "This thread couldn't be read." });
      }
      const { place, checkout } = yield* whereFrom(detail.value, project.workspaceRoot);
      return yield* writeMoveExport({
        git,
        checkout,
        transferId,
        dir,
        attachmentsDir: config.attachmentsDir,
        thread: detail.value,
        projectTitle: project.title,
        canonicalKey: place.canonicalKey,
        subdirectory: place.subdirectory,
        source: {
          environmentId: descriptor.environmentId,
          environmentLabel: descriptor.label,
          threadId: thread.id,
        },
        agent,
      });
    });

  /** Sends the payload from where the other computer's copy ends, reporting every 10%. */
  const send = (
    threadId: ThreadId,
    transferId: ThreadMoveId,
    environmentId: EnvironmentId,
    manifest: PeerMoveManifest,
    from: number,
  ) =>
    Effect.gen(function* () {
      const path = movePayloadPath(moveDir(transferId));
      let offset = from;
      let reported = -1;
      while (offset < manifest.totalBytes) {
        const move = yield* currentMove(threadId, transferId);
        if (move === null) return null;
        if (move.cancelRequested) {
          return yield* peerCall(threadId, environmentId, (peer) =>
            peer["peer.move.abort"]({ transferId }),
          );
        }
        const length = Math.min(CHUNK_BYTES, manifest.totalBytes - offset);
        const bytes = yield* Effect.tryPromise({
          try: async () => {
            const handle = await NodeFs.open(path, "r");
            try {
              const buffer = Buffer.alloc(length);
              await handle.read(buffer, 0, length, offset);
              return buffer;
            } finally {
              await handle.close();
            }
          },
          catch: () => new ThreadMoveFailure({ reason: "The packed thread couldn't be read." }),
        });
        const state = yield* peerCall(threadId, environmentId, (peer) =>
          peer["peer.move.chunk"]({ transferId, offset, data: bytes.toString("base64") }),
        );
        if (state.status !== "receiving") return state;
        offset = state.bytesReceived;
        const tenth = Math.floor((offset / manifest.totalBytes) * 10);
        if (tenth !== reported) {
          reported = tenth;
          yield* dispatchStep(threadId, transferId, {
            kind: "progress",
            phase: "sending",
            sentBytes: offset,
            totalBytes: manifest.totalBytes,
          });
        }
      }
      return yield* peerCall(threadId, environmentId, (peer) =>
        peer["peer.move.finish"]({ transferId }),
      );
    });

  /**
   * Runs one move to its end, from wherever it stands: packing, the offer,
   * the wait for the other computer's user, the bytes, the import. Every
   * step asks the other computer where it is first, so a restart resumes.
   */
  const runMove = (threadId: ThreadId, transferId: ThreadMoveId): Effect.Effect<void> => {
    if (running.has(transferId)) return Effect.void;
    running.add(transferId);
    /**
     * Drops the move on the other computer and records its answer. Its
     * answer is the only way the thread unfreezes, so a drop it couldn't
     * record yet is asked again until it is.
     */
    const drop = (environmentId: EnvironmentId, reason: string) =>
      peerCall(threadId, environmentId, (peer) => peer["peer.move.abort"]({ transferId })).pipe(
        Effect.retry({
          schedule: Schedule.spaced(Duration.seconds(15)),
          while: (error) => error._tag === "PeerRpcError",
        }),
        Effect.flatMap((dropped) => settle(threadId, transferId, dropped, reason)),
      );
    /**
     * The thread was deleted while it moved: the other computer is asked
     * once to drop the move (one that already arrived there stays), and the
     * packed copy goes. Unreachable, its own expiry drops a move that never
     * finished arriving.
     */
    const dropIfDeleted = Effect.gen(function* () {
      const row = yield* threadRows.getById({ threadId });
      if (Option.isNone(row) || row.value.deletedAt === null) return;
      const move = row.value.move ?? null;
      if (move === null || move.transferId !== transferId || move.movedAway !== undefined) return;
      yield* client
        .withPeer(move.target.environmentId, (peer) => peer["peer.move.abort"]({ transferId }))
        .pipe(Effect.ignore);
      yield* Effect.tryPromise(() =>
        NodeFs.rm(moveDir(transferId), { recursive: true, force: true }),
      ).pipe(Effect.ignore);
    }).pipe(Effect.ignore);
    const steps = Effect.gen(function* () {
      const move = yield* currentMove(threadId, transferId);
      if (move === null) return;
      const environmentId = move.target.environmentId;
      const label = move.target.label;
      // Where the other computer stands, if it heard of this move at all: one
      // it never heard of reads aborted with no reason.
      const known = yield* peerCall(threadId, environmentId, (peer) =>
        peer["peer.move.status"]({ transferId }),
      );
      let state: PeerMoveState | null = known;
      if (known.status === "aborted" && known.bytesReceived === 0 && known.reason === undefined) {
        // Never offered (or the offer never arrived): pack it and offer it.
        if (move.cancelRequested) {
          yield* dispatchStep(threadId, transferId, {
            kind: "abort",
            reason: "You cancelled the move.",
          });
          return;
        }
        const thread = (yield* readModel).threads.find((entry) => entry.id === threadId);
        if (thread === undefined) return;
        const manifest = yield* exportFor(thread, move.agent, transferId, false).pipe(
          Effect.result,
        );
        if (manifest._tag === "Failure") {
          yield* dispatchStep(threadId, transferId, {
            kind: "abort",
            reason: manifest.failure.reason,
          });
          return;
        }
        state = yield* peerCall(threadId, environmentId, (peer) =>
          peer["peer.move.prepare"]({ transferId, manifest: manifest.success }),
        );
      }
      for (;;) {
        if (state === null) return;
        if (yield* settle(threadId, transferId, state, `${label} dropped the move.`)) return;
        switch (state.status) {
          case "awaiting_approval":
            yield* dispatchStep(threadId, transferId, {
              kind: "progress",
              phase: "awaiting_approval",
            });
            state = yield* awaitStatus(threadId, transferId, environmentId, "awaiting_approval");
            break;
          case "receiving": {
            const thread = (yield* readModel).threads.find((entry) => entry.id === threadId);
            if (thread === undefined) return;
            const manifest = yield* exportFor(thread, move.agent, transferId, true).pipe(
              Effect.result,
            );
            if (manifest._tag === "Failure") {
              // The other computer has part of it: drop it there first.
              yield* drop(environmentId, manifest.failure.reason);
              return;
            }
            state = yield* send(
              threadId,
              transferId,
              environmentId,
              manifest.success,
              state.bytesReceived,
            );
            break;
          }
          case "importing":
            yield* dispatchStep(threadId, transferId, { kind: "progress", phase: "importing" });
            state = yield* awaitStatus(threadId, transferId, environmentId, "importing");
            break;
          default:
            return;
        }
      }
    });
    const attempt = steps.pipe(
      // The other computer refused a step outright: drop the move there, and
      // record what it answers. Unanswered, the thread stays frozen.
      Effect.catchTag("PeerRpcError", (error) =>
        Effect.gen(function* () {
          const move = yield* currentMove(threadId, transferId);
          if (move === null) return;
          yield* drop(move.target.environmentId, error.detail);
        }),
      ),
    );
    // Runs until the move ends. Anything else that stops it (a read that
    // failed, a dropped connection) starts it again from the top, which asks
    // the other computer where it stands first.
    const supervised = Effect.gen(function* () {
      for (;;) {
        const exit = yield* Effect.exit(attempt);
        if (Exit.isSuccess(exit)) return yield* dropIfDeleted;
        if (Cause.hasInterruptsOnly(exit.cause)) return;
        yield* Effect.logWarning("thread move stopped, trying again", {
          transferId,
          cause: exit.cause,
        });
        yield* Effect.sleep(Duration.seconds(30));
      }
    });
    return supervised.pipe(Effect.ensuring(Effect.sync(() => running.delete(transferId))));
  };

  const startReactor: ThreadMovesShape["startReactor"] = () =>
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      // Every move the previous process left unfinished.
      const model = yield* readModel.pipe(Effect.option);
      if (Option.isSome(model)) {
        for (const thread of model.value.threads) {
          const move = thread.move ?? null;
          if (thread.deletedAt === null && move !== null && move.movedAway === undefined) {
            yield* runMove(thread.id, move.transferId).pipe(Effect.forkScoped);
          }
        }
      }
      yield* events.pipe(
        // A cancel wakes a move this process isn't running (it does
        // nothing to one it is).
        Stream.runForEach((event) =>
          event.type === "thread.move-started" || event.type === "thread.move-cancel-requested"
            ? runMove(event.payload.threadId, event.payload.transferId).pipe(
                Effect.forkScoped,
                Effect.asVoid,
              )
            : Effect.void,
        ),
        Effect.forkScoped,
      );
    });

  return ThreadMoves.of({ preview, start, cancel, startReactor });
});

export const ThreadMovesLive = Layer.effect(ThreadMoves, make);
