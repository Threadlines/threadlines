/**
 * ProviderAuthSessions - ephemeral PTY sessions for provider sign-in.
 *
 * Deliberately separate from `TerminalManager`: thread terminals are
 * thread-scoped and persist their scrollback to disk, which must never
 * happen here because an auth flow prints credentials. These sessions keep
 * a small in-memory buffer, are keyed by provider instance id, and are
 * disposed as soon as the flow ends.
 *
 * Behaviour worth knowing:
 *   - The command is derived server-side from the instance's configuration
 *     (binary path, shadow HOME / CODEX_HOME) via
 *     `@threadlines/shared/providerAuthCommands`, and spawned directly in
 *     the PTY — no intermediate shell — so process exit means "the flow
 *     finished" and the exit code is meaningful.
 *   - Starting a flow for an instance stops any flow already running for it.
 *   - `claude setup-token` output is scanned for the long-lived OAuth token.
 *     On a match the token is stored as a sensitive instance environment
 *     variable and *masked before fanout*, so no client ever receives it.
 *
 * @module provider/auth/ProviderAuthSessions
 */
import {
  ProviderAuthError,
  type ProviderAuthEvent,
  type ProviderAuthFlow,
  type ProviderAuthResizeInput,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  type ProviderAuthStatus,
  type ProviderAuthStopInput,
  type ProviderAuthWriteInput,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
} from "@threadlines/contracts";
import {
  buildProviderAuthCommand,
  CLAUDE_DRIVER_KIND,
  CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES,
  CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
  upsertClaudeLongLivedOAuthTokenEnvironment,
} from "@threadlines/shared/providerAuthCommands";
import { randomUUID } from "node:crypto";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { throwawayClaudeSpawnViolation } from "../claudeThrowawayIsolation.ts";
import { resolveOpenCodeBinary } from "../opencode/OpenCodeBinary.ts";
import { PtyAdapter, type PtyAdapterShape, type PtyProcess } from "../../terminal/Services/PTY.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderAuthTerminalCommand, ProviderInstanceAuthFlows } from "../ProviderDriver.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 26;
const DEFAULT_PARTIAL_FLUSH_DELAY_MS = 75;
const DEFAULT_SCROLLBACK_CHARS = 64_000;
/** How long a flow waits for its instance to pick up a just-saved setting. */
const REBUILD_WAIT_INTERVAL_MS = 200;
const REBUILD_WAIT_ATTEMPTS = 50;
const CAPTURE_BUFFER_CHARS = 8_192;

/**
 * The setup-token PTY is spawned much wider than any real token and never
 * resized: the CLI hard-wraps its output at the PTY width, and a token
 * wrapped onto a second line would be captured truncated and leak its tail
 * past the mask. At this width the token always arrives on one line; the
 * client's xterm still soft-wraps long lines for display.
 */
const SETUP_TOKEN_PTY_COLS = 512;

/** Placeholder swapped in for a captured token before any fanout. */
export const CAPTURED_TOKEN_MASK = "••• captured";

const TOKEN_PREFIX = "sk-ant-oat01-";
const TOKEN_BODY_CHAR = /[A-Za-z0-9_-]/;
const TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]+/;
const TOKEN_PATTERN_GLOBAL = /sk-ant-oat01-[A-Za-z0-9_-]+/g;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Index at which a trailing "this could still grow into a token" run starts,
 * or `value.length` when the tail is safe to flush.
 *
 * PTY data arrives in arbitrary chunks, so a token can straddle two events.
 * Holding the candidate tail back until it is terminated is what makes the
 * masking reliable — we never emit half a token and then the other half.
 */
export function trailingTokenCandidateIndex(value: string): number {
  const scanStart = Math.max(0, value.length - (TOKEN_PREFIX.length + 512));
  for (let index = scanStart; index < value.length; index += 1) {
    const tail = value.slice(index);
    if (tail.length <= TOKEN_PREFIX.length) {
      if (TOKEN_PREFIX.startsWith(tail)) {
        return index;
      }
      continue;
    }
    if (!tail.startsWith(TOKEN_PREFIX)) {
      continue;
    }
    const body = tail.slice(TOKEN_PREFIX.length);
    if ([...body].every((character) => TOKEN_BODY_CHAR.test(character))) {
      return index;
    }
  }
  return value.length;
}

