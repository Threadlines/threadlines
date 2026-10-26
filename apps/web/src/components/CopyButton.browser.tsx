import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const clipboard = vi.hoisted(() => ({ copy: vi.fn<(value: string) => Promise<void>>() }));
vi.mock("~/lib/clipboard", () => ({ copyTextToClipboard: clipboard.copy }));

// The notice stack reads the open thread from the route; there is no route here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));

import { CopyIconButton } from "./CopyButton";
import { ToastProvider, toastManager } from "./ui/toast";

describe("CopyIconButton", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("shows a check after a copy, and a notice only when the copy fails", async () => {
    const mounted = await render(
      <ToastProvider>
        <CopyIconButton
          value="npm install -g @openai/codex@latest"
          what="update command"
          aria-label="Copy update command"
        />
      </ToastProvider>,
    );

    try {
      const button = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Copy update command']",
      )!;
      const noticeTitle = () => document.querySelector("[data-slot='toast-title']")?.textContent;

      clipboard.copy.mockResolvedValueOnce();
      button.click();
      await vi.waitFor(() => expect(button.querySelector(".lucide-check")).not.toBeNull());
      expect(clipboard.copy).toHaveBeenCalledWith("npm install -g @openai/codex@latest");
      expect(noticeTitle()).toBeUndefined();

      clipboard.copy.mockRejectedValueOnce(new Error("Clipboard access was denied."));
      button.click();
      await vi.waitFor(() => expect(noticeTitle()).toBe("Couldn't copy the update command"));
    } finally {
      await mounted.unmount();
    }
  });
});
