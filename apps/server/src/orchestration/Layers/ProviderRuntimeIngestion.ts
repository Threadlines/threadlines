import {
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCheckpointFile,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@threadlines/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";

import { metricAttributes, providerFirstOutputDuration } from "../../observability/Metrics.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { resolveThreadProviderCwd } from "../generalChats.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  projectRuntimeEventToActivities,
  type ProviderActivityStreamSnapshot,
} from "./ProviderActivityProjection.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.make(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_SUBAGENT_RESULT_TEXT_BY_KEY_CACHE_CAPACITY = 10_000;
const BUFFERED_SUBAGENT_RESULT_TEXT_BY_KEY_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const BUFFERED_ACTIVITY_STREAM_BY_KEY_CACHE_CAPACITY = 20_000;
const BUFFERED_ACTIVITY_STREAM_BY_KEY_TTL = Duration.minutes(120);
const STREAMING_ASSISTANT_DELTA_FLUSH_INTERVAL = Duration.millis(50);
const MARKDOWN_FENCE_INDENT_LIMIT = 3;
type ContentDeltaStreamKind = Extract<
  ProviderRuntimeEvent,
  { type: "content.delta" }
>["payload"]["streamKind"];
type ActivityStreamDeltaKind = Extract<
  ContentDeltaStreamKind,
  "reasoning_summary_text" | "reasoning_text" | "command_output" | "file_change_output"
>;
const ACTIVITY_STREAM_EMIT_BYTE_THRESHOLDS = {
  reasoning_summary_text: 128,
  reasoning_text: 4096,
  command_output: 2048,
  file_change_output: 2048,
} as const satisfies Record<ActivityStreamDeltaKind, number>;
const ACTIVITY_STREAM_EMIT_LINE_THRESHOLDS = {
  reasoning_summary_text: 2,
  reasoning_text: 32,
  command_output: 8,
  file_change_output: 8,
} as const satisfies Record<ActivityStreamDeltaKind, number>;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_BUFFERED_SUBAGENT_RESULT_CHARS = 120_000;
const MAX_BUFFERED_ACTIVITY_STREAM_CHARS = 4_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD =
  (process.env.THREADLINES_STRICT_PROVIDER_LIFECYCLE_GUARD ??
    process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD) !== "0";

interface BufferedActivityStream {
  readonly text: string;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly truncated: boolean;
}

interface PendingStreamingAssistantMessage {
  readonly event: ProviderRuntimeEvent;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId?: TurnId;
  readonly createdAt: string;
}

interface EmittedActivityStreamCursor {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly truncated: boolean;
}

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;
const domainCommandId = (event: TurnStartRequestedDomainEvent, tag: string): CommandId =>
  CommandId.make(`provider:${event.eventId}:${tag}`);

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      source: "flush";
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function runtimeEventMatchesThreadSession(
  event: ProviderRuntimeEvent,
  session: OrchestrationThread["session"] | null | undefined,
): boolean {
  if (!session || session.providerName === null) {
    return true;
  }
  if (session.providerInstanceId !== undefined && event.providerInstanceId !== undefined) {
    return sameId(session.providerInstanceId, event.providerInstanceId);
  }
  if (session.providerInstanceId !== undefined && event.providerInstanceId === undefined) {
    return event.provider === session.providerName;
  }
  return true;
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<
      OrchestrationProposedPlan,
      "id" | "createdAt" | "implementedAt" | "implementationThreadId" | "dismissedAt"
    >
  >,
  planId: string,
):
  | Pick<
      OrchestrationProposedPlan,
      "id" | "createdAt" | "implementedAt" | "implementationThreadId" | "dismissedAt"
    >
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function turnScopedRuntimeEventMatchesThread(
  thread: Pick<OrchestrationThread, "latestTurn" | "session">,
  turnId: TurnId,
): boolean {
  const activeTurnId = thread.session?.activeTurnId ?? null;
  if (activeTurnId !== null) {
    return sameId(activeTurnId, turnId);
  }

  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (latestTurnId !== null) {
    return sameId(latestTurnId, turnId);
  }

  return true;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function detectMarkdownFenceAtLineStart(
  text: string,
  index: number,
): { marker: "`" | "~"; length: number; end: number } | null {
  if (index > 0 && text[index - 1] !== "\n") {
    return null;
  }

  let cursor = index;
  let indent = 0;
  while (text[cursor] === " " && indent < MARKDOWN_FENCE_INDENT_LIMIT + 1) {
    cursor += 1;
    indent += 1;
  }
  if (indent > MARKDOWN_FENCE_INDENT_LIMIT) {
    return null;
  }

  const marker = text[cursor];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let end = cursor;
  while (text[end] === marker) {
    end += 1;
  }
  const length = end - cursor;
  return length >= 3 ? { marker, length, end } : null;
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isAsciiAlphaNumeric(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/u.test(char);
}

function isMarkdownBoundaryBefore(char: string | undefined): boolean {
  return (
    char === undefined ||
    /\s/u.test(char) ||
    char === "(" ||
    char === "[" ||
    char === "{" ||
    char === "<" ||
    char === '"' ||
    char === "'"
  );
}

function isMarkdownBoundaryAfter(char: string | undefined): boolean {
  return (
    char === undefined ||
    /\s/u.test(char) ||
    char === "." ||
    char === "," ||
    char === ":" ||
    char === ";" ||
    char === "!" ||
    char === "?" ||
    char === ")" ||
    char === "]" ||
    char === "}" ||
    char === ">" ||
    char === '"' ||
    char === "'"
  );
}

interface MarkdownLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly hasLineEnding: boolean;
}

function splitMarkdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    lines.push({
      text: text.slice(start, index),
      start,
      end: index,
      hasLineEnding: true,
    });
    start = index + 1;
  }
  lines.push({
    text: text.slice(start),
    start,
    end: text.length,
    hasLineEnding: false,
  });
  return lines;
}

