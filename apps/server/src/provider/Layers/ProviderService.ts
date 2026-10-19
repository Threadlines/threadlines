/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderExternalThreadListInput,
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeListVoicesInput,
  ProviderRealtimeStartInput,
  ProviderRealtimeStopInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStartReviewInput,
  ProviderSubagentInputRequest,
  ProviderCommandOutputInput,
  ProviderSubagentTranscriptInput,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
  ThreadGoalStatus,
  TrimmedNonEmptyString,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { parseSessionKey, sessionKeyThreadId } from "@threadlines/shared/threadParticipants";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeTurnLatencyTracker, type TurnLatencySample } from "../turnLatency.ts";
import { type EarlySessionEndReason, makeEarlySessionLedger } from "../earlySessions.ts";

/** An early start that takes longer than this is given up. */
const EARLY_SESSION_START_TIMEOUT = Duration.seconds(60);
/** How often unused early sessions are checked for expiry. */
const EARLY_SESSION_SWEEP_INTERVAL = Duration.seconds(30);
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  analyticsAgentProperties,
  analyticsModelProperties,
  classifyModelRerouteReason,
  classifyProviderSessionStart,
  classifyProviderFailure,
} from "../../telemetry/AnalyticsProperties.ts";

const isProviderValidationError = Schema.is(ProviderValidationError);
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
  targetUserMessageId: Schema.optional(MessageId),
});
const ProviderCompactContextInput = Schema.Struct({
  threadId: ThreadId,
});
const ProviderDeleteThreadInput = Schema.Struct({
  threadId: ThreadId,
});
const ProviderSetThreadGoalServiceInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(ThreadGoalStatus),
  tokenBudget: Schema.optional(Schema.NullOr(NonNegativeInt)),
  modelSelection: Schema.optional(ModelSelection),
});
const ProviderClearThreadGoalServiceInput = Schema.Struct({
  threadId: ThreadId,
});

function readCodexResumeThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const threadId = (value as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function isMissingProviderBindingForReview(error: unknown): error is ProviderValidationError {
  return (
    isProviderValidationError(error) &&
    error.operation === "ProviderService.startReview" &&
    error.issue.includes("no persisted provider binding exists")
  );
}

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly earlyUnused?: boolean;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    // Kept so a recovered runtime gets the room tools it was started with.
    ...(session.roomTools !== undefined ? { roomTools: session.roomTools } : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.earlyUnused !== undefined ? { earlyUnused: extra.earlyUnused } : {}),
  };
}

/**
 * A fresh session started early whose conversation nothing has used: its
 * resume cursor points at a conversation the provider may never have
 * written, so the next start begins fresh instead of resuming it.
 */
function readPersistedEarlyUnused(runtimePayload: ProviderRuntimeBinding["runtimePayload"]) {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "earlyUnused" in runtimePayload &&
    runtimePayload.earlyUnused === true
  );
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

/**
 * Whether the runtime was asked for the room tools. Reported either way
 * (ProviderSession.roomTools is true or false once asked), so a recovered
 * runtime is asked again and answers again, even one that could not take them.
 */
function readPersistedRoomToolsRequest(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): boolean {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "roomTools" in runtimePayload &&
    typeof runtimePayload.roomTools === "boolean"
  );
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

/**
 * Consumers see the thread an event belongs to. A room agent runs under a
 * derived session key (see `threadParticipants`); it is mapped back here, the
 * one place events leave the provider layer, and the agent is kept on the
 * event. A side answer's runtime also stamps its side answer, so every
 * consumer can tell it from the agent's working session by the event alone.
 * Logs and the session directory above still use the key.
 */
