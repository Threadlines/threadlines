import "../../index.css";

import {
  ChildRequestId,
  type ComputerLinkPendingRequest,
  EnvironmentId,
  OutsideAgentConnectionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
import {
  __resetComputerLinksForTests,
  __setComputerLinksClientForTests,
  useComputerLinksStore,
  type ComputerLinksClient,
} from "../../environments/links/computerLinks";
import {
  resolveRemoteFamilyChildren,
  resolveThreadStatusPill,
  summarizeChildThreads,
} from "../Sidebar.logic";
import {
  InboxChildRow,
  InboxLinkRequestRow,
  InboxRemoteChildRow,
  InboxThreadRow,
} from "./InboxRows";
import { usePendingLinkRequests } from "./linkedComputers";
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
  settledAt: null,
  headBranch: null,
  diffStat: null,
  observedAt: null,
  isDraft: false,
  autoMergeEnabled: false,
  title: "Add the pull requests page",
  url: "https://github.com/threadlines/threadlines/pull/123",
  repository: "threadlines/threadlines",
};

function renderRow(
  listPullRequest: ThreadPullRequest | null,
  linkedPullRequests: readonly ThreadPullRequest[] = [],
  thread: SidebarThreadSummary = THREAD,
) {
  const openPrLink = vi.fn();
  render(
    <ThreadHoverCardProvider>
      <ul>
        <InboxThreadRow
          thread={thread}
          status={resolveThreadStatusPill({ thread })}
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
          linkedPullRequests={linkedPullRequests}
          openPrLink={openPrLink}
        />
      </ul>
    </ThreadHoverCardProvider>,
  );
  return { openPrLink };
}

describe("InboxThreadRow on a touch screen", () => {
  it("opens the thread's menu on a held finger, and the lift doesn't also open the thread", async () => {
    const handleThreadContextMenu = vi.fn(async () => undefined);
    const handleThreadClick = vi.fn();
    render(
      <ThreadHoverCardProvider>
        <ul>
          <InboxThreadRow
            thread={THREAD}
            status={resolveThreadStatusPill({ thread: THREAD })}
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
            handleThreadClick={handleThreadClick}
            navigateToThread={() => undefined}
            handleMultiSelectContextMenu={async () => undefined}
            handleThreadContextMenu={handleThreadContextMenu}
            clearSelection={() => undefined}
            commitRename={async () => undefined}
            cancelRename={() => undefined}
            markThreadDone={() => undefined}
            listPullRequest={null}
            linkedPullRequests={[]}
            openPrLink={() => undefined}
          />
        </ul>
      </ThreadHoverCardProvider>,
    );
    const row = page.getByTestId(`thread-row-${THREAD_ID}`);
    await expect.element(row).toBeVisible();
    const element = row.element();
    const rect = element.getBoundingClientRect();
    const finger = {
      bubbles: true,
      clientX: rect.left + 24,
      clientY: rect.top + 12,
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
    };
    const tap = () => element.dispatchEvent(new MouseEvent("click", finger));

    // Held: the menu opens where the finger is, and lifting it opens nothing.
    element.dispatchEvent(new PointerEvent("pointerdown", finger));
    await vi.waitFor(() => expect(handleThreadContextMenu).toHaveBeenCalledTimes(1));
    expect(handleThreadContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID }),
      { x: finger.clientX, y: finger.clientY },
    );
    element.dispatchEvent(new PointerEvent("pointerup", finger));
    tap();
    expect(handleThreadClick).not.toHaveBeenCalled();

    // A quick tap still opens the thread, and no menu.
    element.dispatchEvent(new PointerEvent("pointerdown", finger));
    element.dispatchEvent(new PointerEvent("pointerup", finger));
    tap();
    expect(handleThreadClick).toHaveBeenCalledTimes(1);
    expect(handleThreadContextMenu).toHaveBeenCalledTimes(1);

    // A hold whose lift lands on the menu, not the row, leaves nothing behind:
    // the next press, even a mouse's, opens the thread.
    element.dispatchEvent(new PointerEvent("pointerdown", finger));
    await vi.waitFor(() => expect(handleThreadContextMenu).toHaveBeenCalledTimes(2));
    element.dispatchEvent(new PointerEvent("pointercancel", finger));
    const mouse = { ...finger, pointerType: "mouse", pointerId: 1 };
    element.dispatchEvent(new PointerEvent("pointerdown", mouse));
    element.dispatchEvent(new PointerEvent("pointerup", mouse));
    element.dispatchEvent(new MouseEvent("click", mouse));
    expect(handleThreadClick).toHaveBeenCalledTimes(2);
  });
});