/**
 * Split buffered PTY output into the part that is safe to broadcast and the
 * part that must stay buffered.
 *
 * `mode`:
 *   - `"line"` — a data chunk just arrived: flush whole lines only.
 *   - `"partial"` — the stream went quiet: flush the partial line too, minus
 *     any trailing token candidate (interactive prompts have no trailing
 *     newline, so without this they would never appear).
 *   - `"final"` — the process exited: nothing more can arrive, flush it all.
 */
export function splitProviderAuthOutput(
  buffer: string,
  mode: "line" | "partial" | "final",
): { readonly flush: string; readonly pending: string } {
  if (mode === "final") {
    return { flush: buffer, pending: "" };
  }
  const lineEnd = buffer.lastIndexOf("\n") + 1;
  if (mode === "line") {
    return { flush: buffer.slice(0, lineEnd), pending: buffer.slice(lineEnd) };
  }
  const rest = buffer.slice(lineEnd);
  const candidateStart = trailingTokenCandidateIndex(rest);
  return {
    flush: buffer.slice(0, lineEnd + candidateStart),
    pending: rest.slice(candidateStart),
  };
}

/**
 * Find a complete token in the raw capture stream.
 *
 * The match must be *terminated* — followed by at least one more character,
 * or the process exited — because a match at the very end of the stream may
 * still grow in the next chunk, and saving a truncated token means saving a
 * dead credential. Newlines are valid terminators only because the
 * setup-token PTY is spawned too wide (`SETUP_TOKEN_PTY_COLS`) for the CLI
 * to ever wrap the token across lines.
 */
export function findClaudeOAuthToken(value: string, options?: { final?: boolean }): string | null {
  const match = value.match(TOKEN_PATTERN);
  if (!match) return null;
  const endIndex = (match.index ?? 0) + match[0].length;
  if (endIndex >= value.length && options?.final !== true) return null;
  return match[0];
}

export function maskClaudeOAuthTokens(value: string): string {
  return value.replace(TOKEN_PATTERN_GLOBAL, CAPTURED_TOKEN_MASK);
}

