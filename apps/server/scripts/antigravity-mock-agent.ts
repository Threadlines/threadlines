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
 * - `hang`: starts a command that never finishes; a cancel fails it, then
 *   the CLI's cancellation notice follows.
 * - `exit`: starts a command, ends its prompt, then the process exits.
 * - `ignore-cancel`: never answers its prompt, a cancel included.
 * - `schedule`: sets a timer (a `Running schedule` call that stays as it
 *   started), ends its prompt, and replies when the timer fires.
 * - `subagents`: launches two subagents in one batch call; their reports come
 *   3 seconds apart.
 * - `cost`: reports a running USD cost before its answer and more after its
 *   own reply once a command ends.
 * - `steer-late-log-error`: as `steer`, but the first prompt writes its
 *   error to the log only once the steer has arrived.
 * - `subagent-quiet`: launches one subagent whose report never sends the
 *   closing `usage_update`.
 * - `permission-second`: answers its first prompt at once; a second asks
 *   for a permission before it replies.
 * - `steer-log-error`: as `steer`, but the first prompt's log ends in an
 *   error before the steer comes; the second answers cleanly.
 * - `steer-own-log-error`: as `steer`, but the steer fails upstream: its
 *   error is logged before the first prompt answers, and nothing after it.
 * - `subagent`: launches a subagent, ends its prompt, and replies with the
 *   subagent's report later. It writes no subagent records.
 * - `subagent-records`: as `subagents`, with the children's records (as
 *   1.5.12+ keeps them under `brain/`) and their reports in them.
 * - `tools`: an MCP call through `call_mcp_tool`, a long command line, and
 *   a screenshot in a tool's content.
 * - `mcp-permission`: asks to run a real `call_mcp_tool` call, then a
 *   command whose input also names an MCP tool.
 * - `mcp-lossy`: an MCP-looking call with big arguments and a field no
 *   wrapper has, after them.
 * - `mcp-then-location`: an MCP call whose later update names a file.
 * - `permission-partial`: a command update, then a permission request that
 *   names the call by its id alone.
 * - `permission-reask`: asks for an MCP call; while it waits, an update shows
 *   the call runs a command.
 * - `plan-file-permission`: asks for a command naming the plan file, then
 *   for an edit of the plan file. It writes no subagent records.
 * - `records-one-reply`: as `subagent-records`, but both children report
 *   before the agent wakes, and it answers both in one reply.
 * - `records-killed`: as `subagent-records`, but in the reply to the first
 *   child's report the agent kills the second (its record says so).
 * - `wake`: ends its prompt with nothing running, then replies by itself.
 * - `background-quick`: as `background`, but the command ends 20 ms after
 *   the answer, and the wake's reply streams in two parts 300 ms apart.
 * - `quiet-activity`: starts a command that never ends; 100 ms after the
 *   answer an update about it shows nothing new.
 * - `stuck`: starts a command that never ends, and ignores a cancel.
 * - `mode-fails-once`: the first switch back to the `default` mode fails;
 *   later ones work.
 * - `steer`: holds its first prompt until a second arrives, answers the first
 *   `end_turn`, and replies to the second.
 * - `log-error`: ends `end_turn`, its log's last step an upstream 502 error.
 * - `quota`: fails the prompt with Google's quota error (1.5.9).
 * - `lost-signature`: fails the prompt with the refused-thinking error.
 *
 * Every new session lists its slash commands right after it opens
 * (`available_commands_update`), as the 1.5 CLI does. Under `flapping` it
 * then changes the list ten times in a row.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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

