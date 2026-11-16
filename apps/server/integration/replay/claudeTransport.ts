/**
 * Claude at the SDK boundary: our Claude adapter opens each session with
 * `createQuery` (ClaudeAdapterLiveOptions). Recording wraps the real SDK
 * query; replay hands the adapter a fake query that answers from a transcript.
 * The adapter, ingestion and orchestration above it are the real code.
 *
 * Frames (one channel per query):
 * - out `open`: the session's options, as an allow-listed projection (never
 *   its environment, MCP headers or other secrets), and the control methods
 *   the real SDK query had (the adapter checks for some before using them).
 * - out `prompt`: each message the SDK took from our prompt stream.
 * - out `call` / in `return` | `throw`: a control call (interrupt, setModel,
 *   getContextUsage, rewindFiles, ...) and its answer, paired by `id`.
 * - in `message`: an SDK message.
 * - in `callback` / out `callbackResult`: the SDK calling into us (canUseTool,
 *   a hook, an elicitation) and what we answered.
 */
import type { ClaudeAdapterLiveOptions } from "../../src/provider/Layers/ClaudeAdapter.ts";
import {
  applyFileChanges,
  makePathMaterializer,
  makePathScrubber,
  pick,
  type FrameRedactor,
  type Recorder,
  type ReplayPaths,
} from "./recorder.ts";
import { makeReplayCursor, type ReplayCursor, type Transcript } from "./transcript.ts";

type CreateQuery = NonNullable<ClaudeAdapterLiveOptions["createQuery"]>;
type QueryInput = Parameters<CreateQuery>[0];
type QueryRuntime = ReturnType<CreateQuery>;
type QueryOptions = QueryInput["options"];

const CONTROL_METHODS = [
  "interrupt",
  "setModel",
  "setPermissionMode",
  "setMaxThinkingTokens",
  "applyFlagSettings",
  "getContextUsage",
  "reloadPlugins",
  "reloadSkills",
  "rewindFiles",
  "stopTask",
  "backgroundTasks",
  "getTaskOutput",
  "mcpServerStatus",
  "readMcpResource",
  "request",
] as const;
type ControlMethod = (typeof CONTROL_METHODS)[number];

/**
 * Calls our code makes or skips depending on timing, so a replay may or may
 * not make them: a status refresh after 30 s, and the context meter's reading
 * after each message (one still pending when a stop closes the session).
 */
const TIMING_DEPENDENT_CALLS: ReadonlySet<ControlMethod> = new Set([
  "mcpServerStatus",
  "getContextUsage",
]);

/** The options a recording keeps: what shapes the session, nothing secret. */
const RECORDED_OPTION_KEYS = [
  "model",
  "fallbackModel",
  "cwd",
  "permissionMode",
  "resume",
  "forkSession",
  "includePartialMessages",
  "enableFileCheckpointing",
  "persistSession",
  "forwardSubagentText",
  "maxThinkingTokens",
  "effort",
  "allowedTools",
  "disallowedTools",
  "perTaskStopAffordance",
  "promptSuggestions",
  "settingSources",
  "additionalDirectories",
  "extraArgs",
] as const;

/**
 * The options as recorded and compared: what shapes the session's behaviour
 * (permissions, hooks, which MCP servers it gets), never their secrets or our
 * instruction text.
 */
