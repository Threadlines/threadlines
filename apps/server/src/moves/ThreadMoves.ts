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
 * A computer busy with other moves is offered the move again later while the
 * thread waits frozen (`waitingForTarget`); one that asks first takes the
 * bytes before its user answers (`staged_awaiting_approval`), which counts as
 * done for quitting (docs/design/fleet.md, Part 3c).
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
  type ThreadMoveAbortCode,
  ThreadMoveError,
  ThreadMoveId,
  type ThreadMoveRequestId,
  type ThreadMovePhase,
  type ThreadMovePreview,
  type ThreadMovePreviewMany,
  type ThreadMovePreviewManyThread,
  type ThreadMoveSessionOutcome,
  type ThreadMoveNote,
  type ThreadMoveStartInput,
  type ThreadMoveTakes,
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
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkClient, type PeerClient } from "../links/ComputerLinkClient.ts";
import { ComputerLinkRepository, isUsableLink } from "../links/ComputerLinkRepository.ts";
import { generalChatThreadScratchCwd } from "../orchestration/generalChats.ts";
import {
  ALL_MOVE_TAKES,
  carryBringsWords,
  carryNotTaken,
  type ThreadMoveCarry,
  threadMoveCarry,
} from "../orchestration/threadMoveCarry.ts";
import {
  firstMoveBlock,
  moveWaitsOf,
  threadMoveRefusal,
  threadMoveRefusals,
} from "../orchestration/threadMoveDecisions.ts";
import { ThreadActionGate } from "./ThreadActionGate.ts";
import type { NativeSessionExport } from "../provider/nativeSession.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeThreadMoveContextReader } from "./threadMoveView.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { type ProjectPlace, resolveProjectPlace } from "../project/projectPlace.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  estimateMoveOtherBytes,
  inspectMoveCheckout,
  type MoveCheckout,
  moveThreadStateOf,
  nativeSessionFits,
  movePayloadPath,
  readMoveExport,
  sha256OfFile,
  summarizeMoveChanges,
  summarizeScratchFolder,
  ThreadMoveFailure,
  writeMoveExport,
  writeScratchExport,
} from "./moveExport.ts";

/**
 * How starting a queued move went (`startQueued`), for the move queue to act
 * on: `started`; `unreachable`, the target can't be reached now (try again);
 * `blocked`, it won't pass without the user (link removed or off, agent or
 * project gone there, or something only the user clears here); `busy`, the
 * thread or its session isn't ready yet (look again).
 */
export type QueuedMoveStart =
  | { readonly kind: "started"; readonly transferId: ThreadMoveId }
  | { readonly kind: "unreachable"; readonly words: string }
  | { readonly kind: "blocked"; readonly words: string }
  | { readonly kind: "busy"; readonly words: string };

/** A linked computer as it answered `peer.describe` just now; none when it didn't answer in time. */
export interface DescribedTarget {
  readonly environmentId: EnvironmentId;
  /** The name this computer has for it, until it answers with its own. */
  readonly label: string;
  readonly described: Option.Option<PeerDescriptor>;
}

export interface ThreadMovesShape {
  readonly preview: (threadId: ThreadId) => Effect.Effect<ThreadMovePreview, ThreadMoveError>;
  /**
   * Several threads at once (docs/design/fleet.md, Part 3c): the same checks
   * as `preview`, with each linked computer described once and no change
   * summary. A thread that can't be read is refused, not an error.
   */
  readonly previewMany: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ThreadMovePreviewMany, ThreadMoveError>;
  /** Every linked computer, each described once now: what a batch checks every thread against. */
  readonly describeTargets: Effect.Effect<ReadonlyArray<DescribedTarget>>;
  readonly start: (
    input: ThreadMoveStartInput,
  ) => Effect.Effect<{ readonly transferId: ThreadMoveId }, ThreadMoveError>;
  /**
   * Checks a move to queue (docs/design/fleet.md, Part 3b): the link, and,
   * when the target can be reached, its project and agent. An unreachable
   * target is allowed: the queued move waits for it. Returns the target's
   * name, or why it can't be queued.
   */
  readonly checkQueue: (input: {
    readonly threadId: ThreadId;
    readonly targetEnvironmentId: EnvironmentId;
    /** Absent: the target's suggested agent, checked when the move starts. */
    readonly agent?: ModelSelection | undefined;
    /** The computers as already described (a batch); absent: described now. */
    readonly targets?: ReadonlyArray<DescribedTarget> | undefined;
  }) => Effect.Effect<
    {
      readonly label: string;
      /** What it takes (ThreadMoveTakes); everything, when it couldn't be reached now. */
      readonly takes: ThreadMoveTakes;
    },
    ThreadMoveError
  >;
  /**
   * Before the move's stop (docs/design/fleet.md, Part 3e, "Put back"):
   * whether the target takes what the thread carries. `ok` when it carries
   * nothing to ask about; `unreachable` when the target doesn't answer;
   * `blocked` (with words) when it answered that it doesn't, so the move
   * ends before anything here is stopped.
   */
  readonly checkCarry: (input: {
    readonly threadId: ThreadId;
    readonly targetEnvironmentId: EnvironmentId;
    readonly label: string;
  }) => Effect.Effect<
    | { readonly kind: "ok" }
    | { readonly kind: "unreachable"; readonly words: string }
    | { readonly kind: "blocked"; readonly words: string }
  >;
  /** Starts the thread's queued move `requestId`, now that the thread is free and quiesced. */
  readonly startQueued: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ThreadMoveRequestId;
    readonly targetEnvironmentId: EnvironmentId;
    /** Absent: the agent the target suggests now. */
    readonly agent?: ModelSelection | undefined;
  }) => Effect.Effect<QueuedMoveStart>;
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

