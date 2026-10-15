#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * A Grok Build stand-in for tests: `grok agent stdio` as recorded from Grok
 * 1.0.41-1.0.60, reduced to what the Grok descriptor and the generic ACP
 * core react to. `GROK_MOCK_SCENARIO` picks the prompt's behaviour; every
 * frame the client sends is appended to `GROK_MOCK_LOG` as JSON lines.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";

const scenario = process.env.GROK_MOCK_SCENARIO ?? "simple";
const logPath = process.env.GROK_MOCK_LOG;
const sessionId = "grok-session-1";
const childSessionId = "grok-child-1";

let model = "grok-4.7";
let effort = "high";
/** The session prompts and updates go to: a resumed or forked one once opened. */
let currentSessionId = sessionId;
/**
 * Each session's prompts, by position: what `_x.ai/rewind/points` lists.
 * Kept in `GROK_MOCK_STORE` when set, so every process sees every session,
 * as Grok's sessions folder does.
 */
const storePath = process.env.GROK_MOCK_STORE;
const promptsBySession = new Map<string, Array<string>>(
  Object.entries(
    (() => {
      try {
        return storePath
          ? (JSON.parse(readFileSync(storePath, "utf8")) as Record<string, Array<string>>)
          : {};
      } catch {
        return {};
      }
    })(),
  ),
);
if (!promptsBySession.has(sessionId)) promptsBySession.set(sessionId, []);
const saveStore = () => {
  if (storePath) writeFileSync(storePath, JSON.stringify(Object.fromEntries(promptsBySession)));
};

