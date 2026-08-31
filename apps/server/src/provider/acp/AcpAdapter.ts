/**
 * AcpAdapter — generic `ProviderAdapterShape` for any ACP agent.
 *
 * One ACP child process per thread. Session setup, prompt streaming, mode
 * selection, permission requests and cancellation are protocol-level and
 * identical across agents; a descriptor contributes the spawn command, the
 * model-option mapping and optional vendor extension handlers.
 *
 * @module provider/acp/AcpAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { isProviderPlanGateMessage } from "@threadlines/shared/providerPlan";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "./AcpNativeLogging.ts";
import type {
  AcpExtensionContext,
  AcpProviderDescriptor,
  AcpProviderSettings,
} from "./AcpProviderDescriptor.ts";
import {
  applyAcpModelSelection,
  defaultResolveAcpModelId,
  makeAcpProviderRuntime,
} from "./AcpProviderRuntime.ts";
import {
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "./AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const ACP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export type AcpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface AcpAdapterOptions<Settings extends AcpProviderSettings> {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored when `modelSelection.instanceId` matches this value. */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. Production binds settings to the
   * instance scope (the hydration layer rebuilds the adapter on config
   * change); tests that swap `binaryPath` mid-suite pass a live resolver.
   */
  readonly resolveSettings?: Effect.Effect<Settings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface AcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  /** The in-flight `session/prompt`; ACP runs one prompt per session at a time. */
  promptFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Head of the current turn's assistant text, kept for plan-gate detection. */
  activeTurnText: string;
  /** Last provider status this turn (fx rate-limit retries etc.), for failure detail. */
  lastProviderStatus: string | undefined;
  stopped: boolean;
}

/** Plan-gate replies are one short sentence; more text than this is content. */
const PLAN_GATE_SCAN_MAX_CHARS = 500;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpResumeCursor(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

/**
 * Picks the ACP session mode for the requested interaction/runtime mode.
 * Exported for tests; agents name their modes differently, so matching is
 * alias-based with a "first non-plan mode" fallback.
 */
export function resolveRequestedAcpModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }
  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }
  return undefined;
}

