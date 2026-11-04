/**
 * Answers to agents' settings changes (docs/design/agent-settings-changes.md).
 * Not now ends a waiting card. Change claims it for the app that pressed it,
 * makes this computer's changes in one checked write, and settles by what the
 * write actually did; that app makes the device changes once its claim has
 * won, and reports them here. One answer at a time on this computer, and a
 * claim the server stopped in the middle of is settled at startup from what
 * the settings hold.
 */
import {
  CommandId,
  type OrchestrationSettingsChangeRequest,
  type ServerProvider,
  type ServerSettings,
  type SettingsChangeAnswer,
  SettingsChangeError,
  type SettingsChangeReportDeviceInput,
  type SettingsChangeRequestId,
  type SettingsChangeRespondInput,
  type ThreadId,
} from "@threadlines/contracts";
import { type PlaceId, placePathLabel } from "@threadlines/shared/appPlaces";
import {
  type CheckedEdit,
  checkEdits,
  composeServerPatch,
  describeEditValue,
} from "@threadlines/shared/settingsEdits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { modelChangesProblem } from "./modelChoices.ts";

export interface AgentSettingsChangesShape {
  /** Not now, or Change for the app holding `claim`. */
  readonly respond: (
    input: SettingsChangeRespondInput,
  ) => Effect.Effect<SettingsChangeAnswer, SettingsChangeError>;
  /** What the claiming app's device changes did, for the agent's note. */
  readonly reportDevice: (
    input: SettingsChangeReportDeviceInput,
  ) => Effect.Effect<void, SettingsChangeError>;
}

export class AgentSettingsChanges extends Context.Service<
  AgentSettingsChanges,
  AgentSettingsChangesShape
>()("threadlines/settingsChanges/AgentSettingsChanges") {}

/** How the service finds requests: the live thread's, and every claimed one at startup. */
export interface AgentSettingsChangesReads {
  readonly request: (
    threadId: ThreadId,
    requestId: SettingsChangeRequestId,
  ) => Effect.Effect<OrchestrationSettingsChangeRequest | undefined>;
  readonly claimed: Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly request: OrchestrationSettingsChangeRequest;
    }>
  >;
  /** This computer's providers now: a model may have become unavailable or per use since asked. */
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
}

/** A computer setting that moved since the agent asked. */
interface Stale {
  readonly _tag: "Stale";
  readonly place: PlaceId;
  readonly now: CheckedEdit["value"];
}

/** A model the computer can't take anymore, said for the agent. */
interface ModelRefused {
  readonly _tag: "ModelRefused";
  readonly detail: string;
}

const commandId = (requestId: SettingsChangeRequestId, step: string) =>
  CommandId.make(`server:settings-change:${requestId}:${step}`);

/** What a request that has moved on means for someone answering it now. */
export function answerFor(
  request: OrchestrationSettingsChangeRequest,
  claimId: string | undefined,
): SettingsChangeAnswer {
  const mine = claimId !== undefined && request.claim?.claimId === claimId;
  const detail = request.detail !== undefined ? { detail: request.detail } : {};
  switch (request.status) {
    case "changed":
    case "failed":
    case "uncertain":
      return mine
        ? { outcome: request.status, ...detail, makeDeviceChanges: true }
        : {
            outcome: "already_answered",
            detail: `It was already answered on ${request.claim?.deviceLabel ?? "another device"}.`,
            makeDeviceChanges: false,
          };
    case "claimed":
      return {
        outcome: "already_answered",
        detail: `It's being changed from ${request.claim?.deviceLabel ?? "another device"}.`,
        makeDeviceChanges: false,
      };
    case "declined":
      return {
        outcome: claimId === undefined ? "declined" : "already_answered",
        detail: "It was already answered with Not now.",
        makeDeviceChanges: false,
      };
    case "cancelled":
      return { outcome: "cancelled", ...detail, makeDeviceChanges: false };
    case "replaced":
      return {
        outcome: "gone",
        detail: "The agent asked again, and its new card replaced this one.",
        makeDeviceChanges: false,
      };
    case "waiting":
      return { outcome: "gone", detail: "It's still waiting.", makeDeviceChanges: false };
  }
}

/** The request's changes, checked as this build sees them. */
const checkedEditsOf = (request: OrchestrationSettingsChangeRequest) =>
  checkEdits(request.changes.map((change) => ({ place: change.place, value: change.value })));

