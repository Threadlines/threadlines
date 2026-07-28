import { EnvironmentId, ProjectId, ThreadId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessagesSquareIcon } from "lucide-react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import { DeckRail, type DeckRailProject } from "./DeckRail";
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
    effectiveCwd: null,
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
  return {
    thread: thread(id, title),
    status: pill,
    projectLabel,
    projectCwd: "/repo/badcode",
    dismissible: false,
  };
}

function renderRail(
  entries: readonly OnDeckEntry[],
  overrides?: { routeThreadKey?: string; projects?: readonly DeckRailProject[] },
) {
  const navigateToThread = vi.fn();
  const expandSidebar = vi.fn();
  const onSelectChats = vi.fn();
  const onRevealProject = vi.fn();
  // Project glyphs render a favicon, which fetches over react-query.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <DeckRail
        entries={entries}
        projects={overrides?.projects ?? []}
        onRevealProject={onRevealProject}
        routeThreadKey={overrides?.routeThreadKey ?? null}
        navigateToThread={navigateToThread}
        destinations={[
          {
            id: "chats",
            label: "General chats",
            icon: MessagesSquareIcon,
            active: false,
            onSelect: onSelectChats,
          },
        ]}
        openSearch={vi.fn()}
        openSettings={vi.fn()}
        startNewThread={vi.fn()}
        expandSidebar={expandSidebar}
      />
    </QueryClientProvider>,
  );
  return { expandSidebar, navigateToThread, onRevealProject, onSelectChats, screen };
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

  it("labels the dot with the thread title and details it on hover", async () => {
    renderRail([entry("thread-a", "Fix reconnect race", status("Awaiting Input"))]);

    // The dot itself carries only the title; project, status and branch are
    // the hover card's job now.
    await expect
      .element(page.getByTestId("deck-rail-thread-thread-a"))
      .toHaveAttribute("aria-label", "Fix reconnect race");

    await page.getByTestId("deck-rail-thread-thread-a").hover();
    await expect.element(page.getByTestId("thread-hover-card")).toHaveTextContent("Awaiting Input");
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

  it("offers the same destinations the expanded pane does", async () => {
    const { onSelectChats } = renderRail([]);

    const chats = page.getByTestId("deck-rail-destination-chats");
    await expect.element(chats).toHaveAttribute("aria-label", "General chats");

    await chats.click();
    expect(onSelectChats).toHaveBeenCalledOnce();
  });

  it("shows a project glyph that opens the pane at that project", async () => {
    const { onRevealProject } = renderRail([], {
      projects: [
        {
          projectKey: "badcode",
          summary: {
            name: "badcode",
            cwd: "/repo/badcode",
            environmentId: ENVIRONMENT_ID,
            status: status("Working"),
            threadCount: 3,
            activeCount: 1,
            lastActivityAt: "2026-07-26T00:00:00.000Z",
          },
        },
      ],
    });

    const glyph = page.getByTestId("deck-rail-project-badcode");
    await expect.element(glyph).toHaveAttribute("aria-label", "badcode");

    // The counts a favicon cannot carry live in the hover card.
    await glyph.hover();
    await expect.element(page.getByTestId("project-hover-card")).toHaveTextContent("3 threads");
    await expect.element(page.getByTestId("project-hover-card")).toHaveTextContent("1 active");

    await glyph.click();
    expect(onRevealProject).toHaveBeenCalledWith("badcode");
  });

  it("omits the attention badge when nothing is waiting on the user", async () => {
    renderRail([entry("thread-a", "Fix reconnect race", status("Working"))]);

    await expect.element(page.getByTestId("deck-rail-search")).toBeInTheDocument();
    expect(page.getByTestId("deck-rail-needs-you").query()).toBeNull();
  });
});
