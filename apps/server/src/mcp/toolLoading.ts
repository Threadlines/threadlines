/**
 * Which Threadlines tools Claude Code holds in its prompt from the first turn,
 * and which it looks up when it needs them.
 *
 * Every tool definition in the prompt is sent with every request of every
 * thread. All of them together were about 24,000 tokens, most of it for tools
 * a thread rarely calls (scheduling, themes, starting other threads). Claude
 * Code can keep a tool out of the prompt and list only its name; the model
 * then loads the definition with ToolSearch before its first call. A tool
 * marked here is loaded that way. An unmarked tool stays in the prompt.
 *
 * Threadlines' servers stay `alwaysLoad` in the Claude session's config, so
 * Claude Code still waits for them before the first turn and the unmarked
 * tools are there when it starts; the mark is the exception the SDK documents
 * for a tool "the server itself lists with _meta anthropic/alwaysLoad set to
 * false". A Claude Code too old to know the mark loads every tool, as before.
 * Other providers ignore it.
 *
 * Keep a tool unmarked when a model that cannot see it does the wrong thing
 * instead of looking for it (the browser's entry tools, `show_page`,
 * `ask_user_to_run`, `room_ask`), or when a locked-down side answer needs it:
 * a side answer has no ToolSearch (`room_history`, `room_diff`, `app_guide`).
 * What is loaded up front is pinned by agentContextBudget.test.ts.
 *
 * @module toolLoading
 */
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

/** The `_meta` key Claude Code reads to keep a tool in or out of the prompt. */
export const CLAUDE_ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/** Marks a tool Claude Code loads when the model looks it up, not up front. */
export const loadedOnDemand = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Meta, { [CLAUDE_ALWAYS_LOAD_META_KEY]: false }) as T;

/**
 * The `_meta` of a tool, for a server that registers it by hand. A toolkit
 * passes it on by itself.
 */
export const toolMeta = (tool: Tool.Any): Record<string, unknown> | undefined =>
  Context.getOrUndefined(tool.annotations, Tool.Meta);

/** Whether Claude Code holds this tool in its prompt from the first turn. */
export const isLoadedUpFront = (tool: Tool.Any): boolean =>
  toolMeta(tool)?.[CLAUDE_ALWAYS_LOAD_META_KEY] !== false;

/**
 * What a Claude session is told about the tools it has to look up: a line for
 * each group with what it is for, since a deferred tool shows the model only
 * its name. Scheduling, settings and themes are named in their own sections
 * (scheduleTools.ts, guideTools.ts, pageTools.ts), so they are not repeated.
 * Empty when the session has none of these tools.
 */
export function buildOnDemandToolInstructions(input: {
  /** `mcp__<server>__` for the browser tools, when the session has them. */
  readonly browserPrefix?: string | undefined;
  /** `mcp__<server>__` for the room endpoint's tools, when it is attached. */
  readonly roomPrefix?: string | undefined;
  /** The room endpoint's tools this session may call. */
  readonly roomTools?: ReadonlyArray<string> | undefined;
  /** The tool that finds a VS Code theme, by its full name, when the session has the page tools. */
  readonly vsCodeThemeTool?: string | undefined;
}): string {
  const room = new Set(input.roomPrefix !== undefined ? (input.roomTools ?? []) : []);
  const named = (tools: ReadonlyArray<string>) =>
    tools
      .filter((tool) => room.has(tool))
      .map((tool) => `\`${input.roomPrefix}${tool}\``)
      .join(", ");
  const threads = named([
    "thread_start",
    "thread_send",
    "thread_read",
    "thread_list",
    "thread_stop",
    "thread_wrap",
    "thread_move",
    "thread_agents",
  ]);
  const agents = named(["room_invite", "room_review", "room_hand_off", "room_available_agents"]);
  const alert = named(["alert_assistants"]);
  const lines = [
    ...(input.browserPrefix !== undefined
      ? [
          `- The rest of the browser panel (\`${input.browserPrefix}*\`): tabs, scrolling, key presses, hover, drag, waiting for the page, viewport size, light and dark, page status and running JavaScript.`,
        ]
      : []),
    ...(threads.length > 0
      ? [
          `- Other threads, to work in parallel: start them, then message, read, list, stop and wrap them up (${threads}).`,
        ]
      : []),
    ...(agents.length > 0
      ? [
          `- Other agents in this thread: bring one in, get an independent review, or hand over the next turn (${agents}).`,
        ]
      : []),
    ...(input.vsCodeThemeTool !== undefined
      ? [`- A VS Code color theme by name, as a Threadlines theme (\`${input.vsCodeThemeTool}\`).`]
      : []),
    ...(alert.length > 0
      ? [
          `- Alerting the user's always-on assistants about this thread, only when asked (${alert}).`,
        ]
      : []),
  ];
  if (lines.length === 0) return "";
  return `<threadlines_tools>
Some Threadlines tools are not loaded until you look them up: they are listed by name only, and ToolSearch (\`select:<name>\`) loads one before its first call.
${lines.join("\n")}
</threadlines_tools>`;
}
