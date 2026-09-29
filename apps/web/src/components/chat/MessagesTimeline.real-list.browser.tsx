import "../../index.css";

import {
  EnvironmentId,
  type OrchestrationThreadActivity,
  SideTurnId,
  ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { LIVE_REPRO_GZIP_BASE64 } from "./MessagesTimeline.live-repro.fixture";
import {
  deriveSubagentLiveEntries,
  deriveSubagentProgressState,
  deriveSubagentResultEntries,
  deriveThreadSubagentHistory,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import type { ChatMessage } from "../../types";

const ACTIVE_TURN_ID = "turn-active" as TurnId;
const queryClient = new QueryClient();

function TimelineQueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderTimeline(ui: ReactElement) {
  return render(ui, { wrapper: TimelineQueryProvider });
}

function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  clientY: number,
) {
  const touch = new Touch({ identifier: 1, target, clientY, clientX: 0 });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === "touchend" ? [] : [touch],
      changedTouches: [touch],
    }),
  );
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Calls `read` once per frame, after that frame is drawn: a task posted from a
 * frame's callbacks runs after the frame paints and, in Chromium, before work
 * queued while painting it. Sampling in the frame callback itself would miss a
 * bounce that a late correction undoes before the next frame. Returns a stop.
 */
function readAfterEachPaint(read: () => void): () => void {
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", read);
  channel.port1.start();
  let frame = requestAnimationFrame(function post() {
    channel.port2.postMessage(null);
    frame = requestAnimationFrame(post);
  });
  return () => {
    cancelAnimationFrame(frame);
    channel.port1.close();
  };
}

/** The largest step down between consecutive positions. */
function largestDrop(positions: ReadonlyArray<number>): number {
  return Math.max(...positions.slice(1).map((top, index) => top - positions[index]!));
}

function assistantBodyTop(messageId: string): number {
  return (
    document
      .querySelector(`[data-message-id="${messageId}"] [data-assistant-message-body="true"]`)
      ?.getBoundingClientRect().top ?? Number.NaN
  );
}

