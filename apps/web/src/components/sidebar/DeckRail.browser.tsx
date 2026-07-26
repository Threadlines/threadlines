import { EnvironmentId, ProjectId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import { DeckRail } from "./DeckRail";
import type { OnDeckEntry } from "./OnDeckSection";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function thread(id: string, title: string): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENVIRONMENT_ID,
    projectId: ProjectId.make("project-badcode"),
    title,
    interactionMode: "default",
    session: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function status(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return { label, colorClass: "", dotClass: "bg-amber-500", pulse: false };
}

function entry(
  id: string,
  title: string,
  pill: ThreadStatusPill | null,
  projectLabel: string | null = "badcode",
): OnDeckEntry {
  return { thread: thread(id, title), status: pill, projectLabel, dismissible: false };
}

function renderRail(entries: readonly OnDeckEntry[], overrides?: { routeThreadKey?: string }) {
  const navigateToThread = vi.fn();
  const expandSidebar = vi.fn();
  const screen = render(
    <DeckRail
      entries={entries}
      routeThreadKey={overrides?.routeThreadKey ?? null}
      navigateToThread={navigateToThread}
      openSearch={vi.fn()}
      openSettings={vi.fn()}
      startNewThread={vi.fn()}
      expandSidebar={expandSidebar}
    />,
  );
  return { expandSidebar, navigateToThread, screen };
}

describe("DeckRail", () => {
  it("renders one dot per On Deck thread and navigates on click", async () => {
    const { navigateToThread } = renderRail([
      entry("thread-a", "Fix reconnect race", status("Working")),
      entry("thread-b", "Marketing footer copy", status("Completed")),
    ]);

    await expect.element(page.getByTestId("deck-rail-thread-thread-a")).toBeInTheDocument();
    await expect.element(page.getByTestId("deck-rail-thread-thread-b")).toBeInTheDocument();

    await page.getByTestId("deck-rail-thread-thread-b").click();
    expect(navigateToThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-b" }),
    );
  });

  it("names the thread in place of the title the rail dropped", async () => {
    renderRail([entry("thread-a", "Fix reconnect race", status("Awaiting Input"))]);

    await expect
      .element(page.getByTestId("deck-rail-thread-thread-a"))
      .toHaveAttribute("aria-label", "Fix reconnect race · badcode · Awaiting Input");
  });

  it("badges how many threads are blocked on the user and expands the pane", async () => {
    const { expandSidebar } = renderRail([
      entry("thread-a", "Approve migration plan", status("Pending Approval")),
      entry("thread-b", "Choose reconnect behavior", status("Awaiting Input")),
      // Live but unblocked — must not be counted.
      entry("thread-c", "Rebuild index", status("Working")),
    ]);

    const badge = page.getByTestId("deck-rail-needs-you");
    await expect.element(badge).toHaveAttribute("aria-label", "2 threads need you");

    await badge.click();
    expect(expandSidebar).toHaveBeenCalledOnce();
  });

  it("omits the attention badge when nothing is waiting on the user", async () => {
    renderRail([entry("thread-a", "Fix reconnect race", status("Working"))]);

    await expect.element(page.getByTestId("deck-rail-search")).toBeInTheDocument();
    expect(page.getByTestId("deck-rail-needs-you").query()).toBeNull();
  });
});