function projectOptions(options: QueryOptions): Record<string, unknown> {
  const source = options as unknown as {
    readonly mcpServers?: Record<string, unknown>;
    readonly hooks?: Record<
      string,
      ReadonlyArray<{ readonly matcher?: string; readonly hooks: ReadonlyArray<unknown> }>
    >;
    readonly canUseTool?: unknown;
    readonly onElicitation?: unknown;
  } & Record<string, unknown>;
  return {
    ...Object.fromEntries(
      RECORDED_OPTION_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
    mcpServerNames: Object.keys(source.mcpServers ?? {}).toSorted(),
    hooks: Object.fromEntries(
      Object.entries(source.hooks ?? {}).map(([event, matchers]) => [
        event,
        matchers.map((matcher) => ({
          matcher: matcher.matcher ?? null,
          hooks: matcher.hooks.length,
        })),
      ]),
    ),
    canUseTool: source.canUseTool !== undefined,
    onElicitation: source.onElicitation !== undefined,
  };
}

type Callback = (...args: ReadonlyArray<unknown>) => Promise<unknown>;

/** The SDK's callbacks into us in `options`, by a stable name. */
function callbacksOf(options: QueryOptions): Map<string, Callback> {
  const source = options as unknown as {
    canUseTool?: Callback;
    onElicitation?: Callback;
    hooks?: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<Callback> }>>;
  };
  const callbacks = new Map<string, Callback>();
  if (source.canUseTool) callbacks.set("canUseTool", source.canUseTool);
  if (source.onElicitation) callbacks.set("onElicitation", source.onElicitation);
  for (const [event, matchers] of Object.entries(source.hooks ?? {})) {
    matchers.forEach((matcher, index) =>
      matcher.hooks.forEach((hook, hookIndex) =>
        callbacks.set(`hook:${event}:${index}:${hookIndex}`, hook),
      ),
    );
  }
  return callbacks;
}

/** `options` with each callback replaced by `wrap(name, callback)`. */
function withWrappedCallbacks(
  options: QueryOptions,
  wrap: (name: string, callback: Callback) => Callback,
): QueryOptions {
  const source = options as unknown as {
    canUseTool?: Callback;
    onElicitation?: Callback;
    hooks?: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<Callback> }>>;
  };
  return {
    ...options,
    ...(source.canUseTool ? { canUseTool: wrap("canUseTool", source.canUseTool) } : {}),
    ...(source.onElicitation ? { onElicitation: wrap("onElicitation", source.onElicitation) } : {}),
    ...(source.hooks
      ? {
          hooks: Object.fromEntries(
            Object.entries(source.hooks).map(([event, matchers]) => [
              event,
              matchers.map((matcher, index) => ({
                ...matcher,
                hooks: matcher.hooks.map((hook, hookIndex) =>
                  wrap(`hook:${event}:${index}:${hookIndex}`, hook),
                ),
              })),
            ]),
          ),
        }
      : {}),
  } as QueryOptions;
}

const SIGNAL = "<signal>";

/** Callback arguments as JSON: an AbortSignal becomes a marker the replay turns back into one. */
function serializeArgs(args: ReadonlyArray<unknown>): unknown {
  const replace = (value: unknown): unknown => {
    if (value instanceof AbortSignal) return SIGNAL;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
    }
    return value;
  };
  return JSON.parse(JSON.stringify(replace(args)) ?? "null");
}

function deserializeArgs(args: unknown): ReadonlyArray<unknown> {
  const replace = (value: unknown): unknown => {
    if (value === SIGNAL) return new AbortController().signal;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
    }
    return value;
  };
  return replace(args) as ReadonlyArray<unknown>;
}

const toJson = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null");

const isOwnServer = (name: unknown) => String(name ?? "").startsWith("threadlines_");

const BUILT_IN_AGENTS: ReadonlySet<string> = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "output-style-setup",
]);

/** The init fields the recording keeps; the user's plugins, skills and commands are left out. */
const INIT_KEYS = [
  "type",
  "subtype",
  "cwd",
  "session_id",
  "model",
  "permissionMode",
  "apiKeySource",
  "claude_code_version",
  "output_style",
  "capabilities",
  "uuid",
  "original_cwd",
  "additional_directories",
  "fast_mode_state",
  "fast_mode_disabled_reason",
  "per_turn_effort_active",
  "ultrathink_available",
  "ultrathink_typed_raises",
  "view_mode",
  "user_message_uuids",
  "terminal_slash_commands",
];
const CONTEXT_USAGE_KEYS = [
  "categories",
  "totalTokens",
  "maxTokens",
  "rawMaxTokens",
  "autocompactSource",
  "percentage",
  "model",
  "autoCompactThreshold",
  "isAutoCompactEnabled",
  "apiUsage",
];
const RATE_LIMIT_KEYS = [
  "status",
  "resetsAt",
  "rateLimitType",
  "utilization",
  "surpassedThreshold",
  "unifiedWindows",
];

