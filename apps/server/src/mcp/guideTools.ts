/**
 * `app_guide`: agents' guide to Threadlines itself (docs/design/app-guide.md).
 * Served on the room endpoint; every local thread's own agent gets it, even
 * with rooms and agent-started threads off (then it is the only room tool),
 * so "why can't you start threads?" can still be answered. Read-only.
 *
 * Agents without instructions (ACP) learn when to use it from the
 * description alone, so the description carries the rules.
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { GUIDE_TOOL_NAME } from "./roomToolAccess.ts";
import { McpRoomInvocation } from "./roomTools.ts";

export const AppGuideResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "no_match", "refused"]),
  /** Markdown: places with their links, current values and topic text. */
  answer: Schema.String,
});
export type AppGuideResult = typeof AppGuideResult.Type;

export const AppGuideTool = Tool.make(GUIDE_TOOL_NAME, {
  description:
    'Threadlines\' guide to itself, the app you are running in. Use it before answering any question about Threadlines from memory: where a setting or page is, how a feature works (threads, worktrees, access levels, rooms, threads agents start, linked computers in Fleet, phones, scheduled tasks, outside agents, providers, plugins and skills, the browser panel), or why one of your Threadlines tools said no. `query` takes plain words ("link my windows pc", "turn off agent pages"); `topic` reads one topic; neither lists the pages and topics. Answers give each place\'s path as the screen shows it, what it does, its current value on this computer when the server can see it, and a markdown link: put those links in your reply, and the user can click straight to the place. You can\'t change settings: tell the user where to.',
  parameters: Schema.Struct({
    query: Schema.optional(
      Schema.String.annotate({ description: "What the user asked about, in plain words." }),
    ),
    topic: Schema.optional(
      Schema.String.annotate({ description: "A topic id from the guide's list." }),
    ),
  }),
  success: AppGuideResult,
  dependencies: [McpRoomInvocation],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Title, "Threadlines guide");

export const GuideToolkit = Toolkit.make(AppGuideTool);

/**
 * The one sentence a thread's own runtime gets with the room tools: questions
 * about Threadlines are answered from the guide, and places are linked. Never
 * for a side runtime.
 */
export function buildGuideInstructions(input: {
  /** What precedes the tool's name for this provider. */
  readonly toolPrefix: string;
}): string {
  return `<threadlines_guide>\nYou run inside Threadlines. When the user asks about Threadlines itself (where a setting is, how a feature works, why a Threadlines tool said no), look it up with \`${input.toolPrefix}${GUIDE_TOOL_NAME}\` before answering, and link the places it names with the links it gives.\n</threadlines_guide>`;
}