/**
 * What moving to `peer` with its agent `instanceId` does with the thread's
 * own agent session (docs/design/fleet.md, Part 3d): it carries when there
 * is one, that computer takes sessions, and its agent is the same driver;
 * a session past 50 MB, or one that would take the move past its 100 MB
 * with the `otherBytes` it carries besides, stays behind (`too_large`).
 * Anything else: a summary.
 */
export function sessionOutcomeFor(
  session: NativeSessionExport | null,
  peer: PeerDescriptor,
  instanceId: string,
  otherBytes = 0,
): ThreadMoveSessionOutcome {
  if (session === null || peer.moveNativeSession !== true) return "summary";
  const agent = peer.agents.find((entry) => entry.instanceId === instanceId);
  if (agent === undefined || agent.driver !== session.driver) return "summary";
  const bytes = session.files.reduce((sum, file) => sum + file.size, 0);
  return nativeSessionFits(bytes, otherBytes) ? "carries" : "too_large";
}

/**
 * What a linked computer means for a move: whether it can be reached, takes
 * moves from here, and has agents. For a thread (`forThread`), also whether
 * it has the thread's project, the agent to suggest, and what each agent
 * would get of its session; without one, only what holds for every thread
 * (its default agent is the suggestion).
 */
/** What a linked computer takes beyond a plain thread, as it says (ThreadMoveTakes). */
export function takesOf(peer: PeerDescriptor): ThreadMoveTakes {
  return {
    ...(peer.moveThreadState === true ? { threadState: true as const } : {}),
    ...(peer.moveGeneralChats === true ? { generalChats: true as const } : {}),
  };
}

/** The name General Chats has on every computer, as the dialog's project line says it. */
const GENERAL_CHATS_NAME = "General chats";

/**
 * What won't work on `peer` as it did here, for a thread carrying `carry`
 * (docs/design/fleet.md, Part 3e, "What the user sees"), in the server's
 * words; a note about some of its agents names them (`instanceIds`).
 */
export function targetNotesOf(
  peer: PeerDescriptor,
  carry: ThreadMoveCarry,
  extra: {
    /** Whether GitHub is signed in there for the project; absent: not asked, or it couldn't tell. */
    readonly gitHubReady?: boolean | undefined;
    /** The thread's agent here keeps its turn running until its goal is met (Claude). */
    readonly goalHoldsTurn?: boolean | undefined;
  },
): ReadonlyArray<ThreadMoveNote> {
  const notes: ThreadMoveNote[] = [];
  const goal = carry.goal;
  if (carry.pullRequests !== null && extra.gitHubReady === false) {
    notes.push({
      words: `GitHub isn't signed in on ${peer.label}. Sign in there before you turn auto-fix on.`,
    });
  }
  for (const agent of peer.agents) {
    if (carry.checkBacks.length > 0 && agent.checkBacks === false) {
      notes.push({
        words: `${agent.name} on ${peer.label} can't set check-backs. It's told once what was planned.`,
        instanceIds: [agent.instanceId],
      });
    }
    if (goal !== null && goal.status !== "complete" && agent.threadGoals === false) {
      notes.push({
        words: `${agent.name} on ${peer.label} can't keep goals, so its goal stays behind.`,
        instanceIds: [agent.instanceId],
      });
    } else if (
      goal !== null &&
      goal.tokenBudget !== null &&
      ["active", "paused", "usageLimited"].includes(goal.status) &&
      agent.threadGoals === true &&
      agent.goalBudget === false
    ) {
      notes.push({
        words: `Its goal arrives paused: ${agent.name} on ${peer.label} can't keep its token budget. Resume runs it without one.`,
        instanceIds: [agent.instanceId],
      });
    }
  }
  if (extra.goalHoldsTurn === true && goal?.status === "active") {
    notes.push({
      words: "It's working toward its goal. Move when it's done waits until it gets there.",
    });
  }
  return notes;
}

