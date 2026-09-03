import "../../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

// The row asks git for the checkout's current ref, which is what decides
// whether its own status or the workspace listing answers for the branch.
const gitStatusRef = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../../lib/gitStatusState", () => ({
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatus: () => ({
    data: gitStatusRef.current === null ? null : { refName: gitStatusRef.current, pr: null },
    error: null,
    cause: null,
    isPending: false,
  }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

import { render } from "vitest-browser-react";

import type { ThreadPullRequest } from "../pull-requests/pullRequests.logic";
import type { SidebarThreadSummary } from "../../types";
import { InboxThreadRow } from "./InboxRows";
import { ThreadHoverCardProvider } from "./ThreadHoverCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-pull-request");

const THREAD: SidebarThreadSummary = {
  id: THREAD_ID,
  environmentId: ENVIRONMENT_ID,
  projectId: ProjectId.make("project-threadlines"),
  title: "Add the pull requests page",
  interactionMode: "default",
  session: null,
  effectiveCwd: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  doneOverride: null,
  lastSeenAt: null,
  latestTurn: null,
  branch: "feature/pull-requests",
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  cumulativeDiffStat: null,
};

const OPEN_PULL_REQUEST: ThreadPullRequest = {
  number: 123,
  state: "open",
  isDraft: false,
  title: "Add the pull requests page",
  url: "https://github.com/threadlines/threadlines/pull/123",
  repository: "threadlines/threadlines",
};

function renderRow(listPullRequest: ThreadPullRequest | null) {
  const openPrLink = vi.fn();
  render(
    <ThreadHoverCardProvider>
      <ul>
        <InboxThreadRow
          thread={THREAD}
          status={null}
          projectLabel={null}
          isActive={false}
          jumpLabel={null}
          canMarkDone={false}
          orderedThreadKeys={[]}
          renamingThreadKey={null}
          renamingTitle=""
          setRenamingTitle={() => undefined}
          renamingInputRef={{ current: null }}
          renamingCommittedRef={{ current: false }}
          handleThreadClick={() => undefined}
          navigateToThread={() => undefined}
          handleMultiSelectContextMenu={async () => undefined}
          handleThreadContextMenu={async () => undefined}
          clearSelection={() => undefined}
          commitRename={async () => undefined}
          cancelRename={() => undefined}
          markThreadDone={() => undefined}
          listPullRequest={listPullRequest}
          openPrLink={openPrLink}
        />
      </ul>
    </ThreadHoverCardProvider>,
  );
  return { openPrLink };
}

describe("InboxThreadRow pull request badge", () => {
  it("names the pull request the open listing found for this branch", async () => {
    const { openPrLink } = renderRow(OPEN_PULL_REQUEST);

    const badge = page.getByTestId("inbox-thread-pr-badge");
    await expect.element(badge).toHaveTextContent("#123");
    await expect
      .element(badge)
      .toHaveAttribute("aria-label", "#123 PR open: Add the pull requests page");

    await userEvent.click(badge);
    expect(openPrLink).toHaveBeenCalledTimes(1);
  });

  it("keeps the thread hover card away while the pointer is on the badge", async () => {
    renderRow(OPEN_PULL_REQUEST);

    // The row's own card opens as usual.
    await page.getByTestId(`thread-title-${THREAD_ID}`).hover();
    await expect.element(page.getByTestId("thread-hover-card")).toBeVisible();

    // The badge has a tooltip of its own, so moving onto it closes the card,
    // and further movement over the badge does not bring it back.
    const badge = page.getByTestId("inbox-thread-pr-badge");
    await badge.hover();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="thread-hover-card"]')).toHaveLength(0);
    });
    await badge.hover({ position: { x: 4, y: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(document.querySelectorAll('[data-testid="thread-hover-card"]')).toHaveLength(0);
  });

  it("shows nothing for a branch with no pull request", async () => {
    renderRow(null);

    await expect.element(page.getByTestId(`thread-title-${THREAD_ID}`)).toBeVisible();
    expect(page.getByTestId("inbox-thread-pr-badge").elements()).toHaveLength(0);
  });
});