/** Writes one of the CLI's JSON records under `brain/` in the profile. */
function writeBrainRecord(segments: ReadonlyArray<string>, value: unknown) {
  if (profileDir === undefined) return;
  const file = join(profileDir, "antigravity-acp", "brain", ...segments);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** A child's records as `invoke_subagent` leaves them: its entry, its launch, its steps. */
function recordChild(input: {
  readonly parent: string;
  readonly child: string;
  readonly callId: string;
  readonly role: string;
  readonly prompt: string;
  readonly state: string;
}) {
  writeBrainRecord([input.parent, ".system_generated", "subagents", `${input.child}.json`], {
    conversationId: input.child,
    subagentDescriptor: { typeName: "research", role: input.role },
    state: input.state,
  });
  writeBrainRecord([input.child, ".system_generated", "messages", "launch.json"], {
    sender: input.parent,
    content: input.prompt,
    sourceMetadata: {
      tool: {
        conversationId: input.parent,
        toolCall: {
          id: input.callId,
          name: "invoke_subagent",
          argumentsJson: JSON.stringify({ Role: input.role, Prompt: input.prompt }),
        },
      },
    },
  });
  writeBrainRecord(
    [input.child, ".system_generated", "logs", "transcript.jsonl"],
    [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${input.parent} content=${input.prompt}\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/project/api.test.ts"' } }],
      },
      { step_index: 2, type: "VIEW_FILE", status: "DONE", content: "1: it.skip('flaky')" },
      { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "Found it." },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

/** A child's report, in the parent's inbox. */
function recordReport(parent: string, child: string, content: string) {
  writeBrainRecord([parent, ".system_generated", "messages", `${child}-report.json`], {
    sender: child,
    content,
    priority: "MESSAGE_PRIORITY_HIGH",
  });
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
  // The context grows with each model call, as the CLI reports it.
  let contextUsed = 8_000;
  const modelCallEnds = (sessionId: string) =>
    Effect.suspend(() => {
      contextUsed += 1_000;
      return update(sessionId, {
        sessionUpdate: "usage_update",
        used: contextUsed,
        size: 1_048_576,
      });
    });
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
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      },
    }),
  );
  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      sessionCount += 1;
      // Unique per process, as the CLI's are: two threads never share one.
      const sessionId = `agy-${process.pid}-${sessionCount}`;
      // After the answer, as the CLI sends it.
      yield* Effect.sleep("20 millis").pipe(
        Effect.andThen(
          update(sessionId, {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "goal", description: "Work toward a goal", input: { hint: "objective" } },
              { name: "compact", description: "Summarize the conversation" },
              { name: "plan", description: "Plan before acting" },
              { name: "logout", description: "Sign out" },
            ],
          }),
        ),
        Effect.andThen(
          scenario === "flapping"
            ? Effect.forEach(
                Array.from({ length: 10 }, (_, index) => index),
                (index) =>
                  update(sessionId, {
                    sessionUpdate: "available_commands_update",
                    availableCommands: [{ name: "goal", description: `Version ${index}` }],
                  }).pipe(Effect.andThen(Effect.sleep("10 millis"))),
                { discard: true },
              )
            : Effect.void,
        ),
        Effect.forkDetach,
      );
      return {
        sessionId,
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
  // A mode switch, either way the client sends it. In `mode-fails-once`
  // the first switch back to `default` fails.
  let modeFailed = false;
  const switchMode = (modeId: unknown) => {
    if (scenario === "mode-fails-once" && modeId === "default" && !modeFailed) {
      modeFailed = true;
      return Effect.fail(AcpError.AcpRequestError.internalError("Could not switch mode."));
    }
    return Effect.void;
  };
  yield* agent.handleUnknownExtRequest((method, params) =>
    method === "session/set_mode"
      ? switchMode((params as { readonly modeId?: unknown }).modeId).pipe(Effect.as({}))
      : Effect.fail(AcpError.AcpRequestError.methodNotFound(method)),
  );
  yield* agent.handleSetSessionConfigOption((request) =>
    switchMode(request.value).pipe(Effect.as({ configOptions: [] })),
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
        // The notice lands after the turn was stopped.
        yield* Effect.gen(function* () {
          yield* Effect.sleep("150 millis");
          yield* say(String(sessionId), "The request was cancelled by the client.");
        }).pipe(Effect.forkDetach);
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const sessionId = String(request.sessionId);
      promptsSeen += 1;
      if (scenario === "ignore-cancel") {
        yield* say(sessionId, "Thinking hard.");
        return yield* Effect.never;
      }
      if (scenario === "permission-partial" || scenario === "permission-reask") {
        const options = [
          { optionId: "allow", name: "Allow", kind: "allow_once" as const },
          { optionId: "deny", name: "Deny", kind: "reject_once" as const },
        ];
        if (scenario === "permission-partial") {
          yield* update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "call_rm",
            title: "Running rm -rf build",
            kind: "execute",
            status: "pending",
            rawInput: { CommandLine: "rm -rf build" },
          });
          // The request names the call by its id alone.
          yield* agent.client.requestPermission({
            sessionId,
            toolCall: { toolCallId: "call_rm" },
            options,
          });
          yield* update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_rm",
            status: "failed",
          });
        } else {
          // Asked as an MCP call; an update while it waits shows a command.
          yield* Effect.gen(function* () {
            yield* Effect.sleep("300 millis");
            yield* update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_mcp",
              status: "pending",
              rawInput: { CommandLine: "rm -rf build" },
            });
          }).pipe(Effect.forkDetach);
          yield* agent.client.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: "call_mcp",
              title: "MCP Tool list_issues",
              kind: "execute",
              status: "pending",
              rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: {} },
            },
            options,
          });
        }
        yield* say(sessionId, "Asked.");
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "plan-file-permission") {
        const plan = join(profileDir ?? "", "antigravity-acp", "brain", sessionId, "plan.md");
        const options = [
          { optionId: "allow", name: "Allow", kind: "allow_once" as const },
          { optionId: "deny", name: "Deny", kind: "reject_once" as const },
        ];
        // A command that names the plan file is still a command.
        yield* agent.client.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call_shell",
            title: "Running cat plan.md",
            kind: "execute",
            status: "pending",
            rawInput: { CommandLine: `cat ${plan}` },
            locations: [{ path: plan }],
          },
          options,
        });
        // Writing the plan file itself needs no approval.
        yield* agent.client.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call_plan",
            title: "Write plan.md",
            kind: "edit",
            status: "pending",
            content: [{ type: "diff", path: plan, newText: "# Plan\n" }],
          },
          options,
        });
        yield* say(sessionId, "Planned.");
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "mcp-lossy") {
        // Big arguments, then a field no wrapper has: bounding could drop it.
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_lossy",
          kind: "execute",
          title: "MCP Tool list_issues",
          status: "completed",
          rawInput: {
            ServerName: "github",
            ToolName: "list_issues",
            Arguments: Object.fromEntries(
              Array.from({ length: 600 }, (_, index) => [`k${index}`, index]),
            ),
            Cwd: "/",
          },
        });
        yield* say(sessionId, "Done.");
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "mcp-then-location") {
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_wrapped",
          kind: "execute",
          title: "MCP Tool list_issues",
          status: "in_progress",
          rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: {} },
        });
        // A later update that names a file: not an MCP call after all.
        yield* update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_wrapped",
          status: "in_progress",
          locations: [{ path: "/tmp/agy-target" }],
        });
        yield* say(sessionId, "Done.");
        yield* update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_wrapped",
          status: "completed",
        });
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "mcp-permission") {
        const ask = (toolCall: AcpSchema.ToolCallUpdate) =>
          agent.client.requestPermission({
            sessionId,
            toolCall,
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          });
        // A real `call_mcp_tool` call.
        yield* ask({
          toolCallId: "call_mcp",
          title: "MCP Tool list_issues",
          kind: "execute",
          status: "pending",
          rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: { repo: "x/y" } },
        });
        // A command that also names an MCP tool: it is still a command.
        yield* ask({
          toolCallId: "call_spoof",
          title: "MCP Tool list_issues",
          kind: "execute",
          status: "pending",
          rawInput: { ServerName: "github", ToolName: "list_issues", CommandLine: "rm -rf build" },
        });
        yield* say(sessionId, "Asked twice.");
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "permission-second") {
        if (promptsSeen === 1) {
          yield* say(sessionId, "First done.");
          yield* modelCallEnds(sessionId);
          return { stopReason: "end_turn" as const };
        }
        yield* agent.client.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call_rm",
            title: "Running rm -rf build",
            kind: "execute",
            status: "pending",
            rawInput: { CommandLine: "rm -rf build" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        yield* say(sessionId, "Second done.");
        yield* modelCallEnds(sessionId);
        return { stopReason: "end_turn" as const };
      }
      if (
        scenario === "steer" ||
        scenario === "steer-log-error" ||
        scenario === "steer-late-log-error" ||
        scenario === "steer-own-log-error"
      ) {
        if (promptsSeen === 1) {
          if (scenario === "steer-log-error") appendLogSteps(sessionId, [[17, GATEWAY_ERROR]]);
          yield* say(sessionId, "Working on it.");
          // Answered once the steer arrives, as 1.5.11 does.
          yield* Deferred.await(secondPrompt);
          // Its error written only now, while the steer is under way.
          if (scenario === "steer-late-log-error") {
            appendLogSteps(sessionId, [[17, GATEWAY_ERROR]]);
          }
          return {
            stopReason: "end_turn" as const,
            usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          };
        }
        // The steer's own upstream error, logged before the first prompt answers.
        if (scenario === "steer-own-log-error") appendLogSteps(sessionId, [[17, GATEWAY_ERROR]]);
        yield* Deferred.succeed(secondPrompt, undefined);
        yield* Effect.sleep("50 millis");
        if (scenario === "steer-own-log-error") {
          yield* say(sessionId, "API error: the request failed.");
          return { stopReason: "end_turn" as const };
        }
        // The CLI logs the model's reply to the steer as a step of its own.
        appendLogSteps(sessionId, [[15, `Steered: ${textOf(request.prompt)}`]]);
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
      if (scenario === "schedule") {
        const timer = {
          toolCallId: "call_timer",
          kind: "other" as const,
          title: "Running schedule",
        };
        yield* update(sessionId, { sessionUpdate: "tool_call", ...timer, status: "in_progress" });
        yield* say(sessionId, "Timer set.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("3000 millis");
          yield* update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: timer.toolCallId,
            status: "completed",
          });
          yield* say(sessionId, "Timer fired.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "subagents" || scenario === "subagent-quiet") {
        // `subagents` launches both in one batch call.
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_launch",
          kind: "other",
          title: "Running invoke_subagent",
          status: "completed",
          rawInput:
            scenario === "subagents"
              ? {
                  Subagents: [
                    { Role: "Researcher", Prompt: "Work as Researcher" },
                    { Role: "Tester", Prompt: "Work as Tester" },
                  ],
                }
              : { Role: "Researcher", Prompt: "Work as Researcher" },
        });
        yield* say(sessionId, "Subagents are on it.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("1000 millis");
          yield* say(sessionId, "The researcher reported.");
          if (scenario === "subagent-quiet") return;
          yield* modelCallEnds(sessionId);
          yield* Effect.sleep("3000 millis");
          yield* say(sessionId, "The tester reported.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "cost") {
        // A running cost on the context fill, as fx sends it: 2 cents by the
        // answer, 5 once the agent's own reply after the command is done.
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          ...command,
          status: "in_progress",
        });
        yield* update(sessionId, {
          sessionUpdate: "usage_update",
          used: 9_000,
          size: 1_048_576,
          cost: { amount: 0.02, currency: "USD" },
        });
        yield* Effect.gen(function* () {
          yield* Effect.sleep("300 millis");
          yield* update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: command.toolCallId,
            status: "completed",
          });
          yield* say(sessionId, "Done.");
          yield* update(sessionId, {
            sessionUpdate: "usage_update",
            used: 9_500,
            size: 1_048_576,
            cost: { amount: 0.05, currency: "USD" },
          });
        }).pipe(Effect.forkDetach);
        return {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 400, outputTokens: 10, totalTokens: 410 },
        };
      }
      if (scenario === "background" || scenario === "hang" || scenario === "exit") {
        yield* update(sessionId, { sessionUpdate: "tool_call", ...command, status: "in_progress" });
        yield* say(sessionId, "I'll report once the build finishes.");
        yield* modelCallEnds(sessionId);
        if (scenario === "exit") {
          yield* Effect.gen(function* () {
            yield* Effect.sleep("400 millis");
            yield* Effect.sync((): void => process.exit(1));
          }).pipe(Effect.forkDetach);
        }
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
      if (scenario === "records-one-reply" || scenario === "records-killed") {
        const launch = (callId: string, child: string, role: string, prompt: string) =>
          Effect.gen(function* () {
            recordChild({
              parent: sessionId,
              child,
              callId,
              role,
              prompt,
              state: "SUBAGENT_STATE_ALIVE",
            });
            yield* update(sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: callId,
              kind: "other",
              // How agy 1.5 titles a launch it ran without asking.
              title: "Run invoke_subagent",
              status: "completed",
              rawInput: { Role: role, Prompt: prompt },
            });
          });
        yield* launch("call_research", "child-research", "Researcher", "Find the flaky test");
        yield* launch("call_review", "child-review", "Reviewer", "Review the fix");
        yield* say(sessionId, "Two agents are on it.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("400 millis");
          recordReport(sessionId, "child-research", "The flaky test is api.test.ts.");
          if (scenario === "records-one-reply") {
            recordReport(sessionId, "child-review", "The fix looks right.");
            yield* say(sessionId, " Both agents reported.");
          } else {
            // The kill only rewrites the child's entry.
            recordChild({
              parent: sessionId,
              child: "child-review",
              callId: "call_review",
              role: "Reviewer",
              prompt: "Review the fix",
              state: "SUBAGENT_STATE_KILLED",
            });
            yield* say(sessionId, " The researcher found it, so I stopped the reviewer.");
          }
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "subagent-records") {
        const launch = (callId: string, child: string, role: string, prompt: string) =>
          Effect.gen(function* () {
            recordChild({
              parent: sessionId,
              child,
              callId,
              role,
              prompt,
              state: "SUBAGENT_STATE_ALIVE",
            });
            yield* update(sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: callId,
              kind: "other",
              // The title the turn's hold counts; agy 1.5 also sends "Run invoke_subagent".
              title: "Running invoke_subagent",
              status: "completed",
              rawInput: { Role: role, Prompt: prompt },
            });
          });
        yield* launch("call_research", "child-research", "Researcher", "Find the flaky test");
        yield* launch("call_review", "child-review", "Reviewer", "Review the fix");
        yield* say(sessionId, "Two agents are on it.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep("400 millis");
          recordReport(sessionId, "child-research", "The flaky test is api.test.ts.");
          yield* say(sessionId, " The researcher found it.");
          yield* modelCallEnds(sessionId);
          // Longer than a held turn's settle: only the records hold it.
          yield* Effect.sleep("3000 millis");
          recordReport(sessionId, "child-review", "The fix looks right.");
          yield* say(sessionId, " The reviewer agreed.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return { stopReason: "end_turn" as const };
      }
      if (scenario === "tools") {
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_mcp",
          kind: "execute",
          title: "MCP Tool list_issues",
          status: "completed",
          rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: { repo: "x/y" } },
          rawOutput: "[]",
        });
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_long",
          kind: "execute",
          title: "Running long command",
          status: "completed",
          rawInput: { CommandLine: `echo start ${"x".repeat(9_000)} 😀 end` },
          rawOutput: { output: `${"y".repeat(9_000)}tail`, exit_code: 0 },
        });
        yield* update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_shot",
          kind: "other",
          title: "Took a screenshot",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            },
            { type: "content", content: { type: "text", text: "Screenshot taken." } },
          ],
        });
        yield* say(sessionId, "Done.");
        yield* modelCallEnds(sessionId);
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
      if (
        scenario === "background-quick" ||
        scenario === "quiet-activity" ||
        scenario === "stuck"
      ) {
        yield* update(sessionId, { sessionUpdate: "tool_call", ...command, status: "in_progress" });
        yield* say(sessionId, "I'll report once the build finishes.");
        yield* modelCallEnds(sessionId);
        yield* Effect.gen(function* () {
          yield* Effect.sleep(scenario === "quiet-activity" ? "100 millis" : "20 millis");
          if (scenario === "quiet-activity") {
            // An update about the command that shows nothing new.
            yield* update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: command.toolCallId,
              status: "in_progress",
            });
            return;
          }
          if (scenario === "stuck") return;
          yield* update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: command.toolCallId,
            status: "completed",
            rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
          });
          yield* say(sessionId, "The build");
          yield* Effect.sleep("300 millis");
          yield* say(sessionId, " passed.");
          yield* modelCallEnds(sessionId);
        }).pipe(Effect.forkDetach);
        return {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 700, outputTokens: 30, totalTokens: 730 },
        };
      }
      yield* say(sessionId, "hello from agy");
      yield* modelCallEnds(sessionId);
      return {
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      };
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
