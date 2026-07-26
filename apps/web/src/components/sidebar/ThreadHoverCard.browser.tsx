import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import { ThreadHoverCard } from "./ThreadHoverCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-hover"),
    environmentId: ENVIRONMENT_ID,
    projectId: ProjectId.make("project-badcode"),
    title: "Add smooth hover cards to the sidebar rows",
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
    ...overrides,
  };
}

function status(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return { label, colorClass: "", dotClass: "bg-primary-graph", pulse: false };
}

async function openCard(summary: SidebarThreadSummary, pill: ThreadStatusPill | null) {
  render(
    <ThreadHoverCard thread={summary} status={pill}>
      <button type="button" data-testid="hover-trigger">
        row
      </button>
    </ThreadHoverCard>,
  );
  await page.getByTestId("hover-trigger").hover();
  return page.getByTestId("thread-hover-card");
}

describe("ThreadHoverCard", () => {
  it("restores the full title the row had to truncate", async () => {
    const card = await openCard(thread(), status("Working"));

    await expect.element(card).toHaveTextContent("Add smooth hover cards to the sidebar rows");
    await expect.element(card).toHaveTextContent("Working");
  });

  it("names the provider the way the model picker does", async () => {
    const card = await openCard(
      thread({
        session: {
          provider: ProviderDriverKind.make("claudeAgent"),
          status: "ready",
          orchestrationStatus: "idle",
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      }),
      null,
    );

    await expect.element(card).toHaveTextContent("Claude");
    // The internal driver kind must never reach the surface.
    await expect.element(card).not.toHaveTextContent("claudeAgent");
  });

  it("reports a branch when the thread has one", async () => {
    const card = await openCard(thread({ branch: "feature/deck-sidebar" }), null);

    await expect.element(card).toHaveTextContent("feature/deck-sidebar");
  });

  it("falls back to Idle when the thread has no status", async () => {
    const card = await openCard(thread(), null);

    await expect.element(card).toHaveTextContent("Idle");
  });
});
