import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

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
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
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
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Activity");
  });

  it("summarizes command-heavy activity groups by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          "git status --short",
          'rg -n "isWorking" apps/web/src',
          "Get-Content -Path apps/web/src/session-logic.ts",
          "git diff --stat",
        ].map((command, index) => ({
          id: `entry-${index}`,
          kind: "work" as const,
          createdAt: `2026-03-17T19:12:2${index}.000Z`,
          entry: {
            id: `work-${index}`,
            createdAt: `2026-03-17T19:12:2${index}.000Z`,
            label: "Ran command",
            tone: "tool" as const,
            requestKind: "command" as const,
            executionState: "completed" as const,
            command,
          },
        }))}
      />,
    );

    expect(markup).toContain("Activity (4)");
    expect(markup).toContain("Explored project");
    expect(markup).toContain("1 search");
    expect(markup).toContain("1 file read");
    expect(markup).toContain("2 git checks");
    expect(markup).toContain("View transcript");
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("apps/web/src/session-logic.ts");
  });

  it("keeps live activity compact and height-stable while a turn is working", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        timelineEntries={[
          ...[
            "git status --short",
            'rg -n "isWorking" apps/web/src',
            "Get-Content -Path apps/web/src/session-logic.ts",
            "git diff --stat",
          ].map((command, index) => ({
            id: `entry-${index}`,
            kind: "work" as const,
            createdAt: `2026-03-17T19:12:2${index}.000Z`,
            entry: {
              id: `work-${index}`,
              createdAt: `2026-03-17T19:12:2${index}.000Z`,
              label: "Ran command",
              tone: "tool" as const,
              requestKind: "command" as const,
              executionState: "completed" as const,
              command,
            },
          })),
          {
            id: "entry-running",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-running",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Running command",
              tone: "tool" as const,
              requestKind: "command" as const,
              executionState: "running" as const,
              command: "bun typecheck",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Current activity");
    expect(markup).toContain("3 earlier events");
    expect(markup).toContain('aria-label="Show 3 previous activities"');
    expect(markup).toContain("Show previous");
    expect(markup).toContain('data-live-activity-strip="true"');
    expect(markup).toContain("min-h-[3.25rem]");
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("rg -n");
    expect(markup).not.toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain("git diff --stat");
    expect(markup).toContain("Verifying bun typecheck");
    expect(markup).toContain("bun typecheck");
    expect(markup).toMatch(/aria-label="Tool still running"[\s\S]*Verifying bun typecheck/u);
    expect(markup).not.toContain("Explored project");
    expect(markup).not.toContain("View transcript");
  });

  it("renders verification commands as a semantic activity summary", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          "bun run test src/components/chat/MessagesTimeline.test.tsx",
          "bun lint",
          "bun typecheck",
        ].map((command, index) => ({
          id: `entry-verify-${index}`,
          kind: "work" as const,
          createdAt: `2026-03-17T19:13:2${index}.000Z`,
          entry: {
            id: `work-verify-${index}`,
            createdAt: `2026-03-17T19:13:2${index}.000Z`,
            label: "Ran command",
            tone: "tool" as const,
            requestKind: "command" as const,
            executionState: "completed" as const,
            command,
          },
        }))}
      />,
    );

    expect(markup).toContain("Verified changes");
    expect(markup).toContain("bun test, bun lint, bun typecheck");
    expect(markup).toContain("View transcript");
    expect(markup).not.toContain("MessagesTimeline.test.tsx");
  });

  it("renders subagent tool calls with delegated-work language", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-subagent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-subagent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              detail: "reviewer: Inspect timeline rendering",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              executionState: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Finished reviewer subagent");
    expect(markup).toContain("Inspect timeline rendering");
    expect(markup).toContain('data-subagent-activity-row="true"');
    expect(markup).toContain("Subagent");
    expect(markup).toContain("Details");
    expect(markup).not.toContain('data-subagent-activity-details="true"');
  });

  it("marks agent response bodies without changing markdown rendering", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("assistant-entry"),
              role: "assistant",
              text: "Subagent review complete.",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-agent-response-body="true"');
    expect(markup).toContain('data-assistant-message-body="true"');
    expect(markup).not.toContain("agent-response-reveal");
    expect(markup).not.toContain("--agent-response-reveal-duration");
  });

  it("renders generated image previews in work log rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const imageSrc =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Image view",
              tone: "tool",
              itemType: "image_view",
              images: [
                {
                  id: "ig-1",
                  name: "logo.png",
                  previewUrl: imageSrc,
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("Image view");
    expect(markup).toContain('aria-label="Preview logo.png"');
    expect(markup).toContain('alt="logo.png"');
    expect(markup).toContain(imageSrc);
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("shows inline diff stats on file change work rows when turn diff data is available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              turnId,
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              MessageId.make("assistant-1"),
              {
                turnId,
                completedAt: "2026-03-17T19:13:28.000Z",
                files: [
                  {
                    path: "apps/web/src/session-logic.ts",
                    kind: "modified",
                    additions: 7,
                    deletions: 2,
                  },
                ],
              },
            ],
          ])
        }
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("Edited session-logic.ts");
    expect(markup).toContain("+7");
    expect(markup).toContain("-2");
  });

  it("matches inline diff stats by file path when the work row has no turn id", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File change",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              MessageId.make("assistant-1"),
              {
                turnId,
                completedAt: "2026-03-17T19:13:28.000Z",
                files: [
                  {
                    path: "apps/web/src/session-logic.ts",
                    kind: "modified",
                    additions: 7,
                    deletions: 2,
                  },
                ],
              },
            ],
          ])
        }
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("Edited session-logic.ts");
    expect(markup).toContain("+7");
    expect(markup).toContain("-2");
  });

  it("shows a live verification label while a command is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run test src/session-logic.test.ts",
              executionState: "running",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Verifying bun test");
    expect(markup).toContain("bun run test src/session-logic.test.ts");
  });

  it("shows a live read label while a file-read command is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command:
                "Get-Content -Path C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
              executionState: "running",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Reading session-logic.ts");
    expect(markup).toContain("Get-Content -Path");
  });

  it("renders assistant changed files as a collapsed tree by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const assistantMessageId = MessageId.make("assistant-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done",
              turnId,
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:13:28.000Z",
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
                completedAt: "2026-03-17T19:13:28.000Z",
                files: [
                  {
                    path: "src/example.ts",
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

    expect(markup).toContain("Changed files (1)");
    expect(markup).toContain("Expand tree");
    expect(markup).toContain("View diff");
    expect(markup).not.toContain("src/example.ts");
    expect(markup).not.toContain("Hide files");
  });
});
