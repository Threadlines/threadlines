import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  isModeConfigOption,
  LEGACY_MODE_OPTION_ID,
  legacyControlConfigOptions,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

const FORCE_KILL_AFTER = Duration.seconds(3);

/** Short option lists (effort, mode) are worth spelling out in a rejection. */
const MAX_LISTED_CONFIG_OPTION_VALUES = 8;

/** ACP lets a client pass HTTP/SSE MCP servers only to agents that advertise them. */
export function supportedMcpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  capabilities: EffectAcpSchema.McpCapabilities | null | undefined,
): Array<EffectAcpSchema.McpServer> {
  return servers.filter((server) =>
    "type" in server
      ? server.type === "http"
        ? capabilities?.http === true
        : capabilities?.sse === true
      : true,
  );
}

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Added to the server's environment, or the whole of it when `inheritEnv` is false. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `false` hands the child exactly `env`: for agents whose environment must
   * not carry the server's ambient credentials (Antigravity).
   */
  readonly inheritEnv?: boolean;
  /** Override the default (`true` on Windows so `.cmd` shims resolve). */
  readonly shell?: boolean;
  /** Told the agent's pid once it is running. */
  readonly onSpawned?: (pid: number) => Effect.Effect<void>;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * ACP auth method to invoke after `initialize`. Omit for agents that
   * authenticate outside the protocol (e.g. fx, which advertises no auth
   * methods). When the agent advertises an `authMethods` list that does not
   * contain this id the call is skipped rather than failed.
   */
  readonly authMethodId?: string;
  /** Limit for that `authenticate`; past it the start fails as `auth_required`. */
  readonly authenticateTimeoutMs?: number;
  /**
   * MCP servers Threadlines offers the session (the browser panel tools).
   * HTTP/SSE entries are dropped unless the agent's `initialize` says it
   * speaks that transport, as ACP requires.
   */
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** Each line the agent writes to stderr (see `AcpClientOptions.onStderrLine`). */
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  /**
   * A stderr line that means this process can't go on (a sign-in prompt
   * outside a sign-in flow). Returns the reason: the process is stopped and
   * every request fails with it (code -32000).
   */
  readonly stderrFailure?: (line: string) => string | undefined;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  /**
   * `"native"` for agents Threadlines drives through their own controls
   * (see `AcpProviderDescriptor.sessionControls`): the older `modes` and
   * `models` session fields show up as config options and are set with
   * `session/set_mode` / `session/set_model`, and the agent's own
   * `config_option_update`s replace the option list.
   */
  readonly sessionControls?: "mapped" | "native";
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  /**
   * Set when a `resumeSessionId` was asked for but the agent could not reopen
   * it, so this is a fresh session without the earlier conversation.
   */
  readonly resumeFailure?: string;
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: EffectAcpClient.AcpClientShape["handleRequestPermission"];
  readonly handleElicitation: EffectAcpClient.AcpClientShape["handleElicitation"];
  readonly handleReadTextFile: EffectAcpClient.AcpClientShape["handleReadTextFile"];
  readonly handleWriteTextFile: EffectAcpClient.AcpClientShape["handleWriteTextFile"];
  readonly handleCreateTerminal: EffectAcpClient.AcpClientShape["handleCreateTerminal"];
  readonly handleTerminalOutput: EffectAcpClient.AcpClientShape["handleTerminalOutput"];
  readonly handleTerminalWaitForExit: EffectAcpClient.AcpClientShape["handleTerminalWaitForExit"];
  readonly handleTerminalKill: EffectAcpClient.AcpClientShape["handleTerminalKill"];
  readonly handleTerminalRelease: EffectAcpClient.AcpClientShape["handleTerminalRelease"];
  readonly handleSessionUpdate: EffectAcpClient.AcpClientShape["handleSessionUpdate"];
  readonly handleElicitationComplete: EffectAcpClient.AcpClientShape["handleElicitationComplete"];
  readonly handleUnknownExtRequest: EffectAcpClient.AcpClientShape["handleUnknownExtRequest"];
  readonly handleUnknownExtNotification: EffectAcpClient.AcpClientShape["handleUnknownExtNotification"];
  readonly handleExtRequest: EffectAcpClient.AcpClientShape["handleExtRequest"];
  readonly handleExtNotification: EffectAcpClient.AcpClientShape["handleExtNotification"];
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
  /**
   * Resolves once every event queued so far has been consumed by the
   * `getEvents` reader (which must acknowledge the barrier). Lets a prompt's
   * completion be reported strictly after the deltas it produced.
   */
  readonly flushEvents: Effect.Effect<void>;
  /**
   * What the agent answered to `initialize`, as soon as it has: still there
   * when the session is then refused (an agent that wants a sign-in first
   * lists its sign-in methods here).
   */
  readonly getInitializeResult: Effect.Effect<EffectAcpSchema.InitializeResponse | undefined>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/** Ordering marker: the reader acknowledges it once everything before it was handled. */