function buildProps() {
  return {
    isWorking: true,
    activeTurnInProgress: true,
    activeTurnId: ACTIVE_TURN_ID,
    activeTurnStartedAt: "2026-04-13T12:00:05.000Z",
    listRef: createRef<LegendListRef | null>(),
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    onPreviewFile: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

async function loadAffectedThreadFixture(): Promise<{
  activeTurnId: TurnId;
  activeTurnStartedAt: string;
  cutoff: string;
  activities: OrchestrationThreadActivity[];
  messages: ChatMessage[];
}> {
  const bytes = Uint8Array.from(atob(LIVE_REPRO_GZIP_BASE64), (character) =>
    character.charCodeAt(0),
  );
  const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(decompressed).text());
}

function deriveAffectedThreadRenderState(
  fixture: Awaited<ReturnType<typeof loadAffectedThreadFixture>>,
  cutoffMs: number,
) {
  const activities = fixture.activities.filter(
    (activity) => Date.parse(activity.createdAt) <= cutoffMs,
  );
  const messages = fixture.messages.filter((message) => Date.parse(message.createdAt) <= cutoffMs);
  const workEntries = deriveWorkLogEntries(activities, fixture.activeTurnId);
  const subagentResults = deriveSubagentResultEntries(activities);
  const subagentLiveEntries = deriveSubagentLiveEntries(activities);
  const progress = deriveSubagentProgressState({
    activities,
    latestTurnId: fixture.activeTurnId,
    latestTurnSettled: false,
  });
  return {
    timelineEntries: deriveTimelineEntries(
      messages,
      [],
      workEntries,
      subagentResults,
      [],
      subagentLiveEntries,
    ),
    turnAgents: {
      subagents: progress?.items ?? [],
      history: deriveThreadSubagentHistory(activities),
    },
  };
}

describe("MessagesTimeline with the real virtual list", () => {
  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("does not move streamed text back down as the response grows", async () => {
    const props = buildProps();
    const sentence =
      "This is a plain streamed sentence with enough words to wrap onto another line. ";
    const message: ChatMessage = {
      id: "streaming-response" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: sentence.repeat(20),
      streaming: true,
      createdAt: props.activeTurnStartedAt,
    };
    const renderList = (text: string) => (
      <div style={{ height: 400, width: 600 }}>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: message.id,
              kind: "message",
              createdAt: message.createdAt,
              message: { ...message, text },
            },
          ]}
        />
      </div>
    );
    const screen = await renderTimeline(renderList(message.text));
    let frame = 0;
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const body = document.querySelector<HTMLElement>('[data-assistant-message-body="true"]')!;
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]')!;
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      const positions: number[] = [];
      const sample = () => {
        positions.push(body.getBoundingClientRect().top);
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      for (let length = 15; length <= 900; length += 15) {
        await screen.rerender(renderList(message.text + sentence.repeat(12).slice(0, length)));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      cancelAnimationFrame(frame);
      const downwardSteps = positions.slice(1).map((top, index) => top - positions[index]!);
      expect(
        Math.max(...downwardSteps),
        "new lines must not make earlier text bounce down",
      ).toBeLessThanOrEqual(1);
      expect(positions.at(-1)).toBeLessThan(positions[0]! - 100);
      expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);

      // Reading above the tail must still hold the reader's position as the
      // response grows, instead of pulling them back into bottom-follow mode.
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -150, bubbles: true }));
      list.scrollTop -= 150;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const readingTop = body.getBoundingClientRect().top;
      await screen.rerender(renderList(message.text + sentence.repeat(20)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(Math.abs(body.getBoundingClientRect().top - readingTop)).toBeLessThanOrEqual(1);
    } finally {
      cancelAnimationFrame(frame);
      await screen.unmount();
    }
  });

  // A phone scroll starts while the list follows the stream: a scroll to the
  // end is still in flight, and the working row is the only row starting on
  // screen under the tall response. New lines must not move the text under a
  // finger, whether it rests or drags.
  it("leaves a touch drag where the finger put it while the response streams", async () => {
    const props = buildProps();
    const sentence =
      "This is a plain streamed sentence with enough words to wrap onto another line. ";
    const message: ChatMessage = {
      id: "streaming-response" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: sentence.repeat(20),
      streaming: true,
      createdAt: props.activeTurnStartedAt,
    };
    const renderList = (text: string) => (
      <div style={{ height: 400, width: 600 }}>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: message.id,
              kind: "message",
              createdAt: message.createdAt,
              message: { ...message, text },
            },
          ]}
        />
      </div>
    );
    let text = message.text;
    const screen = await renderTimeline(renderList(text));
    const streamChunk = async () => {
      text += sentence;
      await screen.rerender(renderList(text));
      await nextFrame();
      await nextFrame();
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const body = document.querySelector<HTMLElement>('[data-assistant-message-body="true"]')!;
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]')!;
      await streamChunk();
      expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);

      const drift: number[] = [];
      dispatchTouch(list, "touchstart", 200);
      const restingTop = body.getBoundingClientRect().top;
      await streamChunk();
      drift.push(Math.abs(body.getBoundingClientRect().top - restingTop));

      dispatchTouch(list, "touchmove", 220);
      list.scrollTop -= 20;
      await nextFrame();
      const heldTop = body.getBoundingClientRect().top;
      for (let chunk = 0; chunk < 6; chunk++) {
        await streamChunk();
        drift.push(Math.abs(body.getBoundingClientRect().top - heldTop));
      }
      dispatchTouch(list, "touchend", 220);

      expect(
        Math.max(...drift),
        `streamed lines must not move the text under the finger (${drift.join(", ")})`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  // The list holds still for a touch until it comes to rest, so a stream that
  // keeps growing meanwhile leaves the view short of the new bottom. A swipe
  // that ended at the bottom still means "follow", even when the list reports
  // that scroll only after more lines landed.
  it("follows the stream again after a swipe ends at the bottom", async () => {
    const props = buildProps();
    const sentence =
      "This is a plain streamed sentence with enough words to wrap onto another line. ";
    const message: ChatMessage = {
      id: "streaming-response" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: sentence.repeat(20),
      streaming: true,
      createdAt: props.activeTurnStartedAt,
    };
    const renderList = (text: string) => (
      <div style={{ height: 400, width: 600 }}>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: message.id,
              kind: "message",
              createdAt: message.createdAt,
              message: { ...message, text },
            },
          ]}
        />
      </div>
    );
    let text = message.text;
    const screen = await renderTimeline(renderList(text));
    // Four lines at a time, past the list's at-end tolerance.
    const streamLines = async () => {
      text += sentence.repeat(4);
      await screen.rerender(renderList(text));
      await nextFrame();
      await nextFrame();
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]')!;
      const distanceFromEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop;
      await streamLines();
      expect(distanceFromEnd()).toBeLessThanOrEqual(1);

      dispatchTouch(list, "touchstart", 200);
      dispatchTouch(list, "touchmove", 260);
      list.scrollTop -= 60;
      await nextFrame();
      await nextFrame();
      // More lines land while the finger rests. Then the finger brings the
      // list back to where the bottom was, which the list reports measured
      // after those lines, and lifts.
      const bottomBeforeLines = list.scrollHeight - list.clientHeight;
      await streamLines();
      list.scrollTop = bottomBeforeLines;
      await nextFrame();
      await nextFrame();
      dispatchTouch(list, "touchend", 260);

      // Once the list rests, it catches up and follows again. Wait for that
      // instead of timing the rest, which a slow machine reaches later.
      const atBottom = () => expect(distanceFromEnd()).toBeLessThanOrEqual(1);
      await vi.waitFor(atBottom, { timeout: 1_500 });
      await streamLines();
      await vi.waitFor(atBottom, { timeout: 1_500 });
    } finally {
      await screen.unmount();
    }
  });

  // A row that just landed first takes the list's guess of its height, then
  // the list shrinks to the height the row really draws. Desktop browsers
  // settle that before painting, but a phone's scroll can be caught past the
  // new bottom and snap back. The rows a live turn adds must not make the list
  // take back height it just gave them.
  it("never takes back height from the rows a live turn adds", async () => {
    const props = buildProps();
    const createdAt = (second: number) =>
      `2026-04-13T12:00:${String(second).padStart(2, "0")}.000Z`;
    const history: TimelineEntry[] = Array.from({ length: 8 }, (_, index) => {
      const message: ChatMessage = {
        id: `message-history-${index}` as ChatMessage["id"],
        role: index % 2 === 0 ? "user" : "assistant",
        text: `Earlier message ${index + 1}, with enough text that the thread scrolls.`,
        streaming: false,
        createdAt: `2026-04-13T11:59:${String(index).padStart(2, "0")}.000Z`,
      };
      return { id: message.id, kind: "message", createdAt: message.createdAt, message };
    });
    const step = (id: string, second: number, running: boolean): TimelineEntry => {
      const entry: WorkLogEntry = {
        id,
        createdAt: createdAt(second),
        ...(running ? {} : { completedAt: createdAt(second + 1) }),
        label: "Read file",
        detail: `apps/web/src/${id}.ts`,
        tone: "tool",
        executionState: running ? "running" : "completed",
        activityKind: running ? "tool.started" : "tool.completed",
        turnId: ACTIVE_TURN_ID,
      };
      return { id, kind: "work", createdAt: entry.createdAt, entry };
    };
    const reply: ChatMessage = {
      id: "reply" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: "",
      streaming: true,
      createdAt: createdAt(12),
    };
    const replyEntry: TimelineEntry = {
      id: reply.id,
      kind: "message",
      createdAt: reply.createdAt,
      message: reply,
    };
    const stages: TimelineEntry[][] = [
      [step("step-1", 10, true)],
      [step("step-1", 10, false), replyEntry],
      [step("step-1", 10, false), replyEntry, step("step-2", 14, false)],
    ];
    const renderList = (live: TimelineEntry[]) => (
      <div style={{ height: 400, width: 600 }}>
        <MessagesTimeline {...props} timelineEntries={[...history, ...live]} />
      </div>
    );
    const screen = await renderTimeline(renderList([]));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The list writes its content height on one element, and every write
      // lands here, including ones undone before paint.
      const content = document.querySelector(".legend-list-content-container")!;
      const heightIn = (style: string | null) =>
        Number(/(?:^|;)\s*height:\s*([\d.]+)px/.exec(style ?? "")?.[1] ?? Number.NaN);
      const drops: string[] = [];
      const collect = (records: MutationRecord[]) => {
        for (const record of records) {
          const target = record.target as Element;
          if (target.parentElement !== content) continue;
          const before = heightIn(record.oldValue);
          const after = heightIn(target.getAttribute("style"));
          if (after < before - 1) drops.push(`${before} -> ${after}`);
        }
      };
      const observer = new MutationObserver(collect);
      observer.observe(content, {
        attributes: true,
        attributeFilter: ["style"],
        attributeOldValue: true,
        subtree: true,
      });
      try {
        for (const live of stages) {
          await screen.rerender(renderList(live));
          await nextFrame();
        }
      } finally {
        collect(observer.takeRecords());
        observer.disconnect();
      }
      expect(drops, "rows must land at the height they draw").toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the affected ongoing-thread snapshot at the bottom of the list", async () => {
    const fixture = await loadAffectedThreadFixture();
    const startedAtMs = Date.parse(fixture.activeTurnStartedAt);
    const initialState = deriveAffectedThreadRenderState(fixture, startedAtMs);
    const props = buildProps();
    const onOpenAgentsPanel = vi.fn();
    const renderList = (state: ReturnType<typeof deriveAffectedThreadRenderState>) => (
      <div style={{ height: 710, width: 900 }}>
        <MessagesTimeline
          {...props}
          activeTurnId={fixture.activeTurnId}
          activeTurnStartedAt={fixture.activeTurnStartedAt}
          timelineEntries={state.timelineEntries}
          turnAgents={state.turnAgents}
          onOpenAgentsPanel={onOpenAgentsPanel}
        />
      </div>
    );
    const screen = await renderTimeline(renderList(initialState));

    try {
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]');
      expect(list).not.toBeNull();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-turn-working-anchor="true"]')).not.toBeNull();
      });
      const expectWorkingAnchorAtBottom = (label: string) => {
        const workingAnchor = document.querySelector<HTMLElement>(
          '[data-turn-working-anchor="true"]',
        );
        const currentList = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]');
        expect(workingAnchor, label).not.toBeNull();
        expect(currentList, label).not.toBeNull();
        const listRect = currentList!.getBoundingClientRect();
        const anchorRect = workingAnchor!.getBoundingClientRect();
        expect(anchorRect.bottom, label).toBeGreaterThan(listRect.top);
        expect(anchorRect.top, label).toBeLessThan(listRect.bottom);
        expect(listRect.bottom - anchorRect.bottom, label).toBeLessThan(48);
      };
      expectWorkingAnchorAtBottom("initial snapshot");
      const finalCutoffMs = Date.parse(fixture.cutoff);
      const replayTicks = Array.from(
        new Set(
          fixture.activities
            .map((activity) => Date.parse(activity.createdAt))
            .filter((at) => at > startedAtMs && at <= finalCutoffMs)
            .map((at) => Math.floor(at / 100) * 100),
        ),
      ).sort((left, right) => left - right);
      for (const cutoffMs of replayTicks) {
        await screen.rerender(renderList(deriveAffectedThreadRenderState(fixture, cutoffMs)));
        await vi.waitFor(() => {
          expectWorkingAnchorAtBottom(new Date(cutoffMs).toISOString());
        });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      expectWorkingAnchorAtBottom("settled replay");
    } finally {
      await screen.unmount();
    }
  });

  // LegendList pads its content box for one frame so a scroll adjustment can
  // overshoot content that has not grown yet, then removes the padding only if
  // the inline value still equals the string it wrote. Browsers re-serialize
  // CSS lengths (140.46875px reads back as 140.469px), which left the padding
  // behind forever on fractional-DPR machines: a blank tail below the last row
  // that scroll-to-bottom lands above. patches/@legendapp__list records the
  // stored value instead; this replay pins that with a read-back that never
  // matches the written string.
  it("clears the list's temporary end padding when the browser rounds the written value", async () => {
    // Exercise the library's anchored mode directly: the chat now disables
    // this mode while following streaming text at the bottom.
    const renderList = (height: number) => (
      <div style={{ height: 400, width: 600 }}>
        <LegendList
          data={[
            { id: "response", height },
            { id: "tail", height: 40 },
          ]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <div style={{ height: item.height }}>{item.id}</div>}
          estimatedItemSize={200}
          initialScrollAtEnd
          maintainScrollAtEnd={{ animated: false }}
          maintainVisibleContentPosition
          style={{ height: "100%" }}
        />
      </div>
    );
    const screen = await renderTimeline(renderList(600));
    let restorePaddingAccessor: (() => void) | null = null;

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const content = document.querySelector<HTMLElement>(".legend-list-content-container");
      expect(content).not.toBeNull();
      const style = content!.style;
      const paddingWrites: string[] = [];
      Object.defineProperty(style, "paddingBottom", {
        configurable: true,
        get: () => {
          const value = style.getPropertyValue("padding-bottom");
          return value === "" ? value : `${Number.parseFloat(value).toFixed(1)}px`;
        },
        set: (value: string) => {
          paddingWrites.push(value);
          style.setProperty("padding-bottom", value);
        },
      });
      restorePaddingAccessor = () => {
        delete (style as unknown as Record<string, unknown>)["paddingBottom"];
      };

      for (let step = 1; step <= 6; step++) {
        await screen.rerender(renderList(600 + step * 23.46875));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      expect(paddingWrites.length, "replay should exercise the temporary padding").toBeGreaterThan(
        0,
      );
      await vi.waitFor(() => {
        expect(getComputedStyle(content!).paddingBottom).toBe("0px");
      });
    } finally {
      restorePaddingAccessor?.();
      await screen.unmount();
    }
  });

  // In a room, another agent can answer above the one working at the bottom.
  // Both write at once, and the answer's steps land above its text. While the
  // list follows the bottom, nothing that grows above the tail may push the
  // text below it down, even for a frame.
  it("keeps both agents' text from bouncing while they write at once", async () => {
    const props = buildProps();
    const astraId = ThreadParticipantId.make("agent-astra");
    const agent = (name: string) => ({
      name,
      modelName: name,
      role: null,
      left: false,
      guest: false,
      reasoning: "High",
      entry: undefined,
    });
    const roomAgents = new Map([
      ["primary", agent("Opus 5.5")],
      ["agent-astra", agent("GPT-6 Astra")],
    ]);
    const at = (second: number) => `2026-04-13T12:00:${String(second).padStart(2, "0")}.000Z`;
    const sentence =
      "This is a plain streamed sentence with enough words to wrap onto another line. ";
    const history: TimelineEntry[] = Array.from({ length: 6 }, (_, index) => {
      const message: ChatMessage = {
        id: `message-history-${index}` as ChatMessage["id"],
        role: index % 2 === 0 ? "user" : "assistant",
        text: `Earlier message ${index + 1}, with enough text that the thread scrolls.`,
        streaming: false,
        createdAt: `2026-04-13T11:59:${String(index).padStart(2, "0")}.000Z`,
      };
      return { id: message.id, kind: "message", createdAt: message.createdAt, message };
    });
    const readStep = (id: string, second: number): WorkLogEntry => ({
      id,
      createdAt: at(second),
      completedAt: at(second + 1),
      label: "Read file",
      detail: `apps/web/src/${id}.ts`,
      tone: "tool",
      executionState: "completed",
      activityKind: "tool.completed",
    });
    const workingStep = (id: string, second: number): TimelineEntry => {
      const entry = { ...readStep(id, second), turnId: ACTIVE_TURN_ID };
      return { id, kind: "work", createdAt: entry.createdAt, entry };
    };
    const sideTurnId = SideTurnId.make("side-ask");
    const question: ChatMessage = {
      id: "side-question" as ChatMessage["id"],
      role: "user",
      text: "Does the lock get released on every path?",
      participantId: astraId,
      sideTurnId,
      fromAgent: { participantId: null },
      requestKind: "ask",
      streaming: false,
      createdAt: at(7),
    };
    const answer: ChatMessage = {
      id: "side-answer" as ChatMessage["id"],
      role: "assistant",
      text: sentence,
      participantId: astraId,
      sideTurnId,
      streaming: true,
      createdAt: at(8),
    };
    const reply: ChatMessage = {
      id: "working-reply" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: sentence.repeat(4),
      streaming: true,
      createdAt: at(12),
    };
    const renderList = (live: {
      reply: string;
      answer: string;
      steps: ReadonlyArray<WorkLogEntry>;
    }) => (
      <div style={{ height: 500, width: 700 }}>
        <MessagesTimeline
          {...props}
          roomAgents={roomAgents}
          sideAnswers={[
            {
              sideTurnId,
              participantId: astraId,
              kind: "ask",
              askedBy: { participantId: null },
              question,
              answer: { ...answer, text: live.answer },
              steps: live.steps,
              state: "answering",
              error: null,
            },
          ]}
          timelineEntries={[
            ...history,
            workingStep("asked-step", 6),
            workingStep("later-step", 10),
            {
              id: reply.id,
              kind: "message",
              createdAt: reply.createdAt,
              message: { ...reply, text: live.reply },
            },
          ]}
        />
      </div>
    );
    const live = { reply: reply.text, answer: answer.text, steps: [] as WorkLogEntry[] };
    const screen = await renderTimeline(renderList(live));
    const tops = { answer: [] as number[], reply: [] as number[] };
    let stopReading = () => {};
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      stopReading = readAfterEachPaint(() => {
        tops.answer.push(assistantBodyTop(answer.id));
        tops.reply.push(assistantBodyTop(reply.id));
      });
      for (let chunk = 0; chunk < 30; chunk++) {
        live.answer += sentence.slice(0, 30);
        if (chunk % 2 === 0) {
          live.reply += sentence.slice(0, 40);
        }
        if (chunk % 6 === 0) {
          live.steps = [...live.steps, readStep(`side-step-${chunk}`, 8)];
        }
        await screen.rerender(renderList(live));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      stopReading();

      expect(tops.reply.length).toBeGreaterThan(10);
      expect(tops.reply.every(Number.isFinite)).toBe(true);
      expect(tops.answer.every(Number.isFinite)).toBe(true);
      expect(
        largestDrop(tops.reply),
        "the working agent's text must not bounce down",
      ).toBeLessThanOrEqual(1);
      expect(
        largestDrop(tops.answer),
        "the answering agent's text must not bounce down",
      ).toBeLessThanOrEqual(1);
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]')!;
      expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      stopReading();
      await screen.unmount();
    }
  });

  // Half-written markdown can render taller than it ends up (a bare `- `, a
  // code fence before its first line, a link before its `)`), and the list
  // measures a streamed update before the text still waiting to be revealed
  // is hidden. While the list follows the bottom, neither may pull the text
  // down.
  it("keeps streamed markdown from bouncing as its blocks arrive", async () => {
    const props = buildProps();
    const script = [
      "Here is what happens when a job fails, step by step, with the parts that matter most.",
      "",
      "- The job leaves the queue before the lock is taken, so a stuck lock loses it too.",
      "- A failure logs the error and returns early, which leaves the lock held for good.",
      "- Retries run one attempt fewer than asked, because the loop stops before the last.",
      "",
      "```ts",
      "for (let attempt = 1; attempt <= attempts; attempt++) {",
      "  await fn();",
      "}",
      "```",
      "",
      "See [the retry loop](/tmp/project/src/retry.ts:4) and [the drain loop](/tmp/project/src/queue.ts:19) for where each starts.",
      "",
      "1. Release the lock in a finally block, so a failure can never leak it.",
      "2. Keep failed jobs on a list instead of dropping them on the floor.",
      "",
      "",
    ]
      .join("\n")
      .repeat(3);
    const history: TimelineEntry[] = Array.from({ length: 6 }, (_, index) => {
      const message: ChatMessage = {
        id: `message-history-${index}` as ChatMessage["id"],
        role: index % 2 === 0 ? "user" : "assistant",
        text: `Earlier message ${index + 1}, with enough text that the thread scrolls.`,
        streaming: false,
        createdAt: `2026-04-13T11:59:${String(index).padStart(2, "0")}.000Z`,
      };
      return { id: message.id, kind: "message", createdAt: message.createdAt, message };
    });
    const reply: ChatMessage = {
      id: "streaming-markdown" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: "",
      streaming: true,
      createdAt: props.activeTurnStartedAt,
    };
    const renderList = (text: string) => (
      <div style={{ height: 500, width: 700 }}>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            ...history,
            {
              id: reply.id,
              kind: "message",
              createdAt: reply.createdAt,
              message: { ...reply, text },
            },
          ]}
        />
      </div>
    );
    const screen = await renderTimeline(renderList(""));
    // Runs of frames the list spent pinned to its bottom, with the reply's top
    // in each.
    const pinnedRuns: number[][] = [[]];
    let stopReading = () => {};
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]')!;
      stopReading = readAfterEachPaint(() => {
        const top = assistantBodyTop(reply.id);
        const pinned = list.scrollHeight - list.clientHeight - list.scrollTop <= 1;
        if (pinned && Number.isFinite(top)) pinnedRuns.at(-1)!.push(top);
        else if (pinnedRuns.at(-1)!.length > 0) pinnedRuns.push([]);
      });
      for (let length = 9; length <= script.length; length += 9) {
        await screen.rerender(renderList(script.slice(0, length)));
        await nextFrame();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      stopReading();

      expect(pinnedRuns.flat().length).toBeGreaterThan(50);
      expect(
        Math.max(...pinnedRuns.filter((run) => run.length > 1).map(largestDrop)),
        "streamed blocks must not pull the text down",
      ).toBeLessThanOrEqual(1);
      expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      stopReading();
      await screen.unmount();
    }
  });

  // A live reply fades and rises in as it arrives. The list re-sorts its row
  // elements in the DOM once positions settle, moving them with insertBefore,
  // and a reply already on screen must not play that entrance again: blink out
  // and rise 3px in the middle of a sentence.
  it("plays a streaming reply's entrance once, not again when the list re-sorts its rows", async () => {
    const props = buildProps();
    const reply: ChatMessage = {
      id: "streaming-reply" as ChatMessage["id"],
      role: "assistant",
      turnId: ACTIVE_TURN_ID,
      text: "Reading the queue before touching the lock.",
      streaming: true,
      createdAt: props.activeTurnStartedAt,
    };
    // The reply's opacity and top after every painted frame. The first frame
    // of an animation always draws its start, however slow the machine, so
    // reading each frame cannot miss an entrance.
    const frames: { opacity: number; top: number }[] = [];
    const stopReading = readAfterEachPaint(() => {
      const row = document.querySelector(`[data-message-id="${reply.id}"]`);
      const body = row?.querySelector('[data-assistant-message-body="true"]');
      if (!row || !body) return;
      let opacity = 1;
      for (let node: Element | null = body; node && node !== row.parentElement;) {
        opacity *= Number(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      frames.push({ opacity, top: body.getBoundingClientRect().top });
    });
    const screen = await renderTimeline(
      <div style={{ height: 500, width: 700 }}>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            { id: reply.id, kind: "message", createdAt: reply.createdAt, message: reply },
          ]}
        />
      </div>,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(frames[0]!.opacity, "the reply fades in as it arrives").toBeLessThan(1);
      const settled = frames.at(-1)!;
      expect(settled.opacity).toBe(1);

      const moved = frames.length;
      const row = document.querySelector(`[data-message-id="${reply.id}"]`)!;
      const container = row.parentElement!;
      container.parentElement!.insertBefore(container, container.parentElement!.firstChild);
      for (let frame = 0; frame < 3; frame++) await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterMove = frames.slice(moved);
      expect(afterMove.length).toBeGreaterThan(0);
      for (const frame of afterMove) {
        expect(frame.opacity, "the reply must not blink out").toBe(1);
        expect(frame.top, "the reply must not drop").toBe(settled.top);
      }
    } finally {
      stopReading();
      await screen.unmount();
    }
  });

  it("removes stale end space when a live working anchor settles", async () => {
    const turnId = "turn-settles" as TurnId;
    const userMessage: ChatMessage = {
      id: "message-user" as ChatMessage["id"],
      role: "user",
      text: "Watch checks and ship when green",
      streaming: false,
      createdAt: "2026-08-21T21:37:36.097Z",
    };
    const firstAssistantMessage: ChatMessage = {
      id: "message-assistant-progress" as ChatMessage["id"],
      role: "assistant",
      turnId,
      text: "The fix worked. Vercel now passes and only the big CI job is still running.",
      streaming: false,
      createdAt: "2026-08-21T21:37:58.782Z",
      completedAt: "2026-08-21T21:38:00.708Z",
    };
    const finalAssistantMessage: ChatMessage = {
      id: "message-assistant-final" as ChatMessage["id"],
      role: "assistant",
      turnId,
      text: [
        "Yes, the restart killed my watcher, but nothing was lost. Current state:",
        "",
        "- My length fix cleared both failures. The Vercel preview now builds, and all small checks pass.",
        "- Only the big CI job is still running. It takes about 15 minutes.",
        "- The PR is mergeable once that goes green.",
        "",
        "I started a new watcher. When CI passes I'll merge the PR, wait for CI on main, then tag the stable.",
      ].join("\n"),
      streaming: false,
      createdAt: "2026-08-21T21:38:05.801Z",
      completedAt: "2026-08-21T21:38:08.221Z",
    };
    const commandEntry: WorkLogEntry = {
      id: "work-command",
      createdAt: "2026-08-21T21:38:01.950Z",
      completedAt: "2026-08-21T21:38:03.150Z",
      label: "Ran command",
      detail: "gh pr checks 168 --watch --interval 30 > $null 2>&1",
      command: "gh pr checks 168 --watch --interval 30 > $null 2>&1",
      tone: "tool",
      executionState: "completed",
      activityKind: "tool.completed",
      turnId,
    };
    const historyEntries: TimelineEntry[] = Array.from({ length: 10 }, (_, index) => {
      const message: ChatMessage = {
        id: `message-history-${index}` as ChatMessage["id"],
        role: index % 2 === 0 ? "user" : "assistant",
        text:
          index % 2 === 0
            ? `Earlier user message ${index + 1} with enough text to make the thread scroll.`
            : [
                `Earlier assistant response ${index + 1}.`,
                "",
                "This row is intentionally a little taller so the regression test uses a scrollable timeline, matching the real session shape.",
              ].join("\n"),
        streaming: false,
        createdAt: `2026-08-21T21:36:${String(index).padStart(2, "0")}.000Z`,
      };
      return {
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      };
    });
    const entries: TimelineEntry[] = [
      ...historyEntries,
      {
        id: userMessage.id,
        kind: "message",
        createdAt: userMessage.createdAt,
        message: userMessage,
      },
      {
        id: firstAssistantMessage.id,
        kind: "message",
        createdAt: firstAssistantMessage.createdAt,
        message: firstAssistantMessage,
      },
      {
        id: commandEntry.id,
        kind: "work",
        createdAt: commandEntry.createdAt,
        entry: commandEntry,
      },
      {
        id: finalAssistantMessage.id,
        kind: "message",
        createdAt: finalAssistantMessage.createdAt,
        message: finalAssistantMessage,
      },
    ];
    const props = buildProps();
    const renderList = (active: boolean) => (
      <div style={{ height: 710, width: 900 }}>
        <MessagesTimeline
          {...props}
          isWorking={active}
          activeTurnInProgress={active}
          activeTurnId={turnId}
          activeTurnStartedAt="2026-08-21T21:37:46.481Z"
          timelineEntries={entries}
        />
      </div>
    );
    const screen = await renderTimeline(renderList(true));

    try {
      const list = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]');
      expect(list).not.toBeNull();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-turn-working-anchor="true"]')).not.toBeNull();
      });
      await new Promise((resolve) => window.setTimeout(resolve, 150));

      await screen.rerender(renderList(false));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-turn-working-anchor="true"]')).toBeNull();
      });
      await new Promise((resolve) => window.setTimeout(resolve, 150));

      const finalRow = document.querySelector<HTMLElement>(
        '[data-message-id="message-assistant-final"]',
      );
      const currentList = document.querySelector<HTMLElement>('[data-chat-messages-list="true"]');
      expect(finalRow).not.toBeNull();
      expect(currentList).not.toBeNull();
      const listRect = currentList!.getBoundingClientRect();
      const finalRowRect = finalRow!.getBoundingClientRect();
      expect(listRect.bottom - finalRowRect.bottom).toBeLessThan(64);
    } finally {
      await screen.unmount();
    }
  });
});
