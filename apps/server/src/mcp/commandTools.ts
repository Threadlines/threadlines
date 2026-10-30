/**
 * `ask_user_to_run` (docs/terminal-command-runs.md), served at
 * `/mcp/commands` by McpCommandsServer: an agent asks the user to run a shell
 * command it can't run itself, shown as a card with Run, Put in terminal and
 * Skip. Nothing runs until the user chooses.
 */
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

export const COMMANDS_MCP_SERVER_NAME = "threadlines_commands";
export const ASK_USER_TO_RUN_TOOL_NAME = "ask_user_to_run";

/** The tool as Claude names it, for its allow list. */
export const CLAUDE_COMMAND_TOOL_IDS = [
  `mcp__${COMMANDS_MCP_SERVER_NAME}__${ASK_USER_TO_RUN_TOOL_NAME}`,
] as const;

export const AskUserToRunParameters = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "The exact shell command, as the user would type it at the prompt, written for their terminal's shell. One command, or a few short lines; put anything longer in a script file and ask to run that.",
  }),
  reason: Schema.String.annotate({
    description:
      'One short sentence telling the user why you need them to run it, e.g. "It asks for your GitHub password, so I can\'t run it for you."',
  }),
});

export const AskUserToRunResult = Schema.Struct({
  outcome: Schema.Literals(["shown", "off", "not_allowed", "refused"]),
  detail: Schema.String,
});

// Read-only in the MCP sense: the call only shows a card in the caller's own
// thread; the user decides whether anything runs.
export const AskUserToRunTool = Tool.make(ASK_USER_TO_RUN_TOOL_NAME, {
  description: [
    "Ask the user to run a shell command in their Threadlines terminal, when you can't run it yourself: it needs their password or a sign-in, your sandbox or permissions blocked it, or it is a long-running process like a dev server they should own.",
    "It shows a card in the chat with Run, Put in terminal and Skip, and returns right away; nothing runs until the user chooses.",
    "When the command they run finishes, the output comes back to you as a message. Risky commands (deleting files, discarding changes, sudo, publishing and the like) can't run with one click: the user puts them in the terminal and presses Enter themselves, and the output comes back the same way.",
    "Use it instead of asking the user to copy a command into a terminal. Don't use it for commands you can run yourself.",
  ].join(" "),
  parameters: AskUserToRunParameters,
  success: AskUserToRunResult,
})
  .annotate(Tool.Title, "Ask the user to run a command")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/**
 * The short note a provider gets at session start: that the tool exists, and
 * which shell the user's terminal runs. The rules are in the tool description.
 */
export function buildCommandRequestInstructions(input: {
  /** What precedes the tool's name for this provider. */
  readonly toolPrefix?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const prefix = input.toolPrefix ?? `mcp__${COMMANDS_MCP_SERVER_NAME}__`;
  const shell =
    (input.platform ?? process.platform) === "win32"
      ? "PowerShell on Windows"
      : (input.platform ?? process.platform) === "darwin"
        ? "zsh or bash on macOS"
        : "bash or zsh on Linux";
  return `<threadlines_commands>
When the user has to run a shell command you can't run yourself (it needs their password or a sign-in, your sandbox or permissions blocked it, or it is a dev server or other long-running process they should own), call \`${prefix}${ASK_USER_TO_RUN_TOOL_NAME}\` instead of telling them to copy it into a terminal. It shows a card they can run with one click, and the output comes back to you when it finishes. Their terminal runs ${shell}.
</threadlines_commands>`;
}