export function targetPreviewOf(
  target: DescribedTarget,
  forThread: {
    readonly thread: OrchestrationThread;
    readonly place: ProjectPlace | null;
    /** The thread's own agent session as it would travel; absent: not looked at. */
    readonly session?: NativeSessionExport | null | undefined;
    /** What the move carries besides the session (estimateMoveOtherBytes). */
    readonly otherBytes?: number | undefined;
    /** What else it carries (threadMoveCarry); absent: not looked at. */
    readonly carry?: ThreadMoveCarry | undefined;
    /** Whether GitHub is signed in there, per computer (`peer.move.readiness`). */
    readonly gitHubReady?: ReadonlyMap<string, boolean> | undefined;
    readonly goalHoldsTurn?: boolean | undefined;
  } | null,
): ThreadMoveTargetPreview {
  const { environmentId, label } = target;
  if (Option.isNone(target.described)) {
    return {
      environmentId,
      label,
      refusal: `${label} can't be reached right now.`,
      unreachable: true,
      agents: [],
    };
  }
  const peer = target.described.value;
  const place = forThread?.place ?? null;
  const carry = forThread?.carry;
  // A general chat lands in General chats there: no project to match.
  const generalChat = carry?.generalChat === true;
  const project =
    place === null || generalChat
      ? undefined
      : peer.projects.find(
          (entry) =>
            entry.canonicalKey === place.canonicalKey &&
            (entry.subdirectory === undefined || entry.subdirectory === place.subdirectory),
        );
  const noProject = forThread !== null && !generalChat && project === undefined;
  // What the thread has going that this computer doesn't take (Part 3e): it
  // needs a newer Threadlines, whatever else it has.
  const notTaken = carry === undefined ? null : carryNotTaken(carry, takesOf(peer));
  const refusal =
    peer.moves !== true
      ? `${peer.label} needs a newer Threadlines to take moved threads.`
      : peer.access === "off"
        ? `${peer.label} doesn't take work from this computer.`
        : notTaken !== null
          ? `Update Threadlines on ${peer.label} to move this thread: ${notTaken}.`
          : noProject
            ? `${peer.label} doesn't have this project.`
            : peer.agents.length === 0
              ? `${peer.label} has no agent ready.`
              : undefined;
  const notes =
    carry === undefined || refusal !== undefined
      ? []
      : targetNotesOf(peer, carry, {
          gitHubReady: forThread?.gitHubReady?.get(environmentId),
          goalHoldsTurn: forThread?.goalHoldsTurn,
        });
  const suggested =
    forThread !== null
      ? suggestAgent(peer, forThread.thread)
      : ((peer.defaultAgent ?? undefined) as ModelSelection | undefined);
  const session = forThread?.session;
  const sessionOutcomes =
    session === undefined
      ? []
      : peer.agents.map((agent) => ({
          instanceId: agent.instanceId,
          outcome: sessionOutcomeFor(session, peer, agent.instanceId, forThread?.otherBytes),
        }));
  return {
    environmentId,
    label: peer.label,
    ...(refusal !== undefined ? { refusal } : {}),
    ...(refusal !== undefined &&
    peer.moves === true &&
    peer.access !== "off" &&
    notTaken === null &&
    noProject
      ? { refusalCode: "no_project" as const }
      : {}),
    ...(project !== undefined
      ? { projectName: project.name }
      : generalChat
        ? { projectName: GENERAL_CHATS_NAME }
        : {}),
    ...(notes.length > 0 ? { notes } : {}),
    access: peer.access,
    agents: peer.agents,
    ...(suggested !== undefined ? { suggestedAgent: suggested } : {}),
    ...(peer.moveStagedApproval === true ? { stagedApproval: true } : {}),
    ...(sessionOutcomes.length > 0 ? { sessionOutcomes } : {}),
  };
}

/**
 * One thread of `moves.previewMany`: its own refusal and waits, and the
 * computers that would take other threads but not this one (`targets` are
 * the computers as they are for every thread).
 */
export function previewManyThread(
  threadId: ThreadId,
  shown: ThreadMovePreview,
  targets: ReadonlyArray<ThreadMoveTargetPreview>,
): ThreadMovePreviewManyThread {
  const targetRefusals = shown.targets.flatMap((own) => {
    const shared = targets.find((entry) => entry.environmentId === own.environmentId);
    if (own.refusal === undefined || shared === undefined || shared.refusal !== undefined) {
      return [];
    }
    return [
      {
        environmentId: own.environmentId,
        refusal: own.refusal,
        ...(own.refusalCode === "no_project" ? { refusalCode: "no_project" as const } : {}),
      },
    ];
  });
  // A general chat's row says where it lands; any thread's, what won't work there.
  const targetLines = shown.targets.flatMap((own) =>
    batchTargetLines(own, shown.folder !== undefined),
  );
  // A batch moves each thread with the agent its target suggests for it.
  const sessionOutcomes = shown.targets.flatMap((own) => {
    const agent = own.suggestedAgent;
    const outcome =
      agent === undefined
        ? undefined
        : own.sessionOutcomes?.find((entry) => entry.instanceId === agent.instanceId)?.outcome;
    return outcome === undefined || outcome === "summary"
      ? []
      : [{ environmentId: own.environmentId, outcome }];
  });
  return {
    threadId,
    ...(shown.refusal !== undefined ? { refusal: shown.refusal } : {}),
    ...(shown.waitsFor !== undefined && shown.waitsFor.length > 0
      ? { waitsFor: shown.waitsFor }
      : {}),
    ...(targetRefusals.length > 0 ? { targetRefusals } : {}),
    ...(shown.brings !== undefined && shown.brings.length > 0 ? { brings: shown.brings } : {}),
    ...(shown.folder !== undefined ? { folder: shown.folder } : {}),
    ...(targetLines.length > 0 ? { targetLines } : {}),
    ...(sessionOutcomes.length > 0 ? { sessionOutcomes } : {}),
  };
}