export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent = AcpParsedSessionEvent | AcpSessionEventStreamBarrier;

/** Upper bound on waiting for the reader; a dead consumer must not wedge a turn. */
const EVENT_FLUSH_TIMEOUT = "5 seconds";

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export class AcpSessionRuntime extends Context.Service<AcpSessionRuntime, AcpSessionRuntimeShape>()(
  "threadlines/provider/acp/AcpSessionRuntime",
) {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<
    AcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(AcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    // The options the agent lists itself. Readers go through
    // `readConfigOptions`, which adds the legacy stand-ins for native controls.
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const legacyModelStateRef = yield* Ref.make<EffectAcpSchema.SessionModelState | undefined>(
      undefined,
    );
    const initializeResultRef = yield* Ref.make<EffectAcpSchema.InitializeResponse | undefined>(
      undefined,
    );
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    const nativeControls = options.sessionControls === "native";
    const readLegacyConfigOptions = nativeControls
      ? Effect.gen(function* () {
          return legacyControlConfigOptions({
            configOptions: yield* Ref.get(configOptionsRef),
            modeState: yield* Ref.get(modeStateRef),
            modelState: yield* Ref.get(legacyModelStateRef),
          });
        })
      : Effect.succeed<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>([]);
    const readConfigOptions = Effect.gen(function* () {
      const listed = yield* Ref.get(configOptionsRef);
      const legacy = yield* readLegacyConfigOptions;
      return legacy.length === 0 ? listed : [...listed, ...legacy];
    });

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;
    // Set once a stderr line ended the process; requests then fail with it
    // rather than with the bare "process exited" the transport reports.
    const fatalRef = yield* Ref.make<string | undefined>(undefined);
    const withFatalReason = <A>(
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      effect.pipe(
        Effect.catch((error) =>
          Ref.get(fatalRef).pipe(
            Effect.flatMap((reason) =>
              reason === undefined
                ? Effect.fail(error)
                : Effect.fail(
                    new EffectAcpErrors.AcpRequestError({
                      code: -32000,
                      errorMessage: reason,
                      data: { reason: "stderr" },
                    }),
                  ),
            ),
          ),
        ),
      );

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          withFatalReason(effect).pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          options.spawn.command,
          [...options.spawn.args],
          hideWindowsConsole({
            ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
            ...(options.spawn.env
              ? {
                  env:
                    options.spawn.inheritEnv === false
                      ? options.spawn.env
                      : { ...process.env, ...options.spawn.env },
                }
              : {}),
            // Closing the session scope must end the agent even when it
            // ignores SIGTERM, or a stuck agent blocks every teardown.
            forceKillAfter: FORCE_KILL_AFTER,
            // cmd.exe re-splits quoted argv (`bash -lc "fx acp"` → `bash -lc fx acp`),
            // so wrappers like wsl.exe opt out via `spawn.shell`.
            shell: options.spawn.shell ?? process.platform === "win32",
          }),
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    if (options.spawn.onSpawned) yield* options.spawn.onSpawned(Number(child.pid));

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
        ...(options.onStderrLine || options.stderrFailure
          ? {
              onStderrLine: (line: string) =>
                Effect.gen(function* () {
                  if (options.onStderrLine) yield* options.onStderrLine(line);
                  const reason = options.stderrFailure?.(line);
                  if (reason !== undefined && (yield* Ref.get(fatalRef)) === undefined) {
                    yield* Ref.set(fatalRef, reason);
                    // Scope cleanup's deadline doesn't apply to a direct kill.
                    yield* child.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
                  }
                }),
            }
          : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    // `session/load` replays the conversation as ordinary updates; only
    // updates produced by a prompt we sent are live content.
    const promptInFlightRef = yield* Ref.make(false);
    // A resumed session restarts segment numbering at 0 in this process, so
    // its items would collide with the ones persisted by the previous run.
    const itemIdScope = options.resumeSessionId ? `:r${Date.now().toString(36)}` : "";
    yield* acp.handleSessionUpdate((notification) =>
      handleSessionUpdate({
        queue: eventQueue,
        modeStateRef,
        toolCallsRef,
        assistantSegmentRef,
        promptInFlightRef,
        itemIdScope,
        params: notification,
        ...(nativeControls ? { configOptionsRef } : {}),
      }),
    );

    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* readConfigOptions, configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        // This message reaches the chat as the turn error; a 150-model catalog
        // spelled out there buries the one useful fact.
        const expected =
          allowedValues.length <= MAX_LISTED_CONFIG_OPTION_VALUES
            ? `expected one of ${allowedValues.join(", ")}`
            : `the agent doesn't offer it right now (${allowedValues.length} other choices available)`;
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": ${expected}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    /** A change of a legacy stand-in option, sent the way that field is set. */
    const setLegacyControl = (
      sessionId: string,
      configId: string,
      value: string,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        if (configId === LEGACY_MODE_OPTION_ID) {
          const payload = { sessionId, modeId: value };
          yield* runLoggedRequest(
            "session/set_mode",
            payload,
            acp.raw.request("session/set_mode", payload),
          );
          yield* updateCurrentModeId(value);
        } else {
          const payload = { sessionId, modelId: value };
          yield* runLoggedRequest("session/set_model", payload, acp.agent.setSessionModel(payload));
          yield* Ref.update(legacyModelStateRef, (current) =>
            current ? { ...current, currentModelId: value } : current,
          );
        }
        return { configOptions: [...(yield* readConfigOptions)] };
      });

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Effect.all([readConfigOptions, readLegacyConfigOptions]).pipe(
            Effect.flatMap(([configOptions, legacy]) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              if (legacy.some((option) => option.id === configId) && typeof value === "string") {
                return setLegacyControl(started.sessionId, configId, value);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(
                Effect.tap((response) => updateConfigOptions(response)),
                Effect.flatMap((response) =>
                  nativeControls
                    ? readConfigOptions.pipe(
                        Effect.map((composed) => ({ ...response, configOptions: composed })),
                      )
                    : Effect.succeed(response),
                ),
              );
            }),
          ),
        ),
      );

    // Native controls: the option ids are the agent's own (`permission`,
    // `sigit-model`) and can change with its updates, so they are looked up
    // when used. Mapped controls keep the conventional ids.
    const modeConfigId = nativeControls
      ? readConfigOptions.pipe(
          Effect.map(
            (configOptions) =>
              (
                configOptions.find(
                  (option) => option.id.trim().toLowerCase() === LEGACY_MODE_OPTION_ID,
                ) ??
                configOptions.find(
                  (option) => option.type === "select" && isModeConfigOption(option),
                )
              )?.id ?? LEGACY_MODE_OPTION_ID,
          ),
        )
      : Effect.succeed(LEGACY_MODE_OPTION_ID);
    const currentModelConfigId = nativeControls
      ? readConfigOptions.pipe(
          Effect.map((configOptions) => findModelConfigOption(configOptions)?.id.trim()),
        )
      : Effect.succeed<string | undefined>(undefined);

    const startOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

      yield* Ref.set(initializeResultRef, initializeResult);

      if (shouldAuthenticate(options.authMethodId, initializeResult.authMethods)) {
        const authenticatePayload = {
          methodId: options.authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;

        const authenticate = runLoggedRequest(
          "authenticate",
          authenticatePayload,
          acp.agent.authenticate(authenticatePayload),
        );
        yield* options.authenticateTimeoutMs === undefined
          ? authenticate
          : authenticate.pipe(
              Effect.timeoutOrElse({
                duration: options.authenticateTimeoutMs,
                orElse: () => Effect.fail(EffectAcpErrors.AcpRequestError.authRequired()),
              }),
            );
      }

      const mcpServers = supportedMcpServers(
        options.mcpServers ?? [],
        initializeResult.agentCapabilities?.mcpCapabilities,
      );

      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      let resumeFailure: string | undefined;
      if (options.resumeSessionId) {
        const reopenPayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers,
        } satisfies EffectAcpSchema.LoadSessionRequest & EffectAcpSchema.ResumeSessionRequest;
        // `session/resume` reopens without replaying the conversation, which
        // `session/load` streams back update by update; prefer it when offered.
        const canResume =
          initializeResult.agentCapabilities?.sessionCapabilities?.resume !== undefined &&
          initializeResult.agentCapabilities?.sessionCapabilities?.resume !== null;
        const resumed = yield* (
          canResume
            ? runLoggedRequest(
                "session/resume",
                reopenPayload,
                acp.agent.resumeSession(reopenPayload),
              )
            : runLoggedRequest("session/load", reopenPayload, acp.agent.loadSession(reopenPayload))
        ).pipe(Effect.exit);
        if (Exit.isSuccess(resumed)) {
          sessionId = options.resumeSessionId;
          sessionSetupResult = resumed.value;
        } else {
          const failure = Cause.squash(resumed.cause);
          resumeFailure =
            failure instanceof Error && failure.message ? failure.message : "unknown error";
          const createPayload = {
            cwd: options.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
        }
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers,
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      // Native controls: an agent may send its options as a notification
      // while the session opens and answer without any (`session/load`);
      // an answer that lists none must not wipe those.
      const setupListsOptions =
        sessionSetupResult.configOptions !== undefined && sessionSetupResult.configOptions !== null;
      if (!nativeControls || setupListsOptions) {
        yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
      }
      if (nativeControls) {
        yield* Ref.set(legacyModelStateRef, sessionSetupResult.models ?? undefined);
      }

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
        ...(resumeFailure !== undefined ? { resumeFailure } : {}),
      } satisfies AcpStartedState;
      return nextState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((result) =>
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      flushEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(eventQueue, { _tag: "EventStreamBarrier", acknowledge });
        yield* Deferred.await(acknowledge).pipe(Effect.timeout(EVENT_FLUSH_TIMEOUT), Effect.ignore);
      }),
      getInitializeResult: Ref.get(initializeResultRef),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: readConfigOptions,
      prompt: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;
            return closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            }).pipe(
              Effect.andThen(Ref.set(promptInFlightRef, true)),
              Effect.andThen(
                runLoggedRequest(
                  "session/prompt",
                  requestPayload,
                  acp.agent.prompt(requestPayload),
                ),
              ),
              Effect.ensuring(Ref.set(promptInFlightRef, false)),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  queue: eventQueue,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) => acp.agent.cancel({ sessionId: started.sessionId })),
      ),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return modeConfigId.pipe(
              Effect.flatMap((configId) => setConfigOption(configId, modeId)),
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      setModel: (model) =>
        Effect.all([getStartedState, currentModelConfigId]).pipe(
          Effect.flatMap(([started, currentId]) =>
            setConfigOption(currentId ?? started.modelConfigId ?? "model", model),
          ),
          Effect.asVoid,
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntimeShape;
  });

