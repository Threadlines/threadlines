import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PullRequestDetail,
} from "@threadlines/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@threadlines/shared/DrainableWorker";
import {
  changeRequestRepositoryName,
  findPullRequestUrls,
} from "@threadlines/shared/sourceControl";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadPullRequestLinker,
  type ThreadPullRequestLinkerShape,
} from "../Services/ThreadPullRequestLinker.ts";

type MessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

/** Only GitHub addresses are read out of messages; see `findPullRequestUrls`. */
const SUPPORTED_PROVIDER = "github";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * How long to wait before reading a message's pull requests again when the
 * host did not answer. A final message is often the only place the agent
 * names the pull request it opened, so a blip at that moment must not lose it.
 */
const DEFAULT_RETRY_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(30),
  Duration.minutes(2),
  Duration.minutes(10),
];

export interface ThreadPullRequestLinkerLiveOptions {
  readonly retryDelays?: ReadonlyArray<Duration.Duration>;
}

/** One finished message to read, and how many times it has been read before. */
interface LinkWork {
  readonly event: MessageSentEvent;
  readonly attempt: number;
}

/**
 * Whether a pull request the agent linked is one this thread opened: the
 * viewer wrote it (the agent works as the viewer), after the thread began, on
 * a branch other than the thread's own. One that was already open when the
 * thread started is something the agent is talking about, not something it
 * made, and the one on the thread's own branch is found from the branch.
 */
export function isPullRequestOpenedByThread(
  detail: Pick<PullRequestDetail, "viewerIsAuthor" | "createdAt" | "headBranch">,
  thread: Pick<OrchestrationThreadShell, "createdAt" | "branch">,
): boolean {
  const openedAt = Date.parse(detail.createdAt);
  const threadStartedAt = Date.parse(thread.createdAt);
  return (
    detail.viewerIsAuthor &&
    Number.isFinite(openedAt) &&
    Number.isFinite(threadStartedAt) &&
    openedAt >= threadStartedAt &&
    detail.headBranch !== thread.branch
  );
}

const make = (options?: ThreadPullRequestLinkerLiveOptions) =>
  Effect.gen(function* () {
    const retryDelays = options?.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const scope = yield* Effect.scope;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const threadMessages = yield* ProjectionThreadMessageRepository;
    const pullRequestService = yield* PullRequestService;

    // Pull requests read once and found not to be the thread's, keyed by thread
    // and number, so a link the agent repeats is not read from the host again.
    // Only the worker's one fiber touches it. Kept for the server's lifetime.
    const declined = new Set<string>();

    // A finished message's event carries no text when it only closes a
    // streamed one; the projection holds what streamed in, and it is written
    // before the event is published.
    const readMessageText = (event: MessageSentEvent) =>
      event.payload.text.length > 0
        ? Effect.succeed(event.payload.text)
        : threadMessages
            .getByMessageId({ messageId: event.payload.messageId })
            .pipe(
              Effect.map(Option.match({ onNone: () => "", onSome: (message) => message.text })),
            );

    /** Reads one message's pull request links. Answers whether the host left any unanswered. */
    const processMessage = Effect.fn("ThreadPullRequestLinker.processMessage")(function* (
      event: MessageSentEvent,
    ) {
      const links = findPullRequestUrls(yield* readMessageText(event));
      if (links.length === 0) {
        return false;
      }
      const threadId = event.payload.threadId;
      const thread = Option.getOrNull(yield* projectionSnapshotQuery.getThreadShellById(threadId));
      if (thread === null || thread.archivedAt !== null) {
        return false;
      }
      const project = Option.getOrNull(
        yield* projectionSnapshotQuery.getProjectShellById(thread.projectId),
      );
      if (project?.repositoryIdentity?.provider !== SUPPORTED_PROVIDER) {
        return false;
      }
      const repository = changeRequestRepositoryName(project.repositoryIdentity);
      if (repository === null) {
        return false;
      }

      let unanswered = false;

      for (const link of links) {
        const key = `${threadId}#${link.number}`;
        if (
          link.repository.toLowerCase() !== repository.toLowerCase() ||
          thread.linkedPullRequests.some((linked) => linked.number === link.number) ||
          declined.has(key)
        ) {
          continue;
        }
        // A read that fails is no answer either way, so it is asked again later.
        const detail = yield* pullRequestService
          .detail({ projectId: project.id, repository, number: link.number })
          .pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Effect.logDebug("pull-request.link.detail-read-failed", {
                threadId,
                number: link.number,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(Option.none<PullRequestDetail>())),
            ),
          );
        if (Option.isNone(detail)) {
          unanswered = true;
          continue;
        }
        if (!isPullRequestOpenedByThread(detail.value, thread)) {
          declined.add(key);
          continue;
        }
        const createdAt = yield* nowIso;
        yield* orchestrationEngine
          .dispatch({
            type: "thread.pull-request.link",
            // One id per thread and pull request, so a repeat is the same command.
            commandId: CommandId.make(`pull-request-link:${threadId}:${link.number}`),
            threadId,
            number: link.number,
            url: detail.value.url,
            createdAt,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("pull-request.link.linked", { threadId, number: link.number }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("pull-request.link.dispatch-failed", {
                threadId,
                number: link.number,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      return unanswered;
    });

    const processWork = (work: LinkWork) =>
      processMessage(work.event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("pull-request.link.message-failed", {
                threadId: work.event.payload.threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(true)),
        ),
        Effect.flatMap((unanswered) => {
          const delay = retryDelays[work.attempt];
          // Read again after a while, off the worker, so later messages are not held up.
          return unanswered && delay !== undefined
            ? Effect.sleep(delay).pipe(
                Effect.andThen(worker.enqueue({ event: work.event, attempt: work.attempt + 1 })),
                Effect.forkIn(scope),
                Effect.asVoid,
              )
            : Effect.void;
        }),
      );

    const worker: DrainableWorker<LinkWork> = yield* makeDrainableWorker(processWork);

    const start: ThreadPullRequestLinkerShape["start"] = Effect.fn("start")(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          event.type === "thread.message-sent" &&
          event.payload.role === "assistant" &&
          !event.payload.streaming
            ? worker.enqueue({ event, attempt: 0 })
            : Effect.void,
        ),
      );
    });

    return { start, drain: worker.drain } satisfies ThreadPullRequestLinkerShape;
  });

export const makeThreadPullRequestLinkerLive = (options?: ThreadPullRequestLinkerLiveOptions) =>
  Layer.effect(ThreadPullRequestLinker, make(options));

export const ThreadPullRequestLinkerLive = makeThreadPullRequestLinkerLive();
