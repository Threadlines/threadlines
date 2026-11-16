/**
 * Codex at the process boundary: our Codex runtime spawns `codex app-server`
 * through the ChildProcessSpawner service and speaks newline-delimited
 * JSON-RPC on its stdio. Recording wraps the real spawner and tees each line;
 * replay hands the runtime a fake process that answers from a transcript.
 * Everything above the process (protocol client, session runtime, adapter)
 * is the real code. Other commands (git) go to the real spawner untouched.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import { ChildProcessSpawner } from "effect/process";

import {
  applyFileChanges,
  makePathMaterializer,
  makePathScrubber,
  type FrameRedactor,
  type Recorder,
  type ReplayPaths,
} from "./recorder.ts";
import { makeReplayCursor, type ReplayCursor, type Transcript } from "./transcript.ts";

type SpawnerService = ChildProcessSpawner.ChildProcessSpawner["Service"];
type Command = Parameters<SpawnerService["spawn"]>[0];

const encoder = new TextEncoder();

/** Calls `onLine` with each complete line in a byte stream. */
function lineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length > 0) onLine(line);
      end = buffer.indexOf("\n");
    }
  };
}

function isCodexAppServer(command: Command): boolean {
  const args = (command as unknown as { readonly args?: ReadonlyArray<string> }).args ?? [];
  return args.includes("app-server");
}

type Frame = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown };

const isRequest = (frame: Frame) => frame.method !== undefined && frame.id !== undefined;
const isResponse = (frame: Frame) => frame.method === undefined && frame.id !== undefined;

/**
 * What a Codex frame is compared as. Request ids are counters that shift when
 * independent requests reorder, so they are left out (replay remaps them);
 * the client version changes with every release, and our own instructions to
 * the agent change with every copy edit (a replay tests the protocol, not
 * their wording).
 */
function normalizeCodexFrame(frame: unknown): unknown {
  const value = frame as Frame & Record<string, unknown>;
  if (value === null || typeof value !== "object") return value;
  const { id: _id, ...rest } = value;
  const normalized: Record<string, unknown> = isRequest(value) ? rest : { ...value };
  if (value.method === "turn/start") {
    const params = normalized.params as
      | { collaborationMode?: { settings?: Record<string, unknown> } }
      | undefined;
    const settings = params?.collaborationMode?.settings;
    if (settings !== undefined && "developer_instructions" in settings) {
      normalized.params = {
        ...params,
        collaborationMode: {
          ...params!.collaborationMode,
          settings: { ...settings, developer_instructions: "<ignored>" },
        },
      };
    }
  }
  if (value.method === "initialize") {
    const params = normalized.params as { clientInfo?: Record<string, unknown> } | undefined;
    if (params?.clientInfo !== undefined) {
      normalized.params = { ...params, clientInfo: { ...params.clientInfo, version: "<ignored>" } };
    }
  }
  return normalized;
}

const REASONING = "<reasoning>";

/**
 * Codex frames as stored: no machine name, install id or plan; no status for
 * the user's own MCP servers; reasoning text masked.
 */
export const redactCodexFrame: FrameRedactor = (frame) => {
  const value = frame as Frame & { params?: Record<string, unknown> };
  const params = value.params;
  switch (value.method) {
    case "remoteControl/status/changed":
      return {
        ...value,
        params: {
          ...params,
          serverName: "replay-host",
          installationId: "00000000-0000-0000-0000-000000000000",
        },
      };
    case "account/updated":
      return { ...value, params: { ...params, planType: "unknown" } };
    case "account/rateLimits/updated": {
      const rateLimits = params?.rateLimits as Record<string, unknown> | undefined;
      return {
        ...value,
        params: { ...params, rateLimits: { ...rateLimits, planType: "unknown" } },
      };
    }
    case "mcpServer/startupStatus/updated":
      return String(params?.name ?? "").startsWith("threadlines_") ? value : null;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return { ...value, params: { ...params, delta: REASONING } };
    default:
      // Reasoning anywhere: an item notification, or a turn in a history reply.
      return maskReasoning(value);
  }
};

function maskReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskReasoning);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const masked = Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, maskReasoning(entry)]),
  );
  return object.type === "reasoning" ? { ...masked, summary: [REASONING], content: [] } : masked;
}

/** Item kinds after which the agent may have changed files. */
const isFileBoundary = (frame: Frame) =>
  frame.method === "item/completed" || frame.method === "turn/completed";