function isSyntheticTrailingMarkdownLine(line: MarkdownLine, sourceText: string): boolean {
  return !line.hasLineEnding && line.start === sourceText.length && line.text.length === 0;
}

function stripOuterTablePipes(line: string): string {
  let value = line.trim();
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }
  return value;
}

function isPotentialMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(">")) {
    return false;
  }
  if (trimmed.startsWith("|")) {
    return stripOuterTablePipes(trimmed).includes("|");
  }
  const firstPipe = trimmed.indexOf("|");
  return firstPipe >= 0 && trimmed.indexOf("|", firstPipe + 1) >= 0;
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  if (!isPotentialMarkdownTableRow(line)) {
    return false;
  }
  const cells = stripOuterTablePipes(line)
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function findPendingMarkdownTableStart(
  text: string,
  options?: { readonly continuingTable?: boolean },
): number | null {
  const lines = splitMarkdownLines(text);
  let tableActive = options?.continuingTable === true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextLine = lines[index + 1];
    if (isSyntheticTrailingMarkdownLine(line, text)) {
      break;
    }

    if (tableActive) {
      if (!isPotentialMarkdownTableRow(line.text)) {
        tableActive = false;
        continue;
      }
      if (!line.hasLineEnding) {
        return line.start;
      }
      continue;
    }

    if (!isPotentialMarkdownTableRow(line.text)) {
      continue;
    }

    if (!nextLine) {
      return line.start;
    }
    if (!nextLine.hasLineEnding && !isMarkdownTableSeparatorRow(nextLine.text)) {
      return line.start;
    }
    if (!isMarkdownTableSeparatorRow(nextLine.text)) {
      continue;
    }
    if (!nextLine.hasLineEnding) {
      return line.start;
    }

    tableActive = true;
    index += 1;
  }

  return null;
}

function markdownTableContinuesAfterFlush(
  text: string,
  options?: { readonly continuingTable?: boolean },
): boolean {
  const lines = splitMarkdownLines(text);
  let tableActive = options?.continuingTable === true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isSyntheticTrailingMarkdownLine(line, text)) {
      break;
    }

    if (tableActive) {
      if (isPotentialMarkdownTableRow(line.text)) {
        continue;
      }
      tableActive = false;
      continue;
    }

    if (!isPotentialMarkdownTableRow(line.text)) {
      continue;
    }

    const nextLine = lines[index + 1];
    if (
      nextLine &&
      !isSyntheticTrailingMarkdownLine(nextLine, text) &&
      isMarkdownTableSeparatorRow(nextLine.text)
    ) {
      tableActive = true;
      index += 1;
    }
  }

  return tableActive;
}

function findClosingMarkdownParenthesis(text: string, startIndex: number): number | null {
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return null;
}

function findUnclosedInlineCodeSpanStart(text: string): number | null {
  let inlineCode: { start: number; tickCount: number } | null = null;
  let codeFence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < text.length; index += 1) {
    if (inlineCode === null) {
      const fence = detectMarkdownFenceAtLineStart(text, index);
      if (fence) {
        if (codeFence === null) {
          codeFence = { marker: fence.marker, length: fence.length };
        } else if (codeFence.marker === fence.marker && fence.length >= codeFence.length) {
          codeFence = null;
        }
        index = fence.end - 1;
        continue;
      }
    }

    if (codeFence !== null) {
      continue;
    }

    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "`") {
      continue;
    }

    const runStart = index;
    let runEnd = index;
    while (text[runEnd] === "`") {
      runEnd += 1;
    }
    const tickCount = runEnd - runStart;

    if (inlineCode && tickCount === inlineCode.tickCount) {
      inlineCode = null;
    } else if (inlineCode === null) {
      inlineCode = { start: runStart, tickCount };
    }

    index = runEnd - 1;
  }

  return inlineCode?.start ?? null;
}

function findUnclosedLinkStart(text: string): number | null {
  const labelStack: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    if (char === "[") {
      labelStack.push(text[index - 1] === "!" ? index - 1 : index);
      continue;
    }

    if (char !== "]" || labelStack.length === 0) {
      continue;
    }

    const labelStart = labelStack.pop()!;
    const nextChar = text[index + 1];
    if (nextChar === "(") {
      const closeIndex = findClosingMarkdownParenthesis(text, index + 2);
      if (closeIndex === null) {
        return labelStart;
      }
      index = closeIndex;
      continue;
    }

    if (nextChar === "[") {
      const closeReferenceIndex = text.indexOf("]", index + 2);
      if (closeReferenceIndex < 0) {
        return labelStart;
      }
      index = closeReferenceIndex;
    }
  }

  return labelStack[0] ?? null;
}

