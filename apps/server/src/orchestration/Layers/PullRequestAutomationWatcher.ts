import { randomUUID } from "node:crypto";

import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestRef,
  PullRequestServiceError,
  type ThreadId,
} from "@threadlines/contracts";
import {
  buildPullRequestAutoFixPrompt,
  type PullRequestAutoFixCheck,
  type PullRequestAutoFixComment,
} from "@threadlines/shared/pullRequestAutoFix";
import {
  PULL_REQUEST_AUTO_MERGE_ACTIVITY_KIND_PREFIX,
  resolvePullRequestAutoMergeStep,
} from "@threadlines/shared/pullRequestAutoMerge";
import {
  PULL_REQUEST_CHECKS_POLL_INTERVAL_MS,
  pullRequestChecksInMotion,
} from "@threadlines/shared/pullRequestPolling";
import { changeRequestRepositoryName } from "@threadlines/shared/sourceControl";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitManager } from "../../git/GitManager.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestAutomationWatcher,
  type PullRequestAutomationWatcherShape,
} from "../Services/PullRequestAutomationWatcher.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 120 * 1_000;

/**
 * How long a thread keeps the quicker look while its checks stay in motion. A
 * check still running after this is waiting on something a quicker look will
 * not hurry, an approval or a free runner, and the host is asked about it at
 * the usual pace from then on.
 */
const MAX_IN_MOTION_MS = 30 * 60 * 1_000;

/**
 * How many turns one thread's pull request may start on its own before the
 * watcher stands down. A fix that keeps failing is a conversation for the user,
 * not a loop for the agent. Counted per server lifetime, like the baseline.
 */
const MAX_AUTO_TURNS_PER_PULL_REQUEST = 3;

/** Only GitHub answers the reads this needs; see `WRITE_ACCESS_HOSTS`. */
const SUPPORTED_PROVIDER = "github";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** What the watcher had already seen for one thread's pull request. */
interface AutoFixBaseline {
  /** Check names failing when the pull request was last looked at. */
  readonly failingCheckNames: ReadonlySet<string>;
  /** Every comment id seen, the viewer's own included. */
  readonly commentIds: ReadonlySet<string>;
  /** The last time the merge queue gave the pull request back, which is news once. */
  readonly queueRemovalId: string | null;
}

/** A pull request the merge queue gave back, sent to the agent and not yet queued again. */
interface PendingRequeue {
  /** The removal the agent was told about. */
  readonly removalId: string;
  /** When the agent's turn was asked for. */
  readonly requestedAt: string;
}

/** One remark, flattened out of wherever the host filed it. */
interface AutoFixComment {
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
  readonly viewerIsAuthor: boolean;
}

/** One thread and pull request number: the baseline and the cap are both per pair. */
function pairKey(threadId: ThreadId, number: number): string {
  return `${threadId}#${number}`;
}

function threadIdFromPairKey(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

/**
 * Whether a turn is in flight, or the thread is waiting on the user. Starting a
 * turn on top of either would be refused or would bury the question, so both
 * mean "come back next sweep". The shell read model says this three ways: the
 * latest turn's own state, the live session, and the pending-request flags. A
 * session still starting up counts: a turn has been asked for, and until it
 * starts the latest turn on record is the one before it.
 */
function hasWorkInProgress(thread: OrchestrationThreadShell): boolean {
  if (thread.latestTurn?.state === "running") {
    return true;
  }
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan
  ) {
    return true;
  }
  const session = thread.session;
  if (session === null) {
    return false;
  }
  return (
    session.status === "starting" ||
    session.status === "running" ||
    session.activeTurnId !== null ||
    // A dev server left running is not work in progress; a run the agent will
    // wake up for is.
    (session.awaitedBackgroundTaskCount ?? session.pendingBackgroundTaskCount ?? 0) > 0
  );
}

/** Every remark on a pull request: the conversation, then each diff thread's. */
function listActivityComments(activity: PullRequestActivity): ReadonlyArray<AutoFixComment> {
  return [
    ...activity.comments.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? null,
      body: comment.body,
      viewerIsAuthor: comment.viewerIsAuthor,
    })),
    ...activity.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? null,
        body: comment.body,
        viewerIsAuthor: comment.viewerIsAuthor,
      })),
    ),
  ];
}

function failingCheckNames(detail: PullRequestDetail): ReadonlySet<string> {
  return new Set(
    detail.checks.filter((check) => check.status === "failure").map((check) => check.name),
  );
}

/**
 * Whether the watcher has anything to do for a thread's pull requests: fixing
 * its own, or merging its own or a linked one. An archived thread has nothing.
 */