function redactSdkMessage(message: Record<string, unknown>): Record<string, unknown> {
  if (message.type === "system" && message.subtype === "init") {
    return {
      ...pick(message, INIT_KEYS),
      tools: ((message.tools as ReadonlyArray<string> | undefined) ?? []).filter(
        (tool) => !tool.startsWith("mcp__") || tool.startsWith("mcp__threadlines_"),
      ),
      mcp_servers: (
        (message.mcp_servers as ReadonlyArray<{ name?: unknown }> | undefined) ?? []
      ).filter((server) => isOwnServer(server.name)),
      // Claude Code's own agents only: the user's and their plugins' are their setup.
      agents: ((message.agents as ReadonlyArray<string> | undefined) ?? []).filter((agent) =>
        BUILT_IN_AGENTS.has(agent),
      ),
      slash_commands: [],
      skills: [],
      plugins: [],
    };
  }
  if (message.type === "system" && message.subtype === "commands_changed") {
    return { ...message, commands: [] };
  }
  if (message.type === "rate_limit_event") {
    return { ...message, rate_limit_info: pick(message.rate_limit_info, RATE_LIMIT_KEYS) };
  }
  return maskThinking(message) as Record<string, unknown>;
}

/** Thinking anywhere in a message (a block, a stream delta, a subagent's), masked. */
function maskThinking(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskThinking);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const masked = Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, maskThinking(entry)]),
  );
  if (object.type === "thinking" || object.type === "thinking_delta") {
    return {
      ...masked,
      thinking: "<thinking>",
      ...("signature" in object ? { signature: "<signature>" } : {}),
    };
  }
  if (object.type === "signature_delta") return { ...masked, signature: "<signature>" };
  if (object.type === "redacted_thinking") return { ...masked, data: "<redacted>" };
  return masked;
}

/** A tool's input streamed in pieces: the whole input arrives in the assistant message after. */
const isToolInputDelta = (message: Record<string, unknown>) =>
  message.type === "stream_event" &&
  (message.event as { delta?: { type?: unknown } } | undefined)?.delta?.type === "input_json_delta";

/**
 * Claude frames as stored: no plugins, skills, connected services, plan or
 * credit state, and no thinking text (it can quote personal instructions).
 */
export const redactClaudeFrame: FrameRedactor = (frame) => {
  const value = frame as ClaudeFrame & Record<string, unknown>;
  if (value.op === "message") {
    const message = value.message as Record<string, unknown>;
    // Its pieces can split a path the scrubber would otherwise catch whole.
    if (isToolInputDelta(message)) return null;
    return { ...value, message: redactSdkMessage(message) };
  }
  if (value.op === "return" && Array.isArray(value.value)) {
    // mcpServerStatus: the user's own servers are their setup.
    return {
      ...value,
      value: (value.value as ReadonlyArray<{ name?: unknown }>).filter((server) =>
        isOwnServer(server?.name),
      ),
    };
  }
  if (value.op === "return" && value.value !== null && typeof value.value === "object") {
    const answer = value.value as Record<string, unknown>;
    if ("categories" in answer && "totalTokens" in answer) {
      return { ...value, value: pick(answer, CONTEXT_USAGE_KEYS) };
    }
  }
  return value;
};

/** SDK messages after which the agent may have changed files. */
const isFileBoundary = (message: { readonly type?: unknown }) =>
  message.type === "user" || message.type === "result";