function findUnclosedEmphasisStart(text: string): number | null {
  const markerStack: Array<{ marker: "*" | "~"; length: 1 | 2; start: number }> = [];

  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if ((marker !== "*" && marker !== "~") || isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    let runEnd = index;
    while (text[runEnd] === marker) {
      runEnd += 1;
    }
    const runLength = runEnd - index;
    const length = Math.min(runLength, 2) as 1 | 2;
    const previousChar = text[index - 1];
    const nextChar = text[index + length];
    const canOpen =
      isMarkdownBoundaryBefore(previousChar) &&
      isAsciiAlphaNumeric(nextChar) &&
      (marker === "*" || length === 2);
    const canClose = isAsciiAlphaNumeric(previousChar) && isMarkdownBoundaryAfter(nextChar);
    const openIndex = markerStack.findLastIndex(
      (entry) => entry.marker === marker && entry.length === length,
    );

    if (openIndex >= 0 && canClose) {
      markerStack.splice(openIndex, 1);
    } else if (canOpen) {
      markerStack.push({ marker, length, start: index });
    }

    index = runEnd - 1;
  }

  return markerStack.length > 0 ? Math.min(...markerStack.map((entry) => entry.start)) : null;
}

function splitStreamingAssistantMarkdownFlush(
  text: string,
  options?: { readonly continuingTable?: boolean },
): {
  readyText: string;
  pendingText: string;
} {
  const pendingStarts = [
    findUnclosedInlineCodeSpanStart(text),
    findUnclosedLinkStart(text),
    findUnclosedEmphasisStart(text),
    findPendingMarkdownTableStart(text, options),
  ].filter((start): start is number => start !== null);
  if (pendingStarts.length === 0) {
    return { readyText: text, pendingText: "" };
  }
  const pendingStart = Math.min(...pendingStarts);
  return {
    readyText: text.slice(0, pendingStart),
    pendingText: text.slice(pendingStart),
  };
}

function checkpointFileChangeActivity(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly createdAt: string;
}): OrchestrationThreadActivity | null {
  if (input.files.length === 0) {
    return null;
  }

  return {
    id: EventId.make(
      `checkpoint-files:${input.threadId}:${input.turnId}:${input.checkpointTurnCount}`,
    ),
    tone: "tool",
    kind: "tool.completed",
    summary: "Changed files",
    payload: {
      itemType: "file_change",
      status: "completed",
      title: "File change",
      data: {
        files: input.files.map((file) => ({ ...file })),
      },
    },
    turnId: input.turnId,
    createdAt: input.createdAt,
  };
}

function parseCheckpointFilesFromUnifiedDiff(diff: string): OrchestrationCheckpointFile[] {
  return parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
    path: file.path,
    kind: "modified",
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function providerThreadIdFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const providerThreadId = event.providerRefs?.providerThreadId?.trim();
  return providerThreadId && providerThreadId.length > 0 ? providerThreadId : undefined;
}

function childProviderThreadIdForEvent(
  event: ProviderRuntimeEvent,
  thread: Pick<OrchestrationThread, "session">,
): string | undefined {
  const providerThreadId = providerThreadIdFromEvent(event);
  const parentProviderThreadId = thread.session?.providerThreadId?.trim();
  if (!providerThreadId || !parentProviderThreadId) {
    return undefined;
  }
  return providerThreadId === parentProviderThreadId ? undefined : providerThreadId;
}

function appendSubagentResultText(existing: string | undefined, delta: string): string {
  const nextText = `${existing ?? ""}${delta}`;
  if (nextText.length <= MAX_BUFFERED_SUBAGENT_RESULT_CHARS) {
    return nextText;
  }

  const prefix = "[earlier subagent output truncated]\n\n";
  return `${prefix}${nextText.slice(nextText.length - MAX_BUFFERED_SUBAGENT_RESULT_CHARS + prefix.length)}`;
}

function subagentResultTextKey(input: {
  readonly event: ProviderRuntimeEvent;
  readonly childProviderThreadId: string;
}): string {
  return [
    input.event.threadId,
    input.event.turnId ?? "no-turn",
    input.childProviderThreadId,
    input.event.itemId ?? "no-item",
  ].join(":");
}

function subagentResultActivityId(input: {
  readonly event: ProviderRuntimeEvent;
  readonly childProviderThreadId: string;
}): EventId {
  return EventId.make(
    [
      "activity",
      "subagent-result",
      input.event.threadId,
      input.event.turnId ?? "no-turn",
      input.childProviderThreadId,
      input.event.itemId ?? "no-item",
    ].join(":"),
  );
}

function subagentResultToolCallId(input: {
  readonly event: ProviderRuntimeEvent;
  readonly childProviderThreadId: string;
}): string {
  return [
    "subagent-response",
    input.event.turnId ?? "no-turn",
    input.childProviderThreadId,
    input.event.itemId ?? "no-item",
  ].join(":");
}