const textOf = (prompt: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  prompt.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: model,
    options: [
      { value: "grok-4.7", name: "Grok 4.7" },
      { value: "grok-4.5", name: "Grok 4.5" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select" as const,
    currentValue: effort,
    options: [
      { value: "high", name: "High" },
      { value: "low", name: "Low" },
    ],
  },
];

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const interjected = yield* Deferred.make<string>();
  const meta = (promptId: string) => ({ promptId, eventId: `${promptId}-e`, totalTokens: 1234 });
  const say = (text: string, promptId: string, target = currentSessionId) =>
    agent.client.sessionUpdate({
      sessionId: target,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      _meta: meta(promptId),
    });
  const sessionNotice = (update: Record<string, unknown>, target = currentSessionId) =>
    agent.client.extNotification("_x.ai/session_notification", { sessionId: target, update });
  const turnEnded = (promptId: string, stopReason: string, agentResult: unknown = null) =>
    sessionNotice({
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: stopReason,
      agent_result: agentResult,
    });

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [
        { id: "cached_token", name: "Cached token" },
        { id: "grok.com", name: "Grok", description: "Sign in with Grok" },
      ],
      _meta: {
        agentVersion: "1.0.60",
        defaultAuthMethodId: "cached_token",
        modelState: {
          currentModelId: "grok-4.7",
          availableModels: [
            {
              modelId: "grok-4.7",
              name: "Grok 4.7",
              _meta: {
                reasoningEfforts: [
                  { value: "high", label: "High Effort", default: true },
                  { value: "low", label: "Low Effort" },
                ],
              },
            },
          ],
        },
      },
    }),
  );

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      configOptions: configOptions(),
      models: {
        currentModelId: "grok-4.7",
        availableModels: [
          { modelId: "grok-4.7", name: "Grok 4.7", _meta: { totalContextTokens: 500_000 } },
        ],
      },
    }),
  );
  yield* agent.handleResumeSession((request) =>
    promptsBySession.has(request.sessionId)
      ? Effect.sync(() => {
          currentSessionId = request.sessionId;
          return { configOptions: configOptions() };
        })
      : Effect.fail(AcpError.AcpRequestError.resourceNotFound(request.sessionId)),
  );
  yield* agent.handleCloseSession(() =>
    Effect.succeed({ _meta: { "x.ai/closeOutcome": "closed" } }),
  );
  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.sync(() => {
      if (request.configId === "model") model = String(request.value);
      if (request.configId === "reasoning_effort") effort = String(request.value);
      return { configOptions: configOptions() };
    }),
  );
  yield* agent.handleCancel(() => Effect.void);
  const rewindRequest = (method: string, params: unknown) =>
    // `wake-now` answers slowly, holding the prompt's turn open while its
    // wake-up starts.
    Effect.sleep(scenario === "wake-now" ? "60 millis" : "0 millis").pipe(
      Effect.andThen(() => rewindAnswer(method, params)),
    );
  const rewindAnswer = (method: string, params: unknown) =>
    Effect.sync(() => {
      const request = params as {
        readonly sessionId: string;
        readonly targetPromptIndex?: number;
        readonly cwd?: string;
      };
      const prompts = promptsBySession.get(request.sessionId) ?? [];
      if (method === "_x.ai/rewind/points") {
        return {
          rewindPoints: prompts.map((prompt, promptIndex) => ({
            promptIndex,
            promptPreview: prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt,
            hasFileChanges: false,
          })),
        };
      }
      if (method === "_x.ai/rewind/execute") {
        const target = request.targetPromptIndex ?? prompts.length;
        const promptText = prompts[target];
        prompts.splice(target);
        saveStore();
        return { success: promptText !== undefined, targetPromptIndex: target, promptText };
      }
      const newSessionId = `${request.sessionId}-fork-${promptsBySession.size}`;
      promptsBySession.set(newSessionId, [...prompts]);
      saveStore();
      return { newSessionId };
    });
  yield* agent.handleUnknownExtRequest((method, params) =>
    method === "_x.ai/rewind/points" ||
    method === "_x.ai/rewind/execute" ||
    method === "_x.ai/session/fork"
      ? rewindRequest(method, params)
      : method === "_x.ai/interject"
        ? Deferred.succeed(interjected, String((params as { text?: unknown }).text)).pipe(
            Effect.as({ status: "queued" }),
          )
        : method === "session/set_mode" || method === "_x.ai/auth/info"
          ? Effect.succeed(
              method === "_x.ai/auth/info"
                ? { methodId: "cached_token", email: "grok@example.com" }
                : {},
            )
          : Effect.fail(AcpError.AcpRequestError.methodNotFound(method)),
  );
  yield* agent.handleUnknownExtNotification(() => Effect.void);

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const promptId = String(
        (request._meta as Record<string, unknown> | undefined)?.promptId ?? "",
      );
      promptsBySession.get(currentSessionId)?.push(textOf(request.prompt));
      saveStore();
      yield* agent.client.extNotification("_x.ai/queue/changed", {
        sessionId: currentSessionId,
        entries: [],
        runningPromptId: promptId,
      });

      if (scenario === "question") {
        const answer = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          sessionId,
          toolCallId: "call-q",
          questions: [
            {
              question: "Which file?",
              options: [{ label: "a.ts" }, { label: "b.ts" }],
              multiSelect: false,
            },
          ],
          mode: "default",
        });
        yield* say(`answered ${JSON.stringify(answer)}`, promptId);
      } else if (scenario === "plan") {
        const reply = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          sessionId,
          toolCallId: "call-plan",
          planContent: "# Plan\n\n1. Do the thing",
        });
        yield* say(`plan reply ${JSON.stringify(reply)}`, promptId);
      } else if (scenario === "permission-bash" || scenario === "permission-edit") {
        const edit = scenario === "permission-edit";
        const permission = yield* agent.client.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call-perm",
            title: edit ? "Edit a.ts" : "Run npm test",
            kind: edit ? "edit" : "execute",
            status: "pending",
          },
          options: edit
            ? [
                {
                  optionId: "allow-edits-session",
                  name: "Yes, allow all edits",
                  kind: "allow_always",
                },
                { optionId: "allow-once", name: "Yes", kind: "allow_once" },
                { optionId: "reject-once", name: "No", kind: "reject_once" },
              ]
            : [
                { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
                { optionId: "allow-once", name: "Yes", kind: "allow_once" },
                { optionId: "reject-once", name: "No", kind: "reject_once" },
              ],
        });
        yield* say(`permission ${JSON.stringify(permission.outcome)}`, promptId);
      } else if (scenario === "steer") {
        yield* say("working", promptId);
        yield* say(`steered: ${yield* Deferred.await(interjected)}`, promptId);
      } else if (scenario === "error") {
        yield* turnEnded(promptId, "error", "Grok's model is overloaded. Try again soon.");
        return yield* AcpError.AcpRequestError.internalError("Internal error");
      } else if (scenario === "wake" || scenario === "wake-twice" || scenario === "wake-now") {
        yield* sessionNotice({
          sessionUpdate: "subagent_spawned",
          subagent_id: "sub-1",
          parent_session_id: sessionId,
          child_session_id: childSessionId,
          subagent_type: "general-purpose",
          description: "Sleep then reply",
          model: "grok-4.7",
        });
        yield* say("ROOT_DONE", promptId);
        // After the prompt returns: the subagent works on its own session,
        // finishes, and Grok wakes in a turn of its own.
        yield* Effect.gen(function* () {
          yield* Effect.sleep(scenario === "wake-now" ? "5 millis" : "150 millis");
          yield* say(
            "child output that must stay out of the thread",
            "child-prompt",
            childSessionId,
          );
          yield* sessionNotice(
            { sessionUpdate: "turn_completed", prompt_id: "child-prompt", stop_reason: "end_turn" },
            childSessionId,
          );
          yield* sessionNotice({
            sessionUpdate: "subagent_finished",
            subagent_id: "sub-1",
            child_session_id: childSessionId,
            status: "completed",
            output: "SUBAGENT_DONE",
            will_wake: true,
          });
          // Text-only wake-ups, one right after the other.
          for (const [index, text] of (scenario === "wake-twice"
            ? ["The subagent said SUBAGENT_DONE.", "Nothing else to do."]
            : ["The subagent said SUBAGENT_DONE."]
          ).entries()) {
            const wakeId = `subagent-completed-sub-1-${index}`;
            yield* agent.client.extNotification("_x.ai/queue/changed", {
              sessionId,
              entries: [],
              runningPromptId: wakeId,
            });
            yield* say(text, wakeId);
            yield* turnEnded(wakeId, "end_turn");
          }
        }).pipe(Effect.forkDetach);
      } else if (scenario === "remember") {
        // What this session remembers, oldest first, as its reply.
        yield* say(
          `remembers: ${(promptsBySession.get(currentSessionId) ?? []).join(" | ")}`,
          promptId,
        );
      } else {
        yield* say("hello from grok", promptId);
      }

      yield* turnEnded(promptId, "end_turn");
      yield* agent.client.extNotification("_x.ai/session/prompt_complete", {
        sessionId: currentSessionId,
        promptId,
        stopReason: "end_turn",
        agentResult: null,
      });
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
