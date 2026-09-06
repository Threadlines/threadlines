import { randomUUID } from "node:crypto";

import {
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestDetail,
  type ThreadId,
} from "@threadlines/contracts";
import {
  buildPullRequestAutoFixPrompt,
  type PullRequestAutoFixCheck,
  type PullRequestAutoFixComment,
} from "@threadlines/shared/pullRequestAutoFix";
import { changeRequestRepositoryName } from "@threadlines/shared/sourceControl";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { GitManager } from "../../git/GitManager.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestAutoFixWatcher,
  type PullRequestAutoFixWatcherShape,
} from "../Services/PullRequestAutoFixWatcher.ts";

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

export interface PullRequestAutoFixWatcherLiveOptions {
  readonly sweepIntervalMs?: number;
}

const makePullRequestAutoFixWatcher = (options?: PullRequestAutoFixWatcherLiveOptions) =>
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
     * One candidate thread. Answers whether it started a turn, and leaves the
     * baseline holding what its pull request looks like now.
     */
    const sweepThread = Effect.fn("PullRequestAutoFixWatcher.sweepThread")(function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly project: OrchestrationProjectShell;
      readonly repository: string;
    }) {
      const { thread, project, repository } = input;
      const cwd = resolveThreadWorkingCwd({
        projectCwd: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        effectiveCwd: thread.effectiveCwd,
      });

      const remote = yield* attempt("status-read", thread.id, gitManager.remoteStatus({ cwd }));
      const pullRequest = remote?.pr ?? null;
      if (pullRequest === null || pullRequest.state !== "open") {
        return false;
      }

      const key = pairKey(thread.id, pullRequest.number);
      const turnCount = yield* Ref.get(turnCountsRef).pipe(
        Effect.map((counts) => counts.get(key) ?? 0),
      );
      if (turnCount >= MAX_AUTO_TURNS_PER_PULL_REQUEST) {
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
        return false;
      }

      const reference = {
        projectId: project.id,
        repository,
        number: pullRequest.number,
        force: true,
      } as const;
      const detail = yield* attempt("detail-read", thread.id, pullRequestService.detail(reference));
      if (detail === null) {
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

      // Deleted threads never reach the shell snapshot, so archived, unbranched
      // and busy are the only ones left to rule out here.
      const candidates = snapshot.threads.flatMap((thread) => {
        if (!thread.pullRequestAutoFix || thread.archivedAt !== null || thread.branch === null) {
          return [];
        }
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

    const sweepNow: PullRequestAutoFixWatcherShape["sweepNow"] = () => sweep;

    const start: PullRequestAutoFixWatcherShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        yield* Effect.logInfo("pull-request.auto-fix.started", { sweepIntervalMs });
      });

    return { start, sweepNow } satisfies PullRequestAutoFixWatcherShape;
  });

export const makePullRequestAutoFixWatcherLive = (options?: PullRequestAutoFixWatcherLiveOptions) =>
  Layer.effect(PullRequestAutoFixWatcher, makePullRequestAutoFixWatcher(options));

export const PullRequestAutoFixWatcherLive = makePullRequestAutoFixWatcherLive();
