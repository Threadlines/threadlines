import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  type DesktopBridge,
  type DesktopQuitConfirmationRequest,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

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