function subagentResultActivity(input: {
  readonly event: ProviderRuntimeEvent;
  readonly childProviderThreadId: string;
  readonly parentProviderThreadId?: string | undefined;
  readonly body: string;
  readonly status: "inProgress" | "completed";
  readonly createdAt: string;
}): OrchestrationThreadActivity | undefined {
  if (!hasRenderableAssistantText(input.body)) {
    return undefined;
  }

  const turnId = toTurnId(input.event.turnId);
  return {
    id: subagentResultActivityId(input),
    tone: "info",
    kind: "subagent.result",
    summary:
      input.status === "completed" ? "Subagent response ready" : "Subagent response streaming",
    payload: {
      itemType: "collab_agent_tool_call",
      status: input.status,
      data: {
        item: {
          id: subagentResultToolCallId(input),
          type: "collabAgentToolCall",
          tool: "wait",
          status: input.status,
          receiverThreadIds: [input.childProviderThreadId],
          ...(input.parentProviderThreadId ? { senderThreadId: input.parentProviderThreadId } : {}),
          agentsStates: {
            [input.childProviderThreadId]: {
              status: input.status === "completed" ? "completed" : "running",
              message: input.body,
            },
          },
        },
      },
    },
    turnId: turnId ?? null,
    createdAt: input.createdAt,
  };
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}

function activityStreamBaseKey(event: ProviderRuntimeEvent): string {
  if (event.type !== "content.delta") {
    return `${event.threadId}:${event.turnId ?? "thread"}:${event.itemId ?? event.eventId}`;
  }

  const streamIndex = event.payload.summaryIndex ?? event.payload.contentIndex ?? 0;
  return [
    event.threadId,
    event.turnId ?? "thread",
    event.itemId ?? event.eventId,
    event.payload.streamKind,
    streamIndex,
  ].join(":");
}

function activityStreamId(event: ProviderRuntimeEvent): EventId {
  return EventId.make(`activity:${activityStreamBaseKey(event)}`);
}

function appendActivityStreamText(
  previous: BufferedActivityStream | undefined,
  delta: string,
): BufferedActivityStream {
  const nextFullText = `${previous?.text ?? ""}${delta}`;
  const truncated =
    (previous?.truncated ?? false) || nextFullText.length > MAX_BUFFERED_ACTIVITY_STREAM_CHARS;
  const text = truncated
    ? nextFullText.slice(nextFullText.length - MAX_BUFFERED_ACTIVITY_STREAM_CHARS)
    : nextFullText;
  const byteCount = (previous?.byteCount ?? 0) + Buffer.byteLength(delta, "utf8");
  const lineCount = (previous?.lineCount ?? 0) + (delta.match(/\r\n|\r|\n/gu)?.length ?? 0);
  return {
    text,
    byteCount,
    lineCount,
    truncated,
  };
}

function shouldEmitActivityStreamSnapshot(input: {
  readonly streamKind: ActivityStreamDeltaKind;
  readonly lastEmitted: EmittedActivityStreamCursor | undefined;
  readonly next: BufferedActivityStream;
}): boolean {
  if (!input.lastEmitted) {
    return input.next.byteCount > 0 || input.next.lineCount > 0 || input.next.truncated;
  }
  if (input.next.truncated !== input.lastEmitted.truncated) {
    return true;
  }

  const byteDelta = input.next.byteCount - input.lastEmitted.byteCount;
  const lineDelta = input.next.lineCount - input.lastEmitted.lineCount;
  return (
    byteDelta >= ACTIVITY_STREAM_EMIT_BYTE_THRESHOLDS[input.streamKind] ||
    lineDelta >= ACTIVITY_STREAM_EMIT_LINE_THRESHOLDS[input.streamKind]
  );
}

function emittedActivityStreamCursor(stream: BufferedActivityStream): EmittedActivityStreamCursor {
  return {
    byteCount: stream.byteCount,
    lineCount: stream.lineCount,
    truncated: stream.truncated,
  };
}

