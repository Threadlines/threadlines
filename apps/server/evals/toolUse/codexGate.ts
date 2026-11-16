/**
 * The billing and isolation check for a Codex eval session, in the session
 * itself: the process Threadlines starts asks Codex for its sign-in, model
 * provider and MCP servers right after it initializes, and our code's first
 * `turn/start` (the first model request) waits until every answer passes.
 * Its own requests and their answers never reach our code.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { EvalSetupError } from "./isolation.ts";

type SpawnerService = ChildProcessSpawner.ChildProcessSpawner["Service"];

/** The tool servers Threadlines itself adds to an eval session (pages and commands are off). */
const THREADLINES_SERVERS: ReadonlySet<string> = new Set([
  "threadlines_browser",
  "threadlines_room",
  "threadlines_pages",
  "threadlines_commands",
]);

const CHECKS = {
  "eval-gate-account": "account/read",
  "eval-gate-providers": "modelProvider/list",
  "eval-gate-servers": "mcpServerStatus/list",
} as const;
type CheckId = keyof typeof CHECKS;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Why `answer` to `id` fails the session, or null when it passes. */
function checkProblem(id: CheckId, answer: { result?: unknown; error?: unknown }): string | null {
  if (answer.error !== undefined || answer.result === undefined) {
    return `Codex couldn't answer ${CHECKS[id]}, so the session can't be checked.`;
  }
  switch (id) {
    case "eval-gate-account": {
      const type = (answer.result as { account?: { type?: string } | null }).account?.type;
      return type === "chatgpt"
        ? null
        : `Codex isn't signed in with ChatGPT (${type ?? "signed out"}).`;
    }
    case "eval-gate-providers": {
      const provider = (answer.result as { defaultProviderId?: string }).defaultProviderId;
      return provider === "openai"
        ? null
        : `Codex uses the model provider ${provider}, not OpenAI.`;
    }
    case "eval-gate-servers": {
      const servers = (answer.result as { data?: unknown }).data;
      if (!Array.isArray(servers)) return "Codex didn't list its MCP servers.";
      const foreign = servers
        .map((server: { name?: unknown }) => String(server.name))
        .filter((name) => !THREADLINES_SERVERS.has(name));
      return foreign.length === 0
        ? null
        : `Codex has MCP servers besides Threadlines' (${foreign.join(", ")}).`;
    }
  }
}

/**
 * Wraps the real spawner: each `codex app-server` it starts is checked before
 * its first turn. `onBlocked` hears why a session was stopped.
 */
export function makeGatedCodexSpawner(
  real: SpawnerService,
  onBlocked: (reason: string) => void,
): SpawnerService {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* real.spawn(command);
      const args = (command as unknown as { readonly args?: ReadonlyArray<string> }).args ?? [];
      if (!args.includes("app-server")) return handle;

      const gate = yield* Deferred.make<void, EvalSetupError>();
      const passed = new Set<CheckId>();
      let provider: string | undefined;
      const fail = (reason: string) => {
        onBlocked(reason);
        Deferred.doneUnsafe(gate, Effect.fail(new EvalSetupError(reason)));
      };
      const settle = () => {
        if (passed.size === Object.keys(CHECKS).length && provider !== undefined) {
          if (provider === "openai") Deferred.doneUnsafe(gate, Effect.void);
          else fail(`Codex started the thread on the model provider ${provider}, not OpenAI.`);
        }
      };

      /** Our own answers are read and dropped; a thread's start says its provider. */
      const keep = (line: string): boolean => {
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return true;
        }
        if (typeof message.id === "string" && message.id in CHECKS) {
          const id = message.id as CheckId;
          const problem = checkProblem(id, message);
          if (problem !== null) fail(problem);
          else passed.add(id);
          settle();
          return false;
        }
        const started = message.result as { thread?: unknown; modelProvider?: unknown } | undefined;
        if (started?.thread !== undefined && typeof started.modelProvider === "string") {
          provider = started.modelProvider;
          settle();
        }
        return true;
      };

      const checks = Object.entries(CHECKS)
        .map(([id, method]) => `${JSON.stringify({ id, method, params: {} })}\n`)
        .join("");
      const stdin = Sink.mapInputEffect(handle.stdin, (chunk: Uint8Array) =>
        Effect.gen(function* () {
          const text = decoder.decode(chunk);
          // The first model request waits for the checks.
          if (text.includes('"method":"turn/start"')) yield* Deferred.await(gate);
          // Right after the session initializes, ask for what the checks need.
          return text.includes('"method":"initialized"')
            ? encoder.encode(`${text.endsWith("\n") ? text : `${text}\n`}${checks}`)
            : chunk;
        }).pipe(Effect.orDie),
      );
      const stdout = handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter(keep),
        Stream.map((line) => encoder.encode(`${line}\n`)),
      );
      return ChildProcessSpawner.makeHandle({
        pid: handle.pid,
        exitCode: handle.exitCode,
        isRunning: handle.isRunning,
        kill: handle.kill,
        unref: handle.unref,
        stderr: handle.stderr,
        all: handle.all,
        getInputFd: handle.getInputFd,
        getOutputFd: handle.getOutputFd,
        stdin,
        stdout,
      });
    }),
  );
}
