import "../../index.css";

import {
  EnvironmentId,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
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

function buildProps() {
  return {
    isWorking: true,
    activeTurnInProgress: true,
    activeTurnId: ACTIVE_TURN_ID,
    activeTurnStartedAt: "2026-04-13T12:00:05.000Z",
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
    const fixture = await loadAffectedThreadFixture();
    const startedAtMs = Date.parse(fixture.activeTurnStartedAt);
    const props = buildProps();
    const renderList = (state: ReturnType<typeof deriveAffectedThreadRenderState>) => (
      <div style={{ height: 710, width: 900 }}>
        <MessagesTimeline
          {...props}
          activeTurnId={fixture.activeTurnId}
          activeTurnStartedAt={fixture.activeTurnStartedAt}
          timelineEntries={state.timelineEntries}
          turnAgents={state.turnAgents}
          onOpenAgentsPanel={vi.fn()}
        />
      </div>
    );
    const screen = await renderTimeline(
      renderList(deriveAffectedThreadRenderState(fixture, startedAtMs)),
    );
    let restorePaddingAccessor: (() => void) | null = null;

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-turn-working-anchor="true"]')).not.toBeNull();
      });
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