const toThreadRuntimeEvent = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => {
  const target = parseSessionKey(event.threadId);
  if (target.kind === "side") {
    return {
      ...event,
      threadId: target.threadId,
      ...(target.participantId !== null ? { participantId: target.participantId } : {}),
      sideTurnId: target.sideTurnId,
    };
  }
  if (target.participantId === null) {
    return event;
  }
  return { ...event, threadId: target.threadId, participantId: target.participantId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const turnLatency = makeTurnLatencyTracker();
  const earlySessions = makeEarlySessionLedger<ProviderRuntimeEvent>();
  /**
   * An early session that is starting, or being stopped unused, holds its
   * key's gate. An ordinary start or a use of that key waits for it, so none
   * of them races the runtime being started or stopped.
   */
  const earlyGates = new Map<string, Deferred.Deferred<void>>();
  /**
   * Each early start still running: its fiber, and the clean-up that ends
   * it (once, whoever runs it first: the start itself, or whoever stops it).
   */
  const earlyStartRuns = new Map<
    string,
    { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly settle: Effect.Effect<void> }
  >();
  /** Interrupts the key's running early start and waits for its clean-up. */
  const endEarlyStartRun = (threadId: string) => {
    const run = earlyStartRuns.get(threadId);
    return run === undefined
      ? Effect.void
      : Fiber.interrupt(run.fiber).pipe(Effect.andThen(run.settle));
  };
  /** Early sessions that finished starting, kept for whoever adopts them. */
  const earlyStartedSessions = new Map<string, ProviderSession>();
  const awaitEarlyGate = (threadId: string): Effect.Effect<void> => {
    const gate = earlyGates.get(threadId);
    return gate === undefined ? Effect.void : Deferred.await(gate);
  };
  const releaseEarlyGate = (threadId: string, gate: Deferred.Deferred<void>) =>
    Effect.sync(() => {
      if (earlyGates.get(threadId) === gate) earlyGates.delete(threadId);
    }).pipe(Effect.andThen(Deferred.succeed(gate, undefined)), Effect.asVoid);
  /**
   * Runs `effect` holding the key's gate, once whatever holds it lets go: an
   * ordinary start, a recovery, or the stop of an unused early session. An
   * early start meanwhile is turned away; a use or a stop waits.
   */
  const withEarlyGate = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        while (earlyGates.has(threadId)) {
          yield* restore(awaitEarlyGate(threadId));
        }
        earlyGates.set(threadId, gate);
        return yield* restore(effect).pipe(Effect.ensuring(releaseEarlyGate(threadId, gate)));
      }),
    );
  // Early starts run in the service's scope: the caller only reserves.
  const serviceScope = yield* Effect.scope;

  const runtimeEventModel = (event: ProviderRuntimeEvent) =>
    directory.getBinding(event.threadId).pipe(
      Effect.map(
        (binding) =>
          readPersistedModelSelection(Option.getOrUndefined(binding)?.runtimePayload)?.model,
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );

  /** The community agent an instance runs, for analytics; undefined for every other instance. */
  const communityAgentIdOf = (instanceId: ProviderInstanceId | undefined) =>
    instanceId === undefined
      ? Effect.succeed(undefined)
      : registry.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => info.communityAgentId),
          Effect.catch(() => Effect.succeed(undefined)),
        );

  const recordTurnLatency = (latency: TurnLatencySample | undefined) =>
    latency === undefined
      ? Effect.void
      : analytics.record("provider.turn.first_output", {
          ...analyticsAgentProperties(latency),
          ...analyticsModelProperties({ model: latency.model, provider: latency.provider }),
          attachmentCount: latency.attachmentCount,
          sessionStarted: latency.sessionStarted,
          sessionStartedEarly: latency.sessionStartedEarly,
          handoffMs: latency.handoffMs,
          firstOutputMs: latency.firstOutputMs,
        });

  const recordRuntimeEventAnalytics = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* recordTurnLatency(turnLatency.observe(event, yield* Clock.currentTimeMillis));
      switch (event.type) {
        case "model.rerouted": {
          const reason = classifyModelRerouteReason(event.payload.reason);
          yield* analytics.record("provider.model.rerouted", {
            ...analyticsAgentProperties({
              provider: event.provider,
              communityAgentId: yield* communityAgentIdOf(event.providerInstanceId),
            }),
            ...analyticsModelProperties({
              model: event.payload.fromModel,
              provider: event.provider,
              prefix: "from",
            }),
            ...analyticsModelProperties({
              model: event.payload.toModel,
              provider: event.provider,
              prefix: "to",
            }),
            reasonCategory: reason.reasonCategory,
            isFallback: reason.isFallback,
          });
          return;
        }
        case "turn.completed": {
          if (event.payload.state !== "failed") return;
          const selectedModel = yield* runtimeEventModel(event);
          yield* analytics.record("provider.turn.failed", {
            ...analyticsAgentProperties({
              provider: event.provider,
              communityAgentId: yield* communityAgentIdOf(event.providerInstanceId),
            }),
            ...analyticsModelProperties({
              model: selectedModel,
              provider: event.provider,
            }),
            failureCategory: classifyProviderFailure({
              category: event.payload.failureCategory,
              message: event.payload.errorMessage,
              reason: event.payload.stopReason ?? undefined,
            }),
            hasTurnId: event.turnId !== undefined,
          });
          return;
        }
        case "runtime.error": {
          const selectedModel = yield* runtimeEventModel(event);
          yield* analytics.record("provider.runtime.error", {
            ...analyticsAgentProperties({
              provider: event.provider,
              communityAgentId: yield* communityAgentIdOf(event.providerInstanceId),
            }),
            ...analyticsModelProperties({
              model: selectedModel,
              provider: event.provider,
            }),
            failureCategory: classifyProviderFailure({
              category: event.payload.failureCategory,
              errorClass: event.payload.class,
              message: event.payload.message,
            }),
            errorClass: event.payload.class ?? "unknown",
            hasTurnId: event.turnId !== undefined,
          });
          return;
        }
        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("provider runtime analytics capture failed", {
          eventId: event.eventId,
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider canonical event log write failed", {
                  eventId: canonicalEvent.eventId,
                  eventType: canonicalEvent.type,
                  threadId: canonicalEvent.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) =>
        withholdEarlyRuntimeEvent(canonicalEvent).pipe(
          Effect.flatMap((withheld) =>
            withheld ? Effect.void : deliverRuntimeEvent(canonicalEvent),
          ),
        ),
      ),
    );

  /** Hands a runtime event to its thread: analytics, then every consumer. */
  const deliverRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    recordRuntimeEventAnalytics(event).pipe(
      Effect.andThen(PubSub.publish(runtimeEventPubSub, toThreadRuntimeEvent(event))),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly earlyUnused?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    // Brought back as an ordinary start would be: holding the key, and with
    // no early marker left to withhold the new runtime's events.
    return yield* withEarlyGate(
      input.binding.threadId,
      Effect.gen(function* () {
        if (earlySessions.waiting(input.binding.threadId) === undefined) {
          earlySessions.forget(input.binding.threadId);
        }
        const adapter = yield* registry.getByInstance(bindingInstanceId);
        // A cursor nothing used points at a conversation that may not exist.
        const hasResumeCursor =
          input.binding.resumeCursor !== null &&
          input.binding.resumeCursor !== undefined &&
          !readPersistedEarlyUnused(input.binding.runtimePayload);
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find(
            (session) => session.threadId === input.binding.threadId,
          );
          if (existing) {
            yield* upsertSessionBinding(
              { ...existing, providerInstanceId: bindingInstanceId },
              input.binding.threadId,
            );
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              strategy: "adopt-existing",
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            return { adapter, session: existing } as const;
          }
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        // A new runtime, not the early one (that one is gone): nothing early
        // about the key is left.
        earlySessions.forget(input.binding.threadId);
        earlyStartedSessions.delete(input.binding.threadId);
        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

        const resumed = yield* adapter.startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          ...(readPersistedRoomToolsRequest(input.binding.runtimePayload)
            ? { roomTools: true }
            : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        turnLatency.sessionStarted(
          input.binding.threadId,
          yield* Clock.currentTimeMillis,
          bindingInstanceId,
        );
        yield* upsertSessionBinding(
          { ...resumed, providerInstanceId: bindingInstanceId },
          input.binding.threadId,
        );
        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          strategy: "resume-thread",
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });
        return { adapter, session: resumed } as const;
      }),
    ).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    // A side answer's runtime is never brought back: its binding does not
    // record the lockdown, so recovering it would start an unrestricted
    // session under a side key.
    if (!input.allowRecovery || parseSessionKey(input.threadId).kind === "side") {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  // An ordinary start replaces whatever an early start left, holding the key
  // while it starts, so the adapter never starts it twice. An early start
  // already holds it.
  const startSessionWith = (threadId: ThreadId, rawInput: unknown, early: boolean) =>
    early
      ? startSessionHoldingKey(threadId, rawInput, true)
      : withEarlyGate(
          threadId,
          Effect.suspend(() => {
            earlySessions.forget(threadId);
            earlyStartedSessions.delete(threadId);
            return startSessionHoldingKey(threadId, rawInput, false);
          }),
        );

  const startSessionHoldingKey = Effect.fn("startSession")(function* (
    threadId: ThreadId,
    rawInput: unknown,
    early: boolean,
  ) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.startSession",
      schema: ProviderSessionStartInput,
      payload: rawInput,
    });

    const resolvedInstanceId = yield* requireBindingInstanceId(
      "ProviderService.startSession",
      parsed,
    );
    let metricProvider = parsed.provider ?? String(resolvedInstanceId);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "start-session",
      "provider.instance_id": resolvedInstanceId,
      "provider.thread_id": threadId,
      "provider.runtime_mode": parsed.runtimeMode,
    });
    return yield* Effect.gen(function* () {
      const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
      const resolvedProvider = instanceInfo.driverKind;
      metricProvider = resolvedProvider;
      if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
        );
      }
      const input = {
        ...parsed,
        threadId,
        provider: resolvedProvider,
      };
      if (!instanceInfo.enabled) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' is disabled in Threadlines settings.`,
        );
      }
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const persistedModelSelection = readPersistedModelSelection(persistedBinding?.runtimePayload);
      // A saved resume cursor belongs to the conversation history, not to
      // one instance: another instance that reads the same history (an
      // extra account on the same main folder) resumes it too, even after
      // the thread's session stopped or the server restarted.
      const persistedInstanceId = persistedBinding?.providerInstanceId;
      const persistedSharesHistory =
        persistedInstanceId !== undefined &&
        (persistedInstanceId === resolvedInstanceId ||
          (yield* registry.getInstanceInfo(persistedInstanceId).pipe(
            Effect.map(
              (persistedInfo) =>
                persistedInfo.driverKind === instanceInfo.driverKind &&
                persistedInfo.continuationIdentity.continuationKey ===
                  instanceInfo.continuationIdentity.continuationKey,
            ),
            Effect.orElseSucceed(() => false),
          )));
      const persistedCursorUsable =
        persistedSharesHistory && !readPersistedEarlyUnused(persistedBinding?.runtimePayload);
      const effectiveResumeCursor =
        input.resumeCursor ?? (persistedCursorUsable ? persistedBinding?.resumeCursor : undefined);
      const effectiveCwd =
        input.cwd ??
        (persistedSharesHistory ? readPersistedCwd(persistedBinding?.runtimePayload) : undefined);
      yield* Effect.annotateCurrentSpan({
        "provider.kind": resolvedProvider,
        "provider.resume_cursor.source":
          input.resumeCursor !== undefined
            ? "request"
            : effectiveResumeCursor !== undefined && persistedSharesHistory
              ? "persisted"
              : "none",
        "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
        "provider.cwd.source":
          input.cwd !== undefined
            ? "request"
            : effectiveCwd !== undefined && persistedSharesHistory
              ? "persisted"
              : "none",
        "provider.cwd.effective": effectiveCwd ?? "",
      });
      const adapter = yield* registry.getByInstance(resolvedInstanceId);
      const session = yield* adapter.startSession({
        ...input,
        providerInstanceId: resolvedInstanceId,
        ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
        ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        // An early start reopens the conversation or fails: starting it fresh
        // instead is left to the ordinary start, which tells the thread.
        ...(early ? { resumePolicy: "required" as const } : {}),
      });

      if (session.provider !== adapter.provider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
        );
      }
      turnLatency.sessionStarted(threadId, yield* Clock.currentTimeMillis, resolvedInstanceId);
      const sessionWithInstance = {
        ...session,
        providerInstanceId: resolvedInstanceId,
      };

      yield* stopStaleSessionsForThread({
        threadId,
        currentInstanceId: resolvedInstanceId,
      });
      // A fresh early start's conversation exists only once something uses
      // it; until then a later start must not try to resume it.
      const fresh =
        effectiveResumeCursor === undefined &&
        input.contextSeed === undefined &&
        input.forkFrom === undefined;
      yield* upsertSessionBinding(sessionWithInstance, threadId, {
        modelSelection: input.modelSelection,
        earlyUnused: early && fresh,
      });
      yield* analytics.record("provider.session.started", {
        ...analyticsAgentProperties({
          provider: sessionWithInstance.provider,
          communityAgentId: instanceInfo.communityAgentId,
        }),
        sessionStartKind: classifyProviderSessionStart({
          hasPreviousBinding: persistedBinding !== undefined,
          previousProvider: persistedBinding?.provider,
          previousInstanceId: persistedBinding?.providerInstanceId,
          nextProvider: resolvedProvider,
          nextInstanceId: resolvedInstanceId,
          hasContextSeed: input.contextSeed !== undefined,
          hasResumeCursor: effectiveResumeCursor !== undefined,
        }),
        previousProvider: persistedBinding?.provider ?? "none",
        providerChanged:
          persistedBinding !== undefined &&
          (persistedBinding.provider !== resolvedProvider ||
            persistedBinding.providerInstanceId !== resolvedInstanceId),
        modelChanged:
          persistedModelSelection?.model !== undefined &&
          input.modelSelection?.model !== undefined &&
          persistedModelSelection.model !== input.modelSelection.model,
        hasContextSeed: input.contextSeed !== undefined,
        ...analyticsModelProperties({
          model: input.modelSelection?.model,
          provider: resolvedProvider,
        }),
        ...analyticsModelProperties({
          model: persistedModelSelection?.model,
          provider: persistedBinding?.provider,
          prefix: "previous",
        }),
        runtimeMode: input.runtimeMode,
        early,
        hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
        hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
        hasModel:
          typeof input.modelSelection?.model === "string" &&
          input.modelSelection.model.trim().length > 0,
      });

      return sessionWithInstance;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "start",
          }),
      }),
    );
  });

  const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
    startSessionWith(threadId, rawInput, false);

  const startEarlySession: ProviderServiceShape["startEarlySession"] = Effect.fn(
    "startEarlySession",
  )(function* (threadId, input) {
    const capabilities = yield* registry.getByInstance(input.providerInstanceId).pipe(
      Effect.map((adapter) => adapter.capabilities),
      Effect.option,
    );
    if (Option.isNone(capabilities) || capabilities.value.earlySessionStart !== "supported") {
      return "unsupported" as const;
    }
    // One being stopped unused can start again once it's gone.
    if (earlySessions.isEarly(threadId) && earlySessions.waiting(threadId) === undefined) {
      yield* awaitEarlyGate(threadId);
    }
    const nowMs = yield* Clock.currentTimeMillis;
    // Set when the start returns.
    let started: ProviderSession | undefined;
    let settled = false;
    // Ends the start, once, while the gate still holds: a start that failed,
    // was interrupted, or was given up or stopped meanwhile leaves nothing
    // running behind it. Stopped through the instance it started on, which
    // the saved binding may not name yet.
    const settle = (gate: Deferred.Deferred<void>) =>
      Effect.suspend(() => {
        if (settled) return Effect.void;
        settled = true;
        earlyStartRuns.delete(threadId);
        if (started !== undefined && earlySessions.waiting(threadId) !== undefined) {
          // Let go in the same step as the check: one giving it up from now
          // on finds the key free and stops the runtime itself.
          if (earlyGates.get(threadId) === gate) earlyGates.delete(threadId);
          return Deferred.succeed(gate, undefined).pipe(Effect.asVoid);
        }
        // Kept retired, so the stopping runtime's last events stay withheld.
        earlySessions.retire(threadId);
        earlyStartedSessions.delete(threadId);
        return registry.getByInstance(input.providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            adapter
              .hasSession(threadId)
              .pipe(
                Effect.flatMap((hasSession) =>
                  hasSession ? adapter.stopSession(threadId) : Effect.void,
                ),
              ),
          ),
          Effect.ignoreCause({ log: false }),
          Effect.ensuring(releaseEarlyGate(threadId, gate)),
        );
      });
    // Reserving, taking the gate and forking happen as one step: an
    // interrupt between them would leave the gate held with no start to
    // release it. The start itself stays interruptible.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        // An ordinary start or a recovery holds the key: the agent is
        // starting anyway.
        if (earlyGates.has(threadId) && earlySessions.waiting(threadId) === undefined) {
          return "busy" as const;
        }
        const reservation = earlySessions.reserve(threadId, {
          instanceId: input.providerInstanceId,
          cwd: input.cwd,
          nowMs,
        });
        if (reservation !== "reserved") {
          return reservation;
        }
        // Gate held before this returns: the caller's next step (a turn start
        // right behind it) already finds the start and waits for it.
        earlyGates.set(threadId, gate);
        const fiber = yield* restore(
          startSessionWith(threadId, input, true).pipe(
            Effect.timeoutOrElse({
              duration: EARLY_SESSION_START_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  toValidationError(
                    "ProviderService.startEarlySession",
                    "The early start took too long.",
                  ),
                ),
            }),
            Effect.tap((session) =>
              Effect.sync(() => {
                started = session;
                earlySessions.started(threadId, session.createdAt);
                if (earlySessions.waiting(threadId) !== undefined) {
                  earlyStartedSessions.set(threadId, session);
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logInfo("provider service early start failed", {
                    threadId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ).pipe(Effect.ensuring(settle(gate)), Effect.forkIn(serviceScope));
        // A stop that interrupts the fiber before it ever ran still settles,
        // through the run's own clean-up.
        if (!settled) {
          earlyStartRuns.set(threadId, { fiber, settle: settle(gate) });
        }
        return "started" as const;
      }),
    );
  });

  // Something is about to use the session: an early one becomes the thread's.
  const adoptEarlySession: ProviderServiceShape["adoptEarlySession"] = (threadId) =>
    Effect.gen(function* () {
      yield* awaitEarlyGate(threadId);
      const session = earlyStartedSessions.get(threadId);
      earlyStartedSessions.delete(threadId);
      const held = earlySessions.adopt(threadId);
      if (held === undefined) {
        return undefined;
      }
      const binding = Option.getOrUndefined(
        yield* directory.getBinding(threadId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (binding !== undefined && readPersistedEarlyUnused(binding.runtimePayload)) {
        yield* directory
          .upsert({
            threadId,
            provider: binding.provider,
            ...(binding.providerInstanceId !== undefined
              ? { providerInstanceId: binding.providerInstanceId }
              : {}),
            runtimePayload: { earlyUnused: false },
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      // What it said while it waited reaches the thread now it is the thread's.
      yield* Effect.forEach(held, deliverRuntimeEvent, { discard: true });
      return session;
    });

  const isEarlySession: ProviderServiceShape["isEarlySession"] = (threadId) =>
    Effect.sync(() => earlySessions.isEarly(threadId));

  const recordEarlySessionUnused = (
    entry: { readonly instanceId: string; readonly startedAtMs: number },
    reason: EarlySessionEndReason,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const provider = yield* registry.getInstanceInfo(entry.instanceId as ProviderInstanceId).pipe(
        Effect.map((info) => info.driverKind),
        Effect.orElseSucceed(() => "unknown"),
      );
      yield* Effect.logInfo("provider service stopped an unused early session", { reason });
      yield* analytics.record("provider.session.early_unused", {
        provider,
        reason,
        ageMs: Math.max(0, nowMs - entry.startedAtMs),
      });
    });

  // Stops an early session nobody used, while its key's gate is held. Its
  // entry stays retired, so the stopping runtime's last events are ignored.
  const stopUnusedEarlySession = (
    threadId: ThreadId,
    entry: { readonly id: number; readonly instanceId: string; readonly startedAtMs: number },
    reason: EarlySessionEndReason,
  ) =>
    Effect.gen(function* () {
      const live = (yield* listSessions()).find((session) => session.threadId === threadId);
      // Only this start's runtime: the key may have started again since.
      const generation = earlySessions.entryOf(threadId, entry.id)?.generation;
      if (live !== undefined && generation !== undefined && live.createdAt === generation) {
        yield* stopSessionCore({ threadId }).pipe(Effect.ignoreCause({ log: true }));
      }
      yield* recordEarlySessionUnused(entry, reason);
    });

  /**
   * Gives up the key's waiting early session in one step, so no use can
   * adopt it afterwards, and blocks early starts in its checkout: what it did
   * on its own would happen again on the next one. Says how its runtime is
   * to be stopped: by the start still running (which cleans up behind itself
   * once ended), under `gate` (taken now when nothing holds the key), or once
   * whatever holds the key (a recovery, an ordinary start) lets go.
   */
  const giveUpEarlySession = (threadId: ThreadId, gate: Deferred.Deferred<void>) => {
    const retired = earlySessions.retire(threadId);
    if (retired === undefined) return undefined;
    earlySessions.block(retired.instanceId, retired.cwd);
    earlyStartedSessions.delete(threadId);
    if (earlyStartRuns.has(threadId)) return { retired, stop: "end-start" as const };
    if (earlyGates.has(threadId)) return { retired, stop: "after-holder" as const };
    earlyGates.set(threadId, gate);
    return { retired, stop: "holding" as const, gate };
  };

  /** Stops what a given-up early session left (see `giveUpEarlySession`). */
  const stopGivenUpEarlySession = (
    threadId: ThreadId,
    plan: NonNullable<ReturnType<typeof giveUpEarlySession>>,
    reason: EarlySessionEndReason,
  ) => {
    switch (plan.stop) {
      case "end-start":
        return endEarlyStartRun(threadId).pipe(
          Effect.andThen(recordEarlySessionUnused(plan.retired, reason)),
        );
      case "holding":
        return stopUnusedEarlySession(threadId, plan.retired, reason).pipe(
          Effect.ensuring(releaseEarlyGate(threadId, plan.gate)),
        );
      case "after-holder":
        return withEarlyGate(threadId, stopUnusedEarlySession(threadId, plan.retired, reason));
    }
  };

  const abandonEarlySession: ProviderServiceShape["abandonEarlySession"] = (input) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const plan = yield* Effect.sync(() => giveUpEarlySession(input.threadId, gate));
      if (plan !== undefined) {
        yield* stopGivenUpEarlySession(input.threadId, plan, input.reason);
      }
    });

  /**
   * An early runtime isn't its thread's until something uses it
   * (docs/early-agent-start.md), so nothing it says reaches any consumer:
   * the thread, its checkpoints, sleep. Its warnings are held for the thread
   * until it is used. One that starts work or asks the user something on its
   * own is stopped, and isn't started early in that checkout again. Returns
   * whether `event` was withheld.
   */
  const withholdEarlyRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const sessionKey = event.threadId;
      if (!earlySessions.isEarly(sessionKey)) {
        return Effect.succeed(false);
      }
      if (event.type === "runtime.warning") {
        earlySessions.hold(sessionKey, event);
        return Effect.succeed(true);
      }
      if (
        event.type !== "turn.started" &&
        event.type !== "request.opened" &&
        event.type !== "user-input.requested"
      ) {
        return Effect.succeed(true);
      }
      // Given up before this returns: a message sent right now must not
      // adopt a runtime whose question nobody saw.
      return Deferred.make<void>().pipe(
        Effect.flatMap((gate) => {
          const plan = giveUpEarlySession(sessionKey, gate);
          if (plan === undefined) return Effect.void;
          return Effect.logInfo("provider service stopping an early agent working alone", {
            threadId: sessionKey,
            eventType: event.type,
          }).pipe(
            Effect.andThen(
              stopGivenUpEarlySession(
                sessionKey,
                plan,
                event.type === "turn.started" ? "turn_started" : "asked_user",
              ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope)),
            ),
          );
        }),
        Effect.as(true),
      );
    });

  const expireUnusedEarlySessions = Effect.gen(function* () {
    const expired = earlySessions.expired(yield* Clock.currentTimeMillis);
    for (const candidate of expired) {
      const threadId = ThreadId.make(candidate.sessionKey);
      const gate = yield* Deferred.make<void>();
      const nowMs = yield* Clock.currentTimeMillis;
      // Checked again as it is taken: typing may have renewed it since.
      const entry = yield* Effect.sync(() => {
        if (earlyGates.has(threadId) || !earlySessions.isExpired(threadId, nowMs)) {
          return undefined;
        }
        const retired = earlySessions.retire(threadId);
        if (retired !== undefined) {
          earlyStartedSessions.delete(threadId);
          earlyGates.set(threadId, gate);
        }
        return retired;
      });
      if (entry !== undefined) {
        yield* stopUnusedEarlySession(threadId, entry, "idle").pipe(
          Effect.ensuring(releaseEarlyGate(threadId, gate)),
        );
      }
    }
  });

  const listExternalThreads: ProviderServiceShape["listExternalThreads"] = Effect.fn(
    "listExternalThreads",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.listExternalThreads",
      schema: ProviderExternalThreadListInput,
      payload: rawInput,
    });
    const instanceInfo = yield* registry.getInstanceInfo(input.providerInstanceId);
    if (!instanceInfo.enabled) {
      return yield* toValidationError(
        "ProviderService.listExternalThreads",
        `Provider instance '${input.providerInstanceId}' is disabled.`,
      );
    }
    const adapter = yield* registry.getByInstance(input.providerInstanceId);
    if (!adapter.listExternalThreads) {
      return yield* toValidationError(
        "ProviderService.listExternalThreads",
        `Provider '${instanceInfo.driverKind}' does not expose external conversations.`,
      );
    }

    const [page, bindings] = yield* Effect.all([
      adapter.listExternalThreads(input),
      directory.listBindings(),
    ]);
    const linkedProviderThreadIds = new Set(
      bindings.flatMap((binding) => {
        if (binding.providerInstanceId !== input.providerInstanceId) {
          return [];
        }
        const providerThreadId = readCodexResumeThreadId(binding.resumeCursor);
        return providerThreadId ? [providerThreadId] : [];
      }),
    );

    return {
      ...page,
      data: page.data.filter(
        (candidate) => !linkedProviderThreadIds.has(candidate.providerThreadId),
      ),
    };
  });

  const readExternalThread: ProviderServiceShape["readExternalThread"] = Effect.fn(
    "readExternalThread",
  )(function* (input) {
    const providerThreadId = input.providerThreadId.trim();
    const expectedCwd = input.expectedCwd.trim();
    if (!providerThreadId || !expectedCwd) {
      return yield* toValidationError(
        "ProviderService.readExternalThread",
        "Provider thread id and expected working directory are required.",
      );
    }
    const instanceInfo = yield* registry.getInstanceInfo(input.providerInstanceId);
    if (!instanceInfo.enabled) {
      return yield* toValidationError(
        "ProviderService.readExternalThread",
        `Provider instance '${input.providerInstanceId}' is disabled.`,
      );
    }
    const adapter = yield* registry.getByInstance(input.providerInstanceId);
    if (!adapter.readExternalThread) {
      return yield* toValidationError(
        "ProviderService.readExternalThread",
        `Provider '${instanceInfo.driverKind}' does not expose external conversations.`,
      );
    }

    const bindings = yield* directory.listBindings();
    const linkedThread = bindings.find(
      (binding) =>
        binding.providerInstanceId === input.providerInstanceId &&
        readCodexResumeThreadId(binding.resumeCursor) === providerThreadId,
    );
    if (linkedThread) {
      return yield* toValidationError(
        "ProviderService.readExternalThread",
        `This Codex session is already linked to Threadlines thread '${linkedThread.threadId}'.`,
      );
    }
    return yield* adapter.readExternalThread({ providerThreadId, expectedCwd });
  });

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      // Using an early session makes it the thread's.
      yield* adoptEarlySession(input.threadId);
      const sessionStartedEarly = earlySessions.takeFirstTurn(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const communityAgentId = yield* communityAgentIdOf(routed.instanceId);
      const requestedAtMs =
        input.requestedAt !== undefined ? Date.parse(input.requestedAt) : Number.NaN;
      let latencySendId: number | undefined;
      if (Number.isFinite(requestedAtMs)) {
        const { handoffMs, sendId } = turnLatency.sending(input.threadId, {
          requestedAtMs,
          nowMs: yield* Clock.currentTimeMillis,
          provider: routed.adapter.provider,
          communityAgentId,
          instanceId: routed.instanceId,
          model: input.modelSelection?.model,
          attachmentCount: input.attachments.length,
          sessionStartedEarly,
        });
        latencySendId = sendId;
        yield* Effect.annotateCurrentSpan({ "provider.turn.handoff_ms": handoffMs });
      }
      const turn = yield* routed.adapter.sendTurn(input).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (latencySendId !== undefined) {
              turnLatency.notSent(input.threadId, latencySendId);
            }
          }),
        ),
      );
      if (latencySendId !== undefined) {
        yield* recordTurnLatency(turnLatency.sent(input.threadId, latencySendId, turn.turnId));
      }
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      if (input.telemetryContext?.kind === "thread_fork") {
        const sourceModelSelection = input.telemetryContext.sourceModelSelection;
        yield* analytics.record("thread.fork.created", {
          sourceProvider: sourceModelSelection?.instanceId ?? "unknown",
          targetProvider: input.modelSelection?.instanceId ?? routed.instanceId,
          providerChanged:
            sourceModelSelection !== undefined &&
            input.modelSelection !== undefined &&
            sourceModelSelection.instanceId !== input.modelSelection.instanceId,
          modelChanged:
            sourceModelSelection !== undefined &&
            input.modelSelection !== undefined &&
            sourceModelSelection.model !== input.modelSelection.model,
          hasForkContext: true,
          seedMode: input.telemetryContext.seedMode ?? "context-seed",
          includedMessageCount: input.telemetryContext.includedMessageCount,
          includedToolSummaryCount: input.telemetryContext.includedToolSummaryCount,
          includedAttachmentCount: input.telemetryContext.includedAttachmentCount,
          omittedAttachmentCount: input.telemetryContext.omittedAttachmentCount,
          ...analyticsModelProperties({
            model: sourceModelSelection?.model,
            provider: sourceModelSelection?.instanceId,
            prefix: "source",
          }),
          ...analyticsModelProperties({
            model: input.modelSelection?.model,
            provider: input.modelSelection?.instanceId,
            prefix: "target",
          }),
        });
      }
      yield* analytics.record("provider.turn.sent", {
        ...analyticsAgentProperties({ provider: routed.adapter.provider, communityAgentId }),
        ...analyticsModelProperties({
          model: input.modelSelection?.model,
          provider: routed.adapter.provider,
        }),
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const steerTurn: ProviderServiceShape["steerTurn"] = Effect.fn("steerTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.steerTurn",
      schema: ProviderSteerTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.steerTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "steer-turn",
      "provider.thread_id": input.threadId,
      "provider.expected_turn_id": input.expectedTurnId,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      // Using an early session makes it the thread's.
      yield* adoptEarlySession(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.steerTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
      });
      if (
        routed.adapter.capabilities.activeTurnSteering !== "supported" ||
        routed.adapter.steerTurn === undefined
      ) {
        return yield* toValidationError(
          "ProviderService.steerTurn",
          `Provider '${routed.adapter.provider}' does not support active turn steering.`,
        );
      }

      const turn = yield* routed.adapter.steerTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.steerTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.steered", {
        ...analyticsAgentProperties({
          provider: routed.adapter.provider,
          communityAgentId: yield* communityAgentIdOf(routed.instanceId),
        }),
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: undefined,
            extra: {
              operation: "steer",
            },
          }),
      }),
    );
  });

  const startReview: ProviderServiceShape["startReview"] = Effect.fn("startReview")(
    function* (rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startReview",
        schema: ProviderStartReviewInput,
        payload: rawInput,
      });
      const input = {
        ...parsed,
        delivery: parsed.delivery ?? "inline",
      };
      if (input.delivery !== "inline") {
        return yield* toValidationError(
          "ProviderService.startReview",
          "Detached provider reviews are not supported yet.",
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-review",
        "provider.thread_id": input.threadId,
        "provider.review_target": input.target.type,
        "provider.review_delivery": input.delivery,
      });
      let metricProvider = "unknown";
      const requireReviewStart = Effect.fn("requireReviewStart")(function* (
        adapter: ProviderAdapterShape<ProviderAdapterError>,
      ) {
        const startAdapterReview = adapter.startReview;
        if (adapter.capabilities.reviewStart !== "supported" || startAdapterReview === undefined) {
          return yield* toValidationError(
            "ProviderService.startReview",
            `Provider '${adapter.provider}' does not support native code reviews.`,
          );
        }
        return startAdapterReview;
      });
      const startReviewInRoutedSession = Effect.gen(function* () {
        // Using an early session makes it the thread's.
        yield* adoptEarlySession(input.threadId);
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.startReview",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.kind": routed.adapter.provider,
        });
        const startAdapterReview = yield* requireReviewStart(routed.adapter);
        const activeSession = (yield* routed.adapter.listSessions()).find(
          (session) => session.threadId === input.threadId,
        );
        if (
          activeSession?.status === "connecting" ||
          activeSession?.status === "running" ||
          activeSession?.activeTurnId !== undefined
        ) {
          return yield* toValidationError(
            "ProviderService.startReview",
            `Cannot start a code review for thread '${input.threadId}' while another provider turn is starting or running.`,
          );
        }

        const turn = yield* startAdapterReview(input);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.startReview",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
        yield* analytics.record("provider.review.started", {
          provider: routed.adapter.provider,
          targetType: input.target.type,
          delivery: input.delivery,
        });
        return turn;
      });

      return yield* startReviewInRoutedSession.pipe(
        Effect.catchIf(isMissingProviderBindingForReview, () =>
          Effect.gen(function* () {
            if (
              input.cwd === undefined ||
              input.modelSelection === undefined ||
              input.runtimeMode === undefined
            ) {
              return yield* toValidationError(
                "ProviderService.startReview",
                `Cannot start provider review for thread '${input.threadId}' because no provider session exists yet.`,
              );
            }

            yield* Effect.annotateCurrentSpan({
              "provider.review_bootstrap": true,
              "provider.instance_id": input.modelSelection.instanceId,
              "provider.runtime_mode": input.runtimeMode,
            });
            const bootstrapAdapter = yield* registry.getByInstance(input.modelSelection.instanceId);
            yield* requireReviewStart(bootstrapAdapter);
            yield* startSession(input.threadId, {
              threadId: input.threadId,
              providerInstanceId: input.modelSelection.instanceId,
              cwd: input.cwd,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
            });
            return yield* startReviewInRoutedSession;
          }),
        ),
        withMetrics({
          counter: providerTurnsTotal,
          timer: providerTurnDuration,
          attributes: () =>
            providerTurnMetricAttributes({
              provider: metricProvider,
              model: undefined,
              extra: {
                operation: "review",
              },
            }),
        }),
      );
    },
  );

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record(
          "provider.turn.interrupted",
          analyticsAgentProperties({
            provider: routed.adapter.provider,
            communityAgentId: yield* communityAgentIdOf(routed.instanceId),
          }),
        );
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const resolveRealtimeAdapter = Effect.fn("resolveRealtimeAdapter")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: input.operation,
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        input.operation,
        `Cannot use realtime for thread '${input.threadId}' because no active provider session exists.`,
      );
    }
    if (routed.adapter.capabilities.realtimeVoice !== "supported") {
      return yield* toValidationError(
        input.operation,
        `Provider '${routed.adapter.provider}' does not support realtime voice.`,
      );
    }
    return routed;
  });

  const realtimeStart: NonNullable<ProviderServiceShape["realtimeStart"]> = Effect.fn(
    "realtimeStart",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.realtimeStart",
      schema: ProviderRealtimeStartInput,
      payload: rawInput,
    });
    // Using an early session makes it the thread's.
    yield* adoptEarlySession(input.threadId);
    const routed = yield* resolveRealtimeAdapter({
      threadId: input.threadId,
      operation: "ProviderService.realtimeStart",
    });
    if (!routed.adapter.realtimeStart) {
      return yield* toValidationError(
        "ProviderService.realtimeStart",
        "Realtime start capability is missing from the provider adapter.",
      );
    }
    yield* routed.adapter.realtimeStart(
      routed.threadId,
      input.outputModality !== undefined ? { outputModality: input.outputModality } : undefined,
    );
  });

  const realtimeStop: NonNullable<ProviderServiceShape["realtimeStop"]> = Effect.fn("realtimeStop")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.realtimeStop",
        schema: ProviderRealtimeStopInput,
        payload: rawInput,
      });
      const routed = yield* resolveRealtimeAdapter({
        threadId: input.threadId,
        operation: "ProviderService.realtimeStop",
      });
      if (!routed.adapter.realtimeStop) {
        return yield* toValidationError(
          "ProviderService.realtimeStop",
          "Realtime stop capability is missing from the provider adapter.",
        );
      }
      yield* routed.adapter.realtimeStop(routed.threadId);
    },
  );

  const realtimeAppendAudio: NonNullable<ProviderServiceShape["realtimeAppendAudio"]> = Effect.fn(
    "realtimeAppendAudio",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.realtimeAppendAudio",
      schema: ProviderRealtimeAppendAudioInput,
      payload: rawInput,
    });
    const routed = yield* resolveRealtimeAdapter({
      threadId: input.threadId,
      operation: "ProviderService.realtimeAppendAudio",
    });
    if (!routed.adapter.realtimeAppendAudio) {
      return yield* toValidationError(
        "ProviderService.realtimeAppendAudio",
        "Realtime audio capability is missing from the provider adapter.",
      );
    }
    yield* routed.adapter.realtimeAppendAudio(input);
  });

  const realtimeListVoices: NonNullable<ProviderServiceShape["realtimeListVoices"]> = Effect.fn(
    "realtimeListVoices",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.realtimeListVoices",
      schema: ProviderRealtimeListVoicesInput,
      payload: rawInput,
    });
    const routed = yield* resolveRealtimeAdapter({
      threadId: input.threadId,
      operation: "ProviderService.realtimeListVoices",
    });
    if (!routed.adapter.realtimeListVoices) {
      return yield* toValidationError(
        "ProviderService.realtimeListVoices",
        "Realtime voice-list capability is missing from the provider adapter.",
      );
    }
    return yield* routed.adapter.realtimeListVoices(routed.threadId);
  });

  const readConversation: ProviderServiceShape["readConversation"] = Effect.fn("readConversation")(
    function* (input) {
      const live = (yield* listSessions()).find((session) => session.threadId === input.threadId);
      if (live?.providerThreadId !== undefined && live.providerInstanceId !== undefined) {
        return {
          providerInstanceId: live.providerInstanceId,
          providerThreadId: live.providerThreadId,
        };
      }
      const binding = Option.getOrUndefined(
        yield* directory.getBinding(input.threadId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (binding === undefined || binding.providerInstanceId === undefined) {
        return null;
      }
      const cursor = (binding.resumeCursor ?? null) as {
        readonly threadId?: unknown;
        readonly resume?: unknown;
      } | null;
      // Resume cursors are the drivers' own: Codex names its thread, Claude its session.
      const providerThreadId =
        binding.provider === "codex"
          ? cursor?.threadId
          : binding.provider === "claudeAgent"
            ? cursor?.resume
            : undefined;
      return typeof providerThreadId === "string" && providerThreadId.length > 0
        ? { providerInstanceId: binding.providerInstanceId, providerThreadId }
        : null;
    },
  );

  const releaseBackgroundCommands: ProviderServiceShape["releaseBackgroundCommands"] = Effect.fn(
    "releaseBackgroundCommands",
  )(function* (input) {
    // Never starts a runtime: one that is not running has nothing to release.
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.releaseBackgroundCommands",
      allowRecovery: false,
    });
    if (!routed.isActive || routed.adapter.releaseBackgroundCommands === undefined) {
      return;
    }
    yield* routed.adapter.releaseBackgroundCommands(routed.threadId);
  });

  const stopBackgroundTask: ProviderServiceShape["stopBackgroundTask"] = Effect.fn(
    "stopBackgroundTask",
  )(function* (input) {
    // Never starts a runtime: a task lives only as long as its session does.
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.stopBackgroundTask",
      allowRecovery: false,
    });
    if (!routed.isActive || routed.adapter.stopBackgroundTask === undefined) {
      return false;
    }
    return yield* routed.adapter.stopBackgroundTask(routed.threadId, input.taskId);
  });

  // A run's files are read through the instance that ran it, whether or not
  // any of its sessions is running: the files outlive the runtime.
  const workflowRunsOf = Effect.fn("workflowRunsOf")(function* (
    operation: string,
    providerInstanceId: ProviderInstanceId,
  ) {
    const adapter = yield* registry.getByInstance(providerInstanceId);
    if (adapter.workflowRuns === undefined) {
      return yield* toValidationError(
        operation,
        `Provider '${adapter.provider}' does not run workflows.`,
      );
    }
    return adapter.workflowRuns;
  });

  const readWorkflowRunFile: ProviderServiceShape["readWorkflowRunFile"] = Effect.fn(
    "readWorkflowRunFile",
  )(function* (input) {
    const files = yield* workflowRunsOf(
      "ProviderService.readWorkflowRunFile",
      input.providerInstanceId,
    );
    return yield* files.readRunFile({ run: input.run, file: input.file });
  });

  const readWorkflowAgentTranscript: ProviderServiceShape["readWorkflowAgentTranscript"] =
    Effect.fn("readWorkflowAgentTranscript")(function* (input) {
      const files = yield* workflowRunsOf(
        "ProviderService.readWorkflowAgentTranscript",
        input.providerInstanceId,
      );
      return yield* files.readAgentTranscript({
        run: input.run,
        agentId: input.agentId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.fromEnd !== undefined ? { fromEnd: input.fromEnd } : {}),
      });
    });

  const saveWorkflowCommand: ProviderServiceShape["saveWorkflowCommand"] = Effect.fn(
    "saveWorkflowCommand",
  )(function* (input) {
    const files = yield* workflowRunsOf(
      "ProviderService.saveWorkflowCommand",
      input.providerInstanceId,
    );
    return yield* files.saveCommand({
      run: input.run,
      location: input.location,
      cwd: input.cwd,
      overwrite: input.overwrite,
      dryRun: input.dryRun,
    });
  });

  const noteExtensionsChanged: ProviderServiceShape["noteExtensionsChanged"] = Effect.fn(
    "noteExtensionsChanged",
  )(function* (input) {
    // An instance that is not running has no sessions to tell.
    const adapter = yield* registry
      .getByInstance(input.providerInstanceId)
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    if (adapter?.noteExtensionsChanged === undefined) return;
    yield* adapter.noteExtensionsChanged();
  });

  const compactContext: ProviderServiceShape["compactContext"] = Effect.fn("compactContext")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.compactContext",
        schema: ProviderCompactContextInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        // Using an early session makes it the thread's.
        yield* adoptEarlySession(input.threadId);
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.compactContext",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "compact-context",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (
          routed.adapter.capabilities.manualContextCompaction !== "supported" ||
          routed.adapter.compactContext === undefined
        ) {
          return yield* toValidationError(
            "ProviderService.compactContext",
            `Provider '${routed.adapter.provider}' does not support manual context compaction.`,
          );
        }

        const createdAt = yield* nowIso;
        yield* processRuntimeEvent(
          {
            instanceId: routed.instanceId,
            provider: routed.adapter.provider,
          },
          {
            eventId: EventId.make(crypto.randomUUID()),
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            threadId: input.threadId,
            createdAt,
            type: "session.state.changed",
            payload: {
              state: "waiting",
              reason: "status:compacting",
              detail: {
                trigger: "manual",
              },
            },
          },
        );
        yield* routed.adapter.compactContext(routed.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* processRuntimeEvent(
                {
                  instanceId: routed.instanceId,
                  provider: routed.adapter.provider,
                },
                {
                  eventId: EventId.make(crypto.randomUUID()),
                  provider: routed.adapter.provider,
                  providerInstanceId: routed.instanceId,
                  threadId: input.threadId,
                  createdAt: yield* nowIso,
                  type: "item.completed",
                  payload: {
                    itemType: "context_compaction",
                    status: "failed",
                    title: "Context compaction failed",
                    detail: Cause.pretty(cause),
                    data: {
                      trigger: "manual",
                    },
                  },
                },
              );
              return yield* Effect.failCause(cause);
            }),
          ),
        );
        yield* analytics.record("provider.context.compact_requested", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "compact-context",
            }),
        }),
      );
    },
  );

  const setThreadGoal: ProviderServiceShape["setThreadGoal"] = Effect.fn("setThreadGoal")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.setThreadGoal",
        schema: ProviderSetThreadGoalServiceInput,
        payload: rawInput,
      });
      // Using an early session makes it the thread's.
      yield* adoptEarlySession(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.setThreadGoal",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "set-thread-goal",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      if (
        routed.adapter.capabilities.threadGoals !== "supported" ||
        routed.adapter.setThreadGoal === undefined
      ) {
        return yield* toValidationError(
          "ProviderService.setThreadGoal",
          `Provider '${routed.adapter.provider}' does not support thread goals.`,
        );
      }
      const goal = yield* routed.adapter.setThreadGoal({
        threadId: routed.threadId,
        origin: "user",
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      });
      // Project the authoritative response directly: goal notifications keep
      // later autonomous updates flowing, but the requester's own change must
      // not depend on the app-server echoing a notification back.
      yield* processRuntimeEvent(
        {
          instanceId: routed.instanceId,
          provider: routed.adapter.provider,
        },
        {
          eventId: EventId.make(crypto.randomUUID()),
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          threadId: input.threadId,
          createdAt: yield* nowIso,
          type: "goal.updated",
          payload: {
            goal,
          },
        },
      );
      yield* analytics.record("provider.goal.set", {
        provider: routed.adapter.provider,
        status: goal.status,
      });
      return goal;
    },
  );

  const clearThreadGoal: ProviderServiceShape["clearThreadGoal"] = Effect.fn("clearThreadGoal")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.clearThreadGoal",
        schema: ProviderClearThreadGoalServiceInput,
        payload: rawInput,
      });
      // Using an early session makes it the thread's.
      yield* adoptEarlySession(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.clearThreadGoal",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "clear-thread-goal",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      if (
        routed.adapter.capabilities.threadGoals !== "supported" ||
        routed.adapter.clearThreadGoal === undefined
      ) {
        return yield* toValidationError(
          "ProviderService.clearThreadGoal",
          `Provider '${routed.adapter.provider}' does not support thread goals.`,
        );
      }
      yield* routed.adapter.clearThreadGoal(routed.threadId);
      yield* processRuntimeEvent(
        {
          instanceId: routed.instanceId,
          provider: routed.adapter.provider,
        },
        {
          eventId: EventId.make(crypto.randomUUID()),
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          threadId: input.threadId,
          createdAt: yield* nowIso,
          type: "goal.cleared",
          payload: {},
        },
      );
      yield* analytics.record("provider.goal.cleared", {
        provider: routed.adapter.provider,
      });
    },
  );

  const pauseThreadGoalForStop: ProviderServiceShape["pauseThreadGoalForStop"] = Effect.fn(
    "pauseThreadGoalForStop",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.pauseThreadGoalForStop",
      schema: ProviderClearThreadGoalServiceInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.pauseThreadGoalForStop",
      allowRecovery: false,
    });
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "pause-thread-goal-for-stop",
      "provider.kind": routed.adapter.provider,
      "provider.thread_id": input.threadId,
    });
    if (
      !routed.isActive ||
      routed.adapter.capabilities.threadGoals !== "supported" ||
      routed.adapter.getThreadGoal === undefined ||
      routed.adapter.setThreadGoal === undefined
    ) {
      return null;
    }

    const currentGoal = yield* routed.adapter.getThreadGoal(routed.threadId);
    if (
      currentGoal === null ||
      currentGoal.status !== "active" ||
      routed.adapter.capabilities.threadGoalPause === "unsupported"
    ) {
      return currentGoal;
    }

    const pausedGoal = yield* routed.adapter.setThreadGoal({
      threadId: routed.threadId,
      status: "paused",
      origin: "automatic",
    });
    yield* analytics.record("provider.goal.paused_for_stop", {
      provider: routed.adapter.provider,
    });
    return pausedGoal;
  });

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      turnLatency.sessionStopped(input.threadId);
      // An early start still running for this key stops with it, and stops
      // what it left before giving up the key.
      yield* endEarlyStartRun(input.threadId);
      yield* awaitEarlyGate(input.threadId);
      earlySessions.forget(input.threadId, { keepRetired: true });
      earlyStartedSessions.delete(input.threadId);
      return yield* stopSessionCore(input);
    },
  );

  /** Stops the key's runtime and marks its binding stopped; nothing else. */
  const stopSessionCore = Effect.fn("stopSessionCore")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.stopSession",
        allowRecovery: false,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "stop-session",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      // The cursor as the runtime last had it: an ACP agent records where
      // each prompt landed after its turn ends, past the turn's own save.
      let lastResumeCursor: unknown;
      if (routed.isActive) {
        lastResumeCursor = (yield* routed.adapter.listSessions()).find(
          (session) => session.threadId === routed.threadId,
        )?.resumeCursor;
        yield* routed.adapter.stopSession(routed.threadId);
      }
      // A side answer's runtime is disposable: nothing ever resumes it, so
      // its binding goes with it rather than piling up as "stopped".
      if (parseSessionKey(input.threadId).kind === "side") {
        yield* directory.deleteBinding(input.threadId);
      } else {
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          ...(lastResumeCursor !== undefined ? { resumeCursor: lastResumeCursor } : {}),
          runtimePayload: {
            activeTurnId: null,
          },
        });
      }
      yield* analytics.record("provider.session.stopped", {
        provider: routed.adapter.provider,
      });
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "stop",
          }),
      }),
    );
  });

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceShape["getInstanceInfo"] = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return { conversationRolledBack: true };
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      // Using an early session makes it the thread's.
      yield* adoptEarlySession(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
        "provider.rollback_target_user_message_id": input.targetUserMessageId ?? "",
      });
      const rolledBack = yield* routed.adapter.rollbackThread(
        routed.threadId,
        input.numTurns,
        input.targetUserMessageId !== undefined
          ? { targetUserMessageId: input.targetUserMessageId }
          : undefined,
      );
      // Rollbacks may adopt a new provider thread (Codex rolls back by
      // forking); re-persist the binding so a restart before the next turn
      // resumes the rolled-back thread instead of the superseded one.
      const rolledBackSession = (yield* routed.adapter.listSessions()).find(
        (session) => session.threadId === routed.threadId,
      );
      if (rolledBackSession !== undefined) {
        yield* upsertSessionBinding(rolledBackSession, routed.threadId);
      }
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
      return {
        conversationRolledBack:
          rolledBack.conversationRolledBack ??
          routed.adapter.capabilities.conversationRollback !== "none",
      };
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  /**
   * Every provider session key of a thread: its own agent first, then any
   * room agents. A subagent lives inside exactly one of those runtimes, and
   * callers only know the thread, so subagent operations try each in turn.
   */
  const threadSessionKeys = (threadId: ThreadId) =>
    directory.listThreadIds().pipe(
      Effect.map((keys) => [
        threadId,
        ...keys.filter((key) => key !== threadId && sessionKeyThreadId(key) === threadId),
      ]),
      Effect.catch(() => Effect.succeed([threadId])),
    );

  /** Run `attempt` against each of a thread's session keys until one succeeds. */
  const firstSucceedingSessionKey = <A, E, R>(
    threadId: ThreadId,
    attempt: (sessionKey: ThreadId) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const keys = yield* threadSessionKeys(threadId);
      let result = attempt(keys[0] ?? threadId);
      for (const key of keys.slice(1)) {
        result = result.pipe(Effect.catch(() => attempt(key)));
      }
      return yield* result;
    });

  const readSubagentTranscript: ProviderServiceShape["readSubagentTranscript"] = Effect.fn(
    "readSubagentTranscript",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.readSubagentTranscript",
      schema: ProviderSubagentTranscriptInput,
      payload: rawInput,
    });
    return yield* firstSucceedingSessionKey(input.threadId, (sessionKey) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: sessionKey,
          operation: "ProviderService.readSubagentTranscript",
          allowRecovery: true,
        });
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "read-subagent-transcript",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": sessionKey,
        });
        const readTranscript = routed.adapter.readSubagentTranscript;
        if (readTranscript === undefined) {
          return yield* toValidationError(
            "ProviderService.readSubagentTranscript",
            `Provider '${routed.adapter.provider}' does not expose subagent transcripts.`,
          );
        }
        return yield* readTranscript(routed.threadId, input);
      }),
    );
  });

  const readCommandOutput: ProviderServiceShape["readCommandOutput"] = Effect.fn(
    "readCommandOutput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.readCommandOutput",
      schema: ProviderCommandOutputInput,
      payload: rawInput,
    });
    // The command may be a room agent's, and only one session knows it, so
    // each live session is asked in turn; none is started to answer.
    let pending = false;
    for (const sessionKey of yield* threadSessionKeys(input.threadId)) {
      const answer = yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: sessionKey,
          operation: "ProviderService.readCommandOutput",
          allowRecovery: false,
        });
        const read = routed.adapter.readCommandOutput;
        if (!routed.isActive || read === undefined) return undefined;
        return yield* read(routed.threadId, input.toolCallId);
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (answer?.status === "running") return answer;
      if (answer?.status === "pending") pending = true;
    }
    return { status: pending ? "pending" : "unavailable" } as const;
  });

  const sendSubagentInput: ProviderServiceShape["sendSubagentInput"] = Effect.fn(
    "sendSubagentInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendSubagentInput",
      schema: ProviderSubagentInputRequest,
      payload: rawInput,
    });
    return yield* firstSucceedingSessionKey(input.threadId, (sessionKey) =>
      Effect.gen(function* () {
        // Using an early session makes it the thread's.
        yield* adoptEarlySession(sessionKey);
        const routed = yield* resolveRoutableSession({
          threadId: sessionKey,
          operation: "ProviderService.sendSubagentInput",
          allowRecovery: false,
        });
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "send-subagent-input",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": sessionKey,
        });
        const send = routed.adapter.sendSubagentInput;
        if (send === undefined) {
          return yield* new ProviderValidationError({
            operation: "ProviderService.sendSubagentInput",
            issue: `Provider '${routed.adapter.provider}' does not accept direct input to subagents.`,
            code: "subagent_input_unsupported_provider",
          });
        }
        return yield* send(routed.threadId, input);
      }),
    );
  });

  const deleteThread: ProviderServiceShape["deleteThread"] = Effect.fn("deleteThread")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.deleteThread",
        schema: ProviderDeleteThreadInput,
        payload: rawInput,
      });
      // A room's added agents run under their own session keys; they go with
      // the thread. Best-effort, like the rest of deletion cleanup. A side
      // answer's runtime is only stopped: it is a disposable copy, and a
      // native delete could reach the conversation it copied.
      const keys = yield* directory.listThreadIds();
      for (const key of keys) {
        const target = parseSessionKey(key);
        if (target.kind !== "side" || target.threadId !== input.threadId) continue;
        yield* stopSession({ threadId: key }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("provider thread delete skipped a side answer runtime", {
              threadId: input.threadId,
              sessionKey: key,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      const agentKeys = keys.filter(
        (key) => key !== input.threadId && sessionKeyThreadId(key) === input.threadId,
      );
      for (const key of agentKeys) {
        yield* deleteProviderThreadByKey(key).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("provider thread delete skipped a room agent session", {
              threadId: input.threadId,
              sessionKey: key,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      return yield* deleteProviderThreadByKey(input.threadId);
    },
  );

  const deleteProviderThreadByKey = Effect.fn("deleteProviderThreadByKey")(function* (
    threadId: ThreadId,
  ) {
    const input = { threadId };
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.deleteThread",
        allowRecovery: true,
      });
      turnLatency.sessionStopped(input.threadId);
      earlySessions.forget(input.threadId);
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "delete-thread",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.native_delete_supported": routed.adapter.deleteThread !== undefined,
      });
      if (routed.adapter.deleteThread) {
        yield* routed.adapter.deleteThread(routed.threadId);
      } else if (routed.isActive) {
        yield* routed.adapter.stopSession(routed.threadId);
      }
      yield* directory.deleteBinding(input.threadId);
      yield* analytics.record("provider.thread.deleted", {
        provider: routed.adapter.provider,
        nativeDelete: routed.adapter.deleteThread !== undefined,
      });
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "delete-thread",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  yield* expireUnusedEarlySessions.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider service could not stop unused early sessions", {
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.repeat(Schedule.spaced(EARLY_SESSION_SWEEP_INTERVAL)),
    Effect.forkScoped,
  );

  return {
    startSession,
    startEarlySession,
    adoptEarlySession,
    isEarlySession,
    abandonEarlySession,
    listExternalThreads,
    readExternalThread,
    sendTurn,
    steerTurn,
    startReview,
    interruptTurn,
    realtimeStart,
    realtimeStop,
    realtimeAppendAudio,
    realtimeListVoices,
    releaseBackgroundCommands,
    stopBackgroundTask,
    readWorkflowRunFile,
    readWorkflowAgentTranscript,
    saveWorkflowCommand,
    noteExtensionsChanged,
    readConversation,
    compactContext,
    setThreadGoal,
    pauseThreadGoalForStop,
    clearThreadGoal,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    readSubagentTranscript,
    readCommandOutput,
    sendSubagentInput,
    deleteThread,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
