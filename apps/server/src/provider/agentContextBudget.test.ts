/**
 * What Threadlines adds to every request of a Claude thread, pinned.
 *
 * A thread's system prompt and the tool definitions in it are sent with every
 * request. Nobody watched their size, and together they had grown to about
 * 26,000 tokens before anyone measured. This test fails when any of it
 * changes size, so a change that grows it shows up in review as a line in
 * agentContextBudget.json and not as a slower, costlier thread months later.
 *
 * When it fails: set agentContextBudget.json to the measured values, and say
 * in the pull request why the growth is worth it. A tool a thread rarely
 * calls belongs behind tool search (mcp/toolLoading.ts) before it belongs in
 * the prompt. Before moving a tool out of the prompt, check with a real
 * Claude session that it still finds the tool.
 */
import { Tool } from "effect/ai";
import { expect, it } from "vite-plus/test";

import { AlertAssistantsToolkit } from "../mcp/alertAssistantsTools.ts";
import { ProjectNoteToolkit } from "../mcp/projectNoteTools.ts";
import { BrowserScreenshotToolkit, BrowserStandardToolkit } from "../mcp/browserTools.ts";
import { AskUserToRunTool } from "../mcp/commandTools.ts";
import { GuideToolkit } from "../mcp/guideTools.ts";
import { PreviewPageTool, ShowPageTool } from "../mcp/pageTools.ts";
import { roomToolsFor } from "../mcp/roomToolAccess.ts";
import { RoomToolkit } from "../mcp/roomTools.ts";
import { ScheduleToolkit } from "../mcp/scheduleTools.ts";
import { SecretRequestToolkit } from "../mcp/secretRequestTools.ts";
import { SettingsChangeToolkit } from "../mcp/settingsChangeTools.ts";
import { FindVsCodeThemeTool, PreviewThemeTool, ShowThemeTool } from "../mcp/themeTools.ts";
import { ThreadToolkit } from "../mcp/threadTools.ts";
import { isLoadedUpFront } from "../mcp/toolLoading.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import { buildClaudeSystemPromptAppend } from "./Layers/ClaudeAdapter.ts";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Runs `measure` as on Linux, where the budget is measured. The prompt names
 * the user's shell, which is a byte longer on Windows.
 */
function onLinux<A>(measure: () => A): A {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    return measure();
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

/** Every tool an ordinary thread's Claude session is given over MCP. */
const threadTools: ReadonlyArray<Tool.Any> = [
  ...[
    BrowserStandardToolkit,
    BrowserScreenshotToolkit,
    RoomToolkit,
    ThreadToolkit,
    ScheduleToolkit,
    GuideToolkit,
    SettingsChangeToolkit,
    SecretRequestToolkit,
    AlertAssistantsToolkit,
    ProjectNoteToolkit,
  ].flatMap((toolkit) => Object.values(toolkit.tools) as ReadonlyArray<Tool.Any>),
  ShowPageTool,
  PreviewPageTool,
  PreviewThemeTool,
  ShowThemeTool,
  FindVsCodeThemeTool,
  AskUserToRunTool,
  // A scheduled run's own tool is left out: only its thread has it.
].filter((tool) => tool.name !== "scheduled_run_finish");

/** The fields of a definition the model reads. Annotations are protocol metadata. */
const definitionBytes = (tools: ReadonlyArray<Tool.Any>) =>
  utf8Bytes(
    JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
      })),
    ),
  );

it("what a Claude thread is sent on every request matches the committed budget", () => {
  const upFront = threadTools.filter(isLoadedUpFront);
  const onDemand = threadTools.filter((tool) => !isLoadedUpFront(tool));
  const measured = {
    // Every optional section on, as in a thread with pages, artifacts,
    // command requests, schedules and the room tools, in a
    // Threadlines-managed worktree.
    claudeSystemAppendBytes: utf8Bytes(
      onLinux(() =>
        buildClaudeSystemPromptAppend({
          pageAssetsDir: "/tmp/threadlines-page-assets/thread",
          artifacts: true,
          commandRequests: true,
          room: { tools: roomToolsFor(undefined), schedules: true },
          lockdown: false,
          managedWorktree: true,
        }),
      ),
    ),
    // In the prompt from the first turn. `mark_long_running`, Claude's own
    // in-process tool, is there too and is not measured here.
    upFrontTools: upFront.map((tool) => tool.name).toSorted(),
    upFrontToolDefinitionBytes: definitionBytes(upFront),
    // Listed by name; Claude Code loads one when the model looks it up.
    onDemandToolDefinitionBytes: definitionBytes(onDemand),
  };

  expect(
    measured,
    "Set agentContextBudget.json to the measured values, and say in the pull request why the change is worth its size.",
  ).toEqual(budget);
});
