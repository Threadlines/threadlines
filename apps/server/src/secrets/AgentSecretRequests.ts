/**
 * Answers to agents' requests for keys (docs/design/secret-requests.md,
 * "Answering"). Not now ends a waiting card. Save checks the value against
 * the request's use, claims the card for the app that pressed it, writes the
 * value to its one destination, and settles, handing the asking agent its
 * message in the same decision. The first claim wins; a retry with the same
 * claim gets the stored result. The value lives in this handler's memory
 * only, unwrapped at the write, and is never logged, traced or recorded.
 *
 * One lock orders every answer and every file operation under
 * `agent-secrets` (writes, Remove now, thread cleanup, expiry, the sweep), and
 * each runs to its end in the service's own scope. Startup settles claims a
 * previous run stopped in the middle of before any answer is taken, and sets
 * the expiry timers of saved `commands` files.
 */
import {
  CommandId,
  type OrchestrationSecretRequest,
  type OrchestrationThread,
  type SecretRequestAnswer,
  type SecretRequestClaim,
  SecretRequestError,
  type SecretRequestId,
  type SecretRequestRemoveInput,
  type SecretRequestRespondInput,
  type ThreadId,
} from "@threadlines/contracts";
import { isLiveCommandsSecret } from "@threadlines/shared/secretRequestState";
import {
  COMMANDS_SECRET_TTL_MS,
  checkSecretValue,
  failedSecretMessage,
  savedCommandsMessage,
  savedEnvFileMessage,
  secretAnswerMessageId,
} from "@threadlines/shared/secretRequests";
import { activeParticipants } from "@threadlines/shared/threadParticipants";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProcessRunner } from "../processRunner.ts";
import { SecretScrubber } from "./SecretScrubber.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { type SecretDestinations, makeSecretDestinations } from "./secretDestinations.ts";

export interface AgentSecretRequestsShape {
  /** Save or Not now, from the app holding `claimId`. */
  readonly respond: (
    input: SecretRequestRespondInput,
  ) => Effect.Effect<SecretRequestAnswer, SecretRequestError>;
  /** Remove now: a saved `commands` key's file goes early. */
  readonly remove: (input: SecretRequestRemoveInput) => Effect.Effect<void, SecretRequestError>;
  /** What the tool binds an env request to, checked when the agent asks. */
  readonly destinations: SecretDestinations;
  /** The folder a thread's agent works in, which env paths are relative to. */
  readonly threadFolder: (thread: OrchestrationThread) => Effect.Effect<string | undefined>;
}

export class AgentSecretRequests extends Context.Service<
  AgentSecretRequests,
  AgentSecretRequestsShape
>()("threadlines/secrets/AgentSecretRequests") {}

/** How the service reads threads: including archived ones, so an answer sees why it's over. */
export interface AgentSecretRequestsReads {
  readonly thread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** The folder the thread works in: its worktree, or its project's root. */
  readonly threadFolder: (thread: OrchestrationThread) => Effect.Effect<string | undefined>;
  /** Every live thread's requests, at startup. Fails when they can't be read, so nothing is removed blind. */
  readonly all: Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly secretRequests: ReadonlyArray<OrchestrationSecretRequest>;
    }>,
    ProjectionRepositoryError
  >;
}

const commandId = (requestId: SecretRequestId, step: string) =>
  CommandId.make(`server:secret-request:${requestId}:${step}`);

const RECOVERY_COMMANDS = "Threadlines stopped while saving. Ask again.";
const recoveryEnvFile = (request: OrchestrationSecretRequest) =>
  `Threadlines stopped while saving ${request.name}. It may or may not be in ${
    request.use.kind === "env_file" ? request.use.path : "its file"
  }. Ask again if you need it.`;
const PUT_AWAY = "The thread was put away while saving.";
const SWEEP_EVERY = Duration.hours(1);
/** How soon an expiry that couldn't remove its file tries again. */
const EXPIRY_RETRY_MS = 60_000;