/**
 * Legacy agents omit `authMethods` and still expect `authenticate`; agents
 * that advertise a list are only authenticated with a method they listed.
 */
function shouldAuthenticate(
  authMethodId: string | undefined,
  advertised: ReadonlyArray<{ readonly id: string }> | null | undefined,
): authMethodId is string {
  if (!authMethodId) {
    return false;
  }
  if (advertised === undefined || advertised === null) {
    return true;
  }
  return advertised.some((method) => method.id === authMethodId);
}

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

const isPromptContentEvent = (event: AcpParsedSessionEvent): boolean =>
  event._tag === "ContentDelta" ||
  event._tag === "ReasoningDelta" ||
  event._tag === "ToolCallUpdated" ||
  event._tag === "PlanUpdated";

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  promptInFlightRef,
  itemIdScope,
  params,
  configOptionsRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly promptInFlightRef: Ref.Ref<boolean>;
  /** Suffix keeping item ids unique across resumes (segment numbering restarts per process). */
  readonly itemIdScope: string;
  readonly params: EffectAcpSchema.SessionNotification;
  /** Given for native controls only: the agent's own option updates land here. */
  readonly configOptionsRef?: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (configOptionsRef && params.update.sessionUpdate === "config_option_update") {
      yield* Ref.set(configOptionsRef, params.update.configOptions);
    }
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    const promptInFlight = yield* Ref.get(promptInFlightRef);
    for (const event of parsed.events) {
      if (!promptInFlight && isPromptContentEvent(event)) {
        // History replay after session/load (or stray output between
        // turns): the transcript already holds it, so it must not be
        // appended to the latest message again.
        continue;
      }
      if (event._tag === "ReasoningDelta") {
        // Reply text after this thought starts a new segment below it.
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        yield* Queue.offer(queue, event);
        continue;
      }
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: `${params.sessionId}${itemIdScope}`,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous === undefined || previous.title !== next.title || previous.detail !== next.detail;
}

const assistantItemId = (sessionId: string, segmentIndex: number) =>
  `assistant:${sessionId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