function isWatched(thread: OrchestrationThreadShell): boolean {
  const armed =
    thread.pullRequestAutoFix ||
    thread.pullRequestAutoMerge !== null ||
    thread.linkedPullRequests.some((linked) => linked.autoMerge !== null);
  return armed && thread.archivedAt === null;
}

/** A thread the watcher has something to do for, and where its pull requests live. */
interface SweepCandidate {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
}

/** Where the thread's agent works, which is where its unpushed commits are. */
function threadWorkingCwd({ thread, project }: SweepCandidate): string {
  return resolveThreadWorkingCwd({
    projectCwd: project.workspaceRoot,
    worktreePath: thread.worktreePath,
    effectiveCwd: thread.effectiveCwd,
  });
}

/**
 * The merge switch one watch acts on: the thread's own, for the pull request
 * on its branch, or a linked pull request's, by number.
 */
function autoMergeSwitchOf(
  thread: Pick<OrchestrationThreadShell, "pullRequestAutoMerge" | "linkedPullRequests">,
  pullRequestNumber: number | null,
): PullRequestMergeMethod | null {
  return pullRequestNumber === null
    ? thread.pullRequestAutoMerge
    : (thread.linkedPullRequests.find((linked) => linked.number === pullRequestNumber)?.autoMerge ??
        null);
}

/**
 * Where a pull request stands after a merge that did not come back merged,
 * read again rather than taken as a failure. Another environment may have
 * landed it first, which is the outcome that was asked for, whoever ran the
 * merge. A base with a merge queue answers a merge with a place in the queue,
 * or with the host's own instruction to join once its checks pass: either way
 * the host lands it from here, and the pull request is still open.
 */
function landingAfterMerge(detail: PullRequestDetail | null): "merged" | "queued" | null {
  if (detail?.state === "merged") {
    return "merged";
  }
  if (
    detail?.state === "open" &&
    detail.mergeQueue !== undefined &&
    (detail.mergeQueue.position !== null || detail.autoMergeEnabled === true)
  ) {
    return "queued";
  }
  return null;
}

export interface PullRequestAutomationWatcherLiveOptions {
  readonly sweepIntervalMs?: number;
  /** How soon a thread whose pull request is in motion is looked at again. */
  readonly inMotionIntervalMs?: number;
}