/** What a request that has moved on means for the app answering it now. */
export function answerFor(
  request: OrchestrationSecretRequest,
  claimId: string,
): SecretRequestAnswer {
  const mine = request.claim?.claimId === claimId;
  const by = request.claim?.deviceLabel;
  const detail = request.detail !== undefined ? { detail: request.detail } : {};
  switch (request.status) {
    case "saved":
    case "failed":
    case "uncertain":
    case "declined":
      return mine
        ? { outcome: request.status, ...detail }
        : {
            outcome: "already_answered",
            detail:
              request.status === "declined"
                ? "It was already answered with Not now."
                : "It was already answered.",
            ...(by !== undefined ? { by } : {}),
          };
    case "claimed":
      return {
        outcome: "already_answered",
        detail: "It's being saved from another device.",
        ...(by !== undefined ? { by } : {}),
      };
    case "cancelled":
      return { outcome: "cancelled", ...detail };
    case "replaced":
      return {
        outcome: "replaced",
        detail: "The agent asked again, and its new card replaced this one.",
      };
    case "waiting":
      return { outcome: "gone", detail: "It's still waiting." };
  }
}

const isPutAway = (thread: OrchestrationThread | undefined) =>
  thread === undefined ||
  thread.deletedAt !== null ||
  thread.archivedAt !== null ||
  (thread.move ?? null) !== null;

