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
import { resolvePullRequestAutoMergeStep } from "@threadlines/shared/pullRequestAutoMerge";
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
 * latest turn's own state, the live session, and the pending-request flags.
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
    session.status === "running" ||
    session.activeTurnId !== null ||
    (session.pendingBackgroundTaskCount ?? 0) > 0
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
}

const makePullRequestAutomationWatcher = (options?: PullRequestAutomationWatcherLiveOptions) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const gitManager = yield* GitManager;
    const pullRequestService = yield* PullRequestService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    // Dropped when a thread stops being a candidate, so turning the switch off
    // and on again re-observes instead of firing on what it finds.
    const baselinesRef = yield* Ref.make(new Map<string, AutoFixBaseline>());
    // Never dropped: the cap is per server lifetime, so flipping the switch
    // cannot buy three more turns.
    const turnCountsRef = yield* Ref.make(new Map<string, number>());
    const cappedLoggedRef = yield* Ref.make(new Set<string>());
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

    const startTurn = (input: {
      readonly thread: OrchestrationThreadShell;
      readonly number: number;
      readonly text: string;
      readonly trigger: "checks" | "comments" | "checks-and-comments";
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
        if (started) {
          yield* Effect.logInfo("pull-request.auto-fix.turn-started", {
            threadId: input.thread.id,
            number: input.number,
            trigger: input.trigger,
          });
        }
        return started;
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

    /** A line in the thread's timeline, so a merge nobody watched still has a record. */
    const appendAutoMergeActivity = (input: {
      readonly threadId: ThreadId;
      readonly tone: "info" | "warning" | "error";
      readonly kind: string;
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
            kind: input.kind,
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
              kind: "pull-request.auto-merge.stopped",
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
            kind: "pull-request.auto-merge.merged",
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
            kind: "pull-request.auto-merge.queued",
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
          kind: "pull-request.auto-merge.failed",
          summary: `Could not merge #${number}`,
          detail: reason,
          number,
        });
        return false;
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
        if (!autoFixActive && autoMerge === null) {
          return false;
        }

        const reference = {
          projectId: project.id,
          repository,
          number: pullRequest.number,
          force: true,
        } as const;
        const detail = yield* attempt(
          "detail-read",
          thread.id,
          pullRequestService.detail(reference),
        );
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
        const baseline = yield* Ref.get(baselinesRef).pipe(Effect.map((map) => map.get(key)));

        // First sight of this pull request, whether because the server just
        // started or because the switch just came on. Record it and act on what
        // happens next, not on what was already there.
        if (baseline === undefined) {
          yield* Ref.update(baselinesRef, (map) =>
            map.set(key, { failingCheckNames: currentFailing, commentIds }),
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

        const text = buildPullRequestAutoFixPrompt({
          number: pullRequest.number,
          repository,
          failingChecks: newlyFailing,
          comments: newComments,
        });
        if (text === null) {
          // Nothing new. Keep the checks that are still failing, and remember
          // every remark, the viewer's own included, so none of them fires later.
          yield* Ref.update(baselinesRef, (map) =>
            map.set(key, { failingCheckNames: carriedFailing, commentIds }),
          );
          return false;
        }

        const started = yield* startTurn({
          thread,
          number: pullRequest.number,
          text,
          trigger:
            newlyFailing.length > 0 && newComments.length > 0
              ? "checks-and-comments"
              : newlyFailing.length > 0
                ? "checks"
                : "comments",
        });
        // The baseline advances either way: a dispatch the engine refused is not
        // one to retry every two minutes.
        yield* Ref.update(baselinesRef, (map) =>
          map.set(key, {
            failingCheckNames: newlyFailing.length > 0 ? currentFailing : carriedFailing,
            commentIds,
          }),
        );
        if (started) {
          yield* Ref.update(turnCountsRef, (counts) => counts.set(key, turnCount + 1));
        }
        return started;
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
        const detail = yield* attempt(
          "detail-read",
          thread.id,
          pullRequestService.detail(reference),
        );
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
      // The thread's own pull request is the one on its branch, so a thread
      // with no branch has only linked ones.
      const ownArmed = thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null;
      const started =
        thread.branch !== null && ownArmed ? yield* sweepOwnPullRequest(candidate) : false;
      yield* sweepLinkedPullRequests(candidate);
      return started;
    });

    const runSweep = Effect.gen(function* () {
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
      // A thread that is no longer armed forgets its baseline, so re-arming it
      // starts from a fresh observation rather than the state it left behind.
      // Being armed is the only test: a thread that is merely busy this sweep
      // must keep its baseline, or the failure it should act on would be
      // re-observed as the state it started from once the turn ends.
      const armedThreadIds = new Set<string>(
        snapshot.threads
          .filter((thread) => thread.pullRequestAutoFix)
          .map((thread) => thread.id as string),
      );
      yield* Ref.update(baselinesRef, (map) => {
        // Deleting through a Map's own key iterator is defined behaviour, so
        // the keys do not need copying first.
        for (const key of map.keys()) {
          if (!armedThreadIds.has(threadIdFromPairKey(key))) {
            map.delete(key);
          }
        }
        return map;
      });

      // Deleted threads never reach the shell snapshot, so archived and busy
      // are the only ones left to rule out here.
      const candidates = snapshot.threads.flatMap((thread): SweepCandidate[] => {
        const armed =
          thread.pullRequestAutoFix ||
          thread.pullRequestAutoMerge !== null ||
          thread.linkedPullRequests.some((linked) => linked.autoMerge !== null);
        if (!armed || thread.archivedAt !== null) {
          return [];
        }
        // Busy is also "not yet" for a merge: the agent may be about to push.
        if (hasWorkInProgress(thread)) {
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

    const sweep = sweepSemaphore.withPermits(1)(runSweep);

    const sweepNow: PullRequestAutomationWatcherShape["sweepNow"] = () => sweep;

    const start: PullRequestAutomationWatcherShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        // Turning "Merge when checks pass" on is answered at once rather than
        // at the next interval: a pull request with nothing left to wait for
        // merges when the box is ticked, not up to two minutes later.
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
            event.type === "thread.pull-request-automation-changed" &&
            event.payload.autoMerge != null
              ? sweep.pipe(Effect.asVoid)
              : Effect.void,
          ),
        );
        yield* Effect.logInfo("pull-request.auto-fix.started", { sweepIntervalMs });
      });

    return { start, sweepNow } satisfies PullRequestAutomationWatcherShape;
  });

export const makePullRequestAutomationWatcherLive = (
  options?: PullRequestAutomationWatcherLiveOptions,
) => Layer.effect(PullRequestAutomationWatcher, makePullRequestAutomationWatcher(options));

export const PullRequestAutomationWatcherLive = makePullRequestAutomationWatcherLive();
