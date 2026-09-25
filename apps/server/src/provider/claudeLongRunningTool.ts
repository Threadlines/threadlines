/**
 * Lets Claude say that a background command is meant to keep running.
 *
 * Claude reports a dev server and a test run the same way: a background task
 * that wakes the agent when it exits. Only the model knows it is not waiting
 * on the server, so it gets one tool to say so, and the thread settles as done
 * instead of waiting. Without the call, the adapter still stops counting a
 * command as awaited once the user's next message starts a new turn.
 *
 * In-process rather than on the HTTP endpoint the browser tools use: the
 * handler has to change the calling session's own task state, and only Claude
 * reports background tasks at all.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const THREADLINES_CLAUDE_MCP_SERVER_NAME = "threadlines";
export const MARK_LONG_RUNNING_TOOL_NAME = "mark_long_running";
/** The name Claude calls the tool by, for allow lists. */
export const MARK_LONG_RUNNING_TOOL_ID = `mcp__${THREADLINES_CLAUDE_MCP_SERVER_NAME}__${MARK_LONG_RUNNING_TOOL_NAME}`;

const MARK_LONG_RUNNING_DESCRIPTION = [
  "Tell Threadlines that a command you started with run_in_background is meant to keep running,",
  "like a dev server, a preview server, or a file watcher, and that you are not waiting for it to finish.",
  "Otherwise Threadlines shows the user that you are still waiting on the command after your turn ends.",
  "Call this once, right after starting such a command, with the task ID from its Bash result.",
  "Do not call it for commands whose result you will wait for, such as test runs, builds, or polling loops.",
].join(" ");

/**
 * Background task types that run a command rather than an agent: a shell
 * command or a Monitor watch. Only these can be left running on purpose;
 * agents always report back.
 */
export function isClaudeCommandTaskType(taskType: string | undefined): boolean {
  const normalized = taskType?.trim().toLowerCase();
  return normalized === "local_bash" || normalized === "monitor_mcp";
}

export type MarkLongRunningOutcome =
  | { readonly kind: "marked"; readonly description?: string }
  | { readonly kind: "unknown-task" }
  | { readonly kind: "not-a-command" };

/** The one result shape this tool returns; the SDK does not export its own. */
type TextToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function describeOutcome(taskId: string, outcome: MarkLongRunningOutcome): TextToolResult {
  switch (outcome.kind) {
    case "marked":
      return {
        content: [
          {
            type: "text",
            text: `Threadlines will not show you as waiting on ${taskId}${
              outcome.description ? ` (${outcome.description})` : ""
            }. It keeps running, and you are still notified if it exits.`,
          },
        ],
      };
    case "unknown-task":
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No background command with ID ${taskId} is running. Pass the task ID from the Bash result that started it.`,
          },
        ],
      };
    case "not-a-command":
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${taskId} is an agent, not a command. Threadlines always waits for agents to report back.`,
          },
        ],
      };
  }
}

/**
 * The in-process MCP server for one Claude session. `markLongRunning` applies
 * the mark to that session's task state.
 */
export function makeThreadlinesClaudeMcpServer(
  markLongRunning: (taskId: string) => Promise<MarkLongRunningOutcome>,
) {
  return createSdkMcpServer({
    name: THREADLINES_CLAUDE_MCP_SERVER_NAME,
    version: "1",
    // In the prompt rather than behind tool search: the model has to know
    // the tool exists at the moment it starts a server.
    alwaysLoad: true,
    tools: [
      tool(
        MARK_LONG_RUNNING_TOOL_NAME,
        MARK_LONG_RUNNING_DESCRIPTION,
        {
          task_id: z
            .string()
            .describe("The background task ID from the Bash result, e.g. b1a2c3d4e."),
        },
        async ({ task_id }) => {
          const taskId = task_id.trim();
          return describeOutcome(taskId, await markLongRunning(taskId));
        },
        {
          annotations: {
            title: "Mark a background command as long-running",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
}