export const make = (
  reads: AgentSecretRequestsReads,
  destinations: SecretDestinations,
  /** The registry that hides a saved value if the agent prints it (SecretScrubber). */
  watched: {
    readonly watch: (name: string, value: string, requestId: string) => void;
    readonly gone: (requestId: string) => void;
  } = { watch: () => {}, gone: () => {} },
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const analytics = yield* Effect.serviceOption(AnalyticsService);
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const recovered = yield* Deferred.make<void>();
    const nowMs = Clock.currentTimeMillis;
    const nowIso = nowMs.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    const windows = process.platform === "win32";
    /** Expiry timers of saved `commands` files, by request. */
    const timers = new Map<string, Fiber.Fiber<void, never>>();

    const findRequest = (threadId: ThreadId, requestId: SecretRequestId) =>
      reads.thread(threadId).pipe(
        Effect.map((thread) =>
          thread === undefined || thread.deletedAt !== null
            ? { thread: undefined, request: undefined }
            : {
                thread,
                request: (thread.secretRequests ?? []).find(
                  (request) => request.requestId === requestId,
                ),
              },
        ),
      );

    /** Records how it ended; false when the thread didn't take it. */
    const settle = (
      threadId: ThreadId,
      request: OrchestrationSecretRequest,
      fields: {
        readonly ending: "saved" | "failed" | "uncertain" | "declined";
        readonly claim: SecretRequestClaim;
        readonly detail?: string;
        readonly savedAt?: string;
        readonly expiresAt?: string;
        readonly message?: string;
      },
    ) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.secret-request.settle",
          commandId: commandId(request.requestId, `settle:${fields.claim.claimId}`),
          threadId,
          requestId: request.requestId,
          ending: fields.ending,
          claim: fields.claim,
          ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
          ...(fields.savedAt !== undefined ? { savedAt: fields.savedAt } : {}),
          ...(fields.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
          ...(fields.message !== undefined
            ? {
                message: {
                  messageId: secretAnswerMessageId(request.requestId),
                  text: fields.message,
                },
              }
            : {}),
          createdAt: yield* nowIso,
        });
        if (Option.isSome(analytics)) {
          yield* analytics.value.record("secret_request.settled", {
            outcome: fields.ending,
            destinationKind: request.use.kind,
          });
        }
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("secret request settle was not recorded", {
            threadId,
            requestId: request.requestId,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

    /** Marks a saved `commands` key's file removed, once it is gone; false when that wasn't recorded. */
    const recordRemoved = (threadId: ThreadId, requestId: SecretRequestId) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.secret-request.remove",
          commandId: commandId(requestId, "remove"),
          threadId,
          requestId,
          createdAt: yield* nowIso,
        });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("secret request removal was not recorded", {
            threadId,
            requestId,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

    /**
     * Removes a `commands` key's file, under the lock, and records it only
     * once the file is gone: a row never says removed while the key is readable.
     */
    const removeNow = (threadId: ThreadId, requestId: SecretRequestId) =>
      Effect.gen(function* () {
        if (!(yield* destinations.removeCommandsFile(threadId, requestId))) return false;
        watched.gone(requestId);
        return yield* recordRemoved(threadId, requestId);
      });

    /** Removes it now, or keeps trying every minute until it can. */
    const removeOrRetry = (threadId: ThreadId, requestId: SecretRequestId) =>
      Effect.gen(function* () {
        const live = (yield* findRequest(threadId, requestId)).request;
        const removed =
          live !== undefined && isLiveCommandsSecret(live)
            ? yield* removeNow(threadId, requestId)
            : yield* destinations.removeCommandsFile(threadId, requestId);
        if (!removed) {
          yield* scheduleExpiry(
            threadId,
            requestId,
            new Date((yield* nowMs) + EXPIRY_RETRY_MS).toISOString(),
          );
        }
      });

    /** Removes the file at its expiry, trying again shortly if it can't; the sweep is the backstop. */
    const scheduleExpiry = (
      threadId: ThreadId,
      requestId: SecretRequestId,
      expiresAt: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = timers.get(requestId);
        if (existing !== undefined) yield* Fiber.interrupt(existing);
        const wait = Math.max(0, Date.parse(expiresAt) - (yield* nowMs));
        const fiber = yield* Effect.sleep(Duration.millis(wait)).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              timers.delete(requestId);
              const { request } = yield* findRequest(threadId, requestId);
              const removed =
                request !== undefined && isLiveCommandsSecret(request)
                  ? yield* removeNow(threadId, requestId)
                  : yield* destinations.removeCommandsFile(threadId, requestId);
              if (!removed) {
                const retryAt = new Date((yield* nowMs) + EXPIRY_RETRY_MS).toISOString();
                yield* scheduleExpiry(threadId, requestId, retryAt);
              }
            }).pipe(lock.withPermits(1)),
          ),
          Effect.forkIn(scope),
        );
        timers.set(requestId, fiber);
      });

    /**
     * Settles a claim whose save didn't finish (the server stopped, or the
     * run died) without its value: the env file may or may not hold it, a
     * `commands` file is removed. Never writes again, so a later answer can't
     * replace a value that did land.
     */
    const settleInterrupted = (threadId: ThreadId, request: OrchestrationSecretRequest) =>
      Effect.gen(function* () {
        if (request.claim === undefined) return { outcome: "gone" as const };
        if (request.use.kind === "commands") {
          yield* settle(threadId, request, {
            ending: "failed",
            claim: request.claim,
            detail: RECOVERY_COMMANDS,
          });
          yield* removeOrRetry(threadId, request.requestId);
          return { outcome: "failed" as const, detail: RECOVERY_COMMANDS };
        }
        yield* destinations.removeEnvTemp(request);
        const detail = recoveryEnvFile(request);
        yield* settle(threadId, request, { ending: "uncertain", claim: request.claim, detail });
        return { outcome: "uncertain" as const, detail };
      });

    /** The message for a saved key, from the request and where it went. */
    const savedMessage = (
      threadId: ThreadId,
      request: OrchestrationSecretRequest,
      expiresAt: string,
    ) =>
      request.use.kind === "env_file"
        ? savedEnvFileMessage(request.name, request.use.path)
        : savedCommandsMessage({
            name: request.name,
            filePath: destinations.commandsFilePath(threadId, request.requestId),
            expiresAt,
            multiline: request.use.multiline === true,
            windows,
          });

    /** Save, for a request this answer holds the claim on. The value is unwrapped only here. */
    const save = (
      thread: OrchestrationThread,
      request: OrchestrationSecretRequest,
      claim: SecretRequestClaim,
      written: string,
    ) =>
      Effect.gen(function* () {
        const threadId = thread.id;
        const fail = (detail: string) =>
          settle(threadId, request, {
            ending: "failed",
            claim,
            detail,
            message: failedSecretMessage(request.name, detail),
          }).pipe(Effect.as({ outcome: "failed" as const, detail }));

        // The thread as it is now, after the claim: put away since the card
        // showed, nothing is written.
        const now = yield* reads.thread(threadId);
        if (now === undefined || isPutAway(now)) {
          yield* settle(threadId, request, { ending: "failed", claim, detail: PUT_AWAY });
          return { outcome: "failed" as const, detail: PUT_AWAY };
        }
        const wrote: Result.Result<void, string> =
          request.use.kind === "env_file"
            ? yield* Effect.gen(function* () {
                // Its folder now: a checkout switch since the agent asked
                // fails the bound-folder check.
                const folder = yield* reads.threadFolder(now);
                if (folder === undefined) {
                  return Result.fail("This thread's folder isn't on this computer anymore.");
                }
                return yield* destinations
                  .writeEnvFile({ request, threadFolder: folder, written })
                  .pipe(
                    Effect.map(() => Result.succeed(undefined)),
                    Effect.catch((error) => Effect.succeed(Result.fail(error.detail))),
                  );
              })
            : yield* Effect.gen(function* () {
                const unavailable = yield* destinations.commandsUnavailable;
                if (unavailable !== null) return Result.fail(unavailable);
                return yield* destinations
                  .writeCommandsFile({ threadId, requestId: request.requestId, written })
                  .pipe(
                    Effect.map(() => Result.succeed(undefined)),
                    Effect.catch((error) => Effect.succeed(Result.fail(error.detail))),
                  );
              });
        if (Result.isFailure(wrote)) return yield* fail(wrote.failure);

        // Archived, deleted or started moving during the write: what was
        // written for commands goes, and it did not save. An env line already
        // landed, so it settles saved; the agent hears it at its next turn.
        const after = yield* reads.thread(threadId);
        if (isPutAway(after) && request.use.kind === "commands") {
          yield* settle(threadId, request, { ending: "failed", claim, detail: PUT_AWAY });
          yield* removeOrRetry(threadId, request.requestId);
          return { outcome: "failed" as const, detail: PUT_AWAY };
        }
        const savedAtMs = yield* nowMs;
        const savedAt = new Date(savedAtMs).toISOString();
        const expiresAt =
          request.use.kind === "commands"
            ? new Date(savedAtMs + COMMANDS_SECRET_TTL_MS).toISOString()
            : undefined;
        const settled = yield* settle(threadId, request, {
          ending: "saved",
          claim,
          savedAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          message: savedMessage(threadId, request, expiresAt ?? savedAt),
        });
        if (!settled) {
          // The value landed but the thread didn't take the answer: say what
          // is known, the way startup recovery would.
          return yield* settleInterrupted(threadId, request);
        }
        if (request.use.kind === "commands" && expiresAt !== undefined) {
          // Nobody is left to use it: the agent that asked has left the room,
          // judged after the settle, as the decider judged it.
          const settledThread = yield* reads.thread(threadId);
          const asker = request.participantId;
          const present =
            asker === null ||
            (settledThread !== undefined &&
              activeParticipants(settledThread).some((entry) => entry.id === asker));
          if (present) {
            yield* scheduleExpiry(threadId, request.requestId, expiresAt);
          } else {
            yield* removeOrRetry(threadId, request.requestId);
          }
        }
        return { outcome: "saved" as const };
      });

    const answer = (input: SecretRequestRespondInput): Effect.Effect<SecretRequestAnswer> =>
      Effect.gen(function* () {
        const claim: SecretRequestClaim = {
          claimId: input.claimId,
          deviceLabel: input.deviceLabel,
        };
        const { thread, request } = yield* findRequest(input.threadId, input.requestId);
        if (thread === undefined || request === undefined) {
          return { outcome: "gone", detail: "That request is gone." };
        }
        // This app's own claim, left unfinished (the run died in the middle):
        // it settles without writing again, as startup recovery would.
        if (request.status === "claimed" && request.claim?.claimId === input.claimId) {
          return yield* settleInterrupted(input.threadId, request);
        }
        if (request.status !== "waiting") return answerFor(request, input.claimId);

        if (input.answer.type === "decline") {
          if (yield* settle(input.threadId, request, { ending: "declined", claim })) {
            return { outcome: "declined" };
          }
          const after = yield* findRequest(input.threadId, input.requestId);
          return after.request === undefined
            ? { outcome: "gone" }
            : answerFor(after.request, input.claimId);
        }

        const typed = Redacted.value(input.answer.value);
        const checked = checkSecretValue(request.use, typed);
        if (!checked.ok) return { outcome: "rejected", detail: checked.detail };
        // Watched from before the file exists, as typed (not the env file's
        // quoted spelling), and still after a failed write: the file can
        // outlive it.
        watched.watch(request.name, typed, request.requestId);
        // A commands key lands with its line endings normalized: watch that too.
        if (checked.written !== typed && request.use.kind === "commands") {
          watched.watch(request.name, checked.written, request.requestId);
        }

        // Only the committed claim authorizes a write: a request replaced
        // or cancelled since the read fails it, and nothing is written.
        const claimed = yield* engine
          .dispatch({
            type: "thread.secret-request.claim",
            commandId: commandId(request.requestId, `claim:${input.claimId}`),
            threadId: input.threadId,
            requestId: request.requestId,
            claim,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.result);
        if (Result.isFailure(claimed)) {
          const after = yield* findRequest(input.threadId, input.requestId);
          return after.request === undefined
            ? { outcome: "gone" }
            : answerFor(after.request, input.claimId);
        }
        return yield* save(
          thread,
          { ...request, status: "claimed", claim },
          claim,
          checked.written,
        );
      });

    // Recovery first; then one answer at a time, each run to its end in the
    // service's own scope, so an app that disconnects mid-save leaves nothing half done.
    const respond: AgentSecretRequestsShape["respond"] = (input) =>
      Effect.andThen(
        Deferred.await(recovered),
        answer(input).pipe(lock.withPermits(1), Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
      );

    const remove: AgentSecretRequestsShape["remove"] = (input) =>
      Effect.andThen(
        Deferred.await(recovered),
        Effect.gen(function* () {
          const { request } = yield* findRequest(input.threadId, input.requestId);
          if (request === undefined || !isLiveCommandsSecret(request)) {
            return yield* new SecretRequestError({ detail: "That key's file is already gone." });
          }
          if (!(yield* removeNow(input.threadId, request.requestId))) {
            return yield* new SecretRequestError({
              detail: "The file couldn't be removed. Try again in a moment.",
            });
          }
          const timer = timers.get(request.requestId);
          if (timer !== undefined) yield* Fiber.interrupt(timer);
          timers.delete(request.requestId);
        }).pipe(lock.withPermits(1), Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
      );

    /** Archive, delete and the start of a move take the thread's `commands` keys with them. */
    const cleanUpThread = (threadId: ThreadId, recordRemovals: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const removed = yield* destinations.removeThreadFolder(threadId);
        const thread = yield* reads.thread(threadId);
        for (const request of thread?.secretRequests ?? []) {
          if (!isLiveCommandsSecret(request)) continue;
          if (!removed) {
            // Not gone (a file held open on Windows): each key tries again in a minute.
            yield* scheduleExpiry(
              threadId,
              request.requestId,
              new Date((yield* nowMs) + EXPIRY_RETRY_MS).toISOString(),
            );
            continue;
          }
          const timer = timers.get(request.requestId);
          if (timer !== undefined) yield* Fiber.interrupt(timer);
          timers.delete(request.requestId);
          watched.gone(request.requestId);
          if (recordRemovals) yield* recordRemoved(threadId, request.requestId);
        }
        // A deleted thread has no requests left to retry from: try the folder again.
        if (!removed && (thread === undefined || thread.deletedAt !== null)) {
          yield* Effect.sleep(Duration.millis(EXPIRY_RETRY_MS)).pipe(
            Effect.andThen(cleanUpThread(threadId, false)),
            Effect.forkIn(scope),
          );
        }
      }).pipe(lock.withPermits(1));

    yield* Stream.runForEach(engine.streamDomainEvents, (event) => {
      switch (event.type) {
        case "thread.archived":
        case "thread.move-started":
          return cleanUpThread(event.payload.threadId, true);
        case "thread.deleted":
          return cleanUpThread(event.payload.threadId, false);
        default:
          return Effect.void;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("secret request cleanup stopped", { cause })),
      Effect.forkScoped,
    );

    // Claims a previous run stopped in the middle of are settled before any
    // answer is taken; saved `commands` files get their expiry timers back.
    // A thread archived, moved or deleted while the server was down (or
    // before its cleanup ran) loses its `commands` keys here, not a day later.
    yield* Effect.gen(function* () {
      const now = yield* nowMs;
      const all = yield* reads.all;
      const keep = new Set<ThreadId>();
      for (const { threadId, secretRequests } of all) {
        // A thread whose read failed is kept as it is: never removed blind.
        const thread = yield* reads.thread(threadId);
        const putAway = thread !== undefined && isPutAway(thread);
        for (const request of secretRequests) {
          if (request.status === "claimed" && request.claim !== undefined) {
            yield* settleInterrupted(threadId, request);
            continue;
          }
          if (!isLiveCommandsSecret(request)) continue;
          const expiresAt = request.expiresAt ?? new Date(now).toISOString();
          if (putAway || Date.parse(expiresAt) <= now) {
            yield* removeOrRetry(threadId, request.requestId);
          } else {
            keep.add(threadId);
            yield* scheduleExpiry(threadId, request.requestId, expiresAt);
          }
        }
      }
      yield* destinations.removeThreadFoldersExcept(keep);
    }).pipe(
      lock.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("secret request recovery failed", { cause })),
      Effect.ensuring(Deferred.succeed(recovered, undefined)),
      Effect.forkScoped,
    );

    // The backstop for orphaned files, by their own time.
    yield* Effect.gen(function* () {
      yield* destinations.sweep(yield* nowMs);
    }).pipe(
      lock.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("secret request sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      Effect.delay(SWEEP_EVERY),
      Effect.forkScoped,
    );

    return {
      respond,
      remove,
      destinations,
      threadFolder: reads.threadFolder,
    } satisfies AgentSecretRequestsShape;
  });

/** Reads requests from the thread projections; runs git through the process runner. */
export const layer = Layer.effect(
  AgentSecretRequests,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    const processes = yield* ProcessRunner;
    const scrubber = yield* SecretScrubber;
    const destinations = makeSecretDestinations({
      agentSecretsDir: config.agentSecretsDir,
      runGit: (cwd, args) =>
        processes
          .run({
            command: "git",
            args: ["-C", cwd, ...args],
            timeout: "10 seconds",
            maxOutputBytes: 64 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((output) =>
              output.timedOut
                ? null
                : { code: output.code ?? null, stdout: output.stdout, stderr: output.stderr },
            ),
            Effect.orElseSucceed(() => null),
          ),
    });
    const thread = (threadId: ThreadId) =>
      snapshots.getThreadDetailById(threadId, { includeArchived: true }).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
    return yield* make(
      {
        thread,
        // Where the agent works: the folder it entered, its worktree, or
        // its project's root. Relative env paths are from there.
        threadFolder: (entry) => {
          const own = entry.effectiveCwd ?? entry.worktreePath ?? null;
          return own !== null
            ? Effect.succeed(own)
            : snapshots.getProjectShellById(entry.projectId).pipe(
                Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
                Effect.orElseSucceed(() => undefined),
              );
        },
        all: snapshots.listSecretRequests(),
      },
      destinations,
      scrubber,
    );
  }),
);