describe("InboxThreadRow swipes", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("wraps up on a swipe left and pins on a swipe right, and leaves scrolls, short swipes and mouse drags alone", async () => {
    const onSwipeAction = vi.fn();
    const handleThreadClick = vi.fn();
    const handleThreadContextMenu = vi.fn(async () => undefined);
    render(
      <ThreadHoverCardProvider>
        <ul style={{ width: "360px" }}>
          <InboxThreadRow
            thread={THREAD}
            status={resolveThreadStatusPill({ thread: THREAD })}
            projectLabel={null}
            isActive={false}
            jumpLabel={null}
            canMarkDone
            orderedThreadKeys={[]}
            renamingThreadKey={null}
            renamingTitle=""
            setRenamingTitle={() => undefined}
            renamingInputRef={{ current: null }}
            renamingCommittedRef={{ current: false }}
            handleThreadClick={handleThreadClick}
            navigateToThread={() => undefined}
            handleMultiSelectContextMenu={async () => undefined}
            handleThreadContextMenu={handleThreadContextMenu}
            clearSelection={() => undefined}
            commitRename={async () => undefined}
            cancelRename={() => undefined}
            markThreadDone={() => undefined}
            listPullRequest={null}
            linkedPullRequests={[]}
            openPrLink={() => undefined}
            onSwipeAction={onSwipeAction}
          />
        </ul>
      </ThreadHoverCardProvider>,
    );
    const row = page.getByTestId(`thread-row-${THREAD_ID}`);
    await expect.element(row).toBeVisible();
    const element = row.element();
    const rect = element.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2;
    const y0 = rect.top + 12;
    const at = (x: number, y: number, pointerType: string) => ({
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 9,
      pointerType,
      isPrimary: true,
      button: 0,
    });
    /** A finger (or mouse) drawn (dx, dy) across the row in ten steps, not yet lifted. */
    const drag = (dx: number, dy: number, pointerType = "touch") => {
      element.dispatchEvent(new PointerEvent("pointerdown", at(x0, y0, pointerType)));
      for (let step = 1; step <= 10; step += 1) {
        element.dispatchEvent(
          new PointerEvent(
            "pointermove",
            at(x0 + (dx * step) / 10, y0 + (dy * step) / 10, pointerType),
          ),
        );
      }
      return () => {
        element.dispatchEvent(new PointerEvent("pointerup", at(x0 + dx, y0 + dy, pointerType)));
      };
    };
    const swipeAction = () => document.querySelector("[data-testid='row-swipe-action']");

    // Left, far enough: Wrap up shows under the row and is armed; letting go runs it.
    let lift = drag(-220, 0);
    await vi.waitFor(() => {
      expect(swipeAction()?.textContent).toBe("Wrap up");
      expect(swipeAction()?.getAttribute("data-armed")).toBe("true");
    });
    lift();
    // The click a lift can end in is the swipe's, not a tap.
    element.dispatchEvent(new MouseEvent("click", at(x0 - 220, y0, "touch")));
    await vi.waitFor(() => {
      expect(onSwipeAction).toHaveBeenCalledWith(
        "wrap-up",
        expect.stringContaining(THREAD_ID),
        THREAD.title,
      );
    });
    await vi.waitFor(() => expect(swipeAction()).toBeNull());

    // A press during the slide-out still gets the swipe it follows: the owed
    // action runs at once instead of being dropped.
    drag(-220, 0)();
    element.dispatchEvent(new PointerEvent("pointerdown", at(x0, y0, "touch")));
    expect(onSwipeAction).toHaveBeenCalledTimes(2);
    element.dispatchEvent(new PointerEvent("pointerup", at(x0, y0, "touch")));
    await vi.waitFor(() => expect(swipeAction()).toBeNull());

    // Right: Pin.
    drag(220, 0)();
    await vi.waitFor(() => {
      expect(onSwipeAction).toHaveBeenLastCalledWith(
        "pin",
        expect.stringContaining(THREAD_ID),
        THREAD.title,
      );
    });
    await vi.waitFor(() => expect(swipeAction()).toBeNull());

    // Mostly down is a scroll; a short swipe springs back; a mouse never swipes.
    drag(40, 160)();
    drag(-60, 0)();
    drag(-220, 0, "mouse")();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onSwipeAction).toHaveBeenCalledTimes(3);
    expect(handleThreadClick).not.toHaveBeenCalled();
    expect(handleThreadContextMenu).not.toHaveBeenCalled();

    // A tap right after a swipe is a tap of its own: it opens the thread.
    drag(-60, 0)();
    element.dispatchEvent(new PointerEvent("pointerdown", at(x0, y0, "touch")));
    element.dispatchEvent(new PointerEvent("pointerup", at(x0, y0, "touch")));
    element.dispatchEvent(new MouseEvent("click", at(x0, y0, "touch")));
    expect(handleThreadClick).toHaveBeenCalledTimes(1);
  });
});

