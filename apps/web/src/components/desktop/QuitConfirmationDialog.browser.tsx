import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  ThreadMoveBatchId,
  ThreadMoveRequestId,
  type DesktopBridge,
  type DesktopQuitConfirmationRequest,
  type ThreadMoveBatchMember,
  type ThreadMoveBatchStatus,
  type ThreadMoveTargetPreview,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetThreadMovesForTests,
  __setThreadMovesClientForTests,
  type ThreadMovesClient,
} from "../../environments/links/threadMoves";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";

import { useStore, type EnvironmentState } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { QuitConfirmationDialog } from "./QuitConfirmationDialog";

const THIS_COMPUTER_ID = EnvironmentId.make("env-windows");
const MAC_ID = EnvironmentId.make("env-mac");

function runningThreadsOn(environmentId: EnvironmentId, threadId: string): EnvironmentState {
  const id = ThreadId.make(threadId);
  return {
    threadIds: [id],
    sidebarThreadSummaryById: {
      [id]: {
        id,
        environmentId,
        title: threadId,
        session: { status: "running", orchestrationStatus: "running" },
        latestTurn: null,
      },
    },
  } as unknown as EnvironmentState;
}

function stubQuitBridge() {
  let listener: ((request: DesktopQuitConfirmationRequest | null) => void) | null = null;
  const resolveQuitConfirmation = vi.fn(() => Promise.resolve());
  window.desktopBridge = {
    onQuitConfirmationRequested: (next: typeof listener) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    resolveQuitConfirmation,
  } as unknown as DesktopBridge;
  return {
    ask: (request: DesktopQuitConfirmationRequest) => listener?.(request),
    resolveQuitConfirmation,
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  Reflect.deleteProperty(window, "desktopBridge");
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useTerminalStateStore.setState({
    terminalStateByThreadKey: {},
    terminalActivityCommandByKey: {},
    terminalCommandPendingByKey: {},
  });
  resetSavedEnvironmentRegistryStoreForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  __resetThreadMovesForTests();
});

