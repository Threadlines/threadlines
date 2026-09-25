import { EnvironmentId, MessageId, ProviderDriverKind, TurnId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
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

// User rows resolve attachment previews through react-query, so timeline
// renders need the provider the app root supplies.
const renderTimelineQueryClient = new QueryClient();

function renderTimeline(element: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={renderTimelineQueryClient}>{element}</QueryClientProvider>,
  );
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
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    onPreviewFile: () => {},
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
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  }, 60_000);

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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
    const markup = renderTimeline(
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

  it("renders trailing picked-element blocks as chips instead of raw text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Move this below the heading",
              "",
              "<selected_element>",
              "note: Lets move this below the DOJO STORM Heading",
              "tag: p",
              "role: paragraph",
              "name: Facility Services",
              "selector: #top > div:nth-of-type(1) > p:nth-of-type(1)",
              "size: 477x49",
              "url: http://localhost:4321/",
              "</selected_element>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Move this below the heading");
    // The chip names the element; the serialized block stays out of the text.
    expect(markup).toContain("paragraph &quot;Facility Services&quot;");
    expect(markup).not.toContain("selected_element");
    expect(markup).not.toContain("selector: #top");
  });

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("keeps an open transcript note editor across timeline scroll", async () => {
    const { getTranscriptSelectionAfterTimelineScroll } = await import("./MessagesTimeline");
    const noteSelection = {
      sourceMessageId: MessageId.make("message-1"),
      sourceRole: "assistant" as const,
      selectedText: "selected text",
      left: 24,
      anchor: { top: 36 },
      mode: "note" as const,
      note: "draft note",
    };
    const actionsSelection = {
      ...noteSelection,
      mode: "actions" as const,
      note: "",
    };

    expect(getTranscriptSelectionAfterTimelineScroll(noteSelection)).toBe(noteSelection);
    expect(getTranscriptSelectionAfterTimelineScroll(actionsSelection)).toBeNull();
    expect(getTranscriptSelectionAfterTimelineScroll(null)).toBeNull();
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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
    expect(markup).toContain('data-activity-line="true"');
  });

  it("folds looking-around commands into one plain sentence", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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

    expect(markup).toContain('data-activity-summary="true"');
    expect(markup).toContain("Read session-logic.ts, searched once, and checked git");
    expect(markup).not.toContain('data-activity-line="true"');
    // The exact commands stay one click away, not on screen.
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("apps/web/src/session-logic.ts");
  });

  it("gives each command that changes something a line of its own", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          'Remove-Item "C:\\repo\\activity-feed-scratch.md"',
          "rm -rf .tmp-scratch",
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

    expect(markup).not.toContain('data-activity-summary="true"');
    expect(markup.match(/data-activity-line="true"/gu)).toHaveLength(2);
    expect(markup).toContain("Deleted activity-feed-scratch.md");
    expect(markup).toContain("Deleted .tmp-scratch");
  });

  it("surfaces the first error line and output toggle on failed commands", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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
              label: "Command failed",
              tone: "tool",
              requestKind: "command",
              executionState: "failed",
              command: 'Remove-Item "C:\\repo\\activity-feed-scratch.md"',
              outputPreview:
                "Remove-Item : Cannot find path 'C:\\repo\\activity-feed-scratch.md' because it does not exist.\nAt line:1 char:1",
              exitCode: 1,
            },
          },
        ]}
      />,
    );

    // Static markup escapes the apostrophe.
    expect(markup).toContain("Couldn&#x27;t delete activity-feed-scratch.md");
    expect(markup).toContain('data-activity-tone="fail"');
    expect(markup).toContain('data-activity-note="true"');
    expect(markup).toContain("Cannot find path");
    // The command and its output open on click.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-activity-detail="true"');
  });

  it("renders provider authentication errors with terminal sign-in guidance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onRunProviderAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-auth",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-auth",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Authentication required",
              detail: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              tone: "error",
              authReconnect: {
                provider: ProviderDriverKind.make("claudeAgent"),
                command: "claude auth login",
                message:
                  "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-provider-auth-reconnect="true"');
    expect(markup).toContain("Claude needs sign in");
    expect(markup).toContain("claude auth login");
    expect(markup).toContain("Sign in in terminal");
    expect(markup).toContain("complete the browser sign-in");
  });

  it("renders explicit MCP auth reconnect actions with an inline authorize action", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onRunMcpAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-mcp-auth",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-auth",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP startup failed",
              detail: "The supabase MCP server is not logged in.",
              tone: "warning",
              mcpAuthReconnect: {
                provider: ProviderDriverKind.make("codex"),
                serverName: "supabase",
                serverLabel: "Supabase",
                intent: "authorize",
                actionLabel: "Authorize",
                message: "The supabase MCP server is not logged in.",
                terminalCommand: "codex mcp login supabase",
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-mcp-auth-reconnect="true"');
    expect(markup).toContain('data-mcp-auth-reconnect-status="idle"');
    expect(markup).toContain("Supabase MCP needs login");
    expect(markup).toContain("Authorize");
    expect(markup).not.toContain("codex mcp login supabase");
  });

  it("marks explicit MCP auth reconnect actions authorized after OAuth completes", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onRunMcpAuthReconnect={() => {}}
        mcpAuthReconnectStatusByServerName={new Map([["supabase", "completed"]])}
        timelineEntries={[
          {
            id: "entry-mcp-auth",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-mcp-auth",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP startup failed",
              detail: "The supabase MCP server is not logged in.",
              tone: "warning",
              mcpAuthReconnect: {
                provider: ProviderDriverKind.make("codex"),
                serverName: "supabase",
                serverLabel: "Supabase",
                intent: "authorize",
                actionLabel: "Authorize",
                message: "The supabase MCP server is not logged in.",
                terminalCommand: "codex mcp login supabase",
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-mcp-auth-reconnect="true"');
    expect(markup).toContain('data-mcp-auth-reconnect-status="completed"');
    expect(markup).toContain("Supabase MCP authorized");
    expect(markup).toContain("Authorized");
    expect(markup).not.toContain(">Authorize<");
  });

  it("marks provider authentication errors resolved after a later assistant response succeeds", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onRunProviderAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-auth",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-auth",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Authentication required",
              detail: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              tone: "error",
              authReconnect: {
                provider: ProviderDriverKind.make("claudeAgent"),
                command: "claude auth login",
                message:
                  "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              },
            },
          },
          {
            id: "entry-success-message",
            kind: "message",
            createdAt: "2026-03-17T19:13:28.000Z",
            message: {
              id: MessageId.make("message-success"),
              role: "assistant",
              text: "Hi! I'm here and working.",
              createdAt: "2026-03-17T19:13:28.000Z",
              completedAt: "2026-03-17T19:13:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-provider-auth-reconnect="true"');
    expect(markup).toContain('data-provider-auth-reconnect-resolved="true"');
    expect(markup).toContain("Claude sign-in refreshed");
    expect(markup).toContain("A later response succeeded");
    expect(markup).toContain("Resolved");
    expect(markup).not.toContain("Sign in in terminal");
  });

  it("renders assistant authentication messages as provider sign-in guidance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        providerAuthReconnect={{
          provider: ProviderDriverKind.make("claudeAgent"),
          command: "claude auth login",
          message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        }}
        onRunProviderAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-auth-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-auth"),
              role: "assistant",
              text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-provider-auth-reconnect="true"');
    expect(markup).toContain("Claude needs sign in");
    expect(markup).toContain("claude auth login");
    expect(markup).not.toContain('data-agent-response-body="true"');
  });

  it("renders Codex authentication messages with the Codex sign-in command", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        providerAuthReconnect={{
          provider: ProviderDriverKind.make("codex"),
          command: "codex login",
          message: "Not logged in",
        }}
        onRunProviderAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-codex-auth-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-codex-auth"),
              role: "assistant",
              text: "Not logged in",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-provider-auth-reconnect="true"');
    expect(markup).toContain("Codex needs sign in");
    expect(markup).toContain("codex login");
    expect(markup).toContain("Sign in in terminal");
    expect(markup).not.toContain('data-agent-response-body="true"');
  });

  it("renders Claude slash-login messages as terminal sign-in guidance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        providerAuthReconnect={{
          provider: ProviderDriverKind.make("claudeAgent"),
          command: "claude auth login",
          message: "Not logged in • Please run /login",
        }}
        onRunProviderAuthReconnect={() => {}}
        timelineEntries={[
          {
            id: "entry-claude-slash-login",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-claude-slash-login"),
              role: "assistant",
              text: "Not logged in • Please run /login",
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-provider-auth-reconnect="true"');
    expect(markup).toContain("Claude needs sign in");
    expect(markup).toContain("claude auth login");
    expect(markup).toContain("Sign in in terminal");
    expect(markup).not.toContain('data-agent-response-body="true"');
  });

  it("names the running step on the working line while settled steps sum up above it", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt="2026-03-17T19:12:21.000Z"
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

    expect(markup).toContain("Read session-logic.ts, searched once, and checked git");
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("rg -n");
    // The running typecheck lives on the working line, not in the group, so it
    // never reads as passed before it finishes.
    expect(markup).not.toContain("Typecheck passed");
    expect(markup).toContain('data-turn-working-anchor="true"');
    // The anchor's three dots and the shimmering word are the "alive" signal,
    // so no halo pulses anywhere in the timeline.
    expect(markup).toContain(
      'class="working-dots relative -top-px -mr-0.5 shrink-0" data-state="working"',
    );
    expect(markup).toContain(
      '<span class="working-shimmer min-w-0 truncate" data-turn-working-label="true">Typechecking</span>',
    );
    expect(markup).not.toContain("text-warning-foreground");
    expect((markup.match(/class="thread-halo /gu) ?? []).length).toBe(0);
  });

  it("gives the working anchor the label's dot motion and turns amber when waiting on the user", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        activeStatusLabel="Waiting for approval"
        activeTurnStartedAt="2026-03-17T19:12:21.000Z"
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain('data-turn-working-anchor="true"');
    expect(markup).toContain('data-state="approval"');
    expect(markup).toContain("text-warning-foreground");
    expect(markup).toContain(
      '<span class="working-shimmer min-w-0 truncate" data-tone="warning" data-turn-working-label="true">Waiting for approval</span>',
    );
  });

  it("puts warnings and errors on tinted lines of their own", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-warning",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-warning",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Claude API connection issue, retrying in 1s (attempt 1/10)",
              tone: "warning" as const,
            },
          },
          {
            id: "entry-error",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-error",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Runtime error",
              detail:
                "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
              tone: "error" as const,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Claude API connection issue");
    expect(markup).toContain("Runtime error");
    expect(markup).toContain('data-activity-tone="warning"');
    expect(markup).toContain('data-activity-tone="fail"');
    // An error's detail shows without a click.
    expect(markup).toContain("[ede_diagnostic] result_type=user");
  });

  it("keeps a reasoning step with nothing to say off the chat", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeStatusLabel="Working"
        activeTurnStartedAt="2026-03-17T19:12:21.000Z"
        timelineEntries={[
          {
            id: "entry-think",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:25.000Z",
            entry: {
              id: "work-think",
              createdAt: "2026-03-17T19:12:25.000Z",
              label: "Thinking",
              tone: "thinking" as const,
              detail: "Working through the next step",
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain('data-activity-group="true"');
    expect(markup).not.toContain("Working through the next step");
    expect(markup).toContain('data-turn-working-anchor="true"');
    expect(markup).toContain('class="working-dots');
  });

  it("renders unpaired output-only command activity as inactive progress", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        timelineEntries={[
          {
            id: "entry-output-only-command",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-output-only-command",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Command output",
              tone: "tool" as const,
              itemType: "command_execution" as const,
              detail: "2 output lines",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran a command");
    expect(markup).not.toContain("Running a command");
    expect(markup).not.toContain("Command output");
  });

  it("reports verification commands by their result", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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

    expect(markup).toContain("Tests passed");
    expect(markup).toContain("Lint passed");
    expect(markup).toContain("Typecheck passed");
    expect(markup.match(/data-activity-tone="pass"/gu)).toHaveLength(3);
    expect(markup).not.toContain("MessagesTimeline.test.tsx");
  });

  it("keeps agent lifecycle rows out of the conversation and out of its counts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    // Codex: the spawn itself, then the polls that wait on it. Neither carries a
    // source agent thread id, which is why filtering on attribution alone left
    // them in the chat.
    const lifecycleEntries = (
      [
        ["spawn", "reviewer: Inspect timeline rendering", "delegation"],
        ["wait", "wait", "coordination"],
        ["send-input", "sendInput", "coordination"],
      ] as const
    ).map(([id, detail, operation], index) => ({
      id: `entry-${id}`,
      kind: "work" as const,
      createdAt: `2026-03-17T19:12:2${index}.000Z`,
      entry: {
        id: `work-${id}`,
        createdAt: `2026-03-17T19:12:2${index}.000Z`,
        label: "Subagent task",
        detail,
        tone: "tool" as const,
        itemType: "collab_agent_tool_call" as const,
        subagentOperation: operation,
        executionState: "completed" as const,
      },
    }));
    // Claude reports the same lifecycle through its own task stream instead.
    const taskStreamEntry = {
      id: "entry-task-progress",
      kind: "work" as const,
      createdAt: "2026-03-17T19:12:23.000Z",
      entry: {
        id: "work-task-progress",
        createdAt: "2026-03-17T19:12:23.000Z",
        label: "Subagent task",
        detail: "Reading the timeline",
        tone: "thinking" as const,
        activityKind: "task.progress" as const,
        subagentTask: { subagentType: "code-reviewer", toolUseId: "toolu_spawn_1" },
        executionState: "completed" as const,
      },
    };
    // The main model's own tool calls stay, and the receipt counts only them.
    const mainAgentEntries = ["context7", "playwright", "figma"].map((tool, index) => ({
      id: `entry-tool-${tool}`,
      kind: "work" as const,
      createdAt: `2026-03-17T19:12:3${index}.000Z`,
      entry: {
        id: `work-tool-${tool}`,
        createdAt: `2026-03-17T19:12:3${index}.000Z`,
        label: `Used ${tool}`,
        tone: "tool" as const,
        itemType: "mcp_tool_call" as const,
        executionState: "completed" as const,
      },
    }));

    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[...lifecycleEntries, taskStreamEntry, ...mainAgentEntries]}
      />,
    );

    // Nothing about running an agent narrates itself in the chat any more.
    expect(markup).not.toContain("Subagent task");
    expect(markup).not.toContain("Spawned subagent");
    expect(markup).not.toContain("Finished subagent task");
    expect(markup).not.toContain("Delegated work");
    expect(markup).not.toContain("subagent tasks");
    expect(markup).not.toContain("Inspect timeline rendering");
    expect(markup).not.toContain("Reading the timeline");
    // The summary is recomputed from what is left.
    expect(markup).toContain("Used 3 tools");
    expect(markup).not.toContain("Used Used");
  });

  it("renders a finished subagent as a compact receipt and drops live commentary", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        onOpenAgentsPanel={vi.fn()}
        timelineEntries={[
          {
            id: "subagent-live:turn-1:agent-1",
            kind: "subagent-live",
            createdAt: "2026-03-17T19:12:20.000Z",
            live: {
              id: "subagent-live:turn-1:agent-1",
              createdAt: "2026-03-17T19:12:20.000Z",
              turnId: TurnId.make("turn-1"),
              agentThreadId: "agent-1",
              label: "Reviewer subagent",
              nickname: "Heisenberg",
              role: "reviewer",
              objective: "Inspect timeline rendering",
              body: "I’m tracing the Codex child events now.",
              model: "gpt-5.5",
              reasoningEffort: "medium",
            },
          },
          {
            id: "subagent-result:turn-1:agent-1",
            kind: "subagent-result",
            createdAt: "2026-03-17T19:12:30.000Z",
            result: {
              id: "subagent-result:turn-1:agent-1",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: TurnId.make("turn-1"),
              agentThreadId: "agent-1",
              label: "Reviewer subagent",
              nickname: "Heisenberg",
              role: "reviewer",
              objective: "Inspect timeline rendering",
              body: "## Findings\n\n**Finding:** subagent output is visible.",
              model: "gpt-5.5",
              reasoningEffort: "medium",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-subagent-receipt-row="true"');
    expect(markup).toContain('data-subagent-receipt-open="true"');
    expect(markup).toContain("Heisenberg");
    expect(markup).toContain("Findings");
    expect(markup).toContain("Subagent");
    expect(markup).toContain("gpt-5.5");
    // The report itself stays in the rail: no card, no inlined body.
    expect(markup).not.toContain('data-subagent-result-body="true"');
    expect(markup).not.toContain("subagent output is visible");
    // Nothing renders for a still-running agent.
    expect(markup).not.toContain('data-subagent-live-row="true"');
    expect(markup).not.toContain("tracing the Codex child events now");
  });

  it("marks agent response bodies without changing markdown rendering", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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
    const markup = renderTimeline(
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
    const markup = renderTimeline(
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

    expect(markup).toContain("Edited session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("shows inline diff stats on file change work rows when turn diff data is available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
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

  it("does not borrow inline diff stats when the work row has no turn id", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
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
    expect(markup).not.toContain("+7 / -2");
  });

  it("renders provider-reported diff stats without a checkpoint turn diff", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
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
              changedFileStats: [
                {
                  path: "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
                  kind: "update",
                  additions: 8,
                  deletions: 1,
                },
              ],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("Edited session-logic.ts");
    expect(markup).toContain("+8");
    expect(markup).toContain("-1");
  });

  it("coalesces duplicate completed file change rows for the same turn and file", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
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
              executionState: "completed",
              turnId,
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Changed files",
              tone: "tool",
              itemType: "file_change",
              executionState: "completed",
              turnId,
              changedFiles: ["apps/web/src/session-logic.ts"],
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

    expect(markup.match(/Edited session-logic\.ts/gu)).toHaveLength(1);
    expect(markup).toContain("+7");
    expect(markup).toContain("-2");
  });

  it("infers file change row labels and stats from turn diff data when paths are absent", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
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
              executionState: "completed",
              turnId,
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
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
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

    expect(markup).toContain('data-turn-working-label="true">Running tests');
    expect(markup).not.toContain("Tests passed");
    expect(markup).not.toContain("bun run test src/session-logic.test.ts");
  });

  it("does not keep a live command label running after same-turn assistant output starts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              executionState: "running",
              turnId,
            },
          },
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "The command output shows the issue.",
              turnId,
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: true,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran a command");
    expect(markup).not.toContain("Running a command");
  });

  it("anchors the live node at the bottom once the assistant responds after work", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeStatusLabel="Working"
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "codex list mcp resources",
              executionState: "completed",
              turnId,
            },
          },
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "The resource probe returned plugin and skill resources.",
              turnId,
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: true,
            },
          },
        ]}
      />,
    );

    // The steps stay where they happened; the working anchor holds the bottom
    // with its dots.
    expect(markup).toContain('data-work-group="true"');
    expect(markup).toContain('data-turn-working-anchor="true"');
    expect(markup).toContain('class="working-dots');
    expect(markup).toContain("The resource probe returned");
    expect((markup.match(/class="thread-halo /gu) ?? []).length).toBe(0);
  });

  it("shows a live read label while a file-read command is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
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

    expect(markup).toContain('data-turn-working-label="true">Reading session-logic.ts');
    expect(markup).not.toContain("Get-Content -Path");
  });

  it("keeps a finished turn's notes in place and puts its summary under the answer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const message = (
      id: string,
      role: "user" | "assistant",
      text: string,
      at: string,
      done?: string,
    ) => ({
      id: `${id}-entry`,
      kind: "message" as const,
      createdAt: at,
      message: {
        id: MessageId.make(id),
        role,
        text,
        turnId: role === "assistant" ? turnId : null,
        createdAt: at,
        ...(done ? { completedAt: done } : {}),
        streaming: false,
      },
    });
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          message("user-1", "user", "Fix the PR row", "2026-03-17T19:12:00.000Z"),
          message("note", "assistant", "Checking the two PRs first.", "2026-03-17T19:12:05.000Z"),
          {
            id: "work-entry",
            kind: "work" as const,
            createdAt: "2026-03-17T19:12:10.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:10.000Z",
              label: "Ran command",
              tone: "tool" as const,
              itemType: "command_execution" as const,
              command: "pnpm exec vp run typecheck",
              executionState: "completed" as const,
              turnId,
            },
          },
          message(
            "answer",
            "assistant",
            "Fixed both.",
            "2026-03-17T19:13:00.000Z",
            "2026-03-17T19:13:15.000Z",
          ),
        ]}
      />,
    );

    // The note and its step stay where they were; the note fades.
    expect(markup).toContain('data-settled-note="true"');
    expect(markup).toContain("Typecheck passed");
    // The footer sits under the answer, where the working row was.
    const noteAt = markup.indexOf("Checking the two PRs first.");
    const answerAt = markup.indexOf("Fixed both.");
    const footerAt = markup.indexOf('data-turn-footer="true"');
    expect(noteAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(noteAt);
    expect(footerAt).toBeGreaterThan(answerAt);
    expect(markup).toContain("Worked for 1m 15s");
    expect(markup).toContain('data-turn-footer-checks="passed"');
    // The note and its step sit in the turn's work tray; the answer is on the
    // page below it.
    expect(markup.match(/data-tray="(?:first|last)"/gu)).toHaveLength(2);
    const answerRoot = markup.lastIndexOf('data-timeline-root="true"', answerAt);
    expect(markup.slice(answerRoot, answerAt)).not.toContain("data-tray");
  });

  it("keeps the footer and the fade off notes while the agent works", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeTurnStartedAt="2026-03-17T19:12:00.000Z"
        timelineEntries={[
          {
            id: "note-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:05.000Z",
            message: {
              id: MessageId.make("note"),
              role: "assistant",
              text: "Checking the two PRs first.",
              turnId,
              createdAt: "2026-03-17T19:12:05.000Z",
              completedAt: "2026-03-17T19:12:06.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Checking the two PRs first.");
    expect(markup).not.toContain('data-turn-footer="true"');
    expect(markup).not.toContain('data-settled-note="true"');
  });

  it("renders assistant turn changes as a collapsed tree by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const assistantMessageId = MessageId.make("assistant-1");
    const markup = renderTimeline(
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

    expect(markup).toContain("Turn changes (1)");
    expect(markup).toContain("Expand tree");
    expect(markup).toContain("View turn diff");
    expect(markup).toContain("group/assistant-message block w-full max-w-full align-top");
    expect(markup).not.toContain("src/example.ts");
    expect(markup).not.toContain("Hide files");
  });

  it("does not render the persistent turn changes card while that turn is active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const assistantMessageId = MessageId.make("assistant-1");
    const markup = renderTimeline(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        timelineEntries={[
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Still working",
              turnId,
              createdAt: "2026-03-17T19:12:28.000Z",
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

    expect(markup).not.toContain("Turn changes (1)");
    expect(markup).not.toContain("View turn diff");
  });
});