/** Wraps the real spawner so each Codex app-server process is recorded. */
export function makeCodexRecordingSpawner(
  real: SpawnerService,
  recorder: Recorder,
): SpawnerService {
  let channels = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* real.spawn(command);
      if (!isCodexAppServer(command)) return handle;
      const channel = channels++;
      let killed = false;
      const recordOut = lineSplitter((line) => recorder.out(channel, JSON.parse(line)));
      const recordIn = lineSplitter((line) => {
        const frame = JSON.parse(line) as Frame;
        if (isFileBoundary(frame)) recorder.syncFiles();
        recorder.in(channel, frame);
      });
      return ChildProcessSpawner.makeHandle({
        pid: handle.pid,
        isRunning: handle.isRunning,
        unref: handle.unref,
        stderr: handle.stderr,
        all: handle.all,
        getInputFd: handle.getInputFd,
        getOutputFd: handle.getOutputFd,
        stdin: Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
          recordOut(chunk);
          return chunk;
        }),
        stdout: handle.stdout.pipe(Stream.tap((chunk) => Effect.sync(() => recordIn(chunk)))),
        kill: (options) => {
          killed = true;
          return handle.kill(options);
        },
        // An exit our own kill caused is not the provider's doing: replay ends
        // the fake process when our code kills it.
        exitCode: handle.exitCode.pipe(
          Effect.tap((code) =>
            Effect.sync(() => {
              if (!killed) recorder.exit(channel, code);
            }),
          ),
        ),
      });
    }),
  );
}

interface ReplayChannel {
  readonly output: Queue.Queue<Uint8Array, Cause.Done>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  /** Recorded request id → the id our code used for the same request. */
  readonly requestIds: Map<string, unknown>;
}

/**
 * A spawner whose Codex app-server processes answer from `transcript`. The
 * cursor reports the first mismatch (`cursor.failure`), and the fake process
 * exits with code 1 when one happens.
 */
export function makeCodexReplaySpawner(
  real: SpawnerService,
  transcript: Transcript,
  paths: ReplayPaths,
): { readonly spawner: SpawnerService; readonly cursor: ReplayCursor } {
  const scrub = makePathScrubber(paths);
  const materialize = makePathMaterializer(paths);
  const cursor = makeReplayCursor(transcript, {
    normalizeOutbound: (frame) => normalizeCodexFrame(scrub(frame)),
  });
  const channels: Array<ReplayChannel> = [];
  const end = (channel: ReplayChannel, code: number) => {
    Queue.endUnsafe(channel.output);
    Deferred.doneUnsafe(channel.exit, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
  };
  const endAll = () => channels.forEach((channel) => end(channel, 1));

  cursor.start({
    deliver: (index, frame) => {
      const channel = channels[index];
      if (channel === undefined) {
        endAll();
        throw new Error(`Recorded frame for Codex process ${index}, which was never started.`);
      }
      const value = materialize(frame) as Frame;
      const delivered =
        isResponse(value) && channel.requestIds.has(String(value.id))
          ? { ...value, id: channel.requestIds.get(String(value.id)) }
          : value;
      Queue.offerUnsafe(channel.output, encoder.encode(`${JSON.stringify(delivered)}\n`));
    },
    applyFiles: (changes) => applyFileChanges(paths.workspaceDir, changes),
    exit: (index, code) => {
      const channel = channels[index];
      if (channel !== undefined) end(channel, code);
    },
  });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!isCodexAppServer(command)) return yield* real.spawn(command);
      const index = channels.length;
      const channel: ReplayChannel = {
        output: yield* Queue.unbounded<Uint8Array, Cause.Done>(),
        exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
        requestIds: new Map(),
      };
      channels.push(channel);
      const onLine = lineSplitter((line) => {
        const frame = JSON.parse(line) as Frame;
        try {
          const result = cursor.outbound(index, frame);
          if (result.kind === "matched" && isRequest(frame)) {
            const recorded = cursor.entry(result.index) as { readonly frame: Frame } | undefined;
            channel.requestIds.set(String(recorded?.frame.id), frame.id);
          }
        } catch {
          // Kept in cursor.failure; the process dies so our code stops waiting.
          endAll();
        }
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(90_000 + index),
        exitCode: Deferred.await(channel.exit),
        isRunning: Deferred.isDone(channel.exit).pipe(Effect.map((done) => !done)),
        kill: () => Effect.sync(() => end(channel, 143)),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => Effect.sync(() => onLine(chunk))),
        stdout: Stream.fromQueue(channel.output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, cursor };
}