describe("InboxThreadRow scheduled runs", () => {
  const runThread = (event: boolean): SidebarThreadSummary => ({
    ...THREAD,
    scheduledRun: {
      taskId: ScheduledTaskId.make("task-triage"),
      taskName: "Triage labeled issues",
      slotUtc: "2026-09-01T09:00:00.000Z",
      ...(event ? { event: true } : {}),
    },
  });

  it("names an event task's run as an event", async () => {
    renderRow(null, [], runThread(true));
    await expect
      .element(page.getByTestId(`thread-scheduled-run-${THREAD_ID}`))
      .toHaveTextContent("Event · Triage labeled issues");
  });

  it("names a clock task's run as scheduled", async () => {
    renderRow(null, [], runThread(false));
    await expect
      .element(page.getByTestId(`thread-scheduled-run-${THREAD_ID}`))
      .toHaveTextContent("Scheduled · Triage labeled issues");
  });
});

describe("InboxThreadRow outside agents", () => {
  it("names the agent outside Threadlines that started it, in the project's place", async () => {
    renderRow(null, [], {
      ...THREAD,
      outsideOrigin: {
        connectionId: OutsideAgentConnectionId.make("connection-claude"),
        name: "Claude Code",
      },
    });
    const label = page.getByTestId(`thread-outside-origin-${THREAD_ID}`);
    await expect.element(label).toHaveTextContent("from Claude Code");
    await expect
      .element(label)
      .toHaveAttribute("title", "Started by Claude Code, an agent outside Threadlines");
  });
});