function isActivityStreamDeltaKind(
  streamKind: ContentDeltaStreamKind,
): streamKind is ActivityStreamDeltaKind {
  return (
    streamKind === "reasoning_summary_text" ||
    streamKind === "reasoning_text" ||
    streamKind === "command_output" ||
    streamKind === "file_change_output"
  );
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const path = yield* Path.Path;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  const bufferedSubagentResultTextByKey = yield* Cache.make<string, string>({
    capacity: BUFFERED_SUBAGENT_RESULT_TEXT_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_SUBAGENT_RESULT_TEXT_BY_KEY_TTL,
    lookup: () => Effect.succeed(""),
  });
  const pendingStreamingAssistantMessages = yield* Ref.make(
    new Map<MessageId, PendingStreamingAssistantMessage>(),
  );
  const streamingAssistantTableMessageIds = yield* Ref.make(new Set<MessageId>());

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const bufferedActivityStreamByKey = yield* Cache.make<string, BufferedActivityStream>({
    capacity: BUFFERED_ACTIVITY_STREAM_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_ACTIVITY_STREAM_BY_KEY_TTL,
    lookup: () =>
      Effect.succeed({
        text: "",
        byteCount: 0,
        lineCount: 0,
        truncated: false,
      }),
  });
  const emittedActivityStreamCursorByKey = yield* Cache.make<string, EmittedActivityStreamCursor>({
    capacity: BUFFERED_ACTIVITY_STREAM_BY_KEY_CACHE_CAPACITY,
    timeToLive: BUFFERED_ACTIVITY_STREAM_BY_KEY_TTL,
    lookup: () =>
      Effect.succeed({
        byteCount: 0,
        lineCount: 0,
        truncated: false,
      }),
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const peekBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.map((existingText) => Option.getOrElse(existingText, () => "")),
    );

  const replaceBufferedAssistantText = (messageId: MessageId, text: string) =>
    text.length > 0
      ? Cache.set(bufferedAssistantTextByMessageId, messageId, text)
      : Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedSubagentResultText = (key: string, delta: string) =>
    Cache.getOption(bufferedSubagentResultTextByKey, key).pipe(
      Effect.flatMap((existingText) => {
        const nextText = appendSubagentResultText(Option.getOrUndefined(existingText), delta);
        return Cache.set(bufferedSubagentResultTextByKey, key, nextText).pipe(Effect.as(nextText));
      }),
    );

  const takeBufferedSubagentResultText = (key: string) =>
    Cache.getOption(bufferedSubagentResultTextByKey, key).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedSubagentResultTextByKey, key).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const dispatchAssistantDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    delta: string;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      delta: input.delta,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
    });

  const dispatchSubagentResultActivity = (input: {
    event: ProviderRuntimeEvent;
    thread: Pick<OrchestrationThread, "id" | "session">;
    childProviderThreadId: string;
    body: string;
    status: "inProgress" | "completed";
    createdAt: string;
  }) => {
    const activity = subagentResultActivity({
      event: input.event,
      childProviderThreadId: input.childProviderThreadId,
      parentProviderThreadId: input.thread.session?.providerThreadId ?? undefined,
      body: input.body,
      status: input.status,
      createdAt: input.createdAt,
    });
    if (!activity) {
      return Effect.void;
    }

    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: providerCommandId(
        input.event,
        input.status === "completed" ? "subagent-result-complete" : "subagent-result-update",
      ),
      threadId: input.thread.id,
      activity,
      createdAt: activity.createdAt,
    });
  };

  const queuePendingStreamingAssistantMessage = (input: PendingStreamingAssistantMessage) =>
    Ref.update(pendingStreamingAssistantMessages, (pending) => {
      const next = new Map(pending);
      next.set(input.messageId, input);
      return next;
    });

  const takePendingStreamingAssistantMessages = Ref.modify(
    pendingStreamingAssistantMessages,
    (pending) => [
      Array.from(pending.values()),
      new Map<MessageId, PendingStreamingAssistantMessage>(),
    ],
  );

  const clearPendingStreamingAssistantMessage = (messageId: MessageId) =>
    Ref.update(pendingStreamingAssistantMessages, (pending) => {
      if (!pending.has(messageId)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(messageId);
      return next;
    });

  const isStreamingAssistantTableActive = (messageId: MessageId) =>
    Ref.get(streamingAssistantTableMessageIds).pipe(
      Effect.map((messageIds) => messageIds.has(messageId)),
    );

  const setStreamingAssistantTableActive = (messageId: MessageId, active: boolean) =>
    Ref.update(streamingAssistantTableMessageIds, (messageIds) => {
      if (active && messageIds.has(messageId)) {
        return messageIds;
      }
      if (!active && !messageIds.has(messageId)) {
        return messageIds;
      }
      const next = new Set(messageIds);
      if (active) {
        next.add(messageId);
      } else {
        next.delete(messageId);
      }
      return next;
    });

  const clearStreamingAssistantTableState = (messageId: MessageId) =>
    setStreamingAssistantTableActive(messageId, false);

  const flushPendingStreamingAssistantMessage = (input: PendingStreamingAssistantMessage) =>
    Effect.gen(function* () {
      const bufferedText = yield* peekBufferedAssistantText(input.messageId);
      const continuingTable = yield* isStreamingAssistantTableActive(input.messageId);
      const { readyText, pendingText } = splitStreamingAssistantMarkdownFlush(bufferedText, {
        continuingTable,
      });
      if (!hasRenderableAssistantText(readyText)) {
        return false;
      }

      yield* replaceBufferedAssistantText(input.messageId, pendingText);
      yield* setStreamingAssistantTableActive(
        input.messageId,
        markdownTableContinuesAfterFlush(readyText, { continuingTable }),
      );
      yield* dispatchAssistantDelta({
        ...input,
        delta: readyText,
        commandTag: "assistant-delta-stream-batch",
      });
      return true;
    });

  const flushPendingStreamingAssistantMessages = Effect.gen(function* () {
    const pendingMessages = yield* takePendingStreamingAssistantMessages;
    if (pendingMessages.length === 0) {
      return 0;
    }

    let flushedCount = 0;
    yield* Effect.forEach(
      pendingMessages,
      (pending) =>
        flushPendingStreamingAssistantMessage(pending).pipe(
          Effect.tap((flushed) =>
            flushed
              ? Effect.sync(() => {
                  flushedCount += 1;
                })
              : Effect.void,
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    return flushedCount;
  });

  const queueStreamingAssistantDelta = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    delta: string;
    turnId?: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const spillChunk = yield* appendBufferedAssistantText(input.messageId, input.delta);
      if (spillChunk.length > 0) {
        yield* clearPendingStreamingAssistantMessage(input.messageId);
        yield* dispatchAssistantDelta({
          ...input,
          delta: spillChunk,
          commandTag: "assistant-delta-stream-spill",
        });
        return;
      }

      yield* queuePendingStreamingAssistantMessage(input);
    });

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const appendBufferedActivityStream = (
    event: ProviderRuntimeEvent,
  ): Effect.Effect<ProviderActivityStreamSnapshot | undefined> =>
    Effect.gen(function* () {
      if (event.type !== "content.delta") {
        return undefined;
      }
      const streamKind = event.payload.streamKind;
      if (!isActivityStreamDeltaKind(streamKind)) {
        return undefined;
      }

      const streamKey = activityStreamBaseKey(event);
      const previous = yield* Cache.getOption(bufferedActivityStreamByKey, streamKey).pipe(
        Effect.map(Option.getOrUndefined),
      );
      const next = appendActivityStreamText(previous, event.payload.delta);
      yield* Cache.set(bufferedActivityStreamByKey, streamKey, next);
      const lastEmitted = yield* Cache.getOption(emittedActivityStreamCursorByKey, streamKey).pipe(
        Effect.map(Option.getOrUndefined),
      );
      if (
        !shouldEmitActivityStreamSnapshot({
          streamKind,
          lastEmitted,
          next,
        })
      ) {
        return undefined;
      }

      yield* Cache.set(
        emittedActivityStreamCursorByKey,
        streamKey,
        emittedActivityStreamCursor(next),
      );
      return {
        activityId: activityStreamId(event),
        streamKind,
        text: next.text,
        byteCount: next.byteCount,
        lineCount: next.lineCount,
        truncated: next.truncated,
        ...(streamKind === "reasoning_text" ? { redacted: true } : {}),
      } satisfies ProviderActivityStreamSnapshot;
    });

  const projectRuntimeActivities = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const stream = yield* appendBufferedActivityStream(event);
      return projectRuntimeEventToActivities(event, { stream });
    });

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearPendingStreamingAssistantMessage(messageId).pipe(
      Effect.andThen(clearStreamingAssistantTableState(messageId)),
      Effect.andThen(clearBufferedAssistantText(messageId)),
    );

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* dispatchAssistantDelta({
        ...input,
        delta: bufferedText,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* dispatchAssistantDelta({
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
          commandTag: input.finalDeltaCommandTag,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
      dismissedAt: string | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          dismissedAt: existingPlan?.dismissedAt ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
      dismissedAt: string | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;
      if (
        STRICT_PROVIDER_LIFECYCLE_GUARD &&
        !runtimeEventMatchesThreadSession(event, thread.session)
      ) {
        yield* Effect.logDebug("provider runtime ingestion ignored stale provider event", {
          eventId: event.eventId,
          eventType: event.type,
          eventProvider: event.provider,
          eventProviderInstanceId: event.providerInstanceId,
          threadId: thread.id,
          sessionProvider: thread.session?.providerName,
          sessionProviderInstanceId: thread.session?.providerInstanceId,
        });
        return;
      }

      if (event.type === "session.cwd.changed") {
        // The session's working directory moved (or a fresh session reported
        // where it actually runs). Persist only divergence from the thread's
        // configured checkout — observing the configured cwd clears the
        // field, so worktree exits and plain restarts self-correct.
        const project = Option.getOrUndefined(
          yield* projectionSnapshotQuery.getProjectShellById(thread.projectId),
        );
        const configuredCwd = resolveThreadProviderCwd({
          thread: {
            id: thread.id,
            projectId: thread.projectId,
            worktreePath: thread.worktreePath,
          },
          project,
          path,
        });
        const normalizeCwd = (value: string) => value.replace(/[/\\]+$/, "");
        const observedCwd = normalizeCwd(event.payload.cwd);
        const effectiveCwd =
          configuredCwd !== undefined && areFilesystemPathsEqual(configuredCwd, observedCwd)
            ? null
            : observedCwd;
        if ((thread.effectiveCwd ?? null) !== effectiveCwd) {
          yield* orchestrationEngine.dispatch({
            type: "thread.effective-cwd.set",
            commandId: providerCommandId(event, "effective-cwd"),
            threadId: thread.id,
            effectiveCwd,
            createdAt: event.createdAt,
          });
        }
        return;
      }

      if (event.type === "goal.updated") {
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.state.set",
          commandId: providerCommandId(event, "goal-updated"),
          threadId: thread.id,
          goal: {
            threadId: thread.id,
            objective: event.payload.goal.objective,
            status: event.payload.goal.status,
            tokenBudget: event.payload.goal.tokenBudget ?? null,
            tokensUsed: event.payload.goal.tokensUsed,
            timeUsedSeconds: event.payload.goal.timeUsedSeconds,
            createdAt: event.payload.goal.createdAt,
            updatedAt: event.payload.goal.updatedAt,
          },
          createdAt: event.createdAt,
        });
        return;
      }

      if (event.type === "goal.cleared") {
        if (thread.goal === null) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.state.set",
          commandId: providerCommandId(event, "goal-cleared"),
          threadId: thread.id,
          goal: null,
          createdAt: event.createdAt,
        });
        return;
      }

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited"
              ? null
              : activeTurnId;
        const runtimeStatus = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.aborted":
              return "interrupted";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const shouldPreservePendingTurnStartup =
          thread.session?.status === "starting" &&
          nextActiveTurnId === null &&
          runtimeStatus === "ready" &&
          (event.type === "session.started" ||
            event.type === "thread.started" ||
            event.type === "session.state.changed");
        const status = shouldPreservePendingTurnStartup ? "starting" : runtimeStatus;
        const sessionUpdatedAt = shouldPreservePendingTurnStartup
          ? (thread.session?.updatedAt ?? now)
          : now;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready" || status === "interrupted"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              providerSessionId: thread.session?.providerSessionId ?? null,
              providerThreadId:
                event.type === "thread.started"
                  ? (event.payload?.providerThreadId ?? thread.session?.providerThreadId ?? null)
                  : (thread.session?.providerThreadId ?? null),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              pendingBackgroundTaskCount:
                event.type === "session.started" || event.type === "session.exited"
                  ? 0
                  : (thread.session?.pendingBackgroundTaskCount ?? 0),
              lastError,
              updatedAt: sessionUpdatedAt,
            },
            createdAt: now,
          });
        }
      }

      // Codex also publishes an authoritative thread-level idle signal. If a
      // turn/completed notification is lost under load, use a fresh idle
      // observation to settle the matching projected session instead of
      // leaving the UI's working timer running forever.
      if (
        event.type === "thread.state.changed" &&
        event.payload.state === "idle" &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        event.createdAt >= thread.session.updatedAt
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-idle-session-set"),
          threadId: thread.id,
          session: {
            ...thread.session,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      // A provider snapshot is an authoritative level signal. Apply it as an
      // absolute count so missed or reordered task edges cannot wedge the
      // session in a stale background-work state.
      if (event.type === "task.snapshot.updated" && thread.session != null) {
        const nextPendingCount = new Set(event.payload.tasks.map((task) => task.taskId)).size;
        if (nextPendingCount !== (thread.session.pendingBackgroundTaskCount ?? 0)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "task-snapshot-session-set"),
            threadId: thread.id,
            session: {
              ...thread.session,
              pendingBackgroundTaskCount: nextPendingCount,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      // Track provider task edges when no authoritative snapshot owns the
      // count. Edge events still project lifecycle details in either mode.
      if (
        (event.type === "task.started" || event.type === "task.completed") &&
        thread.session != null &&
        event.payload.pendingCountManagedBySnapshot !== true
      ) {
        const currentPendingCount = thread.session.pendingBackgroundTaskCount ?? 0;
        if (event.type === "task.completed" && currentPendingCount === 0) {
          // Clamping hides drift: an unmatched completion here means some other
          // still-running task already lost its decrement, so make it loud.
          yield* Effect.logWarning(
            "provider runtime ingestion saw task.completed with no pending background tasks",
            {
              eventId: event.eventId,
              threadId: thread.id,
              taskId: event.payload.taskId,
            },
          );
        }
        const nextPendingCount =
          event.type === "task.started"
            ? currentPendingCount + 1
            : Math.max(0, currentPendingCount - 1);
        if (nextPendingCount !== currentPendingCount) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "task-pending-session-set"),
            threadId: thread.id,
            session: {
              ...thread.session,
              pendingBackgroundTaskCount: nextPendingCount,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const childProviderThreadId = childProviderThreadIdForEvent(event, thread);
        if (childProviderThreadId) {
          const bufferKey = subagentResultTextKey({ event, childProviderThreadId });
          const body = yield* appendBufferedSubagentResultText(bufferKey, assistantDelta);
          yield* dispatchSubagentResultActivity({
            event,
            thread,
            childProviderThreadId,
            body,
            status: "inProgress",
            createdAt: now,
          });
        } else {
          const turnId = toTurnId(event.turnId);
          const assistantMessageId = yield* getOrCreateAssistantMessageId({
            threadId: thread.id,
            event,
            ...(turnId ? { turnId } : {}),
          });
          if (turnId) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
            serverSettingsService.getSettings,
            (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
          );
          if (assistantDeliveryMode === "buffered") {
            const spillChunk = yield* appendBufferedAssistantText(
              assistantMessageId,
              assistantDelta,
            );
            if (spillChunk.length > 0) {
              yield* orchestrationEngine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: spillChunk,
                ...(turnId ? { turnId } : {}),
                createdAt: now,
              });
            }
          } else {
            yield* queueStreamingAssistantDelta({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: assistantDelta,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const flushedMessageIds = yield* flushBufferedAssistantMessagesForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-delta-flush-on-request-opened"
              : "assistant-delta-flush-on-user-input-requested",
        });
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" &&
        (event.payload.itemType === "assistant_message" ||
          event.payload.itemType === "review_exited")
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const childProviderThreadId = childProviderThreadIdForEvent(event, thread);
        if (childProviderThreadId) {
          const bufferKey = subagentResultTextKey({ event, childProviderThreadId });
          const bufferedText = yield* takeBufferedSubagentResultText(bufferKey);
          const body =
            bufferedText.length > 0
              ? bufferedText
              : (assistantCompletion.fallbackText?.trim().length ?? 0) > 0
                ? assistantCompletion.fallbackText!
                : "";
          yield* dispatchSubagentResultActivity({
            event,
            thread,
            childProviderThreadId,
            body,
            status: "completed",
            createdAt: now,
          });
        } else {
          const detailedThread = yield* getLoadedThreadDetail();
          const messages = detailedThread?.messages ?? [];
          const turnId = toTurnId(event.turnId);
          const activeAssistantMessageId = turnId
            ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
            : Option.none<MessageId>();
          const hasAssistantMessagesForTurn =
            turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
          const assistantMessageId = Option.getOrElse(
            activeAssistantMessageId,
            () => assistantCompletion.messageId,
          );
          const existingAssistantMessage = findMessageById(messages, assistantMessageId);
          const shouldApplyFallbackCompletionText =
            !existingAssistantMessage || existingAssistantMessage.text.length === 0;

          const shouldSkipRedundantCompletion =
            Option.isNone(activeAssistantMessageId) &&
            turnId !== undefined &&
            hasAssistantMessagesForTurn &&
            (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

          if (!shouldSkipRedundantCompletion) {
            if (turnId && Option.isNone(activeAssistantMessageId)) {
              yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
            }

            yield* finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
              commandTag: "assistant-complete",
              finalDeltaCommandTag: "assistant-delta-finalize",
              hasProjectedMessage: existingAssistantMessage !== undefined,
              ...(assistantCompletion.fallbackText !== undefined &&
              shouldApplyFallbackCompletionText
                ? { fallbackText: assistantCompletion.fallbackText }
                : {}),
            });

            if (turnId) {
              yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
            }
          }

          if (turnId) {
            yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
          }
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              pendingBackgroundTaskCount: thread.session?.pendingBackgroundTaskCount ?? 0,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (
          turnId &&
          STRICT_PROVIDER_LIFECYCLE_GUARD &&
          !turnScopedRuntimeEventMatchesThread(thread, turnId)
        ) {
          yield* Effect.logDebug("provider runtime ingestion ignored stale turn diff event", {
            eventId: event.eventId,
            eventType: event.type,
            threadId: thread.id,
            eventTurnId: turnId,
            activeTurnId,
            latestTurnId: thread.latestTurn?.turnId ?? null,
          });
          return;
        }
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            const files = parseCheckpointFilesFromUnifiedDiff(event.payload.unifiedDiff);
            const checkpointTurnCount = maxCheckpointTurnCount(checkpointContext.checkpoints) + 1;
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files,
              assistantMessageId,
              checkpointTurnCount,
              createdAt: now,
            });
            const activity = checkpointFileChangeActivity({
              threadId: thread.id,
              turnId,
              checkpointTurnCount,
              files,
              createdAt: now,
            });
            if (activity) {
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId: providerCommandId(event, "thread-turn-diff-file-change-activity"),
                threadId: thread.id,
                activity,
                createdAt: activity.createdAt,
              });
            }
          }
        }
      }

      const activities = yield* projectRuntimeActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: domainCommandId(event, "thread-turn-preparing-activity"),
      threadId: event.payload.threadId,
      activity: {
        id: EventId.make(`activity:${event.eventId}:provider-turn-preparing`),
        tone: "info",
        kind: "provider.turn.preparing",
        summary: "Preparing provider turn",
        payload: {
          phase: "preparing",
          detail: "Preparing context and provider session before handing off to the provider",
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
        },
        turnId: null,
        createdAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });

  // Time from a turn starting until its first streamed output event, using
  // the provider-stamped event timestamps so queueing delays don't skew it.
  const turnStartTimestamps = new Map<string, number>();
  const firstOutputEventTypes: ReadonlySet<string> = new Set([
    "content.delta",
    "item.started",
    "item.updated",
    "item.completed",
  ]);
  const trackFirstOutputLatency = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    if (event.type === "turn.started") {
      if (event.turnId !== undefined) {
        const startedAtMs = Date.parse(event.createdAt);
        if (!Number.isNaN(startedAtMs)) {
          turnStartTimestamps.set(`${event.threadId}:${event.turnId}`, startedAtMs);
        }
      }
      return Effect.void;
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      if (event.turnId !== undefined) {
        turnStartTimestamps.delete(`${event.threadId}:${event.turnId}`);
      }
      return Effect.void;
    }
    if (event.type === "session.exited") {
      for (const key of turnStartTimestamps.keys()) {
        if (key.startsWith(`${event.threadId}:`)) {
          turnStartTimestamps.delete(key);
        }
      }
      return Effect.void;
    }
    if (event.turnId === undefined || !firstOutputEventTypes.has(event.type)) {
      return Effect.void;
    }
    const key = `${event.threadId}:${event.turnId}`;
    const startedAtMs = turnStartTimestamps.get(key);
    if (startedAtMs === undefined) {
      return Effect.void;
    }
    turnStartTimestamps.delete(key);
    const firstOutputAtMs = Date.parse(event.createdAt);
    if (Number.isNaN(firstOutputAtMs)) {
      return Effect.void;
    }
    return Metric.update(
      Metric.withAttributes(
        providerFirstOutputDuration,
        metricAttributes({ provider: event.provider }),
      ),
      Duration.millis(Math.max(0, firstOutputAtMs - startedAtMs)),
    );
  };

  const processInput = (input: RuntimeIngestionInput) => {
    switch (input.source) {
      case "runtime":
        return processRuntimeEvent(input.event);
      case "domain":
        return processDomainEvent(input.event);
      case "flush":
        return flushPendingStreamingAssistantMessages.pipe(Effect.asVoid);
    }
  };

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          ...(input.source === "flush"
            ? { eventId: "streaming-assistant-flush", eventType: "flush" }
            : { eventId: input.event.eventId, eventType: input.event.type }),
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          trackFirstOutputLatency(event).pipe(
            Effect.andThen(worker.enqueue({ source: "runtime", event })),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
      yield* Effect.forkScoped(
        Effect.sleep(STREAMING_ASSISTANT_DELTA_FLUSH_INTERVAL).pipe(
          Effect.andThen(
            Ref.get(pendingStreamingAssistantMessages).pipe(
              Effect.flatMap((pending) =>
                pending.size === 0 ? Effect.void : worker.enqueue({ source: "flush" }),
              ),
            ),
          ),
          Effect.forever,
        ),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