export interface ProviderAuthSessionsShape {
  /**
   * Start (or restart) the auth flow for an instance. Any flow already
   * running for that instance is stopped first.
   */
  readonly start: (input: ProviderAuthStartInput) => Effect.Effect<void, ProviderAuthError>;
  readonly write: (input: ProviderAuthWriteInput) => Effect.Effect<void, ProviderAuthError>;
  readonly resize: (input: ProviderAuthResizeInput) => Effect.Effect<void, ProviderAuthError>;
  readonly stop: (input: ProviderAuthStopInput) => Effect.Effect<void, ProviderAuthError>;
  /** The user's answer to an agent's request to open a page. */
  readonly respond: (input: ProviderAuthRespondInput) => Effect.Effect<void, ProviderAuthError>;
  /**
   * Attach to one instance's event stream. Replays the current command and
   * status (plus buffered scrollback for a live run) before streaming, so a
   * reconnecting client lands on the right panel state.
   */
  readonly subscribe: (
    instanceId: ProviderInstanceId,
    listener: (event: ProviderAuthEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

export class ProviderAuthSessions extends Context.Service<
  ProviderAuthSessions,
  ProviderAuthSessionsShape
>()("threadlines/provider/auth/ProviderAuthSessions") {}

export interface ProviderAuthSessionsOptions {
  readonly ptyAdapter: PtyAdapterShape;
  readonly settings: ServerSettingsShape;
  /** The existing provider re-probe, run after a flow succeeds. */
  readonly refreshInstance: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  /** Sign-in an instance runs itself (no PTY), when it has one. */
  readonly getInstanceAuthFlows?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceAuthFlows | undefined>;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly partialFlushDelayMs?: number;
  readonly scrollbackChars?: number;
}

interface SessionState {
  readonly flow: ProviderAuthFlow;
  readonly command: string;
  /** Names this run; writes and stops for another run are refused. */
  readonly flowId: string;
  /** The starting client's `requestId`, echoed on the command event. */
  readonly requestId: string | undefined;
  /** Set for a flow the instance runs itself (browser sign-in, sign-out). */
  readonly instanceFlows: ProviderInstanceAuthFlows | null;
  /** `terminal`: a command in the PTY. `browser`: the instance's own `run`. */
  readonly surface: "terminal" | "browser";
  /** An instance's terminal command: told once how it ended. */
  terminalFinished: ((exitCode: number | null) => Effect.Effect<void>) | null;
  /** Pages the agent asked to have opened, waiting for the user's answer. */
  readonly pageRequests: Map<
    string,
    {
      readonly url: string;
      readonly message: string | null;
      readonly answered: Deferred.Deferred<boolean>;
    }
  >;
  runFiber: Fiber.Fiber<void, never> | null;
  status: ProviderAuthStatus;
  exitCode: number | null;
  detail: string | null;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  buffer: string;
  scrollback: string;
  /** Raw output kept solely for token capture; independent of flush timing. */
  captureBuffer: string;
  flushFiber: Fiber.Fiber<void, never> | null;
  tokenCaptured: boolean;
}

function readConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** A folder setting the way the runtime resolves it: `~` expanded, made absolute. */
function readConfigPath(config: unknown, key: string): string {
  const value = readConfigString(config, key).trim();
  return value ? NodePath.resolve(expandHomePath(value)) : "";
}

/**
 * Environment for the auth process: the server's environment plus the
 * instance's own variables, minus every credential override. A stale
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in scope makes the
 * interactive sign-in a no-op, which is exactly the state the user is
 * trying to fix.
 */
function buildAuthSpawnEnv(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly extraSuppressed?: ReadonlyArray<string>;
  readonly instanceEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly commandEnv: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const suppressed = new Set<string>([
    CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
    ...CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES,
    ...(input.extraSuppressed ?? []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value === undefined || suppressed.has(key)) continue;
    env[key] = value;
  }
  for (const variable of input.instanceEnvironment) {
    if (suppressed.has(variable.name)) continue;
    env[variable.name] = variable.value;
  }
  for (const [key, value] of Object.entries(input.commandEnv)) {
    env[key] = value;
  }
  return env;
}

export const makeProviderAuthSessions = Effect.fn("makeProviderAuthSessions")(function* (
  options: ProviderAuthSessionsOptions,
) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const baseEnv = options.env ?? process.env;
  const homeDir = options.homeDir ?? baseEnv.HOME ?? baseEnv.USERPROFILE ?? process.cwd();
  const partialFlushDelayMs = options.partialFlushDelayMs ?? DEFAULT_PARTIAL_FLUSH_DELAY_MS;
  const scrollbackChars = options.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS;

  const sessions = new Map<string, SessionState>();
  const listeners = new Map<string, Set<(event: ProviderAuthEvent) => Effect.Effect<void>>>();
  const startLock = yield* Semaphore.make(1);

  const publish = (instanceId: ProviderInstanceId, event: ProviderAuthEvent) =>
    Effect.gen(function* () {
      for (const listener of listeners.get(String(instanceId)) ?? []) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const publishStatus = (
    instanceId: ProviderInstanceId,
    session: SessionState,
    status: ProviderAuthStatus,
  ) =>
    Effect.gen(function* () {
      session.status = status;
      const createdAt = yield* nowIso;
      yield* publish(instanceId, {
        type: "status",
        instanceId,
        createdAt,
        status,
        exitCode: session.exitCode,
        detail: session.detail,
      });
    });

  const emitOutput = (instanceId: ProviderInstanceId, session: SessionState, data: string) =>
    Effect.gen(function* () {
      if (data.length === 0) return;
      session.scrollback = `${session.scrollback}${data}`.slice(-scrollbackChars);
      const createdAt = yield* nowIso;
      yield* publish(instanceId, { type: "output", instanceId, createdAt, data });
    });

  /**
   * Persist a captured token into the instance's environment through the
   * same settings path the manual paste flow uses, so the value lands in the
   * secret store as a sensitive variable rather than in settings.json.
   */
  const persistCapturedToken = (instanceId: ProviderInstanceId, token: string) =>
    Effect.gen(function* () {
      const settings = yield* options.settings.getSettings;
      const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
      if (!instance) {
        return yield* Effect.fail(
          new ProviderAuthError({ instanceId: String(instanceId), reason: "unknownInstance" }),
        );
      }
      const nextInstance: ProviderInstanceConfig = {
        ...instance,
        environment: upsertClaudeLongLivedOAuthTokenEnvironment(instance.environment ?? [], token),
      };
      yield* options.settings.updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: nextInstance,
        } as ServerSettings["providerInstances"],
      });
    }).pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        Effect.fail(
          new ProviderAuthError({
            instanceId: String(instanceId),
            reason: "settingsFailed",
            detail: cause.message,
          }),
        ),
      ),
    );

  const finishSuccess = (instanceId: ProviderInstanceId, session: SessionState) =>
    Effect.gen(function* () {
      yield* options.refreshInstance(instanceId);
      yield* publishStatus(instanceId, session, "succeeded");
    });

  const captureToken = (instanceId: ProviderInstanceId, session: SessionState, token: string) =>
    Effect.gen(function* () {
      session.tokenCaptured = true;
      const persisted = yield* persistCapturedToken(instanceId, token).pipe(Effect.result);
      if (persisted._tag === "Failure") {
        session.detail = persisted.failure.message;
        yield* publishStatus(instanceId, session, "failed");
        return;
      }
      yield* finishSuccess(instanceId, session);
    });

  const flushOutput = (
    instanceId: ProviderInstanceId,
    session: SessionState,
    mode: "line" | "partial" | "final",
  ) =>
    Effect.gen(function* () {
      if (session.flow !== "claude-setup-token") {
        const data = session.buffer;
        session.buffer = "";
        yield* emitOutput(instanceId, session, data);
        return;
      }

      const { flush, pending } = splitProviderAuthOutput(session.buffer, mode);
      session.buffer = pending;
      if (flush.length === 0) return;
      yield* emitOutput(instanceId, session, maskClaudeOAuthTokens(flush));
    });

  /** Scan the raw capture stream; runs on every chunk and once on exit. */
  const tryCaptureToken = (
    instanceId: ProviderInstanceId,
    session: SessionState,
    options: { readonly final: boolean },
  ) =>
    Effect.gen(function* () {
      if (session.flow !== "claude-setup-token" || session.tokenCaptured) return;
      const token = findClaudeOAuthToken(session.captureBuffer, options);
      if (token) {
        yield* captureToken(instanceId, session, token);
      }
    });

  const schedulePartialFlush = (instanceId: ProviderInstanceId, session: SessionState) =>
    Effect.gen(function* () {
      if (session.flushFiber) {
        yield* Fiber.interrupt(session.flushFiber).pipe(Effect.ignore);
        session.flushFiber = null;
      }
      const fiber = runFork(
        Effect.sleep(partialFlushDelayMs).pipe(
          Effect.andThen(flushOutput(instanceId, session, "partial")),
        ),
      );
      session.flushFiber = fiber;
    });

  const disposeProcess = (session: SessionState) =>
    Effect.sync(() => {
      session.unsubscribeData?.();
      session.unsubscribeData = null;
      session.unsubscribeExit?.();
      session.unsubscribeExit = null;
      session.process = null;
    });

  /** Tells an instance's terminal command how it ended. Once. */
  const finishTerminal = (session: SessionState, exitCode: number | null) =>
    Effect.suspend(() => {
      const finished = session.terminalFinished;
      session.terminalFinished = null;
      return finished ? finished(exitCode) : Effect.void;
    });

  /** Answers every page the agent is still waiting on with "no". */
  const declinePageRequests = (instanceId: ProviderInstanceId, session: SessionState) =>
    Effect.gen(function* () {
      for (const [pageRequestId, pending] of [...session.pageRequests]) {
        session.pageRequests.delete(pageRequestId);
        yield* publish(instanceId, {
          type: "pageRequest",
          instanceId,
          createdAt: yield* nowIso,
          flowId: session.flowId,
          requestId: pageRequestId,
          url: pending.url,
          message: pending.message,
          settled: true,
        });
        yield* Deferred.succeed(pending.answered, false);
      }
    });

  const handleExit = (instanceId: ProviderInstanceId, session: SessionState, exitCode: number) =>
    Effect.gen(function* () {
      if (session.flushFiber) {
        yield* Fiber.interrupt(session.flushFiber).pipe(Effect.ignore);
        session.flushFiber = null;
      }
      session.exitCode = exitCode;
      yield* flushOutput(instanceId, session, "final");
      yield* tryCaptureToken(instanceId, session, { final: true });
      yield* disposeProcess(session);
      session.scrollback = "";
      session.captureBuffer = "";
      // Before the status: the instance reopens itself, so the re-probe a
      // success triggers can start it.
      yield* finishTerminal(session, exitCode);

      if (session.status === "succeeded" || session.status === "failed") {
        return;
      }
      if (session.flow === "claude-setup-token") {
        session.detail = session.tokenCaptured
          ? null
          : "The command finished without printing a token.";
        yield* publishStatus(instanceId, session, session.tokenCaptured ? "succeeded" : "failed");
        return;
      }
      if (exitCode === 0) {
        yield* finishSuccess(instanceId, session);
        return;
      }
      session.detail = `The sign-in command exited with code ${exitCode}.`;
      yield* publishStatus(instanceId, session, "failed");
    });

  const stopSession = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const session = sessions.get(String(instanceId));
      if (!session) return;
      if (session.flushFiber) {
        yield* Fiber.interrupt(session.flushFiber).pipe(Effect.ignore);
        session.flushFiber = null;
      }
      const process = session.process;
      yield* disposeProcess(session);
      session.buffer = "";
      session.scrollback = "";
      session.captureBuffer = "";
      if (process) {
        yield* Effect.sync(() => process.kill()).pipe(Effect.ignore);
      }
      sessions.delete(String(instanceId));
      yield* declinePageRequests(instanceId, session);
      const runFiber = session.runFiber;
      session.runFiber = null;
      if (runFiber) yield* Fiber.interrupt(runFiber).pipe(Effect.ignore);
      yield* finishTerminal(session, null);
    });

  /** A flow the instance runs itself: progress lines in, its outcome as the status. */
  const startInstanceFlow = (
    instanceId: ProviderInstanceId,
    flow: ProviderAuthFlow,
    instanceFlows: ProviderInstanceAuthFlows,
    requestId: string | undefined,
  ) =>
    Effect.gen(function* () {
      const key = String(instanceId);
      const session: SessionState = {
        flow,
        command: instanceFlows.describe(flow),
        flowId: randomUUID(),
        requestId,
        instanceFlows,
        surface: "browser",
        terminalFinished: null,
        pageRequests: new Map(),
        runFiber: null,
        status: "starting",
        exitCode: null,
        detail: null,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        buffer: "",
        scrollback: "",
        captureBuffer: "",
        flushFiber: null,
        tokenCaptured: false,
      };
      sessions.set(key, session);
      const current = () => sessions.get(key) === session;
      yield* publish(instanceId, {
        type: "command",
        instanceId,
        createdAt: yield* nowIso,
        flow,
        command: session.command,
        flowId: session.flowId,
        ...(session.requestId !== undefined ? { requestId: session.requestId } : {}),
        surface: "browser",
      });
      yield* publishStatus(instanceId, session, "starting");
      session.runFiber = runFork(
        instanceFlows
          .run({
            flow,
            report: (line) =>
              current() ? emitOutput(instanceId, session, `${line}\r\n`) : Effect.void,
            requestPage: ({ url, message }) =>
              Effect.gen(function* () {
                if (!current() || !/^https?:\/\//iu.test(url) || url.length > 4096) return false;
                const pageRequestId = randomUUID();
                const answered = yield* Deferred.make<boolean>();
                session.pageRequests.set(pageRequestId, { url, message, answered });
                yield* publish(instanceId, {
                  type: "pageRequest",
                  instanceId,
                  createdAt: yield* nowIso,
                  flowId: session.flowId,
                  requestId: pageRequestId,
                  url,
                  message: message === null ? null : message.slice(0, 1024),
                  settled: false,
                });
                return yield* Deferred.await(answered);
              }),
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: () => (current() ? finishSuccess(instanceId, session) : Effect.void),
              onFailure: (failure) =>
                current()
                  ? Effect.gen(function* () {
                      session.detail = failure.message;
                      yield* publishStatus(instanceId, session, "failed");
                      // A failed sign-in can leave the agent signed out.
                      yield* options.refreshInstance(instanceId);
                    })
                  : Effect.void,
            }),
          ),
      );
      yield* publishStatus(instanceId, session, "running");
    });

  /**
   * The instance's flows once they were built from `entry`, the settings this
   * start just read: a flow started right after a settings save waits out
   * the rebuild, and fails rather than run the old configuration.
   */
  const currentInstanceFlows = (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
    lookup: NonNullable<ProviderAuthSessionsOptions["getInstanceAuthFlows"]>,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt += 1) {
        const flows = yield* lookup(instanceId);
        if (!flows?.builtFrom || flows.builtFrom(entry)) return flows;
        if (attempt >= REBUILD_WAIT_ATTEMPTS) {
          return yield* Effect.fail(
            new ProviderAuthError({
              instanceId: String(instanceId),
              reason: "settingsFailed",
              detail: "The new settings haven't taken effect yet. Try again in a moment.",
            }),
          );
        }
        yield* Effect.sleep(REBUILD_WAIT_INTERVAL_MS);
      }
    });

  const requireRunning = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const session = sessions.get(String(instanceId));
      if (!session?.process) {
        return yield* Effect.fail(
          new ProviderAuthError({ instanceId: String(instanceId), reason: "notRunning" }),
        );
      }
      return session.process;
    });

  const start: ProviderAuthSessionsShape["start"] = (input) =>
    startLock.withPermit(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(input.instanceId);
        yield* stopSession(instanceId);

        const settings = yield* options.settings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAuthError({
                instanceId: String(instanceId),
                reason: "settingsFailed",
                detail: cause.message,
              }),
          ),
        );
        const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
        if (!instance) {
          return yield* Effect.fail(
            new ProviderAuthError({ instanceId: String(instanceId), reason: "unknownInstance" }),
          );
        }

        const instanceFlows = options.getInstanceAuthFlows
          ? yield* currentInstanceFlows(instanceId, instance, options.getInstanceAuthFlows)
          : undefined;
        if (instanceFlows) {
          if (!instanceFlows.flows.includes(input.flow)) {
            return yield* Effect.fail(
              new ProviderAuthError({ instanceId: String(instanceId), reason: "unsupportedFlow" }),
            );
          }
          const instanceTerminal = instanceFlows.terminalCommand
            ? yield* instanceFlows.terminalCommand(input.flow).pipe(
                Effect.mapError(
                  (failure) =>
                    new ProviderAuthError({
                      instanceId: String(instanceId),
                      reason: "spawnFailed",
                      detail: failure.message,
                    }),
                ),
              )
            : undefined;
          if (!instanceTerminal) {
            return yield* startInstanceFlow(instanceId, input.flow, instanceFlows, input.requestId);
          }
          return yield* startTerminal(instanceId, input, {
            command: {
              file: instanceTerminal.file,
              args: instanceTerminal.args,
              display: instanceTerminal.display,
            },
            spawnEnv: instanceTerminal.env,
            instanceFlows,
            terminalFinished: instanceTerminal.finished,
          });
        }

        const builtCommand = buildProviderAuthCommand({
          driver: String(instance.driver),
          flow: input.flow,
          binaryPath: readConfigString(instance.config, "binaryPath"),
          // Expanded here because nothing else will: the command is spawned
          // without a shell, and the runtime expands the same settings, so a
          // `~/…` folder must mean the same folder for sign-in.
          homePath: readConfigPath(instance.config, "homePath"),
          shadowHomePath: readConfigPath(instance.config, "shadowHomePath"),
          accountFolder: readConfigPath(instance.config, "accountFolder"),
          platform: globalThis.process.platform,
        });
        if (!builtCommand) {
          return yield* Effect.fail(
            new ProviderAuthError({ instanceId: String(instanceId), reason: "unsupportedFlow" }),
          );
        }
        const isClaudeAccount =
          String(instance.driver) === CLAUDE_DRIVER_KIND &&
          readConfigString(instance.config, "accountFolder").trim().length > 0;
        const spawnEnv = buildAuthSpawnEnv({
          baseEnv,
          // An account signs in to its own folder; this would redirect the
          // login past it (to the terminal's keychain item when empty).
          ...(isClaudeAccount ? { extraSuppressed: ["CLAUDE_SECURESTORAGE_CONFIG_DIR"] } : {}),
          instanceEnvironment: instance.environment ?? [],
          commandEnv: builtCommand.env,
        });
        // A throwaway run may not sign in to (or out of) a real Claude
        // account its copied settings still point at.
        const isolationViolation =
          String(instance.driver) === CLAUDE_DRIVER_KIND
            ? throwawayClaudeSpawnViolation(spawnEnv, baseEnv)
            : undefined;
        if (isolationViolation !== undefined) {
          return yield* Effect.fail(
            new ProviderAuthError({
              instanceId: String(instanceId),
              reason: "settingsFailed",
              detail: isolationViolation,
            }),
          );
        }
        // OpenCode's installer leaves the binary off this server's PATH until
        // a restart; sign-in right after a one-click install must still work.
        const command =
          String(instance.driver) === "opencode"
            ? { ...builtCommand, file: resolveOpenCodeBinary(builtCommand.file, spawnEnv) }
            : builtCommand;
        return yield* startTerminal(instanceId, input, {
          command,
          spawnEnv,
          instanceFlows: null,
          terminalFinished: null,
        });
      }),
    );

  /** Runs a sign-in command in the PTY and streams it to the panel. */
  const startTerminal = (
    instanceId: ProviderInstanceId,
    input: ProviderAuthStartInput,
    prepared: {
      readonly command: {
        readonly file: string;
        readonly args: ReadonlyArray<string>;
        readonly display: string;
      };
      readonly spawnEnv: NodeJS.ProcessEnv;
      readonly instanceFlows: ProviderInstanceAuthFlows | null;
      readonly terminalFinished: ProviderAuthTerminalCommand["finished"] | null;
    },
  ) =>
    Effect.gen(function* () {
      const { command, spawnEnv } = prepared;
      {
        const session: SessionState = {
          flow: input.flow,
          command: command.display,
          flowId: randomUUID(),
          requestId: input.requestId,
          instanceFlows: prepared.instanceFlows,
          surface: "terminal",
          terminalFinished: prepared.terminalFinished,
          pageRequests: new Map(),
          runFiber: null,
          status: "starting",
          exitCode: null,
          detail: null,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          buffer: "",
          scrollback: "",
          captureBuffer: "",
          flushFiber: null,
          tokenCaptured: false,
        };
        sessions.set(String(instanceId), session);

        const createdAt = yield* nowIso;
        yield* publish(instanceId, {
          type: "command",
          instanceId,
          createdAt,
          flow: input.flow,
          command: command.display,
          flowId: session.flowId,
          ...(session.requestId !== undefined ? { requestId: session.requestId } : {}),
          surface: "terminal",
        });
        yield* publishStatus(instanceId, session, "starting");

        const spawned = yield* options.ptyAdapter
          .spawn({
            shell: command.file,
            args: [...command.args],
            cwd: homeDir,
            cols:
              input.flow === "claude-setup-token"
                ? SETUP_TOKEN_PTY_COLS
                : (input.cols ?? DEFAULT_COLS),
            rows: input.rows ?? DEFAULT_ROWS,
            env: spawnEnv,
          })
          .pipe(Effect.result);

        if (spawned._tag === "Failure") {
          sessions.delete(String(instanceId));
          yield* finishTerminal(session, null);
          session.detail = spawned.failure.message;
          yield* publishStatus(instanceId, session, "failed");
          return yield* Effect.fail(
            new ProviderAuthError({
              instanceId: String(instanceId),
              reason: "spawnFailed",
              detail: spawned.failure.message,
            }),
          );
        }

        const process = spawned.success;
        session.process = process;
        session.unsubscribeData = process.onData((data) => {
          runFork(
            Effect.gen(function* () {
              if (sessions.get(String(instanceId)) !== session) return;
              session.buffer += data;
              session.captureBuffer = `${session.captureBuffer}${data}`.slice(
                -CAPTURE_BUFFER_CHARS,
              );
              yield* flushOutput(instanceId, session, "line");
              yield* tryCaptureToken(instanceId, session, { final: false });
              if (session.buffer.length > 0) {
                yield* schedulePartialFlush(instanceId, session);
              }
            }),
          );
        });
        session.unsubscribeExit = process.onExit((event) => {
          runFork(
            Effect.gen(function* () {
              if (sessions.get(String(instanceId)) !== session) return;
              yield* handleExit(instanceId, session, event.exitCode);
            }),
          );
        });

        yield* publishStatus(instanceId, session, "running");
      }
    });

  const shape: ProviderAuthSessionsShape = {
    start,
    write: (input) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(input.instanceId);
        const session = sessions.get(String(instanceId));
        if (session && input.flowId !== undefined && input.flowId !== session.flowId) {
          return yield* new ProviderAuthError({
            instanceId: String(instanceId),
            reason: "inputRejected",
            detail: "That sign-in has ended. Start a new one.",
          });
        }
        if (session?.instanceFlows && session.surface === "browser") {
          if (session.status !== "running") {
            return yield* new ProviderAuthError({
              instanceId: String(instanceId),
              reason: "notRunning",
            });
          }
          yield* session.instanceFlows.completeRedirect(input.data.trim()).pipe(
            Effect.mapError(
              (failure) =>
                new ProviderAuthError({
                  instanceId: String(instanceId),
                  reason: "inputRejected",
                  detail: failure.message,
                }),
            ),
          );
          return;
        }
        const process = yield* requireRunning(instanceId);
        yield* Effect.sync(() => process.write(input.data));
      }),
    resize: (input) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(input.instanceId);
        if (sessions.get(String(instanceId))?.surface === "browser") return;
        const process = yield* requireRunning(instanceId);
        const session = sessions.get(String(instanceId));
        // The setup-token PTY stays at its extra-wide spawn size: resizing it
        // down would make the CLI re-wrap output and could split the token.
        if (session?.flow === "claude-setup-token") return;
        yield* Effect.sync(() => process.resize(input.cols, input.rows));
      }),
    stop: (input) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(input.instanceId);
        const session = sessions.get(String(instanceId));
        // A stale panel stops only its own run, never a newer one.
        if (session && input.flowId !== undefined && input.flowId !== session.flowId) return;
        yield* stopSession(instanceId);
        if (!session) return;
        // Every panel showing the run clears, not only the one that stopped it.
        yield* publish(instanceId, {
          type: "status",
          instanceId,
          createdAt: yield* nowIso,
          status: "idle",
          exitCode: null,
          detail: null,
        });
      }),
    respond: (input) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(input.instanceId);
        const session = sessions.get(String(instanceId));
        const pending =
          session?.flowId === input.flowId ? session.pageRequests.get(input.requestId) : undefined;
        if (!session || !pending) {
          return yield* new ProviderAuthError({
            instanceId: String(instanceId),
            reason: "notRunning",
          });
        }
        session.pageRequests.delete(input.requestId);
        yield* publish(instanceId, {
          type: "pageRequest",
          instanceId,
          createdAt: yield* nowIso,
          flowId: session.flowId,
          requestId: input.requestId,
          url: pending.url,
          message: pending.message,
          settled: true,
        });
        yield* Deferred.succeed(pending.answered, input.accept);
      }),
    subscribe: (instanceId, listener) =>
      Effect.gen(function* () {
        const key = String(instanceId);
        const existing = listeners.get(key) ?? new Set();
        existing.add(listener);
        listeners.set(key, existing);

        const session = sessions.get(key);
        const createdAt = yield* nowIso;
        if (session) {
          yield* listener({
            type: "command",
            instanceId,
            createdAt,
            flow: session.flow,
            command: session.command,
            flowId: session.flowId,
            ...(session.requestId !== undefined ? { requestId: session.requestId } : {}),
            surface: session.surface,
          }).pipe(Effect.ignoreCause({ log: true }));
          if (session.scrollback.length > 0) {
            yield* listener({
              type: "output",
              instanceId,
              createdAt,
              data: session.scrollback,
            }).pipe(Effect.ignoreCause({ log: true }));
          }
        }
        yield* listener({
          type: "status",
          instanceId,
          createdAt,
          status: session?.status ?? "idle",
          exitCode: session?.exitCode ?? null,
          detail: session?.detail ?? null,
        }).pipe(Effect.ignoreCause({ log: true }));
        // A panel that opens late still sees what the agent is waiting on.
        for (const [pageRequestId, pending] of session?.pageRequests ?? []) {
          yield* listener({
            type: "pageRequest",
            instanceId,
            createdAt,
            flowId: session!.flowId,
            requestId: pageRequestId,
            url: pending.url,
            message: pending.message,
            settled: false,
          }).pipe(Effect.ignoreCause({ log: true }));
        }

        return () => {
          const current = listeners.get(key);
          if (!current) return;
          current.delete(listener);
          if (current.size === 0) {
            listeners.delete(key);
          }
        };
      }),
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], (key) => stopSession(ProviderInstanceId.make(key)), {
      discard: true,
    }).pipe(Effect.ignore),
  );

  return shape;
});

export const ProviderAuthSessionsLive = Layer.effect(
  ProviderAuthSessions,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const settings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const instanceRegistry = yield* ProviderInstanceRegistry;
    return yield* makeProviderAuthSessions({
      ptyAdapter,
      settings,
      refreshInstance: (instanceId) =>
        providerRegistry.refreshInstance(instanceId).pipe(Effect.asVoid),
      getInstanceAuthFlows: (instanceId) =>
        instanceRegistry
          .getInstance(instanceId)
          .pipe(Effect.map((instance) => instance?.authFlows)),
    });
  }),
);