/**
 * Per computer that takes the thread, its own lines in a batch: the project
 * it lands in, and the notes that hold for the agent that computer suggests
 * (a batch moves each thread with that one), without naming agents.
 */
function batchTargetLines(own: ThreadMoveTargetPreview, withLanding: boolean) {
  if (own.refusal !== undefined) return [];
  const projectName = withLanding ? own.projectName : undefined;
  const agent = own.suggestedAgent?.instanceId;
  const notes = (own.notes ?? []).flatMap((note) =>
    note.instanceIds === undefined
      ? [note]
      : agent !== undefined && note.instanceIds.includes(agent)
        ? [{ words: note.words }]
        : [],
  );
  if (projectName === undefined && notes.length === 0) return [];
  return [
    {
      environmentId: own.environmentId,
      ...(projectName !== undefined ? { projectName } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    },
  ];
}

/** How long a move waits for a busy computer before offering again: 15 s, 30 s, 1 min, then every 2 min. */
export const busyRetryDelay = (attempt: number) =>
  Duration.seconds(Math.min(15 * 2 ** Math.max(0, attempt), 120));

/** How often a move waiting for a busy computer looks for a Cancel. */
const BUSY_CANCEL_CHECK = Duration.seconds(2);

/**
 * Offers a move until the other computer takes it or answers for good
 * (docs/design/fleet.md, Part 3c). A `busy` answer (it takes as many moves as
 * it takes at once) recorded nothing there: the thread stays frozen, the
 * move says it waits for that computer (`waiting`, once), and it is offered
 * again with backoff. A Cancel meanwhile ends it here; a move that's no
 * longer the thread's ends the wait.
 */
/**
 * Why the other computer dropped a move, as a code (ThreadMoveAbortCode):
 * its own word (Don't allow, or nobody allowed it in time), a refusal to hold
 * more moves, the user's Cancel here (`cancelRequested`), or any other drop.
 */
export function moveAbortCode(state: PeerMoveState, cancelRequested: boolean): ThreadMoveAbortCode {
  if (state.abortCode !== undefined) return state.abortCode;
  if (state.refusalCode === "staging_full") return "staging_full";
  return cancelRequested ? "cancelled" : "aborted";
}

export const offerUntilTaken = <EPrepare, EStanding, EWaiting, R>(deps: {
  readonly prepare: Effect.Effect<PeerMoveState, EPrepare, R>;
  /** Whether the move is still the thread's and wanted. */
  readonly standing: Effect.Effect<"waiting" | "cancelled" | "gone", EStanding, R>;
  readonly waiting: Effect.Effect<void, EWaiting, R>;
  readonly delay?: (attempt: number) => Duration.Duration;
  readonly cancelCheck?: Duration.Duration;
}): Effect.Effect<
  | { readonly kind: "answered"; readonly state: PeerMoveState }
  | { readonly kind: "cancelled" }
  | { readonly kind: "gone" },
  EPrepare | EStanding | EWaiting,
  R
> =>
  Effect.gen(function* () {
    const delay = deps.delay ?? busyRetryDelay;
    const cancelCheck = Duration.toMillis(deps.cancelCheck ?? BUSY_CANCEL_CHECK);
    for (let attempt = 0; ; attempt += 1) {
      const state = yield* deps.prepare;
      if (state.status !== "aborted" || state.refusalCode !== "busy") {
        return { kind: "answered", state } as const;
      }
      if (attempt === 0) yield* deps.waiting;
      let left = Duration.toMillis(delay(attempt));
      while (left > 0) {
        const standing = yield* deps.standing;
        if (standing !== "waiting") return { kind: standing } as const;
        const step = Math.min(left, cancelCheck);
        yield* Effect.sleep(Duration.millis(step));
        left -= step;
      }
      const standing = yield* deps.standing;
      if (standing !== "waiting") return { kind: standing } as const;
    }
  });

/**
 * The target and agent a move names, checked against what the target said
 * (`moves.preview`). No agent named: the one the target suggests for this
 * thread, as the dialog picks it; none there means the move can't go.
 */
export function checkMoveTarget(
  shown: ThreadMovePreview,
  environmentId: EnvironmentId,
  named: ModelSelection | undefined,
):
  | { readonly ok: ThreadMoveTargetPreview; readonly agent: ModelSelection }
  | { readonly unreachable: ThreadMoveTargetPreview }
  | { readonly refusal: string } {
  const target = shown.targets.find((entry) => entry.environmentId === environmentId);
  if (target === undefined) return { refusal: "This computer isn't linked to that one." };
  if (target.unreachable === true) return { unreachable: target };
  if (target.refusal !== undefined) return { refusal: target.refusal };
  const agent = named ?? target.suggestedAgent;
  if (agent === undefined) return { refusal: `${target.label} has no agent ready.` };
  const offered = target.agents.find((entry) => entry.instanceId === agent.instanceId);
  if (offered === undefined || !offered.models.some((model) => model.model === agent.model)) {
    return { refusal: `${target.label} has no such agent or model.` };
  }
  return { ok: target, agent };
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
  const providers = yield* ProviderService;
  const actionGate = yield* ThreadActionGate;
  const descriptor = yield* environment.getDescriptor;

  const moveDir = (transferId: string) => NodePath.join(config.stateDir, "moves", transferId);

  const readMoveContext = yield* makeThreadMoveContextReader;
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

  /**
   * Every computer this one links to, each asked once what it is now; none
   * for one that doesn't answer in time. Fresh: a project just set up there
   * must show at once, not after the five minutes a cached description lives.
   */
  const describeTargets: ThreadMovesShape["describeTargets"] = Effect.gen(function* () {
    const rows = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).filter(isUsableLink);
    return yield* Effect.forEach(
      rows,
      (row) =>
        client.describe(row.remoteEnvironmentId, { fresh: true }).pipe(
          Effect.timeout(DESCRIBE_WAIT),
          Effect.option,
          Effect.map((described): DescribedTarget => ({
            environmentId: row.remoteEnvironmentId,
            label: row.remoteLabel,
            described,
          })),
        ),
      { concurrency: "unbounded" },
    );
  });

  /**
   * Where the thread could go and what would go with it. `refusal` is what
   * only the user can clear (or a project the other computer can't find);
   * `waitsFor` is what the thread is busy with. `forQueued` names the queued
   * move being started, which doesn't count against itself. `targets` are
   * the computers as already described (several threads at once read them
   * once); `withChanges: false` skips the change summary.
   */
  const inspect = (
    threadId: ThreadId,
    options: {
      readonly forQueued?: ThreadMoveRequestId | undefined;
      readonly targets?: ReadonlyArray<DescribedTarget> | undefined;
      readonly withChanges?: boolean;
      /** Say what each agent would get of the thread's own session (the dialogs). */
      readonly withSession?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      // Only what the checks read: the whole read model costs about half a
      // second on a big install (threadMoveView.ts).
      const context = yield* readMoveContext(threadId).pipe(
        Effect.mapError(() => moveError("This computer's threads couldn't be read.")),
      );
      if (context === null) return yield* moveError("That thread doesn't exist.");
      const { thread, view } = context;
      const project = view.projects.find((entry) => entry.id === thread.projectId);
      // As if the other computer took everything (docs/design/fleet.md, Part
      // 3e): one that doesn't says so as its own refusal.
      const refusals = threadMoveRefusals(view, thread, ALL_MOVE_TAKES);
      const carry = threadMoveCarry(view, thread);
      const pending = thread.pendingMove ?? null;
      let refusal: string | null =
        firstMoveBlock(refusals)?.words ??
        (pending !== null && pending.requestId !== options.forQueued
          ? `A move to ${pending.target.label} is already waiting. Cancel it first.`
          : null);
      let changes: ThreadMovePreview["changes"];
      let folder: ThreadMovePreview["folder"];
      let place: ProjectPlace | null = null;
      let checkout: MoveCheckout | null = null;
      if (project !== undefined && project.kind === "general-chat") {
        // Its folder goes, every file in it, within the move's limits.
        const summary = yield* summarizeScratchFolder(
          generalChatThreadScratchCwd(project.workspaceRoot, thread.id, NodePath),
        );
        folder = { files: summary.files, bytes: summary.bytes };
        refusal ??= summary.refusal;
      } else if (project !== undefined) {
        const source = yield* whereFrom(thread, project.workspaceRoot).pipe(Effect.result);
        if (source._tag === "Success") {
          place = source.success.place;
          checkout = source.success.checkout;
          if (options.withChanges !== false) {
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
          }
        } else {
          refusal ??= source.failure.reason;
        }
      }
      const described = options.targets ?? (yield* describeTargets);
      // Sizes only: the files are read when the move packs them.
      const session =
        options.withSession === true ? yield* providers.exportNativeSession(thread.id) : undefined;
      // What else the move carries, weighed with the session as the export
      // weighs it; only worth measuring when there is a session.
      const otherBytes =
        session !== undefined && session !== null && checkout !== null
          ? yield* estimateMoveOtherBytes({
              git,
              checkout,
              thread,
              attachmentsDir: config.attachmentsDir,
            })
          : (folder?.bytes ?? 0);
      // The dialogs' warnings: GitHub's sign-in there, asked only for a
      // thread whose switches are on, and whether its goal holds the turn here.
      const gitHubReady =
        options.withSession === true && carry.pullRequests !== null && place !== null
          ? yield* readinessOf(described, place.canonicalKey)
          : undefined;
      const goalHoldsTurn =
        options.withSession === true && carry.goal?.status === "active"
          ? yield* providers.getCapabilities(thread.modelSelection.instanceId).pipe(
              Effect.map((capabilities) => capabilities.threadGoalPause === "unsupported"),
              Effect.orElseSucceed(() => false),
            )
          : false;
      const targets = described.map((target) =>
        targetPreviewOf(target, {
          thread,
          place,
          session,
          otherBytes,
          carry,
          gitHubReady,
          goalHoldsTurn,
        }),
      );
      const waitsFor = moveWaitsOf(refusals);
      const brings = carryBringsWords(carry).map((words) => ({ words }));
      return {
        thread,
        carry,
        described,
        // A move that doesn't wait refuses a busy thread too.
        busy: threadMoveRefusal(view, thread, ALL_MOVE_TAKES),
        preview: {
          ...(refusal !== null ? { refusal } : {}),
          ...(waitsFor.length > 0 ? { waitsFor } : {}),
          ...(changes !== undefined ? { changes } : {}),
          ...(folder !== undefined ? { folder } : {}),
          ...(brings.length > 0 ? { brings } : {}),
          targets,
        } satisfies ThreadMovePreview,
      };
    });

  /**
   * Whether GitHub is signed in for the project on each computer that takes
   * thread state (`peer.move.readiness`); one that doesn't answer in time is
   * left out (the dialog says nothing then).
   */
  const readinessOf = (described: ReadonlyArray<DescribedTarget>, canonicalKey: string) =>
    Effect.gen(function* () {
      const answers = yield* Effect.forEach(
        described,
        (target) =>
          Option.isNone(target.described) || target.described.value.moveThreadState !== true
            ? Effect.succeed(null)
            : client
                .withPeer(target.environmentId, (peer) =>
                  peer["peer.move.readiness"]({ canonicalKey }),
                )
                .pipe(
                  Effect.timeout(DESCRIBE_WAIT),
                  Effect.map((answer) =>
                    answer.gitHubReady === undefined
                      ? null
                      : ([target.environmentId, answer.gitHubReady] as const),
                  ),
                  Effect.orElseSucceed(() => null),
                ),
        { concurrency: "unbounded" },
      );
      return new Map(answers.filter((entry) => entry !== null));
    });

  /** What a computer just described takes; one that couldn't be reached is taken to take everything. */
  const takesFrom = (described: ReadonlyArray<DescribedTarget>, environmentId: EnvironmentId) => {
    const target = described.find((entry) => entry.environmentId === environmentId);
    return target === undefined || Option.isNone(target.described)
      ? ALL_MOVE_TAKES
      : takesOf(target.described.value);
  };

  const preview: ThreadMovesShape["preview"] = (threadId) =>
    inspect(threadId, { withSession: true }).pipe(Effect.map((inspected) => inspected.preview));

  const previewMany: ThreadMovesShape["previewMany"] = (threadIds) =>
    Effect.gen(function* () {
      const described = yield* describeTargets;
      const targets = described.map((target) => targetPreviewOf(target, null));
      const threads = yield* Effect.forEach(
        threadIds,
        (threadId) =>
          inspect(threadId, { targets: described, withChanges: false, withSession: true }).pipe(
            Effect.map(({ preview: shown }) => previewManyThread(threadId, shown, targets)),
            Effect.catch((error) => Effect.succeed({ threadId, refusal: error.detail })),
          ),
        // Each look runs a few git commands in the thread's checkout.
        { concurrency: 4 },
      );
      return { threads, targets } satisfies ThreadMovePreviewMany;
    });

  /**
   * Freezes the thread for its move (`thread.move.start`); the decider checks
   * it again, against what the other computer just said it takes. Held in the
   * thread's action gate, so an act for it already under way here (a merge,
   * a turn the pull request watcher starts) finishes first, and every act
   * after reads the thread as moving.
   */
  const dispatchStart = (
    threadId: ThreadId,
    target: ThreadMoveTargetPreview,
    agent: ModelSelection,
    takes: ThreadMoveTakes,
    queuedRequestId?: ThreadMoveRequestId,
  ) =>
    actionGate.withThread(
      threadId,
      Effect.gen(function* () {
        const transferId = ThreadMoveId.make(randomUUID());
        yield* engine.dispatch({
          type: "thread.move.start",
          commandId: CommandId.make(`server:thread-move:${transferId}:start`),
          threadId,
          transferId,
          target: { environmentId: target.environmentId, label: target.label },
          agent,
          ...(queuedRequestId !== undefined ? { queuedRequestId } : {}),
          targetTakes: takes,
          createdAt: yield* nowIso,
        });
        return transferId;
      }),
    );

  const start: ThreadMovesShape["start"] = (input) =>
    Effect.gen(function* () {
      const inspected = yield* inspect(input.threadId);
      const shown = inspected.preview;
      if (shown.refusal !== undefined) return yield* moveError(shown.refusal);
      if (inspected.busy !== null) return yield* moveError(inspected.busy);
      const checked = checkMoveTarget(shown, input.targetEnvironmentId, input.agent);
      if ("refusal" in checked) return yield* moveError(checked.refusal);
      if ("unreachable" in checked) {
        return yield* moveError(checked.unreachable.refusal ?? "That computer can't be reached.");
      }
      const transferId = yield* dispatchStart(
        input.threadId,
        checked.ok,
        input.agent,
        takesFrom(inspected.described, input.targetEnvironmentId),
      ).pipe(Effect.mapError((error) => moveError(error.message)));
      return { transferId };
    });

  const checkQueue: ThreadMovesShape["checkQueue"] = (input) =>
    Effect.gen(function* () {
      const inspected = yield* inspect(input.threadId, {
        targets: input.targets,
        withChanges: false,
      });
      const shown = inspected.preview;
      if (shown.refusal !== undefined) return yield* moveError(shown.refusal);
      const checked = checkMoveTarget(shown, input.targetEnvironmentId, input.agent);
      if ("refusal" in checked) return yield* moveError(checked.refusal);
      return {
        label: "ok" in checked ? checked.ok.label : checked.unreachable.label,
        takes: takesFrom(inspected.described, input.targetEnvironmentId),
      };
    });

  const checkCarry: ThreadMovesShape["checkCarry"] = (input) =>
    Effect.gen(function* () {
      const context = yield* readMoveContext(input.threadId).pipe(Effect.option);
      if (Option.isNone(context) || context.value === null) return { kind: "ok" } as const;
      const carry = threadMoveCarry(context.value.view, context.value.thread);
      if (!carry.needs.threadState && !carry.needs.generalChats) return { kind: "ok" } as const;
      const peer = yield* client
        .describe(input.targetEnvironmentId, { fresh: true })
        .pipe(Effect.timeout(DESCRIBE_WAIT), Effect.option);
      if (Option.isNone(peer)) {
        return { kind: "unreachable", words: `Waiting for ${input.label} to connect.` } as const;
      }
      const notTaken = carryNotTaken(carry, takesOf(peer.value));
      return notTaken === null
        ? ({ kind: "ok" } as const)
        : ({
            kind: "blocked",
            words: `Update Threadlines on ${peer.value.label} to move this thread: ${notTaken}.`,
          } as const);
    });

  const startQueued: ThreadMovesShape["startQueued"] = (input) =>
    Effect.gen(function* () {
      const inspected = yield* inspect(input.threadId, {
        forQueued: input.requestId,
        withChanges: false,
      }).pipe(Effect.result);
      if (inspected._tag === "Failure") {
        return { kind: "busy", words: inspected.failure.detail } as const;
      }
      const shown = inspected.success.preview;
      if (shown.refusal !== undefined) return { kind: "blocked", words: shown.refusal } as const;
      const checked = checkMoveTarget(shown, input.targetEnvironmentId, input.agent);
      if ("refusal" in checked) return { kind: "blocked", words: checked.refusal } as const;
      if ("unreachable" in checked) {
        return {
          kind: "unreachable",
          words: `Waiting for ${checked.unreachable.label} to connect.`,
        } as const;
      }
      const started = yield* dispatchStart(
        input.threadId,
        checked.ok,
        checked.agent,
        takesFrom(inspected.success.described, input.targetEnvironmentId),
        input.requestId,
      ).pipe(Effect.result);
      return started._tag === "Success"
        ? ({ kind: "started", transferId: started.success } as const)
        : ({ kind: "busy", words: started.failure.message } as const);
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
          /** The other computer has every byte; only its user's Allow is left. */
          readonly staged?: boolean;
          /** The other computer is busy with other moves. */
          readonly waitingForTarget?: boolean;
        }
      | { readonly kind: "abort"; readonly reason: string; readonly code: ThreadMoveAbortCode }
      | { readonly kind: "complete"; readonly movedThreadId: ThreadId },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const commandId = CommandId.make(
        `server:thread-move:${transferId}:${step.kind}:${
          step.kind === "progress"
            ? `${step.phase}:${step.sentBytes ?? 0}${step.staged === true ? ":staged" : ""}${
                step.waitingForTarget === true ? ":waiting" : ""
              }`
            : "final"
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
              ...(step.staged === true ? { staged: true } : {}),
              ...(step.waitingForTarget === true ? { waitingForTarget: true } : {}),
              createdAt,
            }
          : step.kind === "abort"
            ? {
                type: "thread.move.abort",
                commandId,
                threadId,
                transferId,
                reason: step.reason,
                code: step.code,
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
      // keeps the packed copy, and the worker tries again. A staged move's
      // progress is an outcome too (a quit waits on it).
      if (step.kind === "progress" && step.staged !== true) {
        return yield* Effect.ignore(dispatched);
      }
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

  /** moveAbortCode for a move as it stands now. */
  const abortCodeOf = (threadId: ThreadId, transferId: ThreadMoveId, state: PeerMoveState) =>
    currentMove(threadId, transferId).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((move) => moveAbortCode(state, move?.cancelRequested === true)),
    );

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
          code: yield* abortCodeOf(threadId, transferId, state),
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
    targetEnvironmentId: EnvironmentId,
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
      const nativeSession = yield* sessionToCarry(thread.id, targetEnvironmentId, agent);
      // What it had going, for a computer that takes it (docs/design/fleet.md,
      // Part 3e); one that doesn't never gets it, and couldn't have been
      // offered a thread that needs it.
      const takes = detail.value.move?.targetTakes;
      const state =
        takes?.threadState === true
          ? moveThreadStateOf(threadMoveCarry({ projects: model.projects }, detail.value))
          : undefined;
      const source = {
        environmentId: descriptor.environmentId,
        environmentLabel: environment.currentLabel(),
        threadId: thread.id,
      };
      if (project.kind === "general-chat") {
        return yield* writeScratchExport({
          dir,
          folder: generalChatThreadScratchCwd(project.workspaceRoot, thread.id, NodePath),
          attachmentsDir: config.attachmentsDir,
          thread: detail.value,
          source,
          agent,
          nativeSession,
          state,
        });
      }
      const { place, checkout } = yield* whereFrom(detail.value, project.workspaceRoot);
      return yield* writeMoveExport({
        state,
        git,
        checkout,
        transferId,
        dir,
        attachmentsDir: config.attachmentsDir,
        thread: detail.value,
        projectTitle: project.title,
        canonicalKey: place.canonicalKey,
        subdirectory: place.subdirectory,
        source,
        agent,
        nativeSession,
      });
    });

  /**
   * The thread's own agent session to pack, read while the thread is
   * quiesced (docs/design/fleet.md, Part 3d): only for a target that takes
   * sessions (an older one refuses the part kind) and an agent there of the
   * same driver. A target that doesn't answer gets none; the move goes on
   * with the summary.
   */
  const sessionToCarry = (
    threadId: ThreadId,
    environmentId: EnvironmentId,
    agent: ModelSelection,
  ) =>
    Effect.gen(function* () {
      const peer = yield* client
        .describe(environmentId)
        .pipe(Effect.timeout(DESCRIBE_WAIT), Effect.option);
      if (Option.isNone(peer)) return null;
      const session = yield* providers.exportNativeSession(threadId);
      // Too large still goes to the export, which leaves it behind and says so.
      return sessionOutcomeFor(session, peer.value, agent.instanceId) === "summary"
        ? null
        : session;
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
            code: "cancelled",
          });
          return;
        }
        const thread = (yield* readModel).threads.find((entry) => entry.id === threadId);
        if (thread === undefined) return;
        // Nothing of the thread may still run while it's packed: its agent's
        // processes must be proven gone (docs/design/fleet.md, Part 3b). Not
        // proven, this attempt stops and the worker tries again; the thread
        // stays frozen, and Cancel still works.
        const quiesced = yield* providers.quiesceThread(threadId);
        if (!quiesced.confirmed) {
          return yield* new ThreadMoveFailure({
            reason: `Couldn't confirm the agent stopped: ${quiesced.reason}.`,
          });
        }
        const manifest = yield* exportFor(
          thread,
          move.agent,
          transferId,
          false,
          environmentId,
        ).pipe(Effect.result);
        if (manifest._tag === "Failure") {
          yield* dispatchStep(threadId, transferId, {
            kind: "abort",
            reason: manifest.failure.reason,
            code: "aborted",
          });
          return;
        }
        // Offered so the other computer takes the bytes before its user
        // allows it (an older one ignores that), and waited for while it is
        // busy with other moves.
        const offered = yield* offerUntilTaken({
          prepare: peerCall(threadId, environmentId, (peer) =>
            peer["peer.move.prepare"]({
              transferId,
              manifest: manifest.success,
              stagedApproval: true,
            }),
          ),
          standing: currentMove(threadId, transferId).pipe(
            Effect.map((current) =>
              current === null ? "gone" : current.cancelRequested ? "cancelled" : "waiting",
            ),
          ),
          // Still exporting, as far as this move goes: the phase stays.
          waiting: dispatchStep(threadId, transferId, {
            kind: "progress",
            phase: "exporting",
            waitingForTarget: true,
          }),
        });
        if (offered.kind === "gone") return;
        if (offered.kind === "cancelled") {
          // It recorded nothing there (a busy offer isn't kept): this ends here.
          yield* dispatchStep(threadId, transferId, {
            kind: "abort",
            reason: "You cancelled the move.",
            code: "cancelled",
          });
          return;
        }
        state = offered.state;
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
          case "staged_awaiting_approval": {
            // Every byte is there (what it has is the whole); its user's
            // Allow imports it without this computer. Final for quitting; the
            // thread stays frozen here until the answer comes (a later
            // status, or one after a restart).
            const total = state.bytesReceived;
            yield* dispatchStep(threadId, transferId, {
              kind: "progress",
              phase: "awaiting_approval",
              sentBytes: total,
              totalBytes: total,
              staged: true,
            });
            state = yield* awaitStatus(
              threadId,
              transferId,
              environmentId,
              "staged_awaiting_approval",
            );
            break;
          }
          case "receiving": {
            const thread = (yield* readModel).threads.find((entry) => entry.id === threadId);
            if (thread === undefined) return;
            const manifest = yield* exportFor(
              thread,
              move.agent,
              transferId,
              true,
              environmentId,
            ).pipe(Effect.result);
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

  return ThreadMoves.of({
    preview,
    previewMany,
    describeTargets,
    start,
    checkQueue,
    checkCarry,
    startQueued,
    cancel,
    startReactor,
  });
});

export const ThreadMovesLive = Layer.effect(ThreadMoves, make);
