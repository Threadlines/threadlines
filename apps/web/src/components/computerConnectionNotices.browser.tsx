import "../index.css";

import { EnvironmentId } from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const MAC_MINI = EnvironmentId.make("environment-mac-mini");

const runtime = vi.hoisted(() => ({
  reconnect: vi.fn<(environmentId: string) => Promise<void>>(),
}));
vi.mock("./computerReconnectClient", () => ({
  getSavedEnvironmentRecord: (environmentId: string) =>
    environmentId === "environment-mac-mini" ? { environmentId, label: "Mac mini" } : null,
  reconnectSavedEnvironment: runtime.reconnect,
}));

// The notice stack reads the open thread from the route; there is no route here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));

import { addComputerNotConnectedNotice } from "./computerConnectionNotices";
import { ToastProvider, toastManager } from "./ui/toast";

const noticeTitles = () =>
  Array.from(document.querySelectorAll("[data-slot='toast-title']"), (el) => el.textContent);
const reconnectButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Reconnect");

describe("addComputerNotConnectedNotice", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("reconnects a linked computer from the notice, and reports in the same place", async () => {
    runtime.reconnect.mockResolvedValueOnce();
    const mounted = await render(<ToastProvider>{null}</ToastProvider>);

    try {
      addComputerNotConnectedNotice({ environmentId: MAC_MINI });
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Mac mini isn't connected"]));

      reconnectButton()!.click();
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Reconnected to Mac mini"]));
      expect(runtime.reconnect).toHaveBeenCalledWith(MAC_MINI);
      expect(reconnectButton()).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it("turns into the failure, with no stale button, when the reconnect fails", async () => {
    let fail!: (error: Error) => void;
    runtime.reconnect.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
    );
    const mounted = await render(<ToastProvider>{null}</ToastProvider>);

    try {
      addComputerNotConnectedNotice({ environmentId: MAC_MINI });
      await vi.waitFor(() => expect(reconnectButton()).toBeDefined());
      reconnectButton()!.click();
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Reconnecting to Mac mini..."]));
      expect(reconnectButton()).toBeUndefined();

      fail(new Error("The computer didn't answer."));
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Couldn't reconnect to Mac mini"]));
      expect(document.body.textContent).toContain("The computer didn't answer.");
      expect(reconnectButton()).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it("offers no Reconnect for a computer it can't reconnect", async () => {
    const mounted = await render(<ToastProvider>{null}</ToastProvider>);

    try {
      addComputerNotConnectedNotice({
        environmentId: EnvironmentId.make("environment-local"),
        failure: "Couldn't update the goal",
        fallbackLabel: "This computer",
      });
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Couldn't update the goal"]));
      expect(document.body.textContent).toContain("This computer isn't connected.");
      expect(reconnectButton()).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });
});