const makePullRequestAutomationWatcher = (options?: PullRequestAutomationWatcherLiveOptions) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const gitManager = yield* GitManager;
    const pullRequestService = yield* PullRequestService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const inMotionIntervalMs = Math.max(
      1,
      options?.inMotionIntervalMs ?? PULL_REQUEST_CHECKS_POLL_INTERVAL_MS,
    );
    // What each armed pull request looked like at the last look. It lives in
    // memory only, so a restart re-observes instead of acting on what was
    // already there.
    const baselinesRef = yield* Ref.make(new Map<string, AutoFixBaseline>());
    // Threads whose fixing switch came on while this server was running. Their
    // next look counts the checks already failing as news: ticking the box on a
    // red pull request is asking for them to be fixed. A restart carries no
    // such word, so it only records what it finds.
    const freshlyArmedRef = yield* Ref.make(new Set<string>());
    // Waiting for the agent's turn to end before the host is asked to queue
    // the pull request again. In memory like the baselines: after a restart
    // the pull request stays out, and its row says so.
    const requeuesRef = yield* Ref.make(new Map<string, PendingRequeue>());
    // Never dropped: the cap is per server lifetime, so flipping the switch
    // cannot buy three more turns.
    const turnCountsRef = yield* Ref.make(new Map<string, number>());
    const cappedLoggedRef = yield* Ref.make(new Set<string>());
    // Threads whose checks were in motion at their last look (one still
    // running, or a push the host has not listed checks for yet), with when
    // that stretch began. They are looked at again at the pace the composer's
    // checks chip keeps, so a check that fails goes to the agent about when the
    // chip turns red, not up to a whole interval later.
    const inMotionRef = yield* Ref.make(new Map<string, number>());
    // When every armed thread was last looked at, which the interval counts from.
    const lastFullSweepAtRef = yield* Ref.make(Number.NEGATIVE_INFINITY);
    // One sweep at a time: the interval fiber and `sweepNow` reach for the same
    // baselines, and two sweeps racing would start the same turn twice.
    const sweepSemaphore = yield* Semaphore.make(1);

    /** A read that must not take the sweep down with it. */
    const attempt = <A, E>(operation: string, threadId: ThreadId, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`pull-request.auto-fix.${operation}-failed`, {
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );

    /**
     * A pull request as the host has it now, past the service's cache. One
     * whose checks are in motion puts its thread on the quicker pace.
     */
    const readDetail = (threadId: ThreadId, reference: PullRequestRef) =>
      Effect.gen(function* () {
        const detail = yield* attempt(
          "detail-read",
          threadId,
          pullRequestService.detail({ ...reference, force: true }),
        );
        const now = yield* Clock.currentTimeMillis;
        if (detail !== null && pullRequestChecksInMotion(detail, now)) {
          yield* Ref.update(inMotionRef, (threads) =>
            threads.has(threadId) ? threads : threads.set(threadId, now),
          );
        }
        return detail;
      });

    /** Answers when the turn was asked for, or null where the engine refused it. */
    const startTurn = (input: {
      readonly thread: OrchestrationThreadShell;
      readonly number: number;
      readonly text: string;
      /** What the message is about, for the log: `merge-queue-and-checks` and so on. */
      readonly trigger: string;
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const started = yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`pull-request-auto-fix:${input.thread.id}:${randomUUID()}`),
            threadId: input.thread.id,
            message: {
              messageId: MessageId.make(randomUUID()),
              role: "user",
              text: input.text,
              attachments: [],
            },
            modelSelection: input.thread.modelSelection,
            runtimeMode: input.thread.runtimeMode,
            interactionMode: input.thread.interactionMode,
            createdAt,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("pull-request.auto-fix.dispatch-failed", {
                threadId: input.thread.id,
                number: input.number,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        if (!started) {
          return null;
        }
        yield* Effect.logInfo("pull-request.auto-fix.turn-started", {
          threadId: input.thread.id,
          number: input.number,
          trigger: input.trigger,
        });
        return createdAt;
      });

    /**
     * Turns "Merge when checks pass" off, the same way the composer's switch
     * does: the thread's own (`pullRequestNumber` null) or a linked pull request's.
     */
    const disarmAutoMerge = (threadId: ThreadId, pullRequestNumber: number | null) =>
      orchestrationEngine
        .dispatch({
          type: "thread.pull-request-automation.set",
          commandId: CommandId.make(`pull-request-auto-merge:${threadId}:${randomUUID()}`),
          threadId,
          ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
          autoMerge: null,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("pull-request.auto-merge.disarm-failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    /**
     * A line in the thread's timeline, so a merge nobody watched still has a
     * record. Its kind carries the shared prefix clients watch for.
     */
    const appendAutoMergeActivity = (input: {
      readonly threadId: ThreadId;
      readonly tone: "info" | "warning" | "error";
      readonly kind: "stopped" | "merged" | "queued" | "failed" | "requeued" | "requeue-failed";
      readonly summary: string;
      readonly detail: string | null;
      readonly number: number;
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`pull-request-auto-merge:${input.threadId}:${randomUUID()}`),
          threadId: input.threadId,
          activity: {
            id: EventId.make(randomUUID()),
            tone: input.tone,
            kind: `${PULL_REQUEST_AUTO_MERGE_ACTIVITY_KIND_PREFIX}${input.kind}`,
            summary: input.summary,
            payload: {
              number: input.number,
              ...(input.detail === null ? {} : { detail: input.detail }),
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pull-request.auto-merge.activity-failed", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    /**
     * "Merge when checks pass" for one open pull request: merge it once the
     * shared rule says so, give up where waiting would never end, and otherwise
     * leave it for the next sweep. Answers whether it merged. Either way it
     * ends, the switch goes off and the thread's timeline says why.
     */
    const sweepAutoMerge = Effect.fn("PullRequestAutomationWatcher.sweepAutoMerge")(
      function* (input: {
        readonly thread: OrchestrationThreadShell;
        readonly reference: PullRequestRef;
        readonly detail: PullRequestDetail;
        readonly mergeMethod: PullRequestMergeMethod;
        readonly unpushedCommits: number;
        /** The auto-fix watch is on and still has turns left to fix a failure. */
        readonly autoFix: boolean;
        /** Whose switch this is: null for the thread's own branch, else a linked pull request's. */
        readonly pullRequestNumber: number | null;
      }) {
        const { thread, detail } = input;
        const number = input.reference.number;
        const now = yield* Clock.currentTimeMillis;
        const step = resolvePullRequestAutoMergeStep({
          detail,
          autoFix: input.autoFix,
          unpushedCommits: input.unpushedCommits,
          now,
        });
        if (step.kind === "wait") {
          return false;
        }
        if (step.kind === "stop") {
          yield* disarmAutoMerge(thread.id, input.pullRequestNumber);
          // A pull request merged or closed by someone else is not news.
          if (detail.state === "open") {
            yield* appendAutoMergeActivity({
              threadId: thread.id,
              tone: "warning",
              kind: "stopped",
              summary: `Stopped waiting to merge #${number}`,
              detail: step.reason,
              number,
            });
          }
          return false;
        }

        // The reads above take seconds, and in that time the switch may have
        // gone off or a turn started (the agent may be about to push). Either
        // one means "not now", so the thread is read again just before a merge
        // that cannot be taken back.
        const latest = yield* attempt(
          "thread-read",
          thread.id,
          projectionSnapshotQuery.getThreadShellById(thread.id),
        );
        if (
          latest === null ||
          Option.isNone(latest) ||
          autoMergeSwitchOf(latest.value, input.pullRequestNumber) === null ||
          hasWorkInProgress(latest.value)
        ) {
          return false;
        }

        // The method the user chose, unless the repository has since stopped
        // allowing it; then the host's own first choice.
        const mergeMethod = detail.mergeMethods.includes(input.mergeMethod)
          ? input.mergeMethod
          : detail.mergeMethods[0];
        const outcome = yield* Effect.exit(
          pullRequestService.runAction({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number,
            action: "merge",
            ...(mergeMethod === undefined ? {} : { mergeMethod }),
          }),
        );
        const landing =
          Exit.isSuccess(outcome) && outcome.value.state === "merged"
            ? "merged"
            : landingAfterMerge(
                yield* attempt(
                  "detail-read",
                  thread.id,
                  pullRequestService.detail({ ...input.reference, force: true }),
                ),
              );
        yield* disarmAutoMerge(thread.id, input.pullRequestNumber);
        if (landing === "merged") {
          yield* Effect.logInfo("pull-request.auto-merge.merged", { threadId: thread.id, number });
          yield* appendAutoMergeActivity({
            threadId: thread.id,
            tone: "info",
            kind: "merged",
            summary: `Merged #${number} after its checks passed`,
            detail: null,
            number,
          });
          return true;
        }
        if (landing === "queued") {
          yield* Effect.logInfo("pull-request.auto-merge.queued", { threadId: thread.id, number });
          yield* appendAutoMergeActivity({
            threadId: thread.id,
            tone: "info",
            kind: "queued",
            summary: `Handed #${number} to the merge queue`,
            detail: null,
            number,
          });
          return false;
        }
        const failure = Exit.isFailure(outcome) ? Cause.squash(outcome.cause) : null;
        const reason =
          failure instanceof PullRequestServiceError
            ? failure.detail
            : failure instanceof Error
              ? failure.message
              : "GitHub did not merge it";
        yield* Effect.logWarning("pull-request.auto-merge.merge-failed", {
          threadId: thread.id,
          number,
          reason,
        });
        yield* appendAutoMergeActivity({
          threadId: thread.id,
          tone: "error",
          kind: "failed",
          summary: `Could not merge #${number}`,
          detail: reason,
          number,
        });
        return false;
      },
    );

    /**
     * Puts a pull request the merge queue gave back into the queue again, once
     * the agent has had its turn at the failure. It arms the host's own merge,
     * so the host queues it as soon as its checks pass, whether or not this
     * server is still running then. One try per removal, told in the timeline.
     */
    const requeueAfterFix = Effect.fn("PullRequestAutomationWatcher.requeueAfterFix")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly key: string;
        readonly reference: PullRequestRef;
        readonly detail: PullRequestDetail;
        readonly unpushedCommits: number;
        readonly pending: PendingRequeue;
      }) {
        const { detail, pending } = input;
        const number = input.reference.number;
        const queue = detail.mergeQueue;
        // A read that said nothing about the queue leaves this for the next one.
        if (queue === undefined) {
          return;
        }
        const forget = Ref.update(requeuesRef, (map) => {
          map.delete(input.key);
          return map;
        });
        // Queued or armed again, taken out again since, or settled: nothing is
        // left of the removal the agent was told about.
        if (
          detail.state !== "open" ||
          queue.position !== null ||
          queue.removal?.id !== pending.removalId ||
          detail.autoMergeEnabled === true
        ) {
          yield* forget;
          return;
        }
        // A fix still only on this machine would be queued without it.
        if (input.unpushedCommits > 0) {
          return;
        }

        // The reads above take seconds, and in that time the switch may have
        // gone off or another turn started, so the thread is read again just
        // before the host is asked. The agent has looked once a turn asked
        // for since the hand-off has completed; one stopped or failed has not,
        // and a time that does not parse proves nothing either way.
        const latest = yield* attempt(
          "thread-read",
          input.threadId,
          projectionSnapshotQuery.getThreadShellById(input.threadId),
        );
        if (latest === null || Option.isNone(latest)) {
          return;
        }
        const thread = latest.value;
        const turn = thread.latestTurn;
        const lookedSince =
          turn !== null &&
          turn.state === "completed" &&
          Date.parse(turn.requestedAt) >= Date.parse(pending.requestedAt);
        if (!thread.pullRequestAutoFix || hasWorkInProgress(thread) || !lookedSince) {
          return;
        }

        yield* forget;
        const outcome = yield* Effect.exit(
          pullRequestService.runAction({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number,
            action: "enable-auto-merge",
          }),
        );
        if (Exit.isSuccess(outcome)) {
          yield* Effect.logInfo("pull-request.auto-fix.requeued", { threadId: thread.id, number });
          yield* appendAutoMergeActivity({
            threadId: thread.id,
            tone: "info",
            kind: "requeued",
            summary: `Put #${number} back in the merge queue`,
            detail: null,
            number,
          });
          return;
        }
        const failure = Cause.squash(outcome.cause);
        const reason =
          failure instanceof PullRequestServiceError
            ? failure.detail
            : failure instanceof Error
              ? failure.message
              : "GitHub did not take it back into the queue";
        yield* Effect.logWarning("pull-request.auto-fix.requeue-failed", {
          threadId: thread.id,
          number,
          reason,
        });
        yield* appendAutoMergeActivity({
          threadId: thread.id,
          tone: "error",
          kind: "requeue-failed",
          summary: `Could not put #${number} back in the merge queue`,
          detail: reason,
          number,
        });
      },
    );

    /**
     * The pull request on the thread's own branch. Answers whether it started a
     * turn, and leaves the baseline holding what the pull request looks like now.
     */
    const sweepOwnPullRequest = Effect.fn("PullRequestAutomationWatcher.sweepOwnPullRequest")(
      function* (input: SweepCandidate) {
        const { thread, project, repository } = input;
        const cwd = threadWorkingCwd(input);

        const remote = yield* attempt("status-read", thread.id, gitManager.remoteStatus({ cwd }));
        if (remote === null || remote.pr === null) {
          return false;
        }
        const pullRequest = remote.pr;
        const autoMerge = thread.pullRequestAutoMerge;
        if (pullRequest.state !== "open") {
          // Merged or closed some other way: the instruction has nothing left
          // to act on, and must not carry over to the next pull request.
          if (autoMerge !== null) {
            yield* disarmAutoMerge(thread.id, null);
          }
          return false;
        }

        const key = pairKey(thread.id, pullRequest.number);
        const turnCount = yield* Ref.get(turnCountsRef).pipe(
          Effect.map((counts) => counts.get(key) ?? 0),
        );
        const autoFixCapped =
          thread.pullRequestAutoFix && turnCount >= MAX_AUTO_TURNS_PER_PULL_REQUEST;
        if (autoFixCapped) {
          const alreadyLogged = yield* Ref.modify(cappedLoggedRef, (logged) => {
            const seen = logged.has(key);
            logged.add(key);
            return [seen, logged];
          });
          if (!alreadyLogged) {
            yield* Effect.logWarning("pull-request.auto-fix.cap-reached", {
              threadId: thread.id,
              number: pullRequest.number,
              cap: MAX_AUTO_TURNS_PER_PULL_REQUEST,
            });
          }
        }
        const autoFixActive = thread.pullRequestAutoFix && !autoFixCapped;
        // A hand-off already made is seen through, even once the cap is reached.
        const pendingRequeue = yield* Ref.get(requeuesRef).pipe(Effect.map((map) => map.get(key)));
        if (!autoFixActive && autoMerge === null && pendingRequeue === undefined) {
          return false;
        }

        const reference = {
          projectId: project.id,
          repository,
          number: pullRequest.number,
          force: true,
        } as const;
        const detail = yield* readDetail(thread.id, reference);
        if (detail === null) {
          return false;
        }

        if (autoMerge !== null) {
          const merged = yield* sweepAutoMerge({
            thread,
            reference,
            detail,
            mergeMethod: autoMerge,
            unpushedCommits: remote.aheadCount,
            autoFix: autoFixActive,
            pullRequestNumber: null,
          });
          if (merged) {
            return false;
          }
        }
        if (pendingRequeue !== undefined) {
          yield* requeueAfterFix({
            threadId: thread.id,
            key,
            reference,
            detail,
            unpushedCommits: remote.aheadCount,
            pending: pendingRequeue,
          });
        }
        if (!autoFixActive) {
          return false;
        }

        const activity = yield* attempt(
          "activity-read",
          thread.id,
          pullRequestService.activity(reference),
        );
        if (activity === null) {
          return false;
        }

        const currentFailing = failingCheckNames(detail);
        const comments = listActivityComments(activity);
        const commentIds = new Set(comments.map((comment) => comment.id));
        const queueRemoval = detail.mergeQueue?.removal ?? null;
        // A switch that just came on starts from no failing checks and no
        // removal from the merge queue, whatever it saw before. Remarks already
        // made are still not news: they may well have been answered, and
        // nothing here can tell.
        const freshlyArmed = yield* Ref.modify(freshlyArmedRef, (armed) => [
          armed.delete(thread.id),
          armed,
        ]);
        const baseline = freshlyArmed
          ? { failingCheckNames: new Set<string>(), commentIds, queueRemovalId: null }
          : (yield* Ref.get(baselinesRef)).get(key);

        // First sight of this pull request since the server started. Record it
        // and act on what happens next, not on what was already there.
        if (baseline === undefined) {
          yield* Ref.update(baselinesRef, (map) =>
            map.set(key, {
              failingCheckNames: currentFailing,
              commentIds,
              queueRemovalId: queueRemoval?.id ?? null,
            }),
          );
          return false;
        }

        // A check that has stopped failing leaves the baseline, so the same check
        // failing again after a push is news again.
        const carriedFailing = new Set(
          [...baseline.failingCheckNames].filter((name) => currentFailing.has(name)),
        );
        // A rollup still running is not a verdict: wait for it rather than send
        // the agent after a check that may pass on its own.
        const newlyFailing: PullRequestAutoFixCheck[] =
          detail.checksState === "pending"
            ? []
            : detail.checks
                .filter((check) => check.status === "failure" && !carriedFailing.has(check.name))
                .map((check) => ({ name: check.name, url: check.url }));
        const newComments: PullRequestAutoFixComment[] = comments
          .filter((comment) => !comment.viewerIsAuthor && !baseline.commentIds.has(comment.id))
          .map((comment) => ({ author: comment.author, body: comment.body }));
        const newQueueRemoval =
          queueRemoval !== null && queueRemoval.id !== baseline.queueRemovalId
            ? queueRemoval
            : null;
        // A read that said nothing about the queue keeps the last removal seen,
        // so that one is not news again once the host answers.
        const queueRemovalId = queueRemoval?.id ?? baseline.queueRemovalId;

        const text = buildPullRequestAutoFixPrompt({
          number: pullRequest.number,
          repository,
          failingChecks: newlyFailing,
          comments: newComments,
          mergeQueueFailure:
            newQueueRemoval === null
              ? null
              : {
                  baseBranch: detail.baseBranch,
                  failedChecks: newQueueRemoval.failedChecks.map((check) => ({
                    name: check.name,
                    url: check.url,
                  })),
                },
        });
        if (text === null) {
          // Nothing new. Keep the checks that are still failing, and remember
          // every remark, the viewer's own included, so none of them fires later.
          yield* Ref.update(baselinesRef, (map) =>
            map.set(key, { failingCheckNames: carriedFailing, commentIds, queueRemovalId }),
          );
          return false;
        }

        // The reads above take seconds, and in that time the user may have sent
        // a message of their own or turned the switch off. Either one means
        // "not now", so the thread is read again just before a turn is started
        // for it. What would have been said stays news: the baseline goes back
        // to the one this look started from, and the first look after that
        // turn says it if it still needs saying.
        const latest = yield* attempt(
          "thread-read",
          thread.id,
          projectionSnapshotQuery.getThreadShellById(thread.id),
        );
        if (
          latest === null ||
          Option.isNone(latest) ||
          !latest.value.pullRequestAutoFix ||
          hasWorkInProgress(latest.value)
        ) {
          yield* Ref.update(baselinesRef, (map) => map.set(key, baseline));
          return false;
        }

        const requestedAt = yield* startTurn({
          thread: latest.value,
          number: pullRequest.number,
          text,
          trigger: [
            newQueueRemoval === null ? null : "merge-queue",
            newlyFailing.length === 0 ? null : "checks",
            newComments.length === 0 ? null : "comments",
          ]
            .filter((part) => part !== null)
            .join("-and-"),
        });
        // The baseline advances either way: a dispatch the engine refused is not
        // one to retry every two minutes.
        yield* Ref.update(baselinesRef, (map) =>
          map.set(key, {
            failingCheckNames: newlyFailing.length > 0 ? currentFailing : carriedFailing,
            commentIds,
            queueRemovalId,
          }),
        );
        if (requestedAt === null) {
          return false;
        }
        yield* Ref.update(turnCountsRef, (counts) => counts.set(key, turnCount + 1));
        // The queue gets it back once the agent has had its turn at the failure.
        if (newQueueRemoval !== null) {
          yield* Ref.update(requeuesRef, (map) =>
            map.set(key, { removalId: newQueueRemoval.id, requestedAt }),
          );
        }
        return true;
      },
    );

    /**
     * "Merge when checks pass" for the pull requests the agent opened on other
     * branches. The thread's checkout is not on those branches, so there are no
     * unpushed commits to count and no auto-fix to run; otherwise it is the
     * same rule as for the thread's own pull request.
     */
    const sweepLinkedPullRequests = Effect.fn(
      "PullRequestAutomationWatcher.sweepLinkedPullRequests",
    )(function* (candidate: SweepCandidate) {
      const { thread, project, repository } = candidate;
      for (const linked of thread.linkedPullRequests) {
        if (linked.autoMerge === null) {
          continue;
        }
        const reference = {
          projectId: project.id,
          repository,
          number: linked.number,
          force: true,
        } as const;
        const detail = yield* readDetail(thread.id, reference);
        if (detail === null) {
          continue;
        }
        if (detail.state !== "open") {
          // Merged or closed some other way: nothing is left to act on.
          yield* disarmAutoMerge(thread.id, linked.number);
          continue;
        }
        // One linked from another branch becomes the thread's own when the
        // thread moves onto that branch. Its checkout can then hold commits for
        // it that are not pushed yet, and a checkout that cannot be read is no
        // answer, so the merge waits.
        const unpushedCommits =
          thread.branch !== null && detail.headBranch === thread.branch
            ? ((yield* attempt(
                "status-read",
                thread.id,
                gitManager.remoteStatus({ cwd: threadWorkingCwd(candidate) }),
              ))?.aheadCount ?? null)
            : 0;
        if (unpushedCommits === null) {
          continue;
        }
        yield* sweepAutoMerge({
          thread,
          reference,
          detail,
          mergeMethod: linked.autoMerge,
          unpushedCommits,
          autoFix: false,
          pullRequestNumber: linked.number,
        });
      }
    });

    /** One candidate thread. Answers whether it started an auto-fix turn. */
    const sweepThread = Effect.fn("PullRequestAutomationWatcher.sweepThread")(function* (
      candidate: SweepCandidate,
    ) {
      const { thread } = candidate;
      // This look decides the pace again: checks it finds in motion put the
      // thread back on the quicker one, in the stretch it was already in.
      const inMotionSince = yield* Ref.modify(inMotionRef, (threads) => {
        const since = threads.get(thread.id);
        threads.delete(thread.id);
        return [since, threads];
      });
      // The thread's own pull request is the one on its branch, so a thread
      // with no branch has only linked ones.
      const ownArmed = thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null;
      const started =
        thread.branch !== null && ownArmed ? yield* sweepOwnPullRequest(candidate) : false;
      yield* sweepLinkedPullRequests(candidate);
      if (inMotionSince !== undefined) {
        yield* Ref.update(inMotionRef, (threads) =>
          threads.has(thread.id) ? threads.set(thread.id, inMotionSince) : threads,
        );
      }
      return started;
    });

    /** Every armed thread, or only the ones named in `only`. */
    const runSweep = Effect.fn("PullRequestAutomationWatcher.runSweep")(function* (
      only?: ReadonlySet<string>,
    ) {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pull-request.auto-fix.snapshot-query-failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (snapshot === null) {
        return 0;
      }

      const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
      // A thread that is no longer armed forgets its baseline, that it was just
      // armed, and any pull request it was to put back in the merge queue.
      // Being armed is the only test: a thread that is merely busy this sweep
      // must keep its baseline, or the failure it should act on would be
      // re-observed as the state it started from once the turn ends.
      const armedThreadIds = new Set<string>(
        snapshot.threads
          .filter((thread) => thread.pullRequestAutoFix)
          .map((thread) => thread.id as string),
      );
      // Deleting through a collection's own iterator is defined behaviour, so
      // nothing needs copying first.
      const forgetDisarmedPairs = <A>(map: Map<string, A>) => {
        for (const key of map.keys()) {
          if (!armedThreadIds.has(threadIdFromPairKey(key))) {
            map.delete(key);
          }
        }
        return map;
      };
      yield* Ref.update(baselinesRef, forgetDisarmedPairs);
      yield* Ref.update(requeuesRef, forgetDisarmedPairs);
      yield* Ref.update(freshlyArmedRef, (armed) => {
        for (const threadId of armed) {
          if (!armedThreadIds.has(threadId)) {
            armed.delete(threadId);
          }
        }
        return armed;
      });
      // Deleted threads never reach the shell snapshot, and archived ones are
      // not watched, so busy is the only one left to rule out here. Busy is
      // also "not yet" for a merge: the agent may be about to push.
      const idleThreadIds = new Set<string>(
        snapshot.threads
          .filter((thread) => isWatched(thread) && !hasWorkInProgress(thread))
          .map((thread) => thread.id as string),
      );
      // The quicker pace is for a thread still watched and idle. A busy one
      // gives it up too: its turn is likely to change the pull request, and a
      // thread left waiting on the user must not keep this read going for as
      // long as it waits. The next full sweep sets its pace again.
      yield* Ref.update(inMotionRef, (threads) => {
        for (const threadId of threads.keys()) {
          if (!idleThreadIds.has(threadId)) {
            threads.delete(threadId);
          }
        }
        return threads;
      });

      const candidates = snapshot.threads.flatMap((thread): SweepCandidate[] => {
        if (!idleThreadIds.has(thread.id) || (only !== undefined && !only.has(thread.id))) {
          return [];
        }
        const project = projectsById.get(thread.projectId);
        if (project === undefined || project.repositoryIdentity?.provider !== SUPPORTED_PROVIDER) {
          return [];
        }
        const repository = changeRequestRepositoryName(project.repositoryIdentity);
        if (repository === null) {
          return [];
        }
        return [{ thread, project, repository }];
      });

      let startedCount = 0;
      for (const candidate of candidates) {
        const started = yield* sweepThread(candidate);
        if (started) {
          startedCount += 1;
        }
      }
      return startedCount;
    });

    const sweep = sweepSemaphore.withPermits(1)(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.set(lastFullSweepAtRef, now)),
        Effect.andThen(runSweep()),
      ),
    );

    /**
     * Looks again at the threads whose checks were in motion at their last
     * look, and only those, so the host is not asked about every armed pull
     * request at this pace. Nothing in motion reads nothing at all.
     */
    const sweepInMotion = sweepSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const due = new Set<string>();
        for (const [threadId, since] of yield* Ref.get(inMotionRef)) {
          if (now - since < MAX_IN_MOTION_MS) {
            due.add(threadId);
          }
        }
        return due.size === 0 ? 0 : yield* runSweep(due);
      }),
    );

    /**
     * One beat of the watcher's own pace: every armed thread once an
     * interval, and in between, the ones whose checks are in motion. One
     * fiber for both, so the two never read the same pull request back to back.
     */
    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const lastFullSweepAt = yield* Ref.get(lastFullSweepAtRef);
      return now - lastFullSweepAt >= sweepIntervalMs ? yield* sweep : yield* sweepInMotion;
    });

    /**
     * Marks the thread's fixing switch as just turned on, then sweeps. Both
     * under the sweep's own permit, so a sweep already running cannot clear
     * the mark on the strength of a read taken before the switch came on.
     */
    const sweepFreshlyArmed = (threadId: ThreadId) =>
      sweepSemaphore.withPermits(1)(
        Ref.update(freshlyArmedRef, (armed) => armed.add(threadId)).pipe(
          Effect.andThen(runSweep()),
        ),
      );

    const sweepNow: PullRequestAutomationWatcherShape["sweepNow"] = () => sweep;

    const start: PullRequestAutomationWatcherShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          tick.pipe(
            Effect.repeat(
              Schedule.spaced(Duration.millis(Math.min(inMotionIntervalMs, sweepIntervalMs))),
            ),
          ),
        );
        // Turning either switch on is answered at once rather than at the next
        // interval: a check already failing goes to the agent, and a pull
        // request with nothing left to wait for merges, when the box is
        // ticked, not up to two minutes later.
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
            if (event.type !== "thread.pull-request-automation-changed") {
              return Effect.void;
            }
            if (event.payload.autoFix === true) {
              return sweepFreshlyArmed(event.payload.threadId).pipe(Effect.asVoid);
            }
            return event.payload.autoMerge != null ? sweep.pipe(Effect.asVoid) : Effect.void;
          }),
        );
        yield* Effect.logInfo("pull-request.auto-fix.started", {
          sweepIntervalMs,
          inMotionIntervalMs,
        });
      });

    return { start, sweepNow } satisfies PullRequestAutomationWatcherShape;
  });

export const makePullRequestAutomationWatcherLive = (
  options?: PullRequestAutomationWatcherLiveOptions,
) => Layer.effect(PullRequestAutomationWatcher, makePullRequestAutomationWatcher(options));

export const PullRequestAutomationWatcherLive = makePullRequestAutomationWatcherLive();
