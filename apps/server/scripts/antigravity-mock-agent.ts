#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * An `agy acp` 1.5 stand-in for tests: what the Antigravity descriptor and
 * the generic ACP core react to around a turn's end, as Google's changelog
 * and T3 Code's fixtures describe it. `AGYMOCK_SCENARIO` picks the prompt's
 * behaviour (the launcher drops `AGY_` and `ANTIGRAVITY_` variables, so the
 * names avoid both); every frame the client sends is appended to
 * `AGYMOCK_LOG` as JSON lines.
 *
 * - `simple`: replies and ends.
 * - `background`: starts a command, ends its prompt, and when the command
 *   finishes replies by itself (1.5.10), then a `usage_update` ends the reply.
 * - `hang`: starts a command that never finishes; a cancel fails it.
 * - `subagent`: launches a subagent, ends its prompt, and replies with the
 *   subagent's report later.
 * - `wake`: ends its prompt with nothing running, then replies by itself.
 * - `steer`: holds its first prompt until a second arrives, answers the first
 *   `end_turn`, and replies to the second.
 * - `log-error`: ends `end_turn`, its log's last step an upstream 502 error.
 * - `quota`: fails the prompt with Google's quota error (1.5.9).
 * - `lost-signature`: fails the prompt with the refused-thinking error.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const scenario = process.env.AGYMOCK_SCENARIO ?? "simple";
const logPath = process.env.AGYMOCK_LOG;
const profileDir = process.env.GEMINI_HOME;
let sessionCount = 0;

const QUOTA_ERROR =
  "Error 429, Message: Quota exhausted for gemini-4-argon., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:2026-11-24T01:05:00Z] reason:QUOTA_EXHAUSTED]]";
const GATEWAY_ERROR =
  "Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []";
const LOST_SIGNATURE_ERROR =
  'Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT, Details: []';

/** Appends steps to the session's log, as the CLI keeps it (step 15 a reply, 17 an error). */
function appendLogSteps(sessionId: string, steps: ReadonlyArray<readonly [number, string]>) {
  if (profileDir === undefined) return;
  const dir = join(profileDir, "antigravity-acp", "conversations");
  mkdirSync(dir, { recursive: true });
  const database = new DatabaseSync(join(dir, `${sessionId}.db`));
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
    );
    const insert = database.prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)");
    for (const [type, payload] of steps) insert.run(type, Buffer.from(payload));
  } finally {
    database.close();
  }
}

const textOf = (prompt: ReadonlyArray<AcpSchema.ContentBlock>) =>
  prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const secondPrompt = yield* Deferred.make<void>();
  let promptsSeen = 0;

  const update = (sessionId: string, value: AcpSchema.SessionUpdate) =>
    agent.client.sessionUpdate({ sessionId, update: value });
  const say = (sessionId: string, text: string) =>
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const modelCallEnds = (sessionId: string) =>
    update(sessionId, { sessionUpdate: "usage_update", used: 9_000, size: 1_048_576 });
  const command = {
    toolCallId: "call_build",
    title: "Running node build.mjs",
    kind: "execute" as const,
    rawInput: { CommandLine: "node build.mjs" },
  };

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentInfo: { name: "agy", title: "Antigravity", version: "1.5.14" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    }),
  );
  yield* agent.handleCreateSession(() =>
    Effect.sync(() => {
      sessionCount += 1;
      return {
        sessionId: `agy-session-${sessionCount}`,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "accept-edits", name: "Accept edits" },
            { id: "plan", name: "Plan" },
          ],
        },
      };
    }),
  );
  yield* agent.handleResumeSession(() => Effect.succeed({}));
  yield* agent.handleLoadSession(() => Effect.succeed({}));
  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      // 1.5.10: a cancel stops the session's commands too.
      if (scenario === "hang") {
        yield* update(String(sessionId), {
          sessionUpdate: "tool_call_update",
          toolCallId: command.toolCallId,
          status: "failed",
        });
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const sessionId = String(request.sessionId);
      promptsSeen += 1;
      if (scenario === "steer") {
        if (promptsSeen === 1) {
          yield* say(sessionId, "Working on it.");
          // Answered once the steer arrives, as 1.5.11 does.
          yield* Deferred.await(secondPrompt);
          return { stopReason: "end_turn" as const };
        }
        yield* Deferred.succeed(secondPrompt, undefined);
        yield* Effect.sleep("50 millis");
        yield* say(sessionId, `Steered: ${textOf(request.prompt)}`);
        yield* modelCallEnds(sessionId);
        return {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320 },
        };
      }
      if (scenario === "quota") {
        return yield* AcpError.AcpRequestError.internalError(QUOTA_ERROR);
      }
      if (scenario === "lost-signature") {
        return yield* AcpError.AcpRequestError.internalError(LOST_SIGNATURE_ERROR);
      }
      if (scenario === "log-error") {
        appendLogSteps(sessionId, [
          [14, textOf(request.prompt)],
          [17, GATEWAY_ERROR],
        ]);
        yield* say(sessionId, "API error: the request failed.");
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "background" || scenario === "hang") {
        yield* update(sessionId, { sessionUpdate: "tool_call", ...command, status: "in_progress" });
        yield* say(sessionId, "I'll report once the build finishes.");
        yield* modelCallEnds(sessionId);
        if (scenario === "background") {
          yield* Effect.gen(function* () {
            yield* Effect.sleep("400 millis");
            yield* update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: command.toolCallId,
              status: "completed",
              rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
            });
            yield* Effect.sleep("100 millis");
            yield* say(sessionId, "The build passed.");
            yield* modelCallEnds(sessionId);
          }).pipe(Effect.forkDetach);
        }
        return {
          stopReason: "end_turn" as const,
          usage: {
            inputTokens: 1_000,
            cachedReadTokens: 4_000,
            outputTokens: 50,
            thoughtTokens: 20,
            totalTokens: 5_050,
          },
        };
      }
      if (scenario === "subagent") {
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_research",
          kind: "other",
          title: "Running invoke_subagent",
          status: "completed",
          rawInput: { Role: "Researcher", Prompt: "Find the flaky test" },
        });
        yield* say(sessionId, "A researcher is on it.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("2500 millis");
          yield* say(sessionId, "The researcher found it.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "wake") {
        yield* say(sessionId, "Timer set.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("3000 millis");
          yield* say(sessionId, "Woke up by myself.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      yield* say(sessionId, "hello from agy");
      yield* modelCallEnds(sessionId);
      return { stopReason: "end_turn" as const };
    }),
  );

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      logPath
        ? {
            logIncoming: true,
            logger: (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string"
                ? Effect.sync(() => {
                    const payload = event.payload as string;
                    appendFileSync(
                      logPath,
                      payload.endsWith("\n") ? payload : `${payload}\n`,
                      "utf8",
                    );
                  })
                : Effect.void,
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
