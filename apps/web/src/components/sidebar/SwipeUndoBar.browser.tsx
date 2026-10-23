import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SwipeUndoBar } from "./SwipeUndoBar";

describe("SwipeUndoBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays while an undo is out, says so in place when it fails, and goes once a retry lands", async () => {
    let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
    const undo = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    const onDismiss = vi.fn();
    render(
      <div style={{ position: "relative", height: "200px", width: "320px" }}>
        <SwipeUndoBar
          undo={{ id: 4, verb: "Archived", title: "Ship the release", undo }}
          onDismiss={onDismiss}
        />
      </div>,
    );
    const bar = page.getByTestId("swipe-undo-bar");
    await expect.element(bar).toMatchTextContent(/Archived Ship the release/);

    await bar.getByRole("button", { name: "Undo" }).click();
    await expect.element(bar.getByRole("button", { name: "Undo" })).toBeDisabled();
    settle!.reject(new Error("offline"));
    // The toast layer sits under the phone's sidebar, so the failure shows here.
    await expect.element(bar).toMatchTextContent(/Couldn't put back Ship the release/);
    expect(onDismiss).not.toHaveBeenCalled();

    await bar.getByRole("button", { name: "Try again" }).click();
    settle!.resolve();
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledWith(4));
    expect(undo).toHaveBeenCalledTimes(2);
  });
});