export function makeAcpAdapter<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  options?: AcpAdapterOptions<Settings>,
) {
  const PROVIDER = descriptor.driverKind;
  const resolveModelId = descriptor.resolveModelId ?? defaultResolveAcpModelId;
  const extensionSource = descriptor.extensions?.source;

  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, AcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: AcpSessionContext,
      payload: AcpPlanUpdate,
      rawPayload: unknown,
      source: "acp.jsonrpc" | `acp.${string}.extension`,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.promptFiber) {
          yield* Fiber.interrupt(ctx.promptFiber);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const applyRequestedSessionConfiguration = (input: {
      readonly runtime: AcpSessionRuntimeShape;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode | undefined;
      readonly modelSelection:
        | {
            readonly model: string;
            readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
          }
        | undefined;
    }): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (input.modelSelection) {
          yield* applyAcpModelSelection({
            descriptor,
            runtime: input.runtime,
            model: input.modelSelection.model,
            selections: input.modelSelection.options,
            mapError: ({ cause }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });
        }

        const requestedModeId = resolveRequestedAcpModeId({
          interactionMode: input.interactionMode,
          runtimeMode: input.runtimeMode,
          modeState: yield* input.runtime.getModeState,
        });
        if (!requestedModeId) {
          return;
        }
        yield* input.runtime
          .setMode(requestedModeId)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
            ),
          );
      });

    const startSession: AcpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const boundModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AcpSessionContext;

          const resumeSessionId = parseAcpResumeCursor(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const effectiveSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : settings;

          const acp = yield* makeAcpProviderRuntime(descriptor, {
            settings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "threadlines", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const requestUserInput: AcpExtensionContext["requestUserInput"] = (request) =>
            Effect.gen(function* () {
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { questions: request.questions },
                ...(extensionSource
                  ? {
                      raw: {
                        source: extensionSource,
                        method: request.method,
                        payload: request.payload,
                      },
                    }
                  : {}),
              });
              const resolved = yield* Deferred.await(answers);
              pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              return resolved;
            });

          const extensionContext: AcpExtensionContext = {
            threadId: input.threadId,
            acp,
            activeTurnId: () => ctx?.activeTurnId,
            logNative: (method, payload) => logNative(input.threadId, method, payload),
            requestUserInput,
            emitProposedPlan: (request) =>
              Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "turn.proposed.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  payload: { planMarkdown: request.planMarkdown },
                  ...(extensionSource
                    ? {
                        raw: {
                          source: extensionSource,
                          method: request.method,
                          payload: request.payload,
                        },
                      }
                    : {}),
                });
              }),
            emitPlanUpdate: (request) =>
              ctx && extensionSource
                ? emitPlanUpdate(
                    ctx,
                    request.plan,
                    request.payload,
                    extensionSource,
                    request.method,
                  )
                : Effect.void,
          };

          const started = yield* Effect.gen(function* () {
            if (descriptor.extensions) {
              yield* descriptor.extensions.register(extensionContext);
            }
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: { outcome: "selected" as const, optionId: autoApprovedOptionId },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : { outcome: "selected" as const, optionId: acpPermissionOutcome(resolved) },
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: boundModelSelection,
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: boundModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: ACP_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            promptFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            activeTurnText: "",
            lastProviderStatus: undefined,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "SessionStatus":
                    if (event.message === ctx.lastProviderStatus) {
                      return;
                    }
                    ctx.lastProviderStatus = event.message;
                    // Narrate provider-side recovery (rate-limit retries) on
                    // the live turn so it doesn't read as a hang.
                    if (ctx.activeTurnId) {
                      yield* offerRuntimeEvent({
                        type: "turn.status.updated",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: { statusMessage: event.message },
                      });
                    }
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    if (ctx.activeTurnText.length < PLAN_GATE_SCAN_MAX_CHARS) {
                      ctx.activeTurnText += event.text;
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
            // Tied to the session, not to whichever fiber called startSession:
            // a child fork dies with its caller, which in the server is a
            // short-lived command fiber — and with it every later delta.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              state: "ready",
              reason: `${descriptor.presentation.displayName} ACP session ready`,
            },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    // The turn id is returned as soon as `session/prompt` is dispatched —
    // orchestration marks the turn accepted from that result, so it must
    // land before the streamed items and the completion, exactly as the
    // native drivers behave. The prompt itself runs in the session scope.
    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.promptFiber) {
          // ACP serializes prompts per session; a turn sent while one is in
          // flight starts after it, never interleaved with it.
          yield* Fiber.await(ctx.promptFiber);
        }
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveModelId(model);

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          if (attachment.type === "file") {
            // ACP prompt input has no document type; the agent reads the
            // staged file from disk instead (see buildFileAttachmentNote).
            promptParts.push({
              type: "text",
              text: buildFileAttachmentNote(attachment, attachmentPath),
            });
            continue;
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          promptParts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,
          threadId: input.threadId,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection:
            model === undefined ? undefined : { model, options: turnModelSelection?.options },
        });
        ctx.activeTurnId = turnId;
        ctx.lastPlanFingerprint = undefined;
        ctx.activeTurnText = "";
        ctx.lastProviderStatus = undefined;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const runPrompt = Effect.gen(function* () {
          const exit = yield* Effect.exit(ctx.acp.prompt({ prompt: promptParts }));
          // Deltas travel through the notification fiber; make sure every one
          // queued before the prompt returned is out before the turn closes.
          yield* ctx.acp.flushEvents;
          if (Exit.isSuccess(exit)) {
            const result = exit.value;
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            ctx.session = {
              ...ctx.session,
              updatedAt: yield* nowIso,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            };
            // Multi-provider harnesses advertise their whole catalog and
            // reject a plan-gated model as a one-line "reply" — surface that
            // as the failure it is so the chat can offer the upgrade page.
            const turnText = ctx.activeTurnText.trim();
            const planGateMessage =
              result.stopReason !== "cancelled" && isProviderPlanGateMessage(turnText)
                ? turnText
                : undefined;
            // A refusal that produced no text would render as a silently
            // empty turn; say so instead. (`refused` is fx's dialect.)
            const silentRefusal =
              (result.stopReason === "refusal" || result.stopReason === "refused") &&
              turnText.length === 0;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: planGateMessage
                ? { state: "failed", stopReason: "plan_gated", errorMessage: planGateMessage }
                : silentRefusal
                  ? {
                      state: "failed",
                      stopReason: result.stopReason ?? null,
                      // A rate-limit retry that ran out also surfaces as a
                      // bare refusal; the provider's own status tells them apart.
                      errorMessage: ctx.lastProviderStatus
                        ? `${descriptor.presentation.displayName} returned no output. Provider status: ${ctx.lastProviderStatus}`
                        : `${descriptor.presentation.displayName} reported the model refused this request and returned no output.`,
                    }
                  : {
                      state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                      stopReason: result.stopReason ?? null,
                    },
            });
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          const failure = Cause.squash(exit.cause);
          const detail =
            failure instanceof Error
              ? mapAcpToAdapterError(
                  PROVIDER,
                  input.threadId,
                  "session/prompt",
                  failure as EffectAcpErrors.AcpError,
                ).message
              : String(failure);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: "failed",
              stopReason: isProviderPlanGateMessage(detail) ? "plan_gated" : null,
              errorMessage: ctx.lastProviderStatus
                ? `${detail} Provider status: ${ctx.lastProviderStatus}`
                : detail,
            },
          });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
              }
            }),
          ),
        );
        ctx.promptFiber = yield* Effect.forkIn(runPrompt, ctx.scope);

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: AcpAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: AcpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));

    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AcpAdapterShape;
  });
}
