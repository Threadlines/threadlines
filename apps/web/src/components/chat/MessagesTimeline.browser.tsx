import "../../index.css";

import { EnvironmentId, MessageId, TurnId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useUiStateStore } from "../../uiStateStore";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));

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
          props.onScroll?.({
            nativeEvent: {
              layoutMeasurement: { height: 100 },
              contentSize: { height: 200 },
              contentOffset: { y: 0 },
              contentInset: { bottom: 0 },
            },
          });
        }}
        onWheelCapture={props.onWheelCapture}
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

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1" as never,
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

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
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

  it("exposes a continue-in-new-thread action on user messages", async () => {
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
        'button[aria-label="Continue in new thread"]',
      );
      expect(continueButton).toBeTruthy();
      expect(getComputedStyle(continueButton!).cursor).toBe("pointer");
      expect(continueButton?.getAttribute("title")).toBeNull();

      await page.getByRole("button", { name: "Continue in new thread" }).click();

      expect(onContinueInNewThread).toHaveBeenCalledWith("message-1");
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

  it("expands truncated subagent result instructions when clicking the text", async () => {
    const longObjective = [
      "This is a UI preview task only.",
      "Do not edit files or run destructive commands.",
      "Please return a concise chat-style response with markdown formatting.",
      "Include one heading, one bullet list, one inline-code example, and one file reference.",
      "Keep the final instruction visible only after the clamped text expands.",
    ].join(" ");
    const screen = await renderTimeline(
      <div style={{ width: 360 }}>
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[buildSubagentResultTimelineEntry(longObjective)]}
        />
      </div>,
    );

    try {
      await vi.waitFor(() => {
        const objective = document.querySelector<HTMLElement>(
          "[data-subagent-result-objective='true']",
        );
        expect(objective).not.toBeNull();
        expect(objective?.tagName).toBe("BUTTON");
        expect(objective?.getAttribute("data-subagent-result-objective-truncated")).toBe("true");
        expect(objective?.getAttribute("aria-expanded")).toBe("false");
        expect(objective?.className).toContain("line-clamp-2");
      });

      await page.getByRole("button", { name: "Expand subagent instructions" }).click();

      await vi.waitFor(() => {
        const objective = document.querySelector<HTMLElement>(
          "[data-subagent-result-objective='true']",
        );
        expect(objective?.getAttribute("data-subagent-result-objective-expanded")).toBe("true");
        expect(objective?.className).not.toContain("line-clamp-2");
      });

      await page.getByRole("button", { name: "Collapse subagent instructions" }).click();

      await vi.waitFor(() => {
        const objective = document.querySelector<HTMLElement>(
          "[data-subagent-result-objective='true']",
        );
        expect(objective?.getAttribute("data-subagent-result-objective-expanded")).toBe("false");
        expect(objective?.className).toContain("line-clamp-2");
      });
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
});