describe("QuitConfirmationDialog", () => {
  it("says work on another computer keeps running when this one quits", async () => {
    writePrimaryEnvironmentDescriptor({
      environmentId: THIS_COMPUTER_ID,
      label: "Gaming PC",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "0.1.0",
      capabilities: { repositoryIdentity: false },
    });
    useSavedEnvironmentRegistryStore.setState({
      byId: {
        [MAC_ID]: {
          environmentId: MAC_ID,
          label: "Studio Mac",
          wsBaseUrl: "ws://mac.local",
          httpBaseUrl: "http://mac.local",
          createdAt: new Date().toISOString(),
          lastConnectedAt: null,
        },
      },
    });
    useStore.setState({
      activeEnvironmentId: THIS_COMPUTER_ID,
      environmentStateById: {
        [THIS_COMPUTER_ID]: runningThreadsOn(THIS_COMPUTER_ID, "thread-local"),
        [MAC_ID]: runningThreadsOn(MAC_ID, "thread-mac"),
      },
    });
    const bridge = stubQuitBridge();
    mounted = await render(<QuitConfirmationDialog />);

    // The app asks with this computer's count only.
    bridge.ask({ requestId: "quit-1", runningThreadCount: 1 });
    const dialog = page.getByRole("alertdialog");
    await expect
      .element(dialog)
      .toMatchTextContent(
        "An agent session is still running on this computer. Quitting now will stop it and the local Threadlines server. Work on Studio Mac keeps running.",
      );

    await dialog.getByRole("button", { name: "Quit Anyway" }).click();
    expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(true);
  });

  it("names what this computer's terminals are running", async () => {
    writePrimaryEnvironmentDescriptor({
      environmentId: THIS_COMPUTER_ID,
      label: "Gaming PC",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "0.1.0",
      capabilities: { repositoryIdentity: false },
    });
    const busyTerminal = (environmentId: EnvironmentId, command: string) => {
      const threadKey = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make("thread-1")));
      return {
        threadKey,
        state: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: ["default"],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
        commandKey: `${threadKey}\u0000default`,
        command,
      };
    };
    const local = busyTerminal(THIS_COMPUTER_ID, "npm run dev");
    // The Mac's terminal runs on the Mac and keeps running.
    const mac = busyTerminal(MAC_ID, "cargo watch");
    useTerminalStateStore.setState({
      terminalStateByThreadKey: { [local.threadKey]: local.state, [mac.threadKey]: mac.state },
      terminalActivityCommandByKey: {
        [local.commandKey]: local.command,
        [mac.commandKey]: mac.command,
      },
    });
    const bridge = stubQuitBridge();
    mounted = await render(<QuitConfirmationDialog />);

    bridge.ask({ requestId: "quit-2", runningThreadCount: 0, busyTerminalCount: 1 });
    await expect
      .element(page.getByRole("alertdialog"))
      .toMatchTextContent(
        "npm run dev is still running in a terminal. Quitting now will stop it and the local Threadlines server.",
      );
  });

  describe("moving the working threads before quitting", () => {
    const BATCH_ID = ThreadMoveBatchId.make("batch-quit");
    const MAC: ThreadMoveTargetPreview = {
      environmentId: MAC_ID,
      label: "Studio Mac",
      access: "ask",
      stagedApproval: true,
      agents: [],
    };

    function member(
      threadId: string,
      state: ThreadMoveBatchMember["state"],
      extra: Partial<ThreadMoveBatchMember> = {},
    ): ThreadMoveBatchMember {
      return {
        threadId: ThreadId.make(threadId),
        title: threadId,
        requestId: ThreadMoveRequestId.make(`request-${threadId}`),
        state,
        final: state === "moved" || state === "not_moved" || state === "awaiting_approval",
        ...extra,
      };
    }

    function batch(members: ThreadMoveBatchMember[]): ThreadMoveBatchStatus {
      return {
        batchId: BATCH_ID,
        target: { environmentId: MAC_ID, label: "Studio Mac" },
        createdAt: new Date().toISOString(),
        members,
        final: members.every((candidate) => candidate.final),
      };
    }

    /** This computer moves several threads at once, with two agents working and Studio Mac linked. */
    function setUpMoves(statuses: ThreadMoveBatchStatus[]) {
      writePrimaryEnvironmentDescriptor({
        environmentId: THIS_COMPUTER_ID,
        label: "Gaming PC",
        platform: { os: "windows", arch: "x64" },
        serverVersion: "0.1.0",
        capabilities: { repositoryIdentity: false, threadMoveBatch: true },
      });
      const one = runningThreadsOn(THIS_COMPUTER_ID, "thread-a");
      const two = runningThreadsOn(THIS_COMPUTER_ID, "thread-b");
      useStore.setState({
        activeEnvironmentId: THIS_COMPUTER_ID,
        environmentStateById: {
          [THIS_COMPUTER_ID]: {
            ...one,
            projectById: {},
            threadIds: [...one.threadIds, ...two.threadIds],
            sidebarThreadSummaryById: {
              ...one.sidebarThreadSummaryById,
              ...two.sidebarThreadSummaryById,
            },
          },
        },
      });
      let statusIndex = 0;
      const client = {
        previewMany: vi.fn(async (input: { threadIds: readonly ThreadId[] }) => ({
          threads: input.threadIds.map((threadId) => ({
            threadId,
            waitsFor: [{ code: "turn" as const, words: "when this turn ends" }],
          })),
          targets: [MAC],
        })),
        queueMany: vi.fn(async () => ({ batchId: BATCH_ID, queued: [], refused: [] })),
        batchStatus: vi.fn(async () => {
          const status = statuses[Math.min(statusIndex, statuses.length - 1)]!;
          statusIndex += 1;
          return status;
        }),
        setMode: vi.fn(async () => undefined),
        unqueue: vi.fn(async () => undefined),
      };
      __setThreadMovesClientForTests(THIS_COMPUTER_ID, client as unknown as ThreadMovesClient);
      const bridge = stubQuitBridge();
      const quitAfterMoves = vi.fn(() => Promise.resolve());
      const cancelQuitAfterMoves = vi.fn(() => Promise.resolve());
      const showQuitAfterMoves = vi.fn(() => Promise.resolve());
      Object.assign(window.desktopBridge!, {
        quitAfterMoves,
        cancelQuitAfterMoves,
        showQuitAfterMoves,
      });
      return { bridge, client, quitAfterMoves, cancelQuitAfterMoves, showQuitAfterMoves };
    }

    it("queues the working threads, shows how they go, and quits once all have moved", async () => {
      const { bridge, client, quitAfterMoves, showQuitAfterMoves } = setUpMoves([
        batch([member("thread-a", "moved"), member("thread-b", "waiting")]),
        batch([member("thread-a", "moved"), member("thread-b", "awaiting_approval")]),
      ]);
      mounted = await render(<QuitConfirmationDialog />);
      bridge.ask({ requestId: "quit-moves-1", runningThreadCount: 2 });

      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Move them to Studio Mac and quit" }).click();
      // Each with its family here (none in this case), exactly those.
      expect(client.queueMany).toHaveBeenCalledWith({
        threadIds: [ThreadId.make("thread-a"), ThreadId.make("thread-b")],
        targetEnvironmentId: MAC_ID,
        mode: "when-done",
        familySelection: "explicit",
      });
      expect(quitAfterMoves).toHaveBeenCalledWith({ batchId: BATCH_ID });
      // One moved, one waiting for its agent; then sent, which counts as done.
      await expect
        .element(page.getByTestId("quit-moves-progress"))
        .toHaveTextContent("1 moved, 1 waiting for its agent.");
      await expect
        .element(page.getByTestId("quit-moves-sent"))
        .toHaveTextContent("Sent. Studio Mac will ask its user to allow it.");
      await expect.element(dialog).toMatchTextContent(/All moved\. Quitting…/u);
      await vi.waitFor(() => expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(true), {
        timeout: 3_000,
      });
      // Nothing needed the user: the window stayed where it was.
      expect(showQuitAfterMoves).not.toHaveBeenCalled();
    });

    it("a page loaded mid-wait picks the moves' progress up, and quits once they're done", async () => {
      const { bridge, client } = setUpMoves([
        batch([member("thread-a", "moved"), member("thread-b", "moving")]),
        batch([member("thread-a", "moved"), member("thread-b", "moved")]),
      ]);
      mounted = await render(<QuitConfirmationDialog />);
      // The app asks a fresh page with the batch its quit already waits on.
      bridge.ask({
        requestId: "quit-moves-reloaded",
        runningThreadCount: 2,
        quitAfterMoves: { batchId: BATCH_ID },
      });
      await expect
        .element(page.getByTestId("quit-moves-progress"))
        .toHaveTextContent("1 moved, 1 on the way.");
      await expect.element(page.getByRole("alertdialog")).toMatchTextContent(/Studio Mac/u);
      await expect
        .element(page.getByRole("alertdialog"))
        .toMatchTextContent(/All moved\. Quitting…/u);
      await vi.waitFor(() => expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(true), {
        timeout: 3_000,
      });
      // Nothing was queued again.
      expect(client.queueMany).not.toHaveBeenCalled();
    });

    it("lists a thread that didn't move with why, doesn't quit by itself, and offers Quit Anyway", async () => {
      const { bridge, showQuitAfterMoves } = setUpMoves([
        batch([
          member("thread-a", "moved"),
          member("thread-b", "not_moved", { words: "Has a goal set. Clear it first." }),
        ]),
      ]);
      mounted = await render(<QuitConfirmationDialog />);
      bridge.ask({ requestId: "quit-moves-2", runningThreadCount: 2 });

      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Move them to Studio Mac and quit" }).click();
      await expect
        .element(page.getByTestId("quit-moves-misses"))
        .toMatchTextContent(/thread-b.*Has a goal set\. Clear it first\./u);
      // The window comes back (it may be hidden while it waited) to show why.
      await vi.waitFor(() => expect(showQuitAfterMoves).toHaveBeenCalledTimes(1));
      // Longer than the all-moved pause: nothing quits on its own.
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(bridge.resolveQuitConfirmation).not.toHaveBeenCalled();

      await page.getByTestId("quit-moves-quit-anyway").click();
      expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(true);
    });

    it("Cancel takes back the moves that haven't started and keeps the app running", async () => {
      const { bridge, client, cancelQuitAfterMoves, showQuitAfterMoves } = setUpMoves([
        batch([
          member("thread-a", "moving"),
          member("thread-b", "waiting", {
            hold: {
              kind: "stop_unconfirmed",
              words: "Couldn't confirm the agent stopped: it didn't exit.",
            },
          }),
        ]),
      ]);
      mounted = await render(<QuitConfirmationDialog />);
      bridge.ask({ requestId: "quit-moves-3", runningThreadCount: 2 });

      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Move them to Studio Mac and quit" })
        .click();
      await expect
        .element(page.getByTestId("quit-moves-progress"))
        .toHaveTextContent("1 on the way, 1 waiting for its agent.");
      // A stop it couldn't confirm needs the user: it says so, and the window comes back.
      await expect
        .element(page.getByTestId("quit-moves-needs-you"))
        .toMatchTextContent(/thread-b.*Couldn't confirm the agent stopped/u);
      await vi.waitFor(() => expect(showQuitAfterMoves).toHaveBeenCalledTimes(1));
      await page.getByTestId("quit-moves-cancel").click();
      await vi.waitFor(() => expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(false));
      expect(client.unqueue).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-b"),
        requestId: ThreadMoveRequestId.make("request-thread-b"),
      });
      expect(client.unqueue).toHaveBeenCalledTimes(1);
      expect(cancelQuitAfterMoves).toHaveBeenCalled();
    });
  });

  it("asks about scheduled tasks alone without naming work that isn't running", async () => {
    writePrimaryEnvironmentDescriptor({
      environmentId: THIS_COMPUTER_ID,
      label: "Gaming PC",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "0.1.0",
      capabilities: { repositoryIdentity: false },
    });
    const bridge = stubQuitBridge();
    mounted = await render(<QuitConfirmationDialog />);

    // Kept running in the tray, quitting stops the schedules and nothing else.
    bridge.ask({ requestId: "quit-3", runningThreadCount: 0, activeScheduledTaskCount: 2 });
    await expect
      .element(page.getByRole("alertdialog"))
      .toMatchTextContent(
        /^Quit Threadlines\?Quitting now will stop the local Threadlines server\. This computer's 2 scheduled tasks won't run until you open Threadlines again\./,
      );
  });
});