describe("InboxThreadRow pull request badge", () => {
  it("names the pull request the open listing found for this branch", async () => {
    const { openPrLink } = renderRow(OPEN_PULL_REQUEST);

    const badge = page.getByTestId("inbox-thread-pr-badge");
    await expect.element(badge).toMatchTextContent("#123");
    await expect
      .element(badge)
      .toHaveAttribute("aria-label", "#123 PR open: Add the pull requests page");

    await userEvent.click(badge);
    expect(openPrLink).toHaveBeenCalledTimes(1);
  });

  it("names the one still open when the thread has more, and counts the rest", async () => {
    const { openPrLink } = renderRow(
      { ...OPEN_PULL_REQUEST, state: "merged", settledAt: "2026-09-24T09:00:00.000Z" },
      [
        {
          ...OPEN_PULL_REQUEST,
          number: 294,
          title: "Lighter PR rules",
          url: "https://github.com/threadlines/threadlines/pull/294",
        },
      ],
    );

    const badge = page.getByTestId("inbox-thread-pr-badge");
    await expect.element(badge).toMatchTextContent("#294+1");
    await expect
      .element(badge)
      .toHaveAttribute(
        "aria-label",
        "#294 PR open: Lighter PR rules; #123 PR merged: Add the pull requests page",
      );

    await userEvent.click(badge);
    expect(openPrLink).toHaveBeenCalledWith(
      expect.anything(),
      { number: 294, url: "https://github.com/threadlines/threadlines/pull/294" },
      expect.anything(),
    );
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

describe("child thread families in the inbox", () => {
  const rowCallbacks = {
    orderedThreadKeys: [],
    renamingThreadKey: null,
    renamingTitle: "",
    setRenamingTitle: () => undefined,
    renamingInputRef: { current: null },
    renamingCommittedRef: { current: false },
    handleThreadClick: () => undefined,
    navigateToThread: () => undefined,
    handleMultiSelectContextMenu: async () => undefined,
    handleThreadContextMenu: async () => undefined,
    clearSelection: () => undefined,
    commitRename: async () => undefined,
    cancelRename: () => undefined,
    markThreadDone: () => undefined,
  } as const;
  const status = (label: "Awaiting Input" | "Working") =>
    resolveThreadStatusPill({
      thread:
        label === "Awaiting Input"
          ? { ...THREAD, hasPendingUserInput: true }
          : {
              ...THREAD,
              session: {
                provider: ProviderDriverKind.make("codex"),
                status: "running",
                orchestrationStatus: "running",
                createdAt: "2026-09-01T09:00:00.000Z",
                updatedAt: "2026-09-01T09:00:00.000Z",
              },
            },
    });

  it("opens a family from the parent's summary line and says who needs you", async () => {
    const onToggleFamily = vi.fn();
    const needsYou = status("Awaiting Input")!;
    render(
      <ThreadHoverCardProvider>
        <ul>
          <InboxThreadRow
            {...rowCallbacks}
            thread={THREAD}
            status={null}
            projectLabel={null}
            isActive={false}
            jumpLabel={null}
            canMarkDone={false}
            listPullRequest={null}
            linkedPullRequests={[]}
            openPrLink={() => undefined}
            family={{
              open: false,
              summary: summarizeChildThreads([
                { threadKey: "a", thread: THREAD, status: needsYou, isDone: false },
                { threadKey: "b", thread: THREAD, status: status("Working"), isDone: false },
                { threadKey: "c", thread: THREAD, status: null, isDone: true },
              ]),
            }}
            onToggleFamily={onToggleFamily}
          />
        </ul>
      </ThreadHoverCardProvider>,
    );

    const line = page.getByTestId(`thread-family-${THREAD_ID}`);
    await expect.element(line).toMatchTextContent("3 threads · 1 needs you");
    await expect.element(line).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(line);
    expect(onToggleFamily).toHaveBeenCalledWith(`${ENVIRONMENT_ID}:${THREAD_ID}`);
  });

  it("names a wrapped parent in a live child's row, and gives child rows jump labels and reopen", async () => {
    const reopenThread = vi.fn();
    const child: SidebarThreadSummary = {
      ...THREAD,
      id: ThreadId.make("thread-child"),
      title: "Write the changelog",
      branch: null,
    };
    render(
      <ThreadHoverCardProvider>
        <ul>
          <InboxThreadRow
            {...rowCallbacks}
            thread={child}
            status={status("Working")}
            projectLabel="threadlines"
            isActive={false}
            jumpLabel={null}
            canMarkDone={false}
            listPullRequest={null}
            linkedPullRequests={[]}
            openPrLink={() => undefined}
            wrappedParentTitle="Ship the 0.6 release"
          />
          <InboxChildRow
            {...rowCallbacks}
            thread={{ ...child, id: ThreadId.make("thread-wrapped-child") }}
            status={null}
            isDone
            doneAt="2026-09-01T09:00:00.000Z"
            isActive={false}
            jumpLabel={null}
            canMarkDone={false}
            reopenThread={reopenThread}
          />
          <InboxChildRow
            {...rowCallbacks}
            thread={{ ...child, id: ThreadId.make("thread-jump-child") }}
            status={status("Working")}
            isDone={false}
            doneAt={null}
            isActive={false}
            jumpLabel="⌘4"
            canMarkDone={false}
            reopenThread={reopenThread}
          />
        </ul>
      </ThreadHoverCardProvider>,
    );

    // Where the project name usually sits, the row says where it came from.
    const detail = page.getByTestId(`thread-detail-${child.id}`);
    await expect.element(detail).toMatchTextContent("Ship the 0.6 release");
    await expect.element(detail).not.toMatchTextContent("threadlines");

    // A child row is a row the keyboard jumps to, so it shows its shortcut too.
    await expect.element(page.getByTestId("child-meta-thread-jump-child")).toMatchTextContent("⌘4");

    await page.getByTestId("child-row-thread-wrapped-child").hover();
    await userEvent.click(page.getByTestId("child-reopen-thread-wrapped-child"));
    expect(reopenThread).toHaveBeenCalledWith(`${ENVIRONMENT_ID}:thread-wrapped-child`);
  });

  it("says which computer a family's thread runs on, and where a thread on its own came from", async () => {
    const remoteChild: SidebarThreadSummary = {
      ...THREAD,
      id: ThreadId.make("thread-on-windows"),
      title: "Fix the flaky test",
      branch: null,
    };
    // A start Windows PC hasn't allowed yet: there is no thread there.
    const [waitingStart] = resolveRemoteFamilyChildren({
      parent: {
        environmentId: EnvironmentId.make("environment-mac"),
        remoteChildStarts: [
          {
            requestId: ChildRequestId.make("request-notes"),
            environmentId: EnvironmentId.make("environment-windows"),
            label: "Windows PC",
            title: "Draft the notes",
            status: "awaiting_approval",
            createdAt: "2026-10-21T09:00:00.000Z",
          },
        ],
      },
      canSeeComputer: () => false,
      computerLabel: (_environmentId, lastKnown) => lastKnown,
      hasThread: () => false,
      wrapUpOnFinish: true,
    });
    // A child started here whose worktree is still being made: nowhere else to name.
    const [settingUp] = resolveRemoteFamilyChildren({
      parent: {
        environmentId: ENVIRONMENT_ID,
        localChildStarts: [
          {
            requestId: ChildRequestId.make("request-changelog"),
            childThreadId: ThreadId.make("thread-changelog"),
            title: "Write the changelog",
            createdAt: "2026-10-21T09:00:00.000Z",
          },
        ],
      },
      canSeeComputer: () => true,
      computerLabel: (_environmentId, lastKnown) => lastKnown,
      hasThread: () => false,
      wrapUpOnFinish: true,
    });
    render(
      <ThreadHoverCardProvider>
        <ul>
          <InboxThreadRow
            {...rowCallbacks}
            thread={remoteChild}
            status={status("Working")}
            projectLabel="threadlines"
            isActive={false}
            jumpLabel={null}
            canMarkDone={false}
            listPullRequest={null}
            linkedPullRequests={[]}
            openPrLink={() => undefined}
            remoteParent={{ title: "Ship the 0.6 release", computerLabel: "Mac mini" }}
          />
          <InboxChildRow
            {...rowCallbacks}
            thread={remoteChild}
            status={status("Working")}
            isDone={false}
            doneAt={null}
            isActive={false}
            jumpLabel={null}
            canMarkDone={false}
            reopenThread={() => undefined}
            computerLabel="Windows PC"
          />
          <InboxRemoteChildRow child={waitingStart!} />
          <InboxRemoteChildRow child={settingUp!} />
        </ul>
      </ThreadHoverCardProvider>,
    );

    await expect
      .element(page.getByTestId(`thread-detail-${remoteChild.id}`))
      .toMatchTextContent("from Ship the 0.6 release on Mac mini");
    await expect
      .element(page.getByTestId(`child-computer-${remoteChild.id}`))
      .toHaveAttribute("aria-label", "On Windows PC");
    await expect
      .element(page.getByTestId("remote-child-meta-start:environment-windows:request-notes"))
      .toMatchTextContent("Waiting for Windows PC to allow it");
    const settingUpMeta = page.getByTestId("remote-child-meta-setup:request-changelog");
    await expect.element(settingUpMeta).toMatchTextContent("Setting up");
    expect(settingUpMeta.element().querySelector("svg")).toBeNull();
  });
});

describe("a thread another computer asked to start", () => {
  const MAC_MINI = EnvironmentId.make("environment-mac-mini");
  const REQUEST: ComputerLinkPendingRequest = {
    deviceId: "device-windows-pc",
    requestId: ChildRequestId.make("request-changelog"),
    fromLabel: "Windows PC",
    parentEnvironmentId: EnvironmentId.make("environment-windows"),
    parentThreadId: ThreadId.make("thread-release"),
    parentThreadTitle: "Ship the 0.6 release",
    askedBy: "Codex",
    title: "Write the changelog",
    prompt: "Read the pull requests merged since 0.5,\n\n   then write the changelog.",
    projectName: "threadlines",
    agent: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "auto",
    createdAt: "2026-10-21T09:00:00.000Z",
    expiresAt: "2099-10-22T09:00:00.000Z",
  };

  // Requests whose row was clicked, in order.
  let opened: string[] = [];

  // What the sidebar draws from the links store: each request waiting on a
  // computer this app hears from, as a row.
  function PendingRequestRows() {
    const pending = usePendingLinkRequests();
    return (
      <ul>
        {pending.map(({ environmentId, request }) => (
          <InboxLinkRequestRow
            key={request.requestId}
            environmentId={environmentId}
            computerLabel="Mac mini"
            askerLabel="Windows PC"
            request={request}
            onOpen={() => opened.push(request.requestId)}
          />
        ))}
      </ul>
    );
  }

  function stubMacMini(
    respondRequest: ComputerLinksClient["respondRequest"],
    pending: ReadonlyArray<ComputerLinkPendingRequest> = [REQUEST],
  ) {
    const unused = () => {
      throw new Error("Not part of this test.");
    };
    __setComputerLinksClientForTests(MAC_MINI, {
      subscribe: () => () => undefined,
      createInvite: unused,
      accept: unused,
      setAccess: unused,
      remove: unused,
      respondRequest,
    });
    useComputerLinksStore.getState().put(MAC_MINI, { outbound: [], inbound: [], pending });
  }

  afterEach(() => {
    __resetComputerLinksForTests();
    opened = [];
  });

  it("reads as a request from another computer and sends Allow to the one it would run on", async () => {
    const respondRequest = vi.fn<ComputerLinksClient["respondRequest"]>(async () => undefined);
    stubMacMini(respondRequest);
    render(<PendingRequestRows />);

    await expect
      .element(page.getByTestId(`link-request-title-${REQUEST.requestId}`))
      .toMatchTextContent("Write the changelog");
    await expect
      .element(page.getByTestId(`link-request-where-${REQUEST.requestId}`))
      .toMatchTextContent("Asked by “Ship the 0.6 release” on Windows PC");

    // Allow answers the request; it doesn't open it.
    await userEvent.click(page.getByTestId(`link-request-allow-${REQUEST.requestId}`));
    expect(respondRequest).toHaveBeenCalledWith({
      deviceId: REQUEST.deviceId,
      requestId: REQUEST.requestId,
      allow: true,
    });
    expect(opened).toEqual([]);
    // Answered: nothing more to press while Mac mini drops the request.
    await expect.element(page.getByTestId(`link-request-deny-${REQUEST.requestId}`)).toBeDisabled();
  });

  it("reads a move as a move: which computers, what goes, and where it lands", async () => {
    const move: ComputerLinkPendingRequest = {
      ...REQUEST,
      requestId: ChildRequestId.make("transfer-login"),
      kind: "move",
      title: "Fix the login bug",
      parentThreadTitle: "Fix the login bug",
      prompt: "",
      move: {
        messageCount: 12,
        branch: "fix/login",
        trackedFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 2,
      },
    };
    const respondRequest = vi.fn<ComputerLinksClient["respondRequest"]>(async () => undefined);
    stubMacMini(respondRequest, [move]);
    render(<PendingRequestRows />);

    await expect
      .element(page.getByTestId(`link-request-title-${move.requestId}`))
      .toMatchTextContent("Fix the login bug");
    await expect
      .element(page.getByTestId(`link-request-where-${move.requestId}`))
      .toMatchTextContent("Windows PC wants to move a thread to Mac mini");
    await expect
      .element(page.getByTestId(`link-request-move-${move.requestId}`))
      .toMatchTextContent(
        "12 messages · branch fix/login · 3 changed files · 1 new file · 2 commits not pushed" +
          "Lands in threadlines with up to Auto access",
      );

    await userEvent.click(page.getByTestId(`link-request-allow-${move.requestId}`));
    expect(respondRequest).toHaveBeenCalledWith({
      deviceId: move.deviceId,
      requestId: move.requestId,
      allow: true,
    });
    expect(opened).toEqual([]);
  });

  it("opens the request when the row is clicked", async () => {
    stubMacMini(vi.fn<ComputerLinksClient["respondRequest"]>(async () => undefined));
    render(<PendingRequestRows />);

    await userEvent.click(page.getByTestId(`link-request-title-${REQUEST.requestId}`));
    expect(opened).toEqual([REQUEST.requestId]);
  });

  it("sends Deny, and offers both again when Mac mini can't take the answer", async () => {
    const respondRequest = vi.fn<ComputerLinksClient["respondRequest"]>(async () => {
      throw new Error("Mac mini can't be reached right now.");
    });
    stubMacMini(respondRequest);
    render(<PendingRequestRows />);

    await userEvent.click(page.getByTestId(`link-request-deny-${REQUEST.requestId}`));
    expect(respondRequest).toHaveBeenCalledWith({
      deviceId: REQUEST.deviceId,
      requestId: REQUEST.requestId,
      allow: false,
    });
    await expect.element(page.getByTestId(`link-request-allow-${REQUEST.requestId}`)).toBeEnabled();
    await expect.element(page.getByTestId(`link-request-deny-${REQUEST.requestId}`)).toBeEnabled();
  });

  it("leaves out a computer the app no longer hears from", async () => {
    stubMacMini(vi.fn<ComputerLinksClient["respondRequest"]>(async () => undefined));
    useComputerLinksStore.getState().markStale(MAC_MINI);
    render(<PendingRequestRows />);

    await expect.element(page.getByRole("list")).toBeInTheDocument();
    expect(page.getByTestId(`link-request-${REQUEST.requestId}`).elements()).toHaveLength(0);
  });
});

describe("InboxThreadRow background wait", () => {
  /** A message getting going, before its turn's row lands: the latest turn
   *  is still the previous one. */
  const startingThread = (launching: boolean): SidebarThreadSummary => ({
    ...THREAD,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-09-01T09:00:00.000Z",
      startedAt: "2026-09-01T09:00:01.000Z",
      completedAt: "2026-09-01T09:05:00.000Z",
      assistantMessageId: null,
    },
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "connecting",
      orchestrationStatus: "starting",
      ...(launching ? { launchingInstanceId: ProviderInstanceId.make("codex") } : {}),
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
  });
  const rowMetaText = () =>
    document.querySelector(`[data-testid="thread-meta-${THREAD_ID}"]`)?.textContent ?? "";

  it("says working for a message to an agent already up, without the previous turn's clock", async () => {
    renderRow(null, [], startingThread(false));
    await expect
      .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
      .toMatchTextContent(/working/);
    expect(rowMetaText()).not.toMatch(/starting|·/);
  });

  it("says starting while the agent's program starts up", async () => {
    renderRow(null, [], startingThread(true));
    await expect
      .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
      .toMatchTextContent(/starting/);
    expect(rowMetaText()).not.toMatch(/·/);
  });

  it("names the agents a settled thread waits on, and lists every task on hover", async () => {
    const thread: SidebarThreadSummary = {
      ...THREAD,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-09-01T09:00:00.000Z",
        startedAt: "2026-09-01T09:00:01.000Z",
        completedAt: "2026-09-01T09:05:00.000Z",
        assistantMessageId: null,
      },
      session: {
        provider: ProviderDriverKind.make("claudeAgent"),
        status: "ready",
        orchestrationStatus: "ready",
        pendingBackgroundTaskCount: 3,
        awaitedBackgroundTaskCount: 3,
        awaitedBackgroundTasks: [
          { kind: "command", description: "Watch CI run until completion" },
          { kind: "agent", description: "Review the diff" },
          { kind: "agent", description: "Research the flaky test" },
        ],
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:05:00.000Z",
      },
    };
    renderRow(null, [], thread);

    await expect
      .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
      .toMatchTextContent(/2 agents/);

    await page.getByTestId(`thread-title-${THREAD_ID}`).hover();
    const card = page.getByTestId("thread-hover-card");
    await expect.element(card).toMatchTextContent(/Waiting on 2\sagents and 1\scommand/);
    await expect.element(card).toMatchTextContent(/Watch CI run until completion/);
  });
});
