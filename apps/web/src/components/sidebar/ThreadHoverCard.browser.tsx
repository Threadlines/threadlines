// The card's width and truncation are CSS, so the production stylesheet is
// part of the behaviour under test.
import "../../index.css";

import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

// The card asks git for the checkout's current ref; the test decides what it
// hears back.
const gitStatusRef = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../../lib/gitStatusState", () => ({
  useGitStatus: () => ({
    data: gitStatusRef.current === null ? null : { refName: gitStatusRef.current },
    error: null,
    cause: null,
    isPending: false,
  }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

function setGitStatusRefName(refName: string | null): void {
  gitStatusRef.current = refName;
}
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import { ThreadHoverCard, ThreadHoverCardProvider } from "./ThreadHoverCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-hover"),
    environmentId: ENVIRONMENT_ID,
    projectId: ProjectId.make("project-badcode"),
    title: "Add smooth hover cards to the sidebar rows",
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
    ...overrides,
  };
}

function status(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return { label, colorClass: "", dotClass: "bg-primary-graph", pulse: false };
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function openCard(summary: SidebarThreadSummary, pill: ThreadStatusPill | null) {
  await waitForProductionStyles();
  render(
    // The trigger and the shared card mount separately in production too:
    // rows carry triggers, the surface mounts one ThreadHoverCardCard.
    // A fresh provider per render, exactly like a real surface: no handle
    // state survives between tests.
    <ThreadHoverCardProvider>
      <ThreadHoverCard thread={summary} status={pill}>
        <button type="button" data-testid="hover-trigger">
          row
        </button>
      </ThreadHoverCard>
    </ThreadHoverCardProvider>,
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

  it("falls back to the checkout's current ref when the thread pinned no branch", async () => {
    // The row prints only a pinned branch, so a branchless thread would
    // otherwise never say which ref its work is on.
    setGitStatusRefName("main");
    try {
      const card = await openCard(thread({ branch: null }), null);

      // Named as what it is: where the checkout sits, not a branch the thread
      // pinned.
      await expect.element(card).toHaveTextContent("main · checkout");
    } finally {
      setGitStatusRefName(null);
    }
  });

  it("truncates an overlong title and branch instead of blowing the card open", async () => {
    const longTitle =
      "Investigate why the orchestration reactor occasionally replays a settled turn " +
      "after a reconnect, and write up what the projection actually guarantees";
    const longBranch = `feature/${"very-long-branch-name-segment-".repeat(5)}tail`;

    const card = await openCard(thread({ title: longTitle, branch: longBranch }), null);
    await expect.element(card).toBeInTheDocument();

    const element = document.querySelector<HTMLElement>('[data-testid="thread-hover-card"]');
    expect(element).not.toBeNull();
    // The card keeps its own width whatever it is handed.
    expect(element!.getBoundingClientRect().width).toBeLessThanOrEqual(280);

    const branchLine = [...element!.querySelectorAll("span")].find((node) =>
      node.textContent?.startsWith("feature/"),
    );
    expect(branchLine, "the branch row should render").not.toBeUndefined();
    // Clipped on one line rather than wrapped into a wall of text.
    expect(branchLine!.scrollWidth).toBeGreaterThan(branchLine!.clientWidth);
    expect(branchLine!.getBoundingClientRect().height).toBeLessThan(24);
  });

  it("falls back to Idle when the thread has no status", async () => {
    const card = await openCard(thread(), null);

    await expect.element(card).toHaveTextContent("Idle");
  });
});
