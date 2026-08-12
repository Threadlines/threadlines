import "../../index.css";

import { EnvironmentId, MessageId, TurnId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../../uiStateStore";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";

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
    completionDividerBeforeEntryId: null,
    completionSummary: null,
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

function buildTurnSubagent(id: string, status: "running" | "completed" | "waiting") {
  return {
    id,
    agentThreadId: id,
    transcriptAgentId: id,
    turnId: ACTIVITY_ROW_TURN_ID,
    label: "Subagent",
    role: null,
    objective: "Review the change",
    status,
    statusLabel: status === "waiting" ? "Needs approval" : "Running",
    model: null,
    reasoningEffort: null,
    liveBody: null,
    telemetry: null,
    createdAt: "2026-04-13T12:00:00.000Z",
    updatedAt: "2026-04-13T12:00:10.000Z",
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    timelineScrollMetrics = AWAY_FROM_END_SCROLL_METRICS;
    useUiStateStore.setState({ threadChangedFilesExpandedById: {} });
    __resetClientSettingsPersistenceForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
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
        .element(page.getByRole("button", { name: "Thinking - Inspecting repository state" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("indents subagent task rows with the corner glyph while main rows stay flush", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-main",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-main",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Running main model step",
              tone: "thinking",
            },
          },
          {
            id: "entry-subagent",
            kind: "work",
            createdAt: "2026-04-13T12:00:01.000Z",
            entry: {
              id: "work-subagent",
              createdAt: "2026-04-13T12:00:01.000Z",
              label: "Running List source structure of server and web apps",
              tone: "thinking",
              subagentTask: { subagentType: "general-purpose", toolUseId: "toolu_spawn_1" },
            },
          },
          {
            id: "entry-subagent-2",
            kind: "work",
            createdAt: "2026-04-13T12:00:02.000Z",
            entry: {
              id: "work-subagent-2",
              createdAt: "2026-04-13T12:00:02.000Z",
              label: "Running Inspect key app package.json deps",
              tone: "thinking",
              subagentTask: { subagentType: "general-purpose", toolUseId: "toolu_spawn_1" },
            },
          },
        ]}
      />,
    );

    try {
      const subagentRows = document.querySelectorAll("[data-subagent-work-row='true']");
      expect(subagentRows).toHaveLength(2);
      expect(subagentRows[0]?.textContent).toContain("List source structure");
      expect(subagentRows[0]?.querySelector("svg.lucide-corner-down-right")).not.toBeNull();
      expect(subagentRows[0]?.textContent).not.toContain("Running main model step");
      // The lane entering after a main-model row is labeled; the contiguous
      // same-agent row after it stays bare.
      const laneLabels = document.querySelectorAll("[data-subagent-lane-label='true']");
      expect(laneLabels).toHaveLength(1);
      expect(laneLabels[0]?.textContent).toBe("general-purpose");
      expect(subagentRows[0]?.contains(laneLabels[0] ?? null)).toBe(true);
      await expect
        .element(page.getByLabelText(/Subagent \(general-purpose\): Running List source/))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps live command preview aligned with its activity heading", async () => {
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
      await expect.element(page.getByText("Verifying bun test")).toBeVisible();

      const heading = document.querySelector(
        "[data-work-entry-heading='true']",
      ) as HTMLElement | null;
      const preview = document.querySelector(
        "[data-work-entry-preview='true']",
      ) as HTMLElement | null;

      expect(heading).not.toBeNull();
      expect(preview).not.toBeNull();

      const headingRect = heading!.getBoundingClientRect();
      const previewRect = preview!.getBoundingClientRect();
      const headingCenterY = headingRect.top + headingRect.height / 2;
      const previewCenterY = previewRect.top + previewRect.height / 2;

      expect(Math.abs(headingCenterY - previewCenterY)).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the provider-stamped duration for a completed command", async () => {
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
              completedAt: "2026-04-13T12:00:03.000Z",
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
      await expect.element(page.getByLabelText("Completed in 3.0s")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("copies expanded command output without making the output panel collapse the row", async () => {
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
      await page.getByRole("button", { name: "Show command output" }).click();

      await expect.element(page.getByRole("button", { name: "Hide command output" })).toBeVisible();
      await expect.element(page.getByText("line 24")).toBeVisible();

      const outputPanel = document.querySelector<HTMLElement>('[data-command-output="true"]');
      expect(outputPanel).not.toBeNull();
      const outputPre = outputPanel!.querySelector<HTMLElement>("pre");
      const copyButton = document.querySelector<HTMLElement>(
        'button[aria-label="Copy command output"]',
      );
      expect(outputPre).not.toBeNull();
      expect(copyButton).not.toBeNull();

      const outputPreRect = outputPre!.getBoundingClientRect();
      const copyButtonRect = copyButton!.getBoundingClientRect();
      expect(outputPreRect.right - copyButtonRect.right).toBeGreaterThanOrEqual(10);

      outputPanel!.click();

      await expect.element(page.getByRole("button", { name: "Hide command output" })).toBeVisible();
      await expect.element(page.getByText("line 24")).toBeVisible();

      await page.getByRole("button", { name: "Copy command output" }).click();

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(expectedCopiedOutput);
      });

      await page.getByRole("button", { name: "Hide command output" }).click();

      await expect.element(page.getByRole("button", { name: "Show command output" })).toBeVisible();
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
        .element(page.getByRole("button", { name: "Thinking - Inspecting repository state" }))
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
        .element(page.getByRole("button", { name: "Thinking - Inspecting repository state" }))
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

  it("exposes an edit-and-branch action on user messages", async () => {
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
        'button[aria-label="Edit and branch"]',
      );
      expect(continueButton).toBeTruthy();
      expect(getComputedStyle(continueButton!).cursor).toBe("pointer");
      expect(continueButton?.getAttribute("title")).toBeNull();

      await page.getByRole("button", { name: "Edit and branch" }).click();

      expect(onContinueInNewThread).toHaveBeenCalledWith("message-1");
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

  it("exposes a continue-in-new-thread action on completed assistant messages", async () => {
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
        'button[aria-label="Continue in new thread"]',
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
      await page.getByRole("button", { name: "Continue in new thread" }).click();

      expect(onContinueInNewThread).toHaveBeenCalledWith("assistant-message-1");
    } finally {
      await screen.unmount();
    }
  });

  it("does not show assistant continue-in-new-thread actions while a turn is working", async () => {
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
        document.querySelector<HTMLButtonElement>('button[aria-label="Continue in new thread"]'),
      ).toBeNull();
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

  it("starts the newest long user prompt collapsed", async () => {
    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText("latest long prompt"))]}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();

      const messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("summarizes the turn's subagents on the activity row and opens the panel from it", async () => {
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
            // A different turn's agent must not be counted on this row.
            { ...buildTurnSubagent("agent-5", "running"), turnId: TurnId.make("turn-other") },
          ],
        }}
      />,
    );

    try {
      const summary = page.getByRole("button", {
        name: "4 subagents · 1 done · 1 needs you. Open the agents panel.",
      });
      await expect.element(summary).toBeVisible();

      await summary.click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith(null);
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

      const receipt = document.querySelector("[data-work-activity-receipt='true']");
      expect(receipt).not.toBeNull();
      expect(receipt?.getAttribute("data-work-activity-anchor")).toBe("true");
      // No misleading count, and no lifecycle row anywhere in the chat.
      expect(receipt?.textContent).not.toContain("actions");
      expect(document.body.textContent).not.toContain("Subagent task");
      // Nothing was hidden, so there is nothing to unhide.
      expect(document.querySelector("[data-activity-transcript-toggle='true']")).toBeNull();
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
      const receipts = [...document.querySelectorAll("[data-work-activity-receipt='true']")];
      expect(receipts.length).toBe(2);

      const trackers = [...document.querySelectorAll("[data-turn-agents-summary='true']")];
      expect(trackers.length).toBe(1);
      // On the group the turn started in, not a later one.
      expect(receipts[0]?.contains(trackers[0] ?? null)).toBe(true);
      expect(trackers[0]?.getAttribute("aria-label")).toBe(
        "2 subagents · 2 done. Open the agents panel.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows one live agent status line under the tracker row and drops it when nothing is live", async () => {
    const onOpenAgentsPanel = vi.fn();
    const liveSubagent = (id: string, step: string, updatedAt: string) => ({
      ...buildTurnSubagent(id, "running"),
      nickname: id === "agent-fresh" ? "Agent panel tests" : "Router sweep",
      telemetry: {
        step,
        lastToolName: null,
        totalTokens: null,
        toolUses: null,
        durationMs: null,
      },
      updatedAt,
    });

    const screen = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={buildOverflowingWorkTimelineEntries()}
        onOpenAgentsPanel={onOpenAgentsPanel}
        turnAgents={{
          subagents: [
            liveSubagent("agent-stale", "reading the router", "2026-04-13T12:00:10.000Z"),
            liveSubagent(
              "agent-fresh",
              "reading AgentsPanel.browser.tsx",
              "2026-04-13T12:00:40.000Z",
            ),
          ],
        }}
      />,
    );

    try {
      // Two agents are live, but the conversation gets exactly one line: the
      // freshest signal, named.
      const statusLines = document.querySelectorAll("[data-turn-live-agent-status='true']");
      expect(statusLines.length).toBe(1);
      expect(statusLines[0]?.textContent).toContain("Agent panel tests");
      expect(statusLines[0]?.textContent).toContain("reading AgentsPanel.browser.tsx");

      (statusLines[0] as HTMLElement).click();
      expect(onOpenAgentsPanel).toHaveBeenCalledWith(null);
    } finally {
      await screen.unmount();
    }

    const settled = await renderTimeline(
      <MessagesTimeline
        {...buildProps()}
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
      const receipt = page.getByRole("button", { name: "Open Reviewer transcript" });
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
