import { randomUUID } from "node:crypto";

import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestRef,
  PullRequestServiceError,
  type ThreadId,
  type VcsStatusRemoteResult,
} from "@threadlines/contracts";
import {
  linkedPullRequestArmed,
  threadPullRequestAutomationArmed,
} from "@threadlines/shared/linkedPullRequests";
import { areFilesystemPathsEqual, isFilesystemPathWithin } from "@threadlines/shared/path";
import {
  buildPullRequestAutoFixPrompt,
  type PullRequestAutoFixCheck,
  type PullRequestAutoFixCheckout,
  type PullRequestAutoFixComment,
} from "@threadlines/shared/pullRequestAutoFix";
import {
  PULL_REQUEST_AUTO_MERGE_ACTIVITY_KIND_PREFIX,
  resolvePullRequestAutoMergeStep,
} from "@threadlines/shared/pullRequestAutoMerge";
import {
  PULL_REQUEST_CHECKS_POLL_INTERVAL_MS,
  PULL_REQUEST_FRESH_PUSH_WATCH_MS,
  pullRequestChecksInMotion,
  pullRequestChecksWait,
} from "@threadlines/shared/pullRequestPolling";
import {
  changeRequestRepositoryName,
  parsePullRequestUrl,
} from "@threadlines/shared/sourceControl";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { forkPullRequestBranchPrefix, GitManager } from "../../git/GitManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import type { GitWorktreeEntry } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestAutomationWatcher,
  type PullRequestAutomationWatcherShape,
} from "../Services/PullRequestAutomationWatcher.ts";

const isPullRequestServiceError = Schema.is(PullRequestServiceError);

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

/**
 * The longest a thread with nothing to watch goes without a look. Such a
 * thread is looked at again after a tenth of the time it has sat untouched, no
 * sooner than a sweep apart and no later than the first sweep after this: one
 * that changed minutes ago keeps nearly the usual pace, and one whose pull
 * request merged days ago costs the host a read twice an hour.
 */
const MAX_REST_MS = 30 * 60 * 1_000;
const REST_SHARE_OF_IDLE_TIME = 10;

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

/**
 * What a look at a thread's pull requests found. `started`: a turn. `watching`:
 * an open pull request there is something left to do for, or none found or a
 * host that did not answer, neither of which is known to be nothing. `nothing`:
 * a pull request that is merged, closed, in another repository, or out of turns.
 */
type LookOutcome = "started" | "watching" | "nothing";

/** A thread found with nothing to watch, and until when it is left alone. */
interface Resting {
  /** What the thread looked like then; a change to any of it ends the rest. */
  readonly stamp: string;
  readonly nextLookAt: number;
}

/**
 * What about a thread says its pull requests may have changed: it was touched
 * (a turn, a switch, a link), or its checkout moved to another branch or folder.
 */
function restStamp(thread: OrchestrationThreadShell): string {
  return [thread.updatedAt, thread.branch, thread.worktreePath, thread.effectiveCwd].join("\n");
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
  return thread.session !== null && sessionHasWorkInProgress(thread.session);
}

