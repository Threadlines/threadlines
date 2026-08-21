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
        expect(workingAnchor, label).not.toBeNull();
        const listRect = list!.getBoundingClientRect();
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
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expectWorkingAnchorAtBottom(new Date(cutoffMs).toISOString());
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      expectWorkingAnchorAtBottom("settled replay");
    } finally {
      await screen.unmount();
    }
  });
});