/** Wraps `createQuery` (the real SDK query by default) so each session is recorded. */
export function makeClaudeRecordingQuery(real: CreateQuery, recorder: Recorder): CreateQuery {
  let channels = 0;
  return (input) => {
    const channel = channels++;
    let nextId = 0;
    const openFrame: { op: string; options: Record<string, unknown>; methods?: Array<string> } = {
      op: "open",
      options: projectOptions(input.options),
    };
    recorder.out(channel, openFrame);
    const prompt = (async function* () {
      for await (const message of input.prompt) {
        recorder.out(channel, { op: "prompt", message: toJson(message) });
        yield message;
      }
    })();
    const options = withWrappedCallbacks(input.options, (name, callback) => async (...args) => {
      const id = nextId++;
      recorder.in(channel, { op: "callback", id, name, args: serializeArgs(args) });
      const value = await callback(...args);
      recorder.out(channel, { op: "callbackResult", id, value: toJson(value) });
      return value;
    });
    const runtime = real({ prompt, options });
    openFrame.methods = CONTROL_METHODS.filter((method) => runtime[method] !== undefined);
    const proxy: Record<string, unknown> = {
      [Symbol.asyncIterator]: async function* () {
        for await (const message of runtime) {
          if (isFileBoundary(message)) recorder.syncFiles();
          recorder.in(channel, { op: "message", message: toJson(message) });
          yield message;
        }
      },
      close: () => runtime.close(),
    };
    for (const method of CONTROL_METHODS) {
      const target = runtime[method] as
        | ((...args: ReadonlyArray<unknown>) => Promise<unknown>)
        | undefined;
      if (target === undefined) continue;
      proxy[method] = async (...args: ReadonlyArray<unknown>) => {
        const id = nextId++;
        recorder.out(channel, { op: "call", id, method, args: toJson(args) });
        try {
          const value = await target.apply(runtime, [...args]);
          recorder.in(channel, { op: "return", id, value: toJson(value) });
          return value;
        } catch (error) {
          recorder.in(channel, { op: "throw", id, message: String(error) });
          throw error;
        }
      };
    }
    return proxy as unknown as QueryRuntime;
  };
}

type ClaudeFrame = {
  readonly op?: string;
  readonly id?: number;
  readonly method?: string;
  readonly name?: string;
  readonly args?: unknown;
  readonly value?: unknown;
  readonly message?: unknown;
};

/**
 * What a Claude frame is compared as: a call's id shifts when independent
 * calls reorder, and the SDK methods on `open` are the recording's facts,
 * not something our code sends.
 */
function normalizeClaudeFrame(frame: unknown): unknown {
  const value = frame as ClaudeFrame & { readonly methods?: unknown };
  if (value?.op === "call") {
    const { id: _id, ...rest } = value;
    return rest;
  }
  if (value?.op === "open") {
    const { methods: _methods, ...rest } = value;
    return rest;
  }
  return frame;
}

interface ReplayQueryChannel {
  readonly messages: Array<unknown>;
  waiting: ((result: IteratorResult<unknown>) => void) | null;
  ended: boolean;
  readonly callbacks: Map<string, Callback>;
  /** Recorded call id → our pending call. */
  readonly calls: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
}

/**
 * A `createQuery` whose sessions answer from `transcript`. The cursor reports
 * the first mismatch (`cursor.failure`), and every session ends when one
 * happens.
 */
