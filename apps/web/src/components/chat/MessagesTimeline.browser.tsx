import "../../index.css";

import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
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
      <div data-testid="legend-list">
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
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
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
    const screen = await render(
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
    const screen = await render(
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

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

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
    const screen = await render(
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

  it("starts long user messages collapsed by default", async () => {
    const screen = await render(
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
    const screen = await render(
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
    const screen = await render(
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
    const screen = await render(
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
