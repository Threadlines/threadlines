import { EnvironmentId, MessageId, ProviderDriverKind, TurnId } from "@threadlines/contracts";
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
    expect(markup).toContain('data-work-activity-inline="true"');
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

    expect(markup).toContain('data-work-activity-receipt="true"');
    expect(markup).toContain("Activity");
    expect(markup).toContain("4 actions");
    expect(markup).toContain("Explored project");
    expect(markup).toContain("1 search");
    expect(markup).toContain("1 file read");
    expect(markup).toContain("2 git checks");
    expect(markup).toContain("View transcript");
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("apps/web/src/session-logic.ts");
  });

  it("keeps consequential commands verbatim instead of compacting them", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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

    expect(markup).not.toContain("Ran 2 commands");
    expect(markup).toContain("Remove-Item");
    expect(markup).toContain("activity-feed-scratch.md");
    expect(markup).toContain("rm -rf .tmp-scratch");
  });

  it("surfaces the first error line and output toggle on failed commands", async () => {
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

    expect(markup).toContain("Command failed");
    expect(markup).toContain('data-command-failure="true"');
    expect(markup).toContain("Cannot find path");
    expect(markup).toContain('aria-label="Show command output"');
    expect(markup).not.toContain('data-command-output="true"');
  });

  it("renders provider authentication errors with terminal sign-in guidance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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
    const markup = renderToStaticMarkup(
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
    const markup = renderToStaticMarkup(
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
    const markup = renderToStaticMarkup(
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
    const markup = renderToStaticMarkup(
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
    const markup = renderToStaticMarkup(
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

  it("keeps live activity compact and height-stable while a turn is working", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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

    // The live turn renders as an accent spine: the most recent steps stay
    // visible (dimming as they recede toward the live node) while the oldest
    // fold into a single count, and the running command keeps its pulse.
    expect(markup).not.toContain("Current activity");
    expect(markup).toContain("2 earlier events");
    expect(markup).not.toContain("Show previous");
    expect(markup).toContain('data-live-activity-strip="true"');
    expect(markup).toContain("--spine:var(--border)");
    expect(markup).toContain(
      "--spine-top:linear-gradient(to bottom, var(--border), color-mix(in oklab, var(--primary-graph) 34%, var(--border)));--spine-bottom:linear-gradient(to bottom, color-mix(in oklab, var(--primary-graph) 34%, var(--border)), color-mix(in oklab, var(--primary-graph) 58%, var(--border)))",
    );
    expect(markup).toMatch(
      /--spine-top:linear-gradient\(to bottom, color-mix\(in oklab, var\(--primary-graph\) 58%, var\(--border\)\), color-mix\(in oklab, var\(--primary-graph\) 82%, var\(--border\)\)\)/u,
    );
    expect(markup).not.toContain("min-h-[3.25rem]");
    expect(markup).not.toContain("git status --short");
    expect(markup).not.toContain("rg -n");
    expect(markup).toContain("Read session-logic.ts");
    expect(markup).toContain("Checked git state");
    expect(markup).toContain("Verifying bun typecheck");
    expect(markup).toContain("bun typecheck");
    expect(markup).toContain('data-live-turn-elapsed="true"');
    expect(markup).toContain("Working ");
    // The running tool is the current activity: it carries the single live node
    // (halo) on the spine rather than a detached inline pulse off the thread.
    expect((markup.match(/class="thread-halo /gu) ?? []).length).toBe(1);
    expect(markup).not.toContain("Tool still running");
    expect(markup).not.toContain("Explored project");
    expect(markup).not.toContain("View transcript");
  });

  it("renders warning and error work activity with solid threadline spine dots", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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
    expect(markup).toContain("size-[6px] rounded-full bg-warning");
    expect(markup).toContain("size-[6px] rounded-full bg-destructive");
    expect(markup).not.toContain("border-warning/65");
    expect(markup).not.toContain("border-destructive/70");
    expect(markup).not.toContain("lucide-circle-alert");
  });

  it("connects an untracked reasoning step to the single live terminus", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
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

    // Reasoning entries carry no turn id, but the step still joins the accent
    // spine (not a settled group) so it connects down to the live node.
    expect(markup).toContain('data-live-activity-strip="true"');
    expect(markup).not.toContain('data-work-activity-inline="true"');
    expect(markup).toContain("Working through the next step");
    // The standalone working row is absorbed into the spine: exactly one live
    // node (halo) terminates the thread.
    expect((markup.match(/class="thread-halo /gu) ?? []).length).toBe(1);
  });

  it("renders unpaired output-only command activity as inactive progress", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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

    expect(markup).toContain("Ran command");
    expect(markup).toContain("2 output lines");
    expect(markup).not.toContain("Running command");
    expect(markup).not.toContain("Command output");
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

  it("renders final subagent results as distinct timeline rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
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
              body: "**Finding:** subagent output is visible.",
              model: "gpt-5.5",
              reasoningEffort: "medium",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-subagent-result-row="true"');
    expect(markup).toContain('data-subagent-result-body="true"');
    expect(markup).toContain("Heisenberg");
    expect(markup).toContain("Reviewer subagent");
    expect(markup).toContain("Inspect timeline rendering");
    expect(markup).toContain("subagent output is visible");
    expect(markup).toContain("Subagent");
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

  it("does not borrow inline diff stats when the work row has no turn id", async () => {
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
    expect(markup).not.toContain("+7 / -2");
  });

  it("renders provider-reported diff stats without a checkpoint turn diff", async () => {
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

    const headingMatches =
      markup.match(/data-work-entry-heading="true">Edited session-logic\.ts/g) ?? [];
    expect(headingMatches).toHaveLength(1);
    expect(markup).toContain("+7");
    expect(markup).toContain("-2");
  });

  it("infers file change row labels and stats from turn diff data when paths are absent", async () => {
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
    const markup = renderToStaticMarkup(
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

    expect(markup).toContain("Verifying bun test");
    expect(markup).toContain("bun run test src/session-logic.test.ts");
  });

  it("does not keep a live command label running after same-turn assistant output starts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
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

    expect(markup).toContain("Ran command");
    expect(markup).not.toContain("Running command");
  });

  it("anchors the live node at the bottom once the assistant responds after work", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
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

    // The work group is no longer the tail, so it is not the live spine; the
    // single live node sits at the very bottom (the working row), not stranded
    // on the finished command above the message.
    expect(markup).not.toContain('data-live-activity-strip="true"');
    expect(markup).toContain("The resource probe returned");
    expect((markup.match(/class="thread-halo /gu) ?? []).length).toBe(1);
  });

  it("shows a live read label while a file-read command is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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

    expect(markup).toContain("Reading session-logic.ts");
    expect(markup).toContain("Get-Content -Path");
  });

  it("renders assistant turn changes as a collapsed tree by default", async () => {
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
    const markup = renderToStaticMarkup(
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
