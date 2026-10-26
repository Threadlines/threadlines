/**
 * Which timeline rows find in chat searches, and the text each one shows.
 *
 * The conversation only: the user's messages, the agents' messages and
 * answers, invites, and proposed plans. Work steps, agent receipts, pages,
 * fork notes and status lines are not searched, and neither is a row that
 * only says where an answer already in the chat was sent (a reply echo, a
 * side answer's delivery line). Each row's text follows the component that
 * draws it (TimelineRowContent), so what is counted is what is on screen.
 */

import { deriveDisplayedUserMessageState } from "../../../lib/terminalContext";
import type { InlineSkill } from "../../../lib/inlineMarkdownTokens";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../../proposedPlan";
import type { ChatMessage } from "../../../types";
import { type MessagesTimelineRow, timelineMessageView } from "../MessagesTimeline.logic";
import { findableMarkdownBlocks, findableUserMessageBlocks } from "./chatFindText";

/** What the timeline draws rows with, beyond the rows themselves. */
export interface ChatFindRowContext {
  readonly cwd: string | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
  /** The timeline sits in a thread, so Codex inline visualizations render. */
  readonly visualizations: boolean;
  readonly sideAnswerRequests: { has(requestId: NonNullable<ChatMessage["requestId"]>): boolean };
}

const blocksCache = new WeakMap<object, { readonly key: string; readonly blocks: string[] }>();

function cached(source: object, key: string, build: () => string[]): string[] {
  const hit = blocksCache.get(source);
  if (hit?.key === key) return hit.blocks;
  const blocks = build();
  blocksCache.set(source, { key, blocks });
  return blocks;
}

function skillsKey(skills: ReadonlyArray<InlineSkill>): string {
  return skills.map((skill) => `${skill.name}\u0001${skill.displayName ?? ""}`).join("\u0002");
}

function messageBlocks(
  row: Extract<MessagesTimelineRow, { kind: "message" }>,
  context: ChatFindRowContext,
  contextKey: string,
): string[] | null {
  const { message } = row;
  const view = timelineMessageView(message, context.sideAnswerRequests);
  switch (view) {
    case null:
    case "side-answer-reply":
      return null;
    case "assistant": {
      const text = message.text || (message.streaming ? "" : "(empty response)");
      const streaming = Boolean(message.streaming);
      return cached(message, `${view}|${streaming}|${contextKey}`, () =>
        findableMarkdownBlocks({
          text,
          cwd: context.cwd,
          skills: context.skills,
          isStreaming: streaming,
          visualizations: context.visualizations,
        }),
      );
    }
    case "user":
      return cached(message, `${view}|${contextKey}`, () => {
        const displayed = deriveDisplayedUserMessageState(message.text);
        return findableUserMessageBlocks({
          text: displayed.visibleText,
          terminalContexts: displayed.contexts,
          skills: context.skills,
        });
      });
    case "agent-message":
      // A hand-off's reply that repeats the answer above it shows one line.
      if (row.agentLine?.echoesAnswer) return null;
      // Markdown, its file links read against this thread's checkout; all of
      // it, folded or not.
      return cached(message, `${view}|${contextKey}`, () =>
        findableMarkdownBlocks({
          text: message.text,
          cwd: context.cwd,
          skills: context.skills,
          isStreaming: false,
          visualizations: false,
        }),
      );
    case "outside-message":
      // Markdown, its file links read against this thread's checkout, like
      // the user's own prompt would be; all of it, folded or not.
      return cached(message, `${view}|${contextKey}`, () =>
        findableMarkdownBlocks({
          text: message.text,
          cwd: context.cwd,
          skills: context.skills,
          isStreaming: false,
          visualizations: false,
        }),
      );
    case "thread-message":
      // Markdown written in another thread's checkout: no file links here.
      return cached(message, `${view}|${contextKey}`, () =>
        findableMarkdownBlocks({
          text: message.text,
          cwd: undefined,
          skills: context.skills,
          isStreaming: false,
          visualizations: false,
        }),
      );
    case "invite": {
      const reason = message.invite?.reason ?? "";
      return reason.trim().length > 0 ? [reason] : null;
    }
  }
}

/**
 * The context's part of every cache key: a row's text depends on these as
 * much as on its own words.
 */
export function chatFindContextKey(context: ChatFindRowContext): string {
  return `${context.cwd ?? ""}|${context.visualizations}|${skillsKey(context.skills)}`;
}

/**
 * The blocks a row shows to find, in reading order; null for a row find does
 * not search. Cached per message or plan, so a long chat parses each one once.
 */
export function findableRowBlocks(
  row: MessagesTimelineRow,
  context: ChatFindRowContext,
  contextKey: string = chatFindContextKey(context),
): string[] | null {
  if (row.kind === "message") {
    return messageBlocks(row, context, contextKey);
  }
  if (row.kind === "proposed-plan") {
    const { planMarkdown } = row.proposedPlan;
    return cached(row.proposedPlan, `plan|${contextKey}`, () => [
      proposedPlanTitle(planMarkdown) ?? "Proposed plan",
      ...findableMarkdownBlocks({
        text: stripDisplayedPlanMarkdown(planMarkdown),
        cwd: context.cwd,
        skills: [],
        isStreaming: false,
        visualizations: context.visualizations,
      }),
    ]);
  }
  return null;
}

/** Whether a row is one find could still have to parse (not yet cached). */
export function isFindableRowKind(row: MessagesTimelineRow): boolean {
  return row.kind === "message" || row.kind === "proposed-plan";
}
