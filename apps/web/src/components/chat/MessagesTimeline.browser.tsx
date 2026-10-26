import "../../index.css";

import {
  ChildRequestId,
  OutsideAgentConnectionId,
  EnvironmentId,
  MessageId,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../../uiStateStore";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import { ThreadlinesFigure } from "../ThreadlinesFigure";
import { deriveTimelineEntries } from "../../session-logic";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));

// Viewport 100 / content 200 at offset 0 — a full viewport away from the end.
const AWAY_FROM_END_SCROLL_METRICS = {
  layoutMeasurement: { height: 100 },
  contentSize: { height: 200 },
  contentOffset: { y: 0 },
  contentInset: { bottom: 0 },
};
// 10px from the end: past the touch intent threshold, still inside the 24px
// at-end tolerance — the window a mobile drag has to cross.
const NEAR_END_SCROLL_METRICS = {
  layoutMeasurement: { height: 100 },
  contentSize: { height: 210 },
  contentOffset: { y: 100 },
  contentInset: { bottom: 0 },
};
let timelineScrollMetrics: typeof AWAY_FROM_END_SCROLL_METRICS = AWAY_FROM_END_SCROLL_METRICS;

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    maintainScrollAtEnd?: unknown;
    onScroll?: (event: {
      nativeEvent: {
        layoutMeasurement: { height: number };
        contentSize: { height: number };
        contentOffset: { y: number };
        contentInset: { bottom: number };
      };
    }) => void;
    onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
    onTouchStartCapture?: React.TouchEventHandler<HTMLDivElement>;
    onTouchMoveCapture?: React.TouchEventHandler<HTMLDivElement>;
    onTouchEndCapture?: React.TouchEventHandler<HTMLDivElement>;
    ref?: React.Ref<LegendListRef>;
  }) {
    React.useImperativeHandle(
      props.ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div
        data-testid="legend-list"
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "true" : "false"}
        onScroll={() => {
          props.onScroll?.({ nativeEvent: timelineScrollMetrics });
        }}
        onWheelCapture={props.onWheelCapture}
        onTouchStartCapture={props.onTouchStartCapture}
        onTouchMoveCapture={props.onTouchMoveCapture}
        onTouchEndCapture={props.onTouchEndCapture}
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";
import type { SideAnswerView } from "./sideAnswers";
import { TIMELINE_ENTRANCE_ANIMATION_ID } from "./timelineEntrance";

const MESSAGE_CREATED_AT = "2026-04-13T12:00:00.000Z";

// User rows resolve attachment previews through react-query, so timeline
// renders need the provider the app root supplies. The wrapper option keeps
// it across screen.rerender calls.
const timelineQueryClient = new QueryClient();

function TimelineQueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={timelineQueryClient}>{children}</QueryClientProvider>;
}

function renderTimeline(ui: ReactElement) {
  return render(ui, { wrapper: TimelineQueryProvider });
}

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
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

function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  clientY: number,
) {
  const touch = new Touch({ identifier: 1, target, clientY, clientX: 0 });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      touches: type === "touchend" ? [] : [touch],
      changedTouches: [touch],
    }),
  );
}

// Native events dispatched outside React's act() flush their state updates on a
// later task, so settle them before asserting a render *didn't* happen. Stays
// well under USER_SCROLL_STICK_LOCK_MS so the lock is still held on the far side.
function flushPendingRenders() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 100);
  });
}

/**
 * Draws this document as a touch screen does: `(pointer: coarse)` rules apply
 * and hover rules don't. Returns the undo. It rewrites the page's own media
 * rules, not the browser's: CDP touch emulation, once turned off, leaves hover
 * off for the rest of the tab on Linux CI, and later specs share that tab.
 */
function drawAsTouchScreen() {
  const undo: Array<() => void> = [];
  const rewrite = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        const original = rule.media.mediaText;
        const touch = original.includes("(hover: hover)")
          ? "not all"
          : original.replace("(pointer: coarse)", "all").replace("(hover: none)", "all");
        if (touch !== original) {
          rule.media.mediaText = touch;
          undo.push(() => {
            rule.media.mediaText = original;
          });
        }
      }
      // Media rules, layers and (nested) style rules all hold rules.
      if (rule instanceof CSSGroupingRule) {
        rewrite(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    rewrite(sheet.cssRules);
  }
  return () => {
    for (const step of undo) step();
  };
}

async function resetBrowserHoverState() {
  const resetTarget = document.createElement("button");
  resetTarget.type = "button";
  resetTarget.setAttribute("aria-label", "Reset hover target");
  resetTarget.style.cssText = "display:block;width:24px;height:24px;margin:0;padding:0";
  document.body.append(resetTarget);

  try {
    await page.getByRole("button", { name: "Reset hover target" }).hover();
  } finally {
    resetTarget.remove();
  }
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string, messageId = "message-1") {
  return {
    id: `entry-${messageId}`,
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: messageId as never,
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  return {
    id: "assistant-entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "assistant-message-1" as never,
      role: "assistant" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      completedAt: "2026-04-13T12:00:30.000Z",
      streaming: false,
    },
  };
}

function buildSubagentResultTimelineEntry(objective: string) {
  return {
    id: "subagent-result:turn-1:agent-1",
    kind: "subagent-result" as const,
    createdAt: MESSAGE_CREATED_AT,
    result: {
      id: "subagent-result:turn-1:agent-1",
      createdAt: MESSAGE_CREATED_AT,
      turnId: TurnId.make("turn-1"),
      agentThreadId: "agent-1",
      label: "Reviewer subagent",
      role: "reviewer",
      objective,
      body: "**Finding:** subagent output is visible.",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    },
  };
}

const ACTIVITY_ROW_TURN_ID = TurnId.make("turn-activity");

/** Enough tool rows that the work row collapses into its activity receipt,
 *  which is the row the subagent summary extends. */
function buildOverflowingWorkTimelineEntries() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `work-${index}`,
    kind: "work" as const,
    createdAt: `2026-04-13T12:0${index}:00.000Z`,
    entry: {
      id: `work-${index}`,
      createdAt: `2026-04-13T12:0${index}:00.000Z`,
      turnId: ACTIVITY_ROW_TURN_ID,
      label: "command",
      detail: `Step ${index + 1}`,
      command: `echo step-${index + 1}`,
      tone: "tool" as const,
    },
  }));
}