/** The computer's changes that are not as asked now, said as the row shows them. */
function notAsAsked(edits: ReadonlyArray<CheckedEdit>, stored: ServerSettings) {
  return edits.flatMap((edit) => {
    if (edit.edit.lands !== "computer") return [];
    const now = edit.edit.read(stored);
    return now === edit.value
      ? []
      : [
          `${placePathLabel(edit.place)} is ${describeEditValue(edit.place, now)} (asked: ${describeEditValue(edit.place, edit.value)})`,
        ];
  });
}

export const make = (reads: AgentSettingsChangesReads) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const settings = yield* ServerSettingsService;
    const answers = yield* Semaphore.make(1);
    // Answers run here, not in the caller's request: an app that disconnects
    // after its claim landed must not leave the change half made.
    const scope = yield* Effect.scope;
    const recovered = yield* Deferred.make<void>();
    const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));

    /** Records how it ended; false when the thread no longer takes it (deleted). */
    const settle = (
      threadId: ThreadId,
      request: OrchestrationSettingsChangeRequest,
      ending: "changed" | "declined" | "failed" | "uncertain",
      detail?: string,
    ) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.settings-change.settle",
          commandId: commandId(request.requestId, "settle"),
          threadId,
          requestId: request.requestId,
          ending,
          ...(request.claim !== undefined ? { claimId: request.claim.claimId } : {}),
          ...(detail !== undefined ? { detail } : {}),
          createdAt: yield* nowIso,
        });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("settings change settle was not recorded", {
            threadId,
            requestId: request.requestId,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

    /**
     * Settles a claimed request from what this computer's settings hold now:
     * for a claim the server stopped in the middle of. Worded as the state
     * now, since the values can't say what this answer did.
     */
    const settleFromStored = (threadId: ThreadId, request: OrchestrationSettingsChangeRequest) =>
      Effect.gen(function* () {
        const checked = checkedEditsOf(request);
        const stored = yield* settings.readStored.pipe(Effect.option);
        if ("refused" in checked || stored._tag === "None") {
          const detail = "Threadlines couldn't check this computer's settings after it restarted.";
          yield* settle(threadId, request, "uncertain", detail);
          return { outcome: "uncertain" as const, detail, makeDeviceChanges: true };
        }
        const computer = checked.edits.filter((edit) => edit.edit.lands === "computer");
        const off = notAsAsked(computer, stored.value);
        if (off.length === 0) {
          yield* settle(threadId, request, "changed");
          return { outcome: "changed" as const, makeDeviceChanges: true };
        }
        const ending: "failed" | "uncertain" =
          off.length === computer.length ? "failed" : "uncertain";
        const detail = `Threadlines stopped while making the change. Now: ${off.join("; ")}.`;
        yield* settle(threadId, request, ending, detail);
        return { outcome: ending, detail, makeDeviceChanges: true };
      });

    /** Change, for a request this answer has just claimed. */
    const makeChange = (threadId: ThreadId, request: OrchestrationSettingsChangeRequest) =>
      Effect.gen(function* () {
        const checked = checkedEditsOf(request);
        if ("refused" in checked) {
          const detail = `This computer's Threadlines can't make it: ${checked.refused.detail}`;
          yield* settle(threadId, request, "failed", detail);
          return { outcome: "failed" as const, detail, makeDeviceChanges: true };
        }
        const computer = checked.edits.filter((edit) => edit.edit.lands === "computer");
        if (computer.length === 0) {
          yield* settle(threadId, request, "changed");
          return { outcome: "changed" as const, makeDeviceChanges: true };
        }
        const asked = new Map(request.changes.map((change) => [change.place, change.from]));
        const providers = computer.some(({ edit }) => edit.control.kind === "model")
          ? yield* reads.providers
          : null;
        const written = yield* settings
          .updateSettingsChecked((current) => {
            for (const edit of computer) {
              if (edit.edit.lands !== "computer") continue;
              const now = edit.edit.read(current);
              const from = asked.get(edit.place);
              if (from !== undefined && now !== from) {
                return Effect.fail<Stale | ModelRefused>({
                  _tag: "Stale",
                  place: edit.place,
                  now,
                });
              }
            }
            const problem =
              providers === null ? null : modelChangesProblem(computer, current, providers);
            return problem !== null
              ? Effect.fail<Stale | ModelRefused>({ _tag: "ModelRefused", detail: problem })
              : Effect.succeed(composeServerPatch(computer));
          })
          .pipe(Effect.result);
        if (Result.isSuccess(written) || written.failure.written) {
          if (Result.isFailure(written)) {
            yield* Effect.logWarning("settings were written, then a later step failed", {
              cause: written.failure.cause,
            });
          }
          yield* settle(threadId, request, "changed");
          return { outcome: "changed" as const, makeDeviceChanges: true };
        }
        const cause = written.failure.cause;
        const detail =
          "_tag" in cause && cause._tag === "Stale"
            ? `${placePathLabel(cause.place)} was changed to ${describeEditValue(cause.place, cause.now)} since the agent asked, so nothing on this computer changed.`
            : "_tag" in cause && cause._tag === "ModelRefused"
              ? `Nothing on this computer changed. ${cause.detail}`
              : `This computer's settings couldn't be saved: ${cause.message}`;
        yield* settle(threadId, request, "failed", detail);
        return { outcome: "failed" as const, detail, makeDeviceChanges: true };
      });

    const answer = (input: SettingsChangeRespondInput) =>
      Effect.gen(function* () {
        const request = yield* reads.request(input.threadId, input.requestId);
        if (request === undefined) {
          return {
            outcome: "gone" as const,
            detail: "That request is gone.",
            makeDeviceChanges: false,
          };
        }
        if (!input.allow) {
          if (request.status !== "waiting") return answerFor(request, undefined);
          if (yield* settle(input.threadId, request, "declined")) {
            return { outcome: "declined" as const, makeDeviceChanges: false };
          }
          const after = yield* reads.request(input.threadId, input.requestId);
          return after === undefined
            ? { outcome: "gone" as const, makeDeviceChanges: false }
            : answerFor(after, undefined);
        }
        const claim = input.claim;
        if (claim === undefined) {
          return yield* new SettingsChangeError({ detail: "Change needs the app's claim." });
        }
        if (request.status !== "waiting") {
          // This app's own claim, left unfinished in this run: settle it now.
          return request.status === "claimed" && request.claim?.claimId === claim.claimId
            ? yield* settleFromStored(input.threadId, request)
            : answerFor(request, claim.claimId);
        }
        const claimed = yield* engine
          .dispatch({
            type: "thread.settings-change.claim",
            commandId: commandId(request.requestId, `claim:${claim.claimId}`),
            threadId: input.threadId,
            requestId: request.requestId,
            claim,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.result);
        if (Result.isFailure(claimed)) {
          const after = yield* reads.request(input.threadId, input.requestId);
          return after === undefined
            ? { outcome: "gone" as const, makeDeviceChanges: false }
            : answerFor(after, claim.claimId);
        }
        return yield* makeChange(input.threadId, { ...request, status: "claimed", claim });
      });

    // Recovery first, outside the lock it takes itself; then one answer at a
    // time, each run to its end in the service's own scope.
    const respond: AgentSettingsChangesShape["respond"] = (input) =>
      Effect.andThen(
        Deferred.await(recovered),
        answer(input).pipe(
          answers.withPermits(1),
          Effect.forkIn(scope),
          Effect.flatMap(Fiber.join),
        ),
      );

    const reportDevice: AgentSettingsChangesShape["reportDevice"] = (input) =>
      Effect.gen(function* () {
        const request = yield* reads.request(input.threadId, input.requestId);
        if (request === undefined || request.claim?.claimId !== input.claimId) {
          return yield* new SettingsChangeError({ detail: "That change isn't this app's." });
        }
        if (request.device !== undefined) return;
        yield* engine
          .dispatch({
            type: "thread.settings-change.report-device",
            commandId: commandId(request.requestId, "device"),
            threadId: input.threadId,
            requestId: request.requestId,
            claimId: input.claimId,
            device: input.device,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError((error) => new SettingsChangeError({ detail: error.message })));
      });

    // Claims a previous run stopped in the middle of are settled before any
    // answer is taken.
    yield* Effect.gen(function* () {
      for (const { threadId, request } of yield* reads.claimed) {
        yield* settleFromStored(threadId, request);
      }
    }).pipe(
      answers.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("settings change recovery failed", { cause })),
      Effect.ensuring(Deferred.succeed(recovered, undefined)),
      Effect.forkScoped,
    );

    return { respond, reportDevice } satisfies AgentSettingsChangesShape;
  });

/** Reads requests from the thread projections. */
export const layer = Layer.effect(
  AgentSettingsChanges,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const registry = yield* ProviderRegistry;
    return yield* make({
      providers: registry.getProviders,
      request: (threadId, requestId) =>
        snapshots.getThreadDetailById(threadId).pipe(
          Effect.map((thread) =>
            Option.isSome(thread) && thread.value.deletedAt === null
              ? thread.value.settingsRequests?.find((request) => request.requestId === requestId)
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      claimed: snapshots
        .listClaimedSettingsChanges()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't list settings changes left claimed", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        ),
    });
  }),
);