export function makeClaudeReplayQuery(
  transcript: Transcript,
  paths: ReplayPaths,
): { readonly createQuery: CreateQuery; readonly cursor: ReplayCursor } {
  const scrub = makePathScrubber(paths);
  const materialize = makePathMaterializer(paths);
  const lastAnswer = new Map<string, unknown>();
  /** Each recorded call's answer, by `channel:id`. */
  const recordedAnswers = new Map<string, unknown>();
  for (const entry of transcript.entries) {
    const frame = (entry as { frame?: ClaudeFrame }).frame;
    if (entry.type === "in" && frame?.op === "return") {
      recordedAnswers.set(`${entry.channel}:${frame.id}`, materialize(frame.value));
      const call = transcript.entries.find(
        (other) =>
          other.type === "out" &&
          other.channel === entry.channel &&
          (other.frame as ClaudeFrame).op === "call" &&
          (other.frame as ClaudeFrame).id === frame.id,
      );
      const method = (call as { frame?: ClaudeFrame } | undefined)?.frame?.method;
      if (method !== undefined) lastAnswer.set(method, frame.value);
    }
  }
  const cursor = makeReplayCursor(transcript, {
    normalizeOutbound: (frame) => normalizeClaudeFrame(scrub(frame)),
    optional: (frame) => {
      const call = frame as ClaudeFrame;
      return call.op === "call" && TIMING_DEPENDENT_CALLS.has(call.method as ControlMethod);
    },
    unrecordedOutbound: (frame) => {
      const call = frame as ClaudeFrame;
      return call.op === "call" && TIMING_DEPENDENT_CALLS.has(call.method as ControlMethod)
        ? { answer: lastAnswer.get(call.method!) ?? null }
        : undefined;
    },
  });
  const channels: Array<ReplayQueryChannel> = [];

  const push = (channel: ReplayQueryChannel, message: unknown) => {
    if (channel.waiting !== null) {
      const resolve = channel.waiting;
      channel.waiting = null;
      resolve({ value: message, done: false });
    } else {
      channel.messages.push(message);
    }
  };
  const end = (channel: ReplayQueryChannel) => {
    channel.ended = true;
    if (channel.waiting !== null) {
      const resolve = channel.waiting;
      channel.waiting = null;
      resolve({ value: undefined, done: true });
    }
    for (const call of channel.calls.values())
      call.reject(new Error("The replayed session ended."));
    channel.calls.clear();
  };
  const endAll = () => channels.forEach(end);
  const sendOut = (index: number, frame: unknown) => {
    try {
      return cursor.outbound(index, frame);
    } catch (error) {
      endAll();
      throw error;
    }
  };

  cursor.start({
    deliver: (index, frame) => {
      const channel = channels[index];
      if (channel === undefined) {
        endAll();
        throw new Error(`Recorded frame for Claude session ${index}, which was never opened.`);
      }
      const value = materialize(frame) as ClaudeFrame;
      if (value.op === "message") {
        push(channel, value.message);
      } else if (value.op === "return" || value.op === "throw") {
        const call = channel.calls.get(value.id!);
        channel.calls.delete(value.id!);
        if (value.op === "return") call?.resolve(value.value);
        else call?.reject(new Error(String((value as { message?: unknown }).message)));
      } else if (value.op === "callback") {
        const callback = channel.callbacks.get(value.name!);
        if (callback === undefined) {
          endAll();
          throw new Error(`The recording calls ${value.name}, which this session doesn't have.`);
        }
        const id = value.id!;
        void callback(...deserializeArgs(value.args)).then(
          (result) => {
            try {
              sendOut(index, { op: "callbackResult", id, value: toJson(result) });
            } catch {
              // Kept in cursor.failure.
            }
          },
          () => endAll(),
        );
      }
    },
    applyFiles: (changes) => applyFileChanges(paths.workspaceDir, changes),
    exit: (index) => {
      const channel = channels[index];
      if (channel !== undefined) end(channel);
    },
  });

  const createQuery: CreateQuery = (input) => {
    const index = channels.length;
    const channel: ReplayQueryChannel = {
      messages: [],
      waiting: null,
      ended: false,
      callbacks: callbacksOf(input.options),
      calls: new Map(),
    };
    channels.push(channel);
    const opened = sendOut(index, { op: "open", options: projectOptions(input.options) });
    const recordedMethods = new Set(
      opened.kind === "matched"
        ? ((cursor.entry(opened.index) as { frame: { methods?: ReadonlyArray<string> } }).frame
            .methods ?? [])
        : [],
    );
    void (async () => {
      for await (const message of input.prompt) {
        if (channel.ended || cursor.failure !== null) return;
        try {
          sendOut(index, { op: "prompt", message: toJson(message) });
        } catch {
          return;
        }
      }
    })();
    const runtime: Record<string, unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            const message = channel.messages.shift();
            if (message !== undefined) resolve({ value: message, done: false });
            else if (channel.ended) resolve({ value: undefined, done: true });
            else channel.waiting = resolve;
          }),
        return: () => {
          end(channel);
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
      close: () => end(channel),
    };
    for (const method of CONTROL_METHODS) {
      // The methods the recorded SDK query had.
      if (!recordedMethods.has(method)) continue;
      runtime[method] = (...args: ReadonlyArray<unknown>) =>
        new Promise((resolve, reject) => {
          const result = sendOut(index, { op: "call", method, args: toJson(args) });
          if (result.kind === "unrecorded") {
            resolve(result.answer);
            return;
          }
          const recordedId = (cursor.entry(result.index) as { frame: ClaudeFrame }).frame.id!;
          // A timing-dependent call doesn't hold back what follows it, so its
          // recorded answer may already have gone by: answer it at once.
          if (TIMING_DEPENDENT_CALLS.has(method)) {
            resolve(
              recordedAnswers.get(`${index}:${recordedId}`) ?? lastAnswer.get(method) ?? null,
            );
            return;
          }
          channel.calls.set(recordedId, { resolve, reject });
        });
    }
    return runtime as unknown as QueryRuntime;
  };
  return { createQuery, cursor };
}