function buildTurnSubagent(
  id: string,
  status: "running" | "completed" | "waiting" | "interrupted",
) {
  return {
    id,
    agentThreadId: id,
    transcriptAgentId: id,
    turnId: ACTIVITY_ROW_TURN_ID,
    label: "Subagent",
    role: null,
    objective: "Review the change",
    status,
    statusLabel:
      status === "waiting"
        ? "Needs approval"
        : status === "completed"
          ? "Done"
          : status === "interrupted"
            ? "Stopped"
            : "Running",
    model: null,
    reasoningEffort: null,
    liveBody: null,
    telemetry: null,
    createdAt: "2026-04-13T12:00:00.000Z",
    updatedAt: "2026-04-13T12:00:10.000Z",
  };
}

describe("MessagesTimeline", () => {
  it("shows a follow-up below the original conversation after a clock correction", async () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("original"),
          role: "user",
          text: "Original request",
          createdAt: "2026-09-05T06:53:37.000Z",
          eventSequence: 10,
          streaming: false,
        },
        {
          id: MessageId.make("answer"),
          role: "assistant",
          text: "Original answer",
          createdAt: "2026-09-05T06:53:41.000Z",
          eventSequence: 11,
          streaming: false,
        },
        {
          id: MessageId.make("follow-up"),
          role: "user",
          text: "Request after restart",
          createdAt: "2026-09-05T06:53:05.000Z",
          eventSequence: 12,
          streaming: false,
        },
      ],
      [],
      [],
    );
    const screen = await renderTimeline(
      <MessagesTimeline {...buildProps()} timelineEntries={entries} />,
    );
    try {
      await expect.element(page.getByText("Request after restart", { exact: true })).toBeVisible();
      const original = page.getByText("Original request", { exact: true }).element();
      const answer = page.getByText("Original answer", { exact: true }).element();
      const followUp = page.getByText("Request after restart", { exact: true }).element();
      expect(
        original.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        answer.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      await screen.unmount();
    }
  });

  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    timelineScrollMetrics = AWAY_FROM_END_SCROLL_METRICS;
    useUiStateStore.setState({ threadChangedFilesExpandedById: {} });
    __resetClientSettingsPersistenceForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps a decorative empty state inside an extra-narrow timeline", async () => {
    const screen = await renderTimeline(
      <div className="h-[400px] w-[240px]">
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[]}
          emptyState={
            <div
              className="flex w-full min-w-0 flex-col items-center"
              data-testid="narrow-timeline-empty-state"
            >
              <ThreadlinesFigure />
              <span>Empty thread</span>
            </div>
          }
        />
      </div>,
    );

    try {
      const emptyState = page.getByTestId("narrow-timeline-empty-state").element();
      const scroller = emptyState.parentElement?.parentElement;
      const figure = emptyState.querySelector("svg");

      expect(scroller).toBeTruthy();
      expect(figure).toBeTruthy();
      expect(getComputedStyle(scroller!).overflowX).toBe("hidden");
      expect(figure!.getBoundingClientRect().width).toBeLessThanOrEqual(
        emptyState.getBoundingClientRect().width,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Inspecting repository state" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the working line's dots level with the running step it names", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        timelineEntries={[
          {
            id: "entry-command",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-command",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test",
              rawCommand: "powershell -NoProfile -Command bun run test",
              executionState: "running",
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Running tests")).toBeVisible();

      const label = document.querySelector<HTMLElement>("[data-turn-working-label='true']");
      const dots = document.querySelector<HTMLElement>(".working-dots");
      expect(label).not.toBeNull();
      expect(dots).not.toBeNull();

      const labelRect = label!.getBoundingClientRect();
      const dotsRect = dots!.getBoundingClientRect();
      const labelCenterY = labelRect.top + labelRect.height / 2;
      const dotsCenterY = dotsRect.top + dotsRect.height / 2;

      // The dots sit a hair above the text's middle on purpose (-top-px).
      expect(Math.abs(labelCenterY - dotsCenterY)).toBeLessThanOrEqual(2);
      // Nothing about the running command is drawn as settled.
      expect(document.querySelector("[data-activity-group='true']")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the newest line a running command printed under the working line", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        timelineEntries={[
          {
            id: "entry-command",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-command",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test",
              executionState: "running",
              // Streamed output, escape codes and a blank last line included.
              outputPreview: "RUN v4\n\u001b[32m✓\u001b[39m src/a.test.ts (3 tests)\n\n",
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Running tests")).toBeVisible();
      const output = document.querySelector<HTMLElement>("[data-turn-working-output='true']");
      expect(output?.textContent).toBe("✓ src/a.test.ts (3 tests)");
    } finally {
      await screen.unmount();
    }
  });

  it("names the step a side answer is on, on its one line, without moving Stop", async () => {
    const astra = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    const sideTurnId = SideTurnId.make("side-live");
    const roomAgents = new Map([
      [
        astra as string,
        {
          name: "GPT-6-Astra",
          modelName: "GPT-6-Astra",
          role: null,
          left: false,
          guest: false,
          reasoning: null,
          entry: undefined,
        },
      ],
    ]);
    const reading = (file: string): SideAnswerView => ({
      sideTurnId,
      participantId: astra,
      kind: "ask",
      askedBy: null,
      question: {
        id: MessageId.make("side-question"),
        role: "user",
        text: "Is the lock released on every path?",
        participantId: astra,
        sideTurnId,
        createdAt: MESSAGE_CREATED_AT,
        streaming: false,
      },
      answer: null,
      steps: [
        {
          id: "astra-read",
          createdAt: MESSAGE_CREATED_AT,
          label: "Read file",
          tone: "tool",
          itemType: "dynamic_tool_call",
          toolTitle: "Read file",
          detail: `src/${file}`,
          executionState: "running",
        },
      ],
      state: "answering",
      error: null,
    });
    const timeline = (sideAnswer: SideAnswerView) => (
      <div className="w-[420px]">
        <MessagesTimeline
          {...buildProps()}
          isWorking
          activeTurnStartedAt={MESSAGE_CREATED_AT}
          roomAgents={roomAgents}
          sideAnswers={[sideAnswer]}
          onStopSideAnswer={vi.fn()}
          timelineEntries={[buildUserTimelineEntry("Fix the lock.")]}
        />
      </div>
    );
    const screen = await renderTimeline(timeline(reading("lock.ts")));

    try {
      const line = () =>
        document.querySelector<HTMLElement>('[data-side-answer-status="answering"] > div')!;
      const stop = () => page.getByRole("button", { name: "Stop" }).element();
      await expect.element(page.getByText("GPT-6-Astra · Reading lock.ts")).toBeVisible();
      const stopAt = stop().getBoundingClientRect();

      // A step too long for the line truncates: Stop stays where it was, on
      // the same single line, and the timer stays in view.
      await screen.rerender(timeline(reading(`${"retry".repeat(30)}.ts`)));
      await expect.element(page.getByText(/GPT-6-Astra · Reading retryretry/u)).toBeVisible();
      expect(line().getBoundingClientRect().height).toBeLessThanOrEqual(20);
      expect(stop().getBoundingClientRect().right).toBe(stopAt.right);
      expect(stop().getBoundingClientRect().top).toBe(stopAt.top);
      expect(line().textContent).toMatch(/· \d+[smh]/u);
    } finally {
      await screen.unmount();
    }
  });

  it("says when the agent will check back, and cancels from the line", async () => {
    // A fixed midday clock, so the check-back 14 minutes out is still today:
    // on the real clock a run after 23:45 reads "Checks back tomorrow at …".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 3, 13, 12, 0, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const cancelled: string[] = [];
    const scheduledFor = new Date(Date.now() + 14 * 60_000 + 20_000).toISOString();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking={false}
        checkBacks={[
          {
            id: "wake-1",
            participantId: null,
            scheduledFor,
            exact: true,
            recurring: false,
            description: "Waiting for CI on PR #502",
            durable: false,
          },
        ]}
        onCancelCheckBack={(checkBack) => cancelled.push(checkBack.id)}
        timelineEntries={[
          {
            id: "entry-reply",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-reply",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Checked PR #502",
              tone: "tool",
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Waiting for CI on PR #502")).toBeVisible();
      const label = document.querySelector<HTMLElement>("[data-check-back-label='true']");
      expect(label?.textContent).toMatch(/^Checks back at /u);
      expect(document.querySelector("[data-check-back-row='true']")?.textContent).toContain(
        "in 14m",
      );
      await page.getByRole("button", { name: "Cancel" }).click();
      expect(cancelled).toEqual(["wake-1"]);
    } finally {
      await screen.unmount();
    }
  });

  it("shows how long a long check took, from the provider's stamps", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-command",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-command",
              createdAt: "2026-04-13T12:00:00.000Z",
              completedAt: "2026-04-13T12:00:52.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "vp run typecheck",
              executionState: "completed",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "Typecheck passed 52s" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens a step into its exact command and output, and copies the output", async () => {
    const outputLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
    const expectedCopiedOutput = outputLines.slice(-20).join("\n");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-command",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-command",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "Get-Process",
              rawCommand: "powershell -NoProfile -Command Get-Process",
              executionState: "completed",
              outputPreview: outputLines.join("\n"),
            },
          },
        ]}
      />,
    );

    try {
      const line = page.getByRole("button", { name: "Checked the environment" });
      await line.click();

      await expect.element(line).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("line 24")).toBeVisible();
      const detail = document.querySelector<HTMLElement>('[data-activity-detail="true"]');
      expect(detail?.textContent).toContain("Get-Process");
      // The oldest lines fall outside the retained tail.
      expect(detail?.textContent).not.toContain("line 4\n");

      // Clicking inside the opened detail leaves it open.
      detail!.click();
      await expect.element(line).toHaveAttribute("aria-expanded", "true");

      await page.getByRole("button", { name: "Copy output" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(expectedCopiedOutput);
      });

      await line.click();
      await expect.element(page.getByText("line 24")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await renderTimeline(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect
        .element(page.getByRole("button", { name: "Inspecting repository state" }))
        .toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("settles populated timelines at the bottom on initial mount", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "Inspecting repository state" }))
        .toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("re-arms bottom sticking when a parent stick request follows user scroll intent", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const timelineEntries = [buildUserTimelineEntry("Message before send.")];
    const screen = await renderTimeline(
      <MessagesTimeline {...props} stickToBottomRequestKey={0} timelineEntries={timelineEntries} />,
    );

    try {
      let legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(legendList).not.toBeNull();
      expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");

      scrollToEndSpy.mockClear();
      props.onIsAtEndChange.mockClear();

      legendList?.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true }));

      await vi.waitFor(() => {
        legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("false");
      });
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(false);

      await screen.rerender(
        <MessagesTimeline
          {...props}
          stickToBottomRequestKey={1}
          timelineEntries={timelineEntries}
        />,
      );

      await vi.waitFor(() => {
        legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");
      });
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
    } finally {
      await screen.unmount();
    }
  });

  it("re-sticks to the bottom when the viewport resizes under an armed timeline", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const timelineEntries = [buildUserTimelineEntry("Message sent from a phone.")];
    const screen = await renderTimeline(
      <MessagesTimeline {...props} timelineEntries={timelineEntries} />,
    );

    try {
      const legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");

      scrollToEndSpy.mockClear();

      // The on-screen keyboard closing after a send.
      window.visualViewport?.dispatchEvent(new Event("resize"));

      await vi.waitFor(() => {
        expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      });

      // A user who scrolled away from the end stays where they are.
      legendList?.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true }));
      await vi.waitFor(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(list?.getAttribute("data-maintain-scroll-at-end")).toBe("false");
      });

      scrollToEndSpy.mockClear();
      window.visualViewport?.dispatchEvent(new Event("resize"));

      expect(scrollToEndSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps following new live output after a parent stick request", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const initialEntries = [buildUserTimelineEntry("Message before send.")];
    const screen = await renderTimeline(
      <MessagesTimeline {...props} stickToBottomRequestKey={0} timelineEntries={initialEntries} />,
    );

    try {
      let legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(legendList).not.toBeNull();

      legendList?.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true }));

      await vi.waitFor(() => {
        legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("false");
      });

      await screen.rerender(
        <MessagesTimeline
          {...props}
          stickToBottomRequestKey={1}
          timelineEntries={initialEntries}
        />,
      );

      await vi.waitFor(() => {
        legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");
      });

      scrollToEndSpy.mockClear();
      props.onIsAtEndChange.mockClear();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          activeTurnInProgress
          stickToBottomRequestKey={1}
          timelineEntries={[
            initialEntries[0]!,
            buildAssistantTimelineEntry("Streaming response has started."),
          ]}
        />,
      );

      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
    } finally {
      await screen.unmount();
    }
  });

  it("ignores transient away-from-end scroll events while bottom sticking is armed", async () => {
    const props = buildProps();
    const screen = await renderTimeline(
      <MessagesTimeline {...props} timelineEntries={[buildUserTimelineEntry("Pinned message.")]} />,
    );

    try {
      const legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(legendList).not.toBeNull();
      expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");

      props.onIsAtEndChange.mockClear();
      legendList?.dispatchEvent(new Event("scroll", { bubbles: true }));

      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a touch drag disarmed while it is still inside the at-end tolerance", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...props}
        activeTurnInProgress
        isWorking
        timelineEntries={[buildUserTimelineEntry("Streaming reply in progress.")]}
      />,
    );

    try {
      const legendList = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(legendList).not.toBeNull();
      expect(legendList?.getAttribute("data-maintain-scroll-at-end")).toBe("true");

      dispatchTouch(legendList!, "touchstart", 400);
      dispatchTouch(legendList!, "touchmove", 412);

      await vi.waitFor(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(list?.getAttribute("data-maintain-scroll-at-end")).toBe("false");
      });

      // The drag has moved further than the intent threshold but is still
      // within the at-end tolerance, so the list keeps reporting itself at the
      // end. Re-arming on those scroll events is what snapped the timeline back
      // under the finger.
      timelineScrollMetrics = NEAR_END_SCROLL_METRICS;
      scrollToEndSpy.mockClear();
      legendList?.dispatchEvent(new Event("scroll", { bubbles: true }));
      dispatchTouch(legendList!, "touchmove", 424);
      legendList?.dispatchEvent(new Event("scroll", { bubbles: true }));
      await flushPendingRenders();

      expect(
        document
          .querySelector<HTMLElement>('[data-testid="legend-list"]')
          ?.getAttribute("data-maintain-scroll-at-end"),
      ).toBe("false");
      expect(scrollToEndSpy).not.toHaveBeenCalled();

      // Lifting the finger at the bottom re-arms once the gesture settles.
      dispatchTouch(legendList!, "touchend", 424);
      await vi.waitFor(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
        expect(list?.getAttribute("data-maintain-scroll-at-end")).toBe("true");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("exposes a branch action on user messages", async () => {
    const onContinueInNewThread = vi.fn();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onContinueInNewThread={onContinueInNewThread}
        timelineEntries={[buildUserTimelineEntry("Continue this work from here.")]}
      />,
    );

    try {
      const continueButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Branch from here"]',
      );
      expect(continueButton).toBeTruthy();
      expect(getComputedStyle(continueButton!).cursor).toBe("pointer");
      expect(continueButton?.getAttribute("title")).toBeNull();

      await page.getByRole("button", { name: "Branch from here" }).click();

      expect(onContinueInNewThread).toHaveBeenCalledWith("message-1");
    } finally {
      await screen.unmount();
    }
  });

  it("shows message actions on a touch screen, and keeps a tap on the device glyph off them", async () => {
    // A touch screen has no hover to reveal the actions, and widens each
    // button's target to 44px, past the button and over what sits beside it.
    onTestFinished(drawAsTouchScreen());
    const entry = buildUserTimelineEntry("ok");
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onContinueInNewThread={vi.fn()}
        timelineEntries={[
          { ...entry, message: { ...entry.message, sentFrom: { kind: "phone", name: "iPhone" } } },
          buildAssistantTimelineEntry("Done."),
        ]}
      />,
    );

    try {
      // Copy and branch, under the user's message and under the answer.
      const actions = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy link"], button[aria-label="Branch from here"]',
      );
      expect(actions).toHaveLength(4);
      for (const action of actions) {
        let opacity = 1;
        for (let el: Element | null = action; el; el = el.parentElement) {
          opacity *= Number(getComputedStyle(el).opacity);
        }
        expect(opacity).toBe(1);
        const box = action.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        expect(hit?.closest("button")).toBe(action);
      }

      const glyph = document.querySelector<HTMLElement>('[aria-label="Sent from iPhone"]')!;
      const rect = glyph.getBoundingClientRect();
      for (const x of [rect.left + 0.5, rect.left + rect.width / 2, rect.right - 0.5]) {
        const hit = document.elementFromPoint(x, rect.top + rect.height / 2);
        expect(hit?.closest("button")).toBeNull();
        expect(glyph.contains(hit)).toBe(true);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("retries only the failed user message from its compact inline action", async () => {
    const onRetry = vi.fn();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        failedTurnRetry={{
          messageId: MessageId.make("message-2"),
          isRetrying: false,
          onRetry,
        }}
        timelineEntries={[
          buildUserTimelineEntry("Earlier request.", "message-1"),
          buildUserTimelineEntry("Request that failed.", "message-2"),
        ]}
      />,
    );

    try {
      const retryButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Retry this message"]',
      );
      expect(retryButtons).toHaveLength(1);
      expect(retryButtons[0]?.closest('[data-message-id="message-2"]')).not.toBeNull();

      await page.getByRole("button", { name: "Retry this message" }).click();

      expect(onRetry).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("exposes a branch action on completed assistant messages", async () => {
    const onContinueInNewThread = vi.fn();
    await resetBrowserHoverState();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onContinueInNewThread={onContinueInNewThread}
        timelineEntries={[buildAssistantTimelineEntry("Implementation notes are ready.")]}
      />,
    );

    try {
      const continueButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Branch from here"]',
      );
      expect(continueButton).toBeTruthy();
      expect(getComputedStyle(continueButton!).cursor).toBe("pointer");
      expect(continueButton?.getAttribute("title")).toBeNull();
      expect(getComputedStyle(continueButton!).opacity).toBe("0");
      expect(getComputedStyle(continueButton!).pointerEvents).toBe("none");

      await page.getByText("Implementation notes are ready.").hover();
      await vi.waitFor(() => {
        expect(Number(getComputedStyle(continueButton!).opacity)).toBeGreaterThan(0.5);
        expect(getComputedStyle(continueButton!).pointerEvents).toBe("auto");
      });
      await page.getByRole("button", { name: "Branch from here" }).click();

      expect(onContinueInNewThread).toHaveBeenCalledWith("assistant-message-1");
    } finally {
      await screen.unmount();
    }
  });

  it("does not show assistant branch actions while a turn is working", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        onContinueInNewThread={vi.fn()}
        timelineEntries={[buildAssistantTimelineEntry("Earlier implementation notes.")]}
      />,
    );

    try {
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Branch from here"]'),
      ).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("moves nothing above the answer when a turn ends", async () => {
    const turnId = TurnId.make("turn-settle");
    const assistant = (id: string, text: string, createdAt: string, completedAt: string) => ({
      id: `entry-${id}`,
      kind: "message" as const,
      createdAt,
      message: {
        id: id as never,
        role: "assistant" as const,
        text,
        turnId,
        createdAt,
        completedAt,
        streaming: false,
      },
    });
    const timelineEntries = [
      buildUserTimelineEntry("Fix the pull request row"),
      assistant(
        "note",
        "Checking where the row gets its status.",
        "2026-04-13T12:00:05.000Z",
        "2026-04-13T12:00:06.000Z",
      ),
      {
        id: "entry-typecheck",
        kind: "work" as const,
        createdAt: "2026-04-13T12:00:10.000Z",
        entry: {
          id: "typecheck",
          createdAt: "2026-04-13T12:00:10.000Z",
          completedAt: "2026-04-13T12:00:40.000Z",
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command: "pnpm exec vp run typecheck",
          executionState: "completed" as const,
          turnId,
        },
      },
      assistant(
        "answer",
        "Fixed. The row now refreshes after a merge.",
        "2026-04-13T12:01:00.000Z",
        "2026-04-13T12:01:15.000Z",
      ),
    ];
    const props = buildProps();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...props}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        timelineEntries={timelineEntries}
      />,
    );

    try {
      const note = page.getByText("Checking where the row gets its status.");
      const answer = page.getByText("Fixed. The row now refreshes after a merge.");
      await expect.element(answer, { timeout: 5_000 }).toBeVisible();
      // Live rows slide in 3px as they mount; measure where they rest.
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.id === TIMELINE_ENTRANCE_ANIMATION_ID)
          .map((animation) => animation.finished),
      );
      const noteTop = note.element().getBoundingClientRect().top;
      const answerTop = answer.element().getBoundingClientRect().top;

      await screen.rerender(<MessagesTimeline {...props} timelineEntries={timelineEntries} />);
      await expect.element(page.getByText("Worked for 1m 15s"), { timeout: 5_000 }).toBeVisible();

      // The working row turned into the footer under the answer; the note only
      // faded.
      expect(note.element().getBoundingClientRect().top).toBe(noteTop);
      expect(answer.element().getBoundingClientRect().top).toBe(answerTop);
      expect(note.element().closest("[data-settled-note='true']")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("starts long user messages collapsed by default", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: "Show full message" });
      await expect.element(toggle).toBeVisible();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

      const messageBody = document.querySelector(
        "[data-user-message-body='true']",
      ) as HTMLDivElement | null;
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.className).toContain("overflow-hidden");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect(messageBody?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("expands and re-collapses long user messages from the toggle", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const expandButton = page.getByRole("button", { name: "Show full message" });
      await expect.element(expandButton).toBeVisible();

      expect(document.body.textContent ?? "").toContain("deep hidden detail only after expand");

      await expandButton.click();

      const collapseButton = page.getByRole("button", { name: "Show less" });
      await expect.element(collapseButton).toBeVisible();
      await expect.element(collapseButton).toHaveAttribute("aria-expanded", "true");

      let messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("false");
      expect(messageBody?.className).not.toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("false");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage ?? "").toBe("");

      await collapseButton.click();

      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();
      messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("folds a thread's report to its first line, and keeps it open once opened", async () => {
    const report = {
      id: MessageId.make("message-report"),
      role: "user" as const,
      text: "The **fix** is in, see [the pull request](https://github.com/o/r/pull/1).\n\n- The tests pass\n- The docs say so",
      fromThread: {
        threadId: ThreadId.make("thread-child"),
        requestId: ChildRequestId.make("request-child"),
        kind: "report" as const,
      },
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    };
    const timeline = () => (
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          { id: report.id, kind: "message", createdAt: MESSAGE_CREATED_AT, message: report },
        ]}
      />
    );
    let screen = await renderTimeline(timeline());

    try {
      // Its first line as the chat draws it, no markdown marks; nothing else.
      const folded = page.getByRole("button", { name: "The fix is in, see #1 the pull request." });
      await expect.element(folded).toHaveAttribute("aria-expanded", "false");
      expect(document.body.textContent).not.toContain("The docs say so");
      expect(document.querySelector('[aria-label="Copy message"]')).toBeNull();

      // Opened from the keyboard, focus moves to the message the line gave way to.
      (folded.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("The docs say so")).toBeVisible();
      expect(document.querySelector(".chat-markdown li")).not.toBeNull();
      expect(document.activeElement?.contains(page.getByText("The docs say so").element())).toBe(
        true,
      );

      // The list drops a row it scrolls past and draws it again: still open.
      await screen.unmount();
      screen = await renderTimeline(timeline());
      await expect.element(page.getByText("The docs say so")).toBeVisible();

      await page.getByRole("button", { name: "Show less" }).click();
      const foldedAgain = page.getByRole("button", {
        name: "The fix is in, see #1 the pull request.",
      });
      await expect.element(foldedAgain).toBeVisible();
      await expect.element(foldedAgain).toHaveFocus();
      expect(document.body.textContent).not.toContain("The docs say so");
    } finally {
      await screen.unmount();
    }
  });

  it("folds an outside agent's prompt under its name, never as the user's", async () => {
    const prompt = {
      id: MessageId.make("message-outside"),
      role: "user" as const,
      text: "Fix the flaky upload test.\n\nIt fails about one run in five on CI.",
      fromOutside: {
        connectionId: OutsideAgentConnectionId.make("connection-claude"),
        name: "Claude Code",
      },
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    };
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          { id: prompt.id, kind: "message", createdAt: MESSAGE_CREATED_AT, message: prompt },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "Fix the flaky upload test." }))
        .toHaveAttribute("aria-expanded", "false");
      const row = document.querySelector("[data-outside-agent-message]");
      expect(row?.querySelector("[data-outside-agent-message-author]")?.textContent).toBe(
        "Claude Code",
      );
      expect(document.body.textContent).not.toContain("one run in five");
      expect(document.querySelector("[data-user-message-body]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("expands assistant changed-files trees from the header when the default is collapsed", async () => {
    const turnId = TurnId.make("turn-1");
    const assistantMessageId = MessageId.make("assistant-1");
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-04-13T12:00:00.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done",
              turnId,
              createdAt: "2026-04-13T12:00:00.000Z",
              completedAt: "2026-04-13T12:01:00.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                completedAt: "2026-04-13T12:01:00.000Z",
                files: [
                  {
                    path: "src/chat/example.ts",
                    kind: "modified",
                    additions: 3,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
      />,
    );

    try {
      const expandTreeButton = page.getByRole("button", { name: "Expand tree" });
      await expect.element(expandTreeButton).toBeVisible();
      await expect.element(page.getByText("example.ts")).not.toBeInTheDocument();

      await expandTreeButton.click();

      await expect.element(page.getByRole("button", { name: "Collapse tree" })).toBeVisible();
      await expect.element(page.getByText("example.ts")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("summarizes a settled turn's working subagents beside the anchor and opens the panel from it", async () => {
    const onOpenAgentsPanel = vi.fn();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{
          subagents: [
            buildTurnSubagent("agent-1", "running"),
            buildTurnSubagent("agent-2", "running"),
            buildTurnSubagent("agent-3", "completed"),
            buildTurnSubagent("agent-4", "waiting"),
            buildTurnSubagent("agent-stopped", "interrupted"),
            // A different turn's finished agent must not be counted with these.
            { ...buildTurnSubagent("agent-5", "completed"), turnId: TurnId.make("turn-other") },
          ],
        }}
      />,
    );

    try {
      const summary = page.getByRole("button", {
        name: "5 subagents · 2 running · 1 done · 1 stopped · 1 needs you. Open the agents panel.",
      });
      await expect.element(summary).toBeVisible();
      // While its agents work, the turn's count sits beside "Agents working",
      // and only there.
      expect(
        document.querySelector("[data-turn-working-anchor='true']")?.contains(summary.element()),
      ).toBe(true);
      expect(document.querySelectorAll("[data-turn-agents-summary='true']")).toHaveLength(1);

      await summary.click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith(null);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the tracker visible while the turn's work group is live", async () => {
    const onOpenAgentsPanel = vi.fn();
    // The tail work group renders as the live spine while the turn works. The
    // turn's tracker must not blink out with the settled receipt — it rides on
    // the working anchor at the bottom, next to the turn's live node.
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={ACTIVITY_ROW_TURN_ID}
        activeTurnStartedAt="2026-04-13T12:00:00.000Z"
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{
          subagents: [
            buildTurnSubagent("agent-1", "running"),
            buildTurnSubagent("agent-2", "running"),
          ],
        }}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "2 subagents. Open the agents panel." }))
        .toBeVisible();
      const anchor = document.querySelector("[data-turn-working-anchor='true']");
      expect(anchor).not.toBeNull();
      expect(anchor?.querySelector("[data-turn-agents-summary='true']")).not.toBeNull();
      // The word stays the turn's own status; the dots say agents are running.
      expect(anchor?.querySelector<HTMLElement>(".working-dots")?.dataset.state).toBe("agents");
      // The settled steps above stay, without a second tracker of their own.
      expect(document.querySelector("[data-work-group='true']")).not.toBeNull();
      expect(document.querySelectorAll("[data-turn-agents-summary='true']")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the tracker row on a reloaded turn that only delegated, with no count and nothing to expand", async () => {
    const onOpenAgentsPanel = vi.fn();
    // Every entry in the turn is agent lifecycle plumbing, so the conversation
    // has nothing of the main model's to narrate. The tracker still has to be
    // here: it is the only inline sign that two agents ran.
    //
    // This is the cold-load shape, which is how the row is seen most of the
    // time: the turn settled before the page was opened, so there is no live
    // agent state at all and the tracker has to come off the durable history.
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={["spawnAgent", "wait"].map((tool, index) => ({
          id: `entry-collab-${tool}`,
          kind: "work" as const,
          createdAt: `2026-04-13T12:00:0${index}.000Z`,
          entry: {
            id: `work-collab-${tool}`,
            createdAt: `2026-04-13T12:00:0${index}.000Z`,
            completedAt: `2026-04-13T12:00:1${index}.000Z`,
            label: "Subagent task",
            detail: tool,
            tone: "tool" as const,
            itemType: "collab_agent_tool_call" as const,
            executionState: "completed" as const,
            turnId: ACTIVITY_ROW_TURN_ID,
          },
        }))}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{
          subagents: [],
          history: [
            { item: buildTurnSubagent("agent-1", "completed"), resultBody: "50 .tsx files." },
            { item: buildTurnSubagent("agent-2", "completed"), resultBody: "31 .ts files." },
            // Another turn's agent is in the same history and must not count here.
            {
              item: { ...buildTurnSubagent("agent-3", "completed"), turnId: TurnId.make("other") },
              resultBody: null,
            },
          ],
        }}
      />,
    );

    try {
      const summary = page.getByRole("button", {
        name: "2 subagents · 2 done. Open the agents panel.",
      });
      await expect.element(summary).toBeVisible();
      await summary.click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith(null);

      expect(document.querySelector("[data-turn-agents-line='true']")).not.toBeNull();
      // No lifecycle step anywhere in the chat, and nothing to open.
      expect(document.body.textContent).not.toContain("Subagent task");
      expect(document.querySelector("[data-activity-group='true']")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("gives a turn's tracker to its first activity group only", async () => {
    // A subagent's report splits the turn's work into two activity groups. The
    // tracker describes the whole turn, so repeating it on the second group
    // would read as a duplicated row rather than as more information.
    const workEntry = (id: string, createdAt: string) => ({
      id,
      kind: "work" as const,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId: ACTIVITY_ROW_TURN_ID,
        label: "command",
        detail: id,
        command: `echo ${id}`,
        tone: "tool" as const,
      },
    });
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          ...Array.from({ length: 8 }, (_, index) =>
            workEntry(`first-${index}`, `2026-04-13T12:0${index}:00.000Z`),
          ),
          {
            ...buildSubagentResultTimelineEntry("Count the files"),
            result: {
              ...buildSubagentResultTimelineEntry("Count the files").result,
              turnId: ACTIVITY_ROW_TURN_ID,
            },
          },
          ...Array.from({ length: 8 }, (_, index) =>
            workEntry(`second-${index}`, `2026-04-13T12:1${index}:00.000Z`),
          ),
        ]}
        onOpenAgentsPanel={vi.fn()}
        turnAgents={{
          subagents: [],
          history: [
            { item: buildTurnSubagent("agent-1", "completed"), resultBody: "50 .tsx files." },
            { item: buildTurnSubagent("agent-2", "completed"), resultBody: "40 .ts files." },
          ],
        }}
      />,
    );

    try {
      const groups = [...document.querySelectorAll("[data-work-group='true']")];
      expect(groups.length).toBe(2);

      const trackers = [...document.querySelectorAll("[data-turn-agents-summary='true']")];
      expect(trackers.length).toBe(1);
      // On the group the turn started in, not a later one.
      expect(groups[0]?.contains(trackers[0] ?? null)).toBe(true);
      expect(trackers[0]?.getAttribute("aria-label")).toBe(
        "2 subagents · 2 done. Open the agents panel.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows a settled turn's live agent once, on the working anchor", async () => {
    // A background agent outlives its turn. Its live status row has one home,
    // the anchor at the tail; the turn's receipt keeps only the tracker chip.
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking={false}
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={vi.fn()}
        turnAgents={{ subagents: [buildTurnSubagent("agent-1", "running")] }}
      />,
    );

    try {
      const anchor = document.querySelector("[data-turn-working-anchor='true']");
      expect(anchor).not.toBeNull();
      expect(anchor?.textContent).toContain("Agent working");
      // The settled turn is only waiting on its agent: the dots say so.
      expect(anchor?.querySelector<HTMLElement>(".working-dots")?.dataset.state).toBe("agents");
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-turn-live-agent-name='true']").length).toBe(1);
      });
      expect(anchor?.querySelector("[data-turn-live-agent-name='true']")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("moves a finished turn's agent count beside the working anchor while its agents run", async () => {
    // The turn answered but its three agents are still going: the count sits
    // once, beside "Agents working", not on the answer's footer as well. When
    // the last one lands the anchor leaves and the count is back on the footer.
    const timelineEntries = [
      buildUserTimelineEntry("Review the tech stack"),
      ...buildOverflowingWorkTimelineEntries().slice(0, 2),
      {
        id: "entry-answer",
        kind: "message" as const,
        createdAt: "2026-04-13T12:05:00.000Z",
        message: {
          id: "answer" as never,
          role: "assistant" as const,
          text: "The three researchers are still running.",
          turnId: ACTIVITY_ROW_TURN_ID,
          createdAt: "2026-04-13T12:05:00.000Z",
          completedAt: "2026-04-13T12:05:10.000Z",
          streaming: false,
        },
      },
    ];
    const agents = ["agent-1", "agent-2", "agent-3"];
    const props = { ...buildProps(), timelineEntries, onOpenAgentsPanel: vi.fn() };
    const screen = await renderTimeline(
      <MessagesTimeline
        {...props}
        turnAgents={{ subagents: agents.map((id) => buildTurnSubagent(id, "running")) }}
      />,
    );
    const trackers = () => [...document.querySelectorAll("[data-turn-agents-summary='true']")];
    const footer = () => document.querySelector("[data-turn-footer='true']");

    try {
      await expect.element(page.getByText("Agents working...")).toBeVisible();
      const anchor = document.querySelector("[data-turn-working-anchor='true']");
      expect(trackers()).toHaveLength(1);
      expect(anchor?.contains(trackers()[0] ?? null)).toBe(true);
      expect(trackers()[0]?.getAttribute("aria-label")).toBe("3 subagents. Open the agents panel.");
      expect(footer()?.textContent).toContain("Worked for");
      expect(footer()?.querySelector("[data-turn-agents-summary='true']")).toBeNull();

      // Settled agents leave the live state; the thread's history keeps them.
      await screen.rerender(
        <MessagesTimeline
          {...props}
          turnAgents={{
            subagents: [],
            history: agents.map((id) => ({
              item: buildTurnSubagent(id, "completed"),
              resultBody: null,
            })),
          }}
        />,
      );
      await expect.element(page.getByText("Agents working...")).not.toBeInTheDocument();
      expect(trackers()).toHaveLength(1);
      expect(footer()?.contains(trackers()[0] ?? null)).toBe(true);
      expect(trackers()[0]?.getAttribute("aria-label")).toBe(
        "3 subagents · 3 done. Open the agents panel.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps one stable, visually distinct status row per live agent", async () => {
    const onOpenAgentsPanel = vi.fn();
    const props = buildProps();
    const liveSubagent = (id: string, step: string, createdAt: string, updatedAt: string) => ({
      ...buildTurnSubagent(id, "running"),
      nickname: id === "agent-tests" ? "Agent panel tests" : "Router sweep",
      telemetry: {
        step,
        totalTokens: null,
        toolUses: null,
        durationMs: null,
        additions: null,
        deletions: null,
      },
      createdAt,
      updatedAt,
    });
    const routerAgent = (step: string, updatedAt: string) =>
      liveSubagent("agent-router", step, "2026-04-13T12:00:00.000Z", updatedAt);
    const testsAgent = (step: string, updatedAt: string) =>
      liveSubagent("agent-tests", step, "2026-04-13T12:00:05.000Z", updatedAt);

    const screen = await renderTimeline(
      <MessagesTimeline
        {...props}
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{
          subagents: [
            routerAgent("reading the router", "2026-04-13T12:00:10.000Z"),
            testsAgent("reading AgentsPanel.browser.tsx", "2026-04-13T12:00:40.000Z"),
          ],
        }}
      />,
    );

    try {
      let statusLines = document.querySelectorAll("[data-turn-live-agent-status='true']");
      expect(statusLines.length).toBe(2);
      expect(statusLines[0]?.textContent).toContain("Router sweep");
      expect(statusLines[0]?.textContent).toContain("reading the router");
      expect(statusLines[1]?.textContent).toContain("Agent panel tests");
      expect(statusLines[1]?.textContent).toContain("reading AgentsPanel.browser.tsx");

      const name = statusLines[0]?.querySelector("[data-turn-live-agent-name='true']");
      const action = statusLines[0]?.querySelector("[data-turn-live-agent-action='true']");
      expect(name?.className).toContain("text-foreground/70");
      expect(action?.className).toContain("text-muted-foreground/55");

      (statusLines[0] as HTMLElement).click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith("agent-router");

      // The router reports after the test agent. Its action changes in place;
      // the start-time ordering keeps the two identities from trading rows.
      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={buildOverflowingWorkTimelineEntries()}
          onOpenAgentsPanel={onOpenAgentsPanel}
          turnAgents={{
            subagents: [
              routerAgent("checking route output", "2026-04-13T12:00:50.000Z"),
              testsAgent("running browser coverage", "2026-04-13T12:00:45.000Z"),
            ],
          }}
        />,
      );

      statusLines = document.querySelectorAll("[data-turn-live-agent-status='true']");
      expect(statusLines[0]?.textContent).toContain("Router sweep");
      expect(statusLines[0]?.textContent).toContain("checking route output");
      expect(statusLines[1]?.textContent).toContain("Agent panel tests");
      expect(statusLines[1]?.textContent).toContain("running browser coverage");

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={buildOverflowingWorkTimelineEntries()}
          onOpenAgentsPanel={onOpenAgentsPanel}
          turnAgents={{
            subagents: [
              routerAgent("checking route output", "2026-04-13T12:00:50.000Z"),
              testsAgent("running browser coverage", "2026-04-13T12:00:45.000Z"),
              {
                ...liveSubagent(
                  "agent-docs",
                  "waiting for input",
                  "2026-04-13T12:00:10.000Z",
                  "2026-04-13T12:00:46.000Z",
                ),
                nickname: "Docs review",
                status: "waiting",
                statusLabel: "Waiting",
              },
              {
                ...liveSubagent(
                  "agent-api",
                  "waiting for input",
                  "2026-04-13T12:00:15.000Z",
                  "2026-04-13T12:00:47.000Z",
                ),
                nickname: "API review",
                status: "waiting",
                statusLabel: "Waiting",
              },
            ],
          }}
        />,
      );

      statusLines = document.querySelectorAll("[data-turn-live-agent-status='true']");
      expect(statusLines.length).toBe(3);
      expect(statusLines[2]?.textContent).toContain("Docs review");
      expect(statusLines[2]?.getAttribute("data-turn-live-agent-state")).toBe("waiting");
      expect(statusLines[2]?.querySelector("[aria-hidden='true']")?.className).toContain(
        "bg-amber-500",
      );

      const overflow = page.getByRole("button", { name: "Open 1 more active subagent" });
      await expect.element(overflow).toBeVisible();
      await overflow.click();
      expect(onOpenAgentsPanel).toHaveBeenLastCalledWith(null);
    } finally {
      await screen.unmount();
    }

    const settled = await renderTimeline(
      <MessagesTimeline
        {...props}
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{ subagents: [buildTurnSubagent("agent-done", "completed")] }}
      />,
    );

    try {
      expect(document.querySelector("[data-turn-live-agent-status='true']")).toBeNull();
    } finally {
      await settled.unmount();
    }
  });

  it("renders a finished subagent as a one-line receipt that drills into it", async () => {
    const onOpenAgentsPanel = vi.fn();
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildSubagentResultTimelineEntry("Review the router wiring")]}
        onOpenAgentsPanel={onOpenAgentsPanel}
      />,
    );

    try {
      // Named by its task, as its live line named it.
      const receipt = page.getByRole("button", {
        name: "Open Review the router wiring transcript",
      });
      await expect.element(receipt).toBeVisible();
      // A receipt, not a card: the full report stays in the rail.
      expect(document.querySelector("[data-subagent-result-body='true']")).toBeNull();
      expect(document.querySelector("[data-subagent-receipt-row='true']")?.textContent).toContain(
        "Finding: subagent output is visible.",
      );

      await receipt.click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith("agent-1");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a running subagent's commentary out of the conversation", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "subagent-live:turn-1:agent-1",
            kind: "subagent-live" as const,
            createdAt: MESSAGE_CREATED_AT,
            live: {
              id: "subagent-live:turn-1:agent-1",
              createdAt: MESSAGE_CREATED_AT,
              turnId: TurnId.make("turn-1"),
              agentThreadId: "agent-1",
              label: "Reviewer subagent",
              role: null,
              objective: null,
              body: "Halfway through the router sweep.",
              model: null,
              reasoningEffort: null,
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Halfway through the router sweep."))
        .not.toBeInTheDocument();
      expect(document.querySelector("[data-subagent-live-row='true']")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