/** The session's part of `hasWorkInProgress`: a turn starting or running, or a run it waits on. */
function sessionHasWorkInProgress(session: OrchestrationSession): boolean {
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
 * Whether two addresses name the same pull request. The thread's own is found
 * from its checkout and then read from the project's repository by number, and
 * the two answers agree only when the checkout is in that repository. An agent
 * that ended its turn in another repository's folder has a different pull
 * request there, under what may be the same number.
 */
function isSamePullRequest(left: string, right: string): boolean {
  const normalize = (url: string) => url.trim().replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Whether the watcher has anything to do for a thread's pull requests: fixing
 * or merging its own or one it holds by number. An archived thread has nothing.
 */
function isWatched(thread: OrchestrationThreadShell): boolean {
  return threadPullRequestAutomationArmed(thread) && thread.archivedAt === null;
}

/**
 * Which of a thread's switches watch one pull request in a look: the ones it
 * holds for it by number (`linkedPullRequests`), and its own while that pull
 * request is the one on its checkout's branch. Both can apply to one.
 */
interface SwitchHolders {
  readonly linked: boolean;
  readonly own: boolean;
}

function linkedPullRequestOf(
  thread: Pick<OrchestrationThreadShell, "linkedPullRequests">,
  number: number,
) {
  return thread.linkedPullRequests.find((linked) => linked.number === number);
}

/** Whether fixing is on for one pull request, by any switch that watches it. */
function fixSwitchOn(
  thread: Pick<OrchestrationThreadShell, "pullRequestAutoFix" | "linkedPullRequests">,
  number: number,
  holders: SwitchHolders,
): boolean {
  return (
    (holders.own && thread.pullRequestAutoFix) ||
    (holders.linked && linkedPullRequestOf(thread, number)?.autoFix === true)
  );
}

/** How one pull request is to be merged, by any switch that watches it; the thread's own first. */
function mergeSwitchOf(
  thread: Pick<OrchestrationThreadShell, "pullRequestAutoMerge" | "linkedPullRequests">,
  number: number,
  holders: SwitchHolders,
): PullRequestMergeMethod | null {
  return (
    (holders.own ? thread.pullRequestAutoMerge : null) ??
    (holders.linked ? (linkedPullRequestOf(thread, number)?.autoMerge ?? null) : null)
  );
}

/**
 * The key a fixing switch coming on is remembered by until its pull request's
 * next look: the thread's own, or one held by number.
 */
function fixSwitchKey(threadId: ThreadId, pullRequestNumber: number | null): string {
  return pullRequestNumber === null ? threadId : pairKey(threadId, pullRequestNumber);
}

/**
 * Where a pull request's branch is checked out, as one look found it: the
 * thread's own checkout or another folder of the repository, whose own read
 * names the pull request, or none it can vouch for. A checkout's status is
 * what a merge waits on (commits not pushed yet, a push the host has yet to
 * show); one on a branch of that name that does not name the pull request is
 * still waited on, but never named to the agent.
 */
type BranchCheckout =
  | { readonly kind: "thread"; readonly status: VcsStatusRemoteResult }
  | { readonly kind: "folder"; readonly path: string; readonly status: VcsStatusRemoteResult }
  | { readonly kind: "unknown"; readonly status: VcsStatusRemoteResult | null };

/** What one pull request's switches ask of a look, and what the watcher holds for it. */
interface PullRequestWatch {
  readonly key: string;
  readonly holders: SwitchHolders;
  readonly turnCount: number;
  /** Fixing is on, and the pull request has turns left. */
  readonly autoFix: boolean;
  readonly autoMerge: PullRequestMergeMethod | null;
  readonly pendingRequeue: PendingRequeue | undefined;
}

/** Reads one look shares between the pull requests it watches, each made at most once. */
interface LookReads {
  /** The status of the checkout at `cwd`; null where it could not be read. */
  readonly statusAt: (cwd: string) => Effect.Effect<VcsStatusRemoteResult | null>;
  /** The repository's checkouts; null where they could not be listed. */
  readonly worktrees: Effect.Effect<ReadonlyArray<GitWorktreeEntry> | null>;
}

/** The busier of two looks' findings: a turn started, then something left to watch. */
function combineOutcomes(left: LookOutcome, right: LookOutcome): LookOutcome {
  if (left === "started" || right === "started") {
    return "started";
  }
  return left === "watching" || right === "watching" ? "watching" : "nothing";
}

/** A thread the watcher has something to do for, and where its pull requests live. */
interface SweepCandidate {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
}

/** The thread with where its pull requests live, or null on a host this cannot read. */
function candidateOf(
  thread: OrchestrationThreadShell,
  project: OrchestrationProjectShell,
): SweepCandidate | null {
  if (project.repositoryIdentity?.provider !== SUPPORTED_PROVIDER) {
    return null;
  }
  const repository = changeRequestRepositoryName(project.repositoryIdentity);
  return repository === null ? null : { thread, project, repository };
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
  /** How long a read that is a commit behind the checkout is held back for the host to catch up. */
  readonly pushWaitMs?: number;
}

const makePullRequestAutomationWatcher = (options?: PullRequestAutomationWatcherLiveOptions) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const gitManager = yield* GitManager;
    const gitWorkflow = yield* GitWorkflowService;
    const pullRequestService = yield* PullRequestService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const inMotionIntervalMs = Math.max(
      1,
      options?.inMotionIntervalMs ?? PULL_REQUEST_CHECKS_POLL_INTERVAL_MS,
    );
    const pushWaitMs = options?.pushWaitMs ?? PULL_REQUEST_FRESH_PUSH_WATCH_MS;
    // What each armed pull request looked like at the last look. It lives in
    // memory only, so a restart re-observes instead of acting on what was
    // already there.
    const baselinesRef = yield* Ref.make(new Map<string, AutoFixBaseline>());
    // Fixing switches that came on while this server was running, by
    // `fixSwitchKey`. Their pull request's next look counts the checks
    // already failing as news: ticking the box on a red pull request is
    // asking for them to be fixed. A restart carries no such word, so it only
    // records what it finds.
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
    // Threads whose last look found nothing to watch. A sweep passes over them
    // until their rest is over or they change, so the armed threads whose
    // pull requests are long merged do not each cost a read of the host every
    // interval. In memory, so a restart looks at everything once.
    const restingRef = yield* Ref.make(new Map<string, Resting>());
    // When each pull request was first read a commit apart from its thread's
    // checkout, and which two commits. The host has a push within seconds, so
    // a difference that outlasts the wait is the checkout's own view gone
    // stale (someone else pushed and its fetch keeps failing), and the host is
    // believed again rather than held to it for good.
    const pushWaitsRef = yield* Ref.make(
      new Map<string, { readonly commits: string; readonly since: number }>(),
    );
    // When every armed thread was last looked at, which the interval counts from.
    const lastFullSweepAtRef = yield* Ref.make(Number.NEGATIVE_INFINITY);
    // One sweep at a time: the interval fiber and `sweepNow` would otherwise
    // read the same pull requests back to back.
    const sweepSemaphore = yield* Semaphore.make(1);
    // One look at a time: every look reaches for the same baselines, and two
    // racing over one thread would start the same turn twice. A sweep holds
    // this a thread at a time, not for its whole run, so that a look asked for
    // meanwhile waits for one thread and not for every armed one.
    const lookSemaphore = yield* Semaphore.make(1);
    // Closed while a look asked for by a switch coming on or a turn ending
    // waits and runs. A sweep stops here between two threads: the permit
    // alone would not make it stand aside, since whoever gives it back can
    // take it again before a waiter wakes.
    const noLookAskedFor = yield* Latch.make(true);

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

    /** Puts a thread on the quicker pace, in the stretch it is already in if it is in one. */
    const keepInMotion = (threadId: ThreadId, now: number) =>
      Ref.update(inMotionRef, (threads) =>
        threads.has(threadId) ? threads : threads.set(threadId, now),
      );

    /**
     * The commit to hold a read of a pull request to: where the checkout has
     * its branch on the host (what it last pushed or fetched), or null where
     * there is nothing to hold it to. That is so where the checkout does not
     * know, and where the read has been a commit apart from it for longer
     * than a push takes to arrive.
     */
    const pushedHeadToAwait = (
      key: string,
      detail: PullRequestDetail,
      pushedHead: string | null,
      now: number,
    ) =>
      Ref.modify(pushWaitsRef, (waits) => {
        if (pullRequestChecksWait(detail, pushedHead, now) !== "push") {
          waits.delete(key);
          return [pushedHead, waits];
        }
        const commits = `${pushedHead}..${detail.headSha}`;
        const prior = waits.get(key);
        const since = prior?.commits === commits ? prior.since : now;
        waits.set(key, { commits, since });
        return [now - since < pushWaitMs ? pushedHead : null, waits];
      });

    /**
     * A pull request as the host has it now, past the service's cache, or why
     * there is none to act on: `unread` where the host did not answer, and
     * `elsewhere` where the project's repository has a different pull request
     * under that number than the one meant, the one at `meant`. `isMeant`
     * says which answers are that one; by default, an answer at the same
     * address. One whose checks are in motion puts its thread on the quicker
     * pace.
     */
    const readDetail = (
      threadId: ThreadId,
      reference: PullRequestRef,
      meant: string,
      isMeant = (detail: PullRequestDetail) => isSamePullRequest(detail.url, meant),
    ) =>
      Effect.gen(function* () {
        const detail = yield* attempt(
          "detail-read",
          threadId,
          pullRequestService.detail({ ...reference, force: true }),
        );
        if (detail === null) {
          return "unread";
        }
        if (!isMeant(detail)) {
          yield* Effect.logWarning("pull-request.auto-fix.other-repository", {
            threadId,
            number: reference.number,
            expected: meant,
            read: detail.url,
          });
          return "elsewhere";
        }
        const now = yield* Clock.currentTimeMillis;
        if (pullRequestChecksInMotion(detail, now)) {
          yield* keepInMotion(threadId, now);
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
     * Turns switches off, the same way the composer's do: the thread's own
     * (`pullRequestNumber` null) or those of a pull request it holds by number.
     */
    const turnOffSwitches = (
      threadId: ThreadId,
      pullRequestNumber: number | null,
      switches: { readonly autoFix?: false; readonly autoMerge?: null },
    ) =>
      orchestrationEngine
        .dispatch({
          type: "thread.pull-request-automation.set",
          commandId: CommandId.make(`pull-request-automation:${threadId}:${randomUUID()}`),
          threadId,
          ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
          ...switches,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("pull-request.automation.disarm-failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    /** Turns "Merge when checks pass" off: the thread's own, or one held by number. */
    const disarmAutoMerge = (threadId: ThreadId, pullRequestNumber: number | null) =>
      turnOffSwitches(threadId, pullRequestNumber, { autoMerge: null });

    /**
     * Turns off what was watching a pull request that has merged or closed:
     * every switch held for it by number, since there is nothing left for them
     * to do and a settled row offers none to turn off by hand, and the
     * thread's own merge switch. The thread's own fixing switch stays, for
     * whatever pull request its branch has next.
     */
    const disarmSettled = (
      thread: OrchestrationThreadShell,
      number: number,
      holders: SwitchHolders,
    ) =>
      Effect.gen(function* () {
        if (holders.own && thread.pullRequestAutoMerge !== null) {
          yield* disarmAutoMerge(thread.id, null);
        }
        const linked = holders.linked ? linkedPullRequestOf(thread, number) : undefined;
        if (linked !== undefined && (linked.autoFix || linked.autoMerge !== null)) {
          yield* turnOffSwitches(thread.id, number, {
            ...(linked.autoFix ? { autoFix: false } : {}),
            ...(linked.autoMerge === null ? {} : { autoMerge: null }),
          });
        }
      });

    /**
     * Turns "Merge when checks pass" off for one pull request: each of the
     * thread's switches that was asking for it.
     */
    const disarmMergeSwitches = (
      thread: OrchestrationThreadShell,
      number: number,
      holders: SwitchHolders,
    ) =>
      Effect.gen(function* () {
        if (holders.own && thread.pullRequestAutoMerge !== null) {
          yield* disarmAutoMerge(thread.id, null);
        }
        if (holders.linked && (linkedPullRequestOf(thread, number)?.autoMerge ?? null) !== null) {
          yield* disarmAutoMerge(thread.id, number);
        }
      });

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
        /** The commit a read is held to before it is merged on; see `pushedHeadToAwait`. */
        readonly pushedHead: string | null;
        /** The auto-fix watch is on and still has turns left to fix a failure. */
        readonly autoFix: boolean;
        /** Whose switches ask for the merge. */
        readonly holders: SwitchHolders;
      }) {
        const { thread, detail } = input;
        const number = input.reference.number;
        const now = yield* Clock.currentTimeMillis;
        const step = resolvePullRequestAutoMergeStep({
          detail,
          autoFix: input.autoFix,
          unpushedCommits: input.unpushedCommits,
          pushedHead: input.pushedHead,
          now,
        });
        if (step.kind === "wait") {
          return false;
        }
        if (step.kind === "stop") {
          yield* disarmMergeSwitches(thread, number, input.holders);
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
          mergeSwitchOf(latest.value, number, input.holders) === null ||
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
        // A merge settles the pull request, so its fixing switch goes too.
        yield* landing === "merged"
          ? disarmSettled(thread, number, input.holders)
          : disarmMergeSwitches(thread, number, input.holders);
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
        const reason = isPullRequestServiceError(failure)
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
        /** Whose fixing switches sent the agent after the removal. */
        readonly holders: SwitchHolders;
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
        if (
          !fixSwitchOn(thread, number, input.holders) ||
          hasWorkInProgress(thread) ||
          !lookedSince
        ) {
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
        const reason = isPullRequestServiceError(failure)
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
     * What one pull request's switches ask of this look, or null where they
     * ask nothing. A fixing switch over its turn cap asks nothing, though a
     * hand-off to the merge queue already made is still seen through.
     */
    const watchOf = Effect.fn("PullRequestAutomationWatcher.watchOf")(function* (
      thread: OrchestrationThreadShell,
      number: number,
      holders: SwitchHolders,
    ) {
      const key = pairKey(thread.id, number);
      const turnCount = (yield* Ref.get(turnCountsRef)).get(key) ?? 0;
      const fixOn = fixSwitchOn(thread, number, holders);
      const autoFixCapped = fixOn && turnCount >= MAX_AUTO_TURNS_PER_PULL_REQUEST;
      if (autoFixCapped) {
        const alreadyLogged = yield* Ref.modify(cappedLoggedRef, (logged) => {
          const seen = logged.has(key);
          logged.add(key);
          return [seen, logged];
        });
        if (!alreadyLogged) {
          yield* Effect.logWarning("pull-request.auto-fix.cap-reached", {
            threadId: thread.id,
            number,
            cap: MAX_AUTO_TURNS_PER_PULL_REQUEST,
          });
        }
      }
      const autoFix = fixOn && !autoFixCapped;
      const autoMerge = mergeSwitchOf(thread, number, holders);
      const pendingRequeue = (yield* Ref.get(requeuesRef)).get(key);
      if (!autoFix && autoMerge === null && pendingRequeue === undefined) {
        return null;
      }
      return {
        key,
        holders,
        turnCount,
        autoFix,
        autoMerge,
        pendingRequeue,
      } satisfies PullRequestWatch;
    });

    /**
     * Whether another thread is at work in the checkout at `path`, from its
     * own folder or the one it moved to, anywhere inside: an agent sent there
     * now would edit under it. An unreadable read model counts as busy, so the
     * fix waits rather than guesses.
     */
    const folderBusyElsewhere = (threadId: ThreadId, path: string) =>
      Effect.gen(function* () {
        const snapshot = yield* attempt(
          "snapshot-read",
          threadId,
          projectionSnapshotQuery.getShellSnapshot(),
        );
        if (snapshot === null) {
          return true;
        }
        const projectRoots = new Map(
          snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
        );
        return snapshot.threads.some((other) => {
          const projectCwd = projectRoots.get(other.projectId);
          return (
            other.id !== threadId &&
            other.archivedAt === null &&
            projectCwd !== undefined &&
            isFilesystemPathWithin(
              resolveThreadWorkingCwd({
                projectCwd,
                worktreePath: other.worktreePath,
                effectiveCwd: other.effectiveCwd,
              }),
              path,
            ) &&
            hasWorkInProgress(other)
          );
        });
      });

    /**
     * Everything the watcher does for one open pull request it has just read:
     * merge it once its switch says so, put it back in the merge queue after a
     * fix, and send the agent what is new while fixing is on, naming the
     * folder to work in when it is not the thread's own. Answers what it
     * found, and leaves the baseline holding what the pull request looks like
     * now.
     */
    const actOnPullRequest = Effect.fn("PullRequestAutomationWatcher.actOnPullRequest")(
      function* (input: {
        readonly candidate: SweepCandidate;
        readonly reference: PullRequestRef;
        readonly detail: PullRequestDetail;
        readonly watch: PullRequestWatch;
        readonly checkout: BranchCheckout;
      }): Effect.fn.Return<LookOutcome> {
        const { reference, detail, watch, checkout } = input;
        const { thread, repository } = input.candidate;
        const number = reference.number;
        const { key } = watch;
        const { status } = checkout;
        const unpushedCommits = status?.aheadCount ?? 0;

        // A look can come seconds after the agent pushed, when its turn ends.
        // A read that still names the commit before says nothing about the
        // push: its checks are that commit's, so they are neither sent to the
        // agent nor merged on, and the thread is looked at again soon.
        const now = yield* Clock.currentTimeMillis;
        const pushedHead = yield* pushedHeadToAwait(
          key,
          detail,
          status?.upstreamHeadSha ?? null,
          now,
        );
        const awaitingPush = pullRequestChecksWait(detail, pushedHead, now) === "push";
        if (awaitingPush) {
          yield* keepInMotion(thread.id, now);
        }

        if (watch.autoMerge !== null) {
          const merged = yield* sweepAutoMerge({
            thread,
            reference,
            detail,
            mergeMethod: watch.autoMerge,
            unpushedCommits,
            pushedHead,
            autoFix: watch.autoFix,
            holders: watch.holders,
          });
          if (merged) {
            return "nothing";
          }
        }
        // Arming the host's merge on the commit before the fix would queue it
        // without the fix, so this waits for the push like everything else.
        if (watch.pendingRequeue !== undefined && !awaitingPush) {
          yield* requeueAfterFix({
            threadId: thread.id,
            key,
            reference,
            detail,
            unpushedCommits,
            pending: watch.pendingRequeue,
            holders: watch.holders,
          });
        }
        if (!watch.autoFix) {
          return "watching";
        }

        const activity = yield* attempt(
          "activity-read",
          thread.id,
          pullRequestService.activity(reference),
        );
        if (activity === null) {
          return "watching";
        }

        const currentFailing = failingCheckNames(detail);
        const comments = listActivityComments(activity);
        const commentIds = new Set(comments.map((comment) => comment.id));
        const queueRemoval = detail.mergeQueue?.removal ?? null;
        // A switch that just came on starts from no failing checks and no
        // removal from the merge queue, whatever it saw before. Remarks already
        // made are still not news: they may well have been answered, and
        // nothing here can tell.
        const freshlyArmed = yield* Ref.modify(freshlyArmedRef, (armed) => {
          const own = watch.holders.own && armed.delete(fixSwitchKey(thread.id, null));
          const linked = watch.holders.linked && armed.delete(fixSwitchKey(thread.id, number));
          return [own || linked, armed];
        });
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
          return "watching";
        }

        // A check that has stopped failing leaves the baseline, so the same check
        // failing again after a push is news again.
        const carriedFailing = new Set(
          [...baseline.failingCheckNames].filter((name) => currentFailing.has(name)),
        );
        // A rollup still running is not a verdict: wait for it rather than send
        // the agent after a check that may pass on its own.
        const newlyFailing: PullRequestAutoFixCheck[] =
          detail.checksState === "pending" || awaitingPush
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

        const promptCheckout: PullRequestAutoFixCheckout | null =
          checkout.kind === "folder"
            ? { kind: "folder", branch: detail.headBranch, path: checkout.path }
            : checkout.kind === "unknown"
              ? { kind: "unknown", branch: detail.headBranch }
              : null;
        const text = buildPullRequestAutoFixPrompt({
          number,
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
          checkout: promptCheckout,
        });
        if (text === null) {
          // Nothing new. Keep the checks that are still failing, and remember
          // every remark, the viewer's own included, so none of them fires later.
          yield* Ref.update(baselinesRef, (map) =>
            map.set(key, { failingCheckNames: carriedFailing, commentIds, queueRemovalId }),
          );
          return "watching";
        }

        // The reads above take seconds, and in that time the user may have sent
        // a message of their own or turned the switch off. Either one means
        // "not now", so the thread is read again just before a turn is started
        // for it. So does another thread at work in the folder the agent would
        // be sent to. What would have been said stays news: the baseline goes
        // back to the one this look started from, and the first look after
        // that says it if it still needs saying.
        const latest = yield* attempt(
          "thread-read",
          thread.id,
          projectionSnapshotQuery.getThreadShellById(thread.id),
        );
        if (
          latest === null ||
          Option.isNone(latest) ||
          !fixSwitchOn(latest.value, number, watch.holders) ||
          hasWorkInProgress(latest.value) ||
          (checkout.kind === "folder" && (yield* folderBusyElsewhere(thread.id, checkout.path)))
        ) {
          yield* Ref.update(baselinesRef, (map) => map.set(key, baseline));
          return "watching";
        }

        const requestedAt = yield* startTurn({
          thread: latest.value,
          number,
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
          return "watching";
        }
        yield* Ref.update(turnCountsRef, (counts) => counts.set(key, watch.turnCount + 1));
        // The queue gets it back once the agent has had its turn at the failure.
        if (newQueueRemoval !== null) {
          yield* Ref.update(requeuesRef, (map) =>
            map.set(key, { removalId: newQueueRemoval.id, requestedAt }),
          );
        }
        return "started";
      },
    );

    /**
     * The thread's own switches, for the pull request on the branch its
     * checkout is on (`remote`, that checkout's status), where the thread does
     * not hold that pull request by number; one it does is watched with the
     * rest in `sweepLinkedPullRequests`. Clients set switches by number now,
     * and this keeps the ones a thread set before that working.
     */
    const sweepOwnPullRequest = Effect.fn("PullRequestAutomationWatcher.sweepOwnPullRequest")(
      function* (
        input: SweepCandidate,
        remote: VcsStatusRemoteResult | null,
      ): Effect.fn.Return<LookOutcome> {
        const { thread, project, repository } = input;
        // No pull request is not known to be none: a lookup the host did not
        // answer reads the same, so the thread keeps the usual pace.
        if (remote === null || remote.pr === null) {
          return "watching";
        }
        const pullRequest = remote.pr;
        const reference = {
          projectId: project.id,
          repository,
          number: pullRequest.number,
          force: true,
        } as const;
        if (pullRequest.state !== "open") {
          // Merged or closed some other way: the instruction has nothing left
          // to act on, and must not carry over to the next pull request. That
          // holds for the project's own pull request, so before the switch
          // goes off the host is asked whether this is it. It is asked about
          // a closed one either way: unlike a merged one it can be reopened,
          // and the status read falls back on what it last saw when its own
          // lookup fails.
          const autoMerge = thread.pullRequestAutoMerge;
          if (autoMerge !== null || pullRequest.state === "closed") {
            const settled = yield* readDetail(thread.id, reference, pullRequest.url);
            if (settled === "unread") {
              return "watching";
            }
            if (settled !== "elsewhere") {
              if (pullRequest.state === "closed" && settled.state === "open") {
                return "watching";
              }
              if (autoMerge !== null) {
                yield* disarmAutoMerge(thread.id, null);
              }
            }
          }
          return "nothing";
        }

        const watch = yield* watchOf(thread, pullRequest.number, { linked: false, own: true });
        if (watch === null) {
          return "nothing";
        }
        const detail = yield* readDetail(thread.id, reference, pullRequest.url);
        if (detail === "unread" || detail === "elsewhere") {
          return detail === "unread" ? "watching" : "nothing";
        }
        return yield* actOnPullRequest({
          candidate: input,
          reference,
          detail,
          watch,
          checkout: { kind: "thread", status: remote },
        });
      },
    );

    /**
     * Where a pull request's branch is checked out, for one look. A checkout
     * is the pull request's only when its own read names it: a branch name
     * alone can be the thread's stale record of where it was, or a branch on
     * a fork that shares a name with one here. Null where that cannot be told
     * (a checkout on the branch, or the list of checkouts, could not be read),
     * which is no answer: a merge waits on what it would have said.
     */
    const locateCheckout = (
      candidate: SweepCandidate,
      reads: LookReads,
      detail: PullRequestDetail,
    ) =>
      Effect.gen(function* (): Effect.fn.Return<BranchCheckout | null> {
        const threadCwd = threadWorkingCwd(candidate);
        const threadStatus = yield* reads.statusAt(threadCwd);
        if (threadStatus?.pr != null && isSamePullRequest(threadStatus.pr.url, detail.url)) {
          return { kind: "thread", status: threadStatus };
        }
        const worktrees = yield* reads.worktrees;
        // A repository always lists its main checkout, so an empty list is a
        // read that failed.
        if (worktrees === null || worktrees.length === 0) {
          return null;
        }
        // The checkout the thread works in is the innermost one around its
        // folder: the main checkout can hold the others.
        const threadCheckout = worktrees
          .filter((entry) => isFilesystemPathWithin(threadCwd, entry.path))
          .reduce<GitWorktreeEntry | null>(
            (innermost, entry) =>
              innermost === null || entry.path.length > innermost.path.length ? entry : innermost,
            null,
          );
        // Its own branch name, or the name a pull request from a fork is
        // checked out under here.
        const forkPrefix = forkPullRequestBranchPrefix(detail.number);
        const onBranch = worktrees.filter(
          (entry) =>
            entry.branch !== null &&
            (entry.branch === detail.headBranch || entry.branch.startsWith(forkPrefix)),
        );
        let fallback: BranchCheckout = { kind: "unknown", status: null };
        for (const entry of onBranch) {
          const isThreadCheckout =
            threadCheckout !== null && areFilesystemPathsEqual(threadCheckout.path, entry.path);
          const status = isThreadCheckout ? threadStatus : yield* reads.statusAt(entry.path);
          if (status === null) {
            return null;
          }
          if (
            !isThreadCheckout &&
            status.pr !== null &&
            isSamePullRequest(status.pr.url, detail.url)
          ) {
            return { kind: "folder", path: entry.path, status };
          }
          if (fallback.status === null) {
            fallback = { kind: "unknown", status };
          }
        }
        return fallback;
      });

    /**
     * The pull requests the thread holds by number, each by its own switches,
     * and the one on its checkout's branch (at `ownUrl`, where the thread's own
     * switches are on) by those too. Each is merged and fixed where its branch
     * is checked out. A look stops at the first turn it starts: the agent is
     * busy from then, and the rest wait for the turn to end.
     */
    const sweepLinkedPullRequests = Effect.fn(
      "PullRequestAutomationWatcher.sweepLinkedPullRequests",
    )(function* (
      candidate: SweepCandidate,
      reads: LookReads,
      ownUrl: string | null,
    ): Effect.fn.Return<LookOutcome> {
      const { thread, project, repository } = candidate;
      let outcome: LookOutcome = "nothing";
      for (const linked of thread.linkedPullRequests) {
        const holders = {
          linked: true,
          own: ownUrl !== null && isSamePullRequest(ownUrl, linked.url),
        };
        // A switch over its turn cap asks nothing of an open pull request, but
        // still has to notice it settle, which is what turns it off.
        const watch = yield* watchOf(thread, linked.number, holders);
        const armed =
          linkedPullRequestArmed(linked) ||
          (holders.own && (thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null));
        if (watch === null && !armed) {
          continue;
        }
        const reference = {
          projectId: project.id,
          repository,
          number: linked.number,
          force: true,
        } as const;
        // The one that was linked: still at the address stored then, or, where
        // the host has since renamed the repository and moved its address,
        // still in the repository it was matched to. A project that now points
        // at another repository has another pull request under the number.
        const detail = yield* readDetail(
          thread.id,
          reference,
          linked.url,
          (read) =>
            isSamePullRequest(read.url, linked.url) ||
            parsePullRequestUrl(linked.url)?.repository.toLowerCase() === repository.toLowerCase(),
        );
        if (detail === "unread" || detail === "elsewhere") {
          outcome = combineOutcomes(outcome, detail === "unread" ? "watching" : "nothing");
          continue;
        }
        if (detail.state !== "open") {
          // Merged or closed some other way: nothing is left to act on.
          yield* disarmSettled(thread, linked.number, holders);
          continue;
        }
        if (watch === null) {
          continue;
        }
        const checkout = yield* locateCheckout(candidate, reads, detail);
        if (checkout === null) {
          outcome = combineOutcomes(outcome, "watching");
          continue;
        }
        outcome = combineOutcomes(
          outcome,
          yield* actOnPullRequest({ candidate, reference, detail, watch, checkout }),
        );
        if (outcome === "started") {
          break;
        }
      }
      return outcome;
    });

    /**
     * One candidate thread. Answers what it found, and puts a thread with
     * nothing to watch to rest.
     */
    const sweepThread = Effect.fn("PullRequestAutomationWatcher.sweepThread")(function* (
      candidate: SweepCandidate,
    ): Effect.fn.Return<LookOutcome> {
      const { thread, project } = candidate;
      // This look decides the pace again: checks it finds in motion put the
      // thread back on the quicker one, in the stretch it was already in.
      const inMotionSince = yield* Ref.modify(inMotionRef, (threads) => {
        const since = threads.get(thread.id);
        threads.delete(thread.id);
        return [since, threads];
      });
      const statuses = new Map<string, VcsStatusRemoteResult | null>();
      const reads: LookReads = {
        statusAt: (cwd) =>
          Effect.suspend(() =>
            statuses.has(cwd)
              ? Effect.succeed(statuses.get(cwd) ?? null)
              : attempt("status-read", thread.id, gitManager.remoteStatus({ cwd })).pipe(
                  Effect.tap((status) => Effect.sync(() => statuses.set(cwd, status))),
                ),
          ),
        worktrees: yield* Effect.cached(
          attempt(
            "worktree-list",
            thread.id,
            gitWorkflow.listWorktrees({ cwd: project.workspaceRoot }),
          ),
        ),
      };
      // The thread's own switches are for the pull request on its checkout's
      // branch, so a thread with no branch has only ones held by number.
      const ownArmed =
        thread.branch !== null &&
        (thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null);
      const ownStatus = ownArmed ? yield* reads.statusAt(threadWorkingCwd(candidate)) : null;
      const ownUrl = ownStatus?.pr?.url ?? null;
      const ownHeld =
        ownUrl !== null &&
        thread.linkedPullRequests.some((linked) => isSamePullRequest(linked.url, ownUrl));
      const own =
        ownArmed && !ownHeld ? yield* sweepOwnPullRequest(candidate, ownStatus) : "nothing";
      const outcome =
        own === "started"
          ? own
          : combineOutcomes(own, yield* sweepLinkedPullRequests(candidate, reads, ownUrl));
      if (inMotionSince !== undefined) {
        yield* Ref.update(inMotionRef, (threads) =>
          threads.has(thread.id) ? threads.set(thread.id, inMotionSince) : threads,
        );
      }
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(restingRef, (threads) => {
        if (outcome !== "nothing") {
          threads.delete(thread.id);
          return threads;
        }
        // A time that does not parse says nothing about how long it has sat.
        const idleMs = now - Date.parse(thread.updatedAt);
        const restMs = Number.isFinite(idleMs)
          ? Math.min(Math.max(idleMs / REST_SHARE_OF_IDLE_TIME, sweepIntervalMs), MAX_REST_MS)
          : sweepIntervalMs;
        return threads.set(thread.id, { stamp: restStamp(thread), nextLookAt: now + restMs });
      });
      return outcome;
    });

    /**
     * One look at a thread, starting from the read model as it stands: the
     * thread and its project are read here, not carried in from a listing. A
     * sweep reaches its last thread long after it listed them, and by then the
     * thread may have started a turn, changed its switches, or had a look of
     * its own. Answers what it found; `busy` where the thread has work in
     * progress, which is "not yet"; null where it is no longer watched or is on
     * a host this cannot read. Run under the look permit.
     */
    const lookAt = Effect.fn("PullRequestAutomationWatcher.lookAt")(function* (threadId: ThreadId) {
      const thread = yield* attempt(
        "thread-read",
        threadId,
        projectionSnapshotQuery.getThreadShellById(threadId),
      );
      if (thread === null || Option.isNone(thread) || !isWatched(thread.value)) {
        return null;
      }
      if (hasWorkInProgress(thread.value)) {
        return "busy";
      }
      const project = yield* attempt(
        "project-read",
        threadId,
        projectionSnapshotQuery.getProjectShellById(thread.value.projectId),
      );
      const candidate =
        project === null || Option.isNone(project)
          ? null
          : candidateOf(thread.value, project.value);
      return candidate === null ? null : yield* sweepThread(candidate);
    });

    /**
     * The threads a sweep looks at: every watched, idle one that is not
     * resting, or only the ones whose checks were in motion at their last
     * look. Forgets what was held for threads that are no longer armed. Run
     * under the look permit, since it reads and clears what looks leave behind.
     */
    const listThreads = Effect.fn("PullRequestAutomationWatcher.listThreads")(function* (
      scope: "all" | "in-motion",
    ) {
      const now = yield* Clock.currentTimeMillis;
      // Nothing in motion reads nothing at all.
      const inMotion = new Set<string>();
      if (scope === "in-motion") {
        for (const [threadId, since] of yield* Ref.get(inMotionRef)) {
          if (now - since < MAX_IN_MOTION_MS) {
            inMotion.add(threadId);
          }
        }
        if (inMotion.size === 0) {
          return [];
        }
      }

      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pull-request.auto-fix.snapshot-query-failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (snapshot === null) {
        return [];
      }

      const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
      // A fixing switch that is no longer on forgets its pull request's
      // baseline, that it was just turned on, and any pull request it was to
      // put back in the merge queue. Being on is the only test: a thread that
      // is merely busy this sweep must keep its baseline, or the failure it
      // should act on would be re-observed as the state it started from once
      // the turn ends. A thread's own switch covers whichever pull request
      // its checkout is on, so it keeps every one of the thread's.
      const armedFixSwitches = new Set<string>(
        snapshot.threads.flatMap((thread) => [
          ...(thread.pullRequestAutoFix ? [fixSwitchKey(thread.id, null)] : []),
          ...thread.linkedPullRequests
            .filter((linked) => linked.autoFix)
            .map((linked) => fixSwitchKey(thread.id, linked.number)),
        ]),
      );
      // Deleting through a collection's own iterator is defined behaviour, so
      // nothing needs copying first.
      const forgetDisarmedPairs = <A>(map: Map<string, A>) => {
        for (const key of map.keys()) {
          if (!armedFixSwitches.has(key) && !armedFixSwitches.has(threadIdFromPairKey(key))) {
            map.delete(key);
          }
        }
        return map;
      };
      yield* Ref.update(baselinesRef, forgetDisarmedPairs);
      yield* Ref.update(requeuesRef, forgetDisarmedPairs);
      yield* Ref.update(freshlyArmedRef, (armed) => {
        for (const key of armed) {
          if (!armedFixSwitches.has(key)) {
            armed.delete(key);
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

      // A rest ends with the watch: a thread armed again starts from a look.
      const watchedThreadIds = new Set<string>(
        snapshot.threads.filter(isWatched).map((thread) => thread.id as string),
      );
      const resting = yield* Ref.updateAndGet(restingRef, (threads) => {
        for (const threadId of threads.keys()) {
          if (!watchedThreadIds.has(threadId)) {
            threads.delete(threadId);
          }
        }
        return threads;
      });
      yield* Ref.update(pushWaitsRef, (waits) => {
        for (const key of waits.keys()) {
          if (!watchedThreadIds.has(threadIdFromPairKey(key))) {
            waits.delete(key);
          }
        }
        return waits;
      });

      return snapshot.threads.flatMap((thread): ThreadId[] => {
        if (!idleThreadIds.has(thread.id) || (scope === "in-motion" && !inMotion.has(thread.id))) {
          return [];
        }
        const rest = resting.get(thread.id);
        if (rest !== undefined && rest.stamp === restStamp(thread) && now < rest.nextLookAt) {
          return [];
        }
        const project = projectsById.get(thread.projectId);
        return project !== undefined && candidateOf(thread, project) !== null ? [thread.id] : [];
      });
    });

    /**
     * Every armed thread, or only the ones whose checks are in motion, one
     * look at a time. Answers how many turns it started.
     */
    const runSweep = Effect.fn("PullRequestAutomationWatcher.runSweep")(function* (
      scope: "all" | "in-motion",
    ) {
      const threadIds = yield* lookSemaphore.withPermits(1)(listThreads(scope));
      let startedCount = 0;
      for (const threadId of threadIds) {
        yield* noLookAskedFor.await;
        const outcome = yield* lookSemaphore.withPermits(1)(lookAt(threadId));
        if (outcome === "started") {
          startedCount += 1;
        }
      }
      return startedCount;
    });

    const sweep = sweepSemaphore.withPermits(1)(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.set(lastFullSweepAtRef, now)),
        Effect.andThen(runSweep("all")),
      ),
    );

    /**
     * Looks again at the threads whose checks were in motion at their last
     * look, and only those, so the host is not asked about every armed pull
     * request at this pace.
     */
    const sweepInMotion = sweepSemaphore.withPermits(1)(runSweep("in-motion"));

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
     * A look asked for by something that just happened to one thread, a switch
     * coming on or a turn ending: at that thread alone, and ahead of whatever a
     * sweep in flight has yet to reach, so the answer takes as long as reading
     * one pull request however many threads are armed. `justArmed` marks a
     * fixing switch (by `fixSwitchKey`) as just turned on first, under the
     * same permit as the look, so no listing can clear the mark on the
     * strength of a read taken before the switch came on. Answers as `lookAt`
     * does.
     */
    const lookNow = (threadId: ThreadId, justArmed: string | null) =>
      noLookAskedFor.close.pipe(
        Effect.andThen(
          lookSemaphore.withPermits(1)(
            Effect.gen(function* () {
              if (justArmed !== null) {
                yield* Ref.update(freshlyArmedRef, (armed) => armed.add(justArmed));
              }
              return yield* lookAt(threadId);
            }),
          ),
        ),
        Effect.ensuring(noLookAskedFor.open),
        Effect.withSpan("PullRequestAutomationWatcher.lookNow"),
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
        // Threads with a turn asked for, to be looked at as it ends. Only this
        // event fiber touches it. A thread enters when its turn is asked for
        // and not on later word that it is running: this fiber can fall behind
        // while a look reads the host, and a stale "running" taken up after
        // the turn's end would have the thread looked at twice. A thread
        // nobody watches leaves at the first sign of its turn. A turn end it
        // misses is no loss: the next sweep looks.
        const awaitingTurnEnd = new Set<string>();

        /** A look asked for; a thread found busy gets another as its turn ends. */
        const lookNowOrAfterTurn = (threadId: ThreadId, justArmed: string | null) =>
          lookNow(threadId, justArmed).pipe(
            Effect.map((outcome) => {
              if (outcome === "busy") {
                awaitingTurnEnd.add(threadId);
              }
            }),
          );

        /**
         * The look a watched thread gets as its turn ends, when the agent has
         * most likely just pushed: its checks go on the quicker pace from the
         * start, and a switch that came on mid-turn is answered now. A turn
         * ends over several events, so one that still finds work in progress
         * waits for the next.
         */
        const lookAfterTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            if (!awaitingTurnEnd.has(threadId)) {
              return;
            }
            const read = yield* attempt(
              "thread-read",
              threadId,
              projectionSnapshotQuery.getThreadShellById(threadId),
            );
            const watched =
              read !== null && Option.isSome(read) && isWatched(read.value) ? read.value : null;
            if (watched !== null && hasWorkInProgress(watched)) {
              return;
            }
            awaitingTurnEnd.delete(threadId);
            if (watched !== null) {
              yield* lookNowOrAfterTurn(threadId, null);
            }
          });

        // What happens to one thread is answered at once rather than at the
        // next interval. A switch coming on: a check already failing goes to
        // the agent, and a pull request with nothing left to wait for merges,
        // when the box is ticked. A turn ending: the pull request it pushed to
        // is watched from then, not from up to two minutes later.
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
            switch (event.type) {
              case "thread.pull-request-automation-changed": {
                const { threadId, pullRequestNumber, autoFix, autoMerge } = event.payload;
                const justArmed =
                  autoFix === true ? fixSwitchKey(threadId, pullRequestNumber ?? null) : null;
                return justArmed !== null || autoMerge != null
                  ? lookNowOrAfterTurn(threadId, justArmed)
                  : Effect.void;
              }
              case "thread.turn-start-requested":
                awaitingTurnEnd.add(event.payload.threadId);
                return Effect.void;
              case "thread.deleted":
                awaitingTurnEnd.delete(event.payload.threadId);
                return Effect.void;
              case "thread.session-set":
                // Still working by its own word, so not worth a read of the thread.
                return sessionHasWorkInProgress(event.payload.session)
                  ? Effect.void
                  : lookAfterTurn(event.payload.threadId);
              case "thread.turn-diff-completed":
              case "thread.turn-completed":
                return lookAfterTurn(event.payload.threadId);
              default:
                return Effect.void;
            }
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
