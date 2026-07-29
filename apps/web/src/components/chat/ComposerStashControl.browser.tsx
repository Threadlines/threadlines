import "../../index.css";

import { ThreadId } from "@threadlines/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { PromptStashEntry } from "../../promptStashStore";
import { ComposerStashControl } from "./ComposerStashControl";

function makeEntry(input: { id: string; prompt: string; withChip?: boolean }): PromptStashEntry {
  return {
    id: input.id,
    createdAt: new Date().toISOString(),
    prompt: input.prompt,
    attachments: [],
    droppedAttachmentNames: [],
    ...(input.withChip
      ? {
          fileSelectionContexts: [
            {
              id: `${input.id}-file`,
              threadId: ThreadId.make("thread-1"),
              createdAt: new Date().toISOString(),
              relativePath: "src/app.ts",
              startLine: 1,
              endLine: 4,
              selectedText: "const a = 1;",
            },
          ],
        }
      : {}),
  };
}

function renderStashControl(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  canStash: boolean;
  onRestore?: (entry: PromptStashEntry) => void;
  onDelete?: (entry: PromptStashEntry) => void;
}) {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <ComposerStashControl
        entries={props.entries}
        open={open}
        onOpenChange={setOpen}
        canStash={props.canStash}
        stashShortcutLabel="⌘S"
        onStash={vi.fn()}
        onRestore={props.onRestore ?? vi.fn()}
        onDelete={props.onDelete ?? vi.fn()}
      />
    );
  }
  return render(<Harness />);
}

describe("ComposerStashControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lists stashed prompts with their chip count and restores the row that was clicked", async () => {
    const onRestore = vi.fn();
    const screen = await renderStashControl({
      entries: [
        makeEntry({ id: "newest", prompt: "rewrite the parser", withChip: true }),
        makeEntry({ id: "older", prompt: "add a retry" }),
      ],
      canStash: true,
      onRestore,
    });

    await page.getByRole("button", { name: "Stashed prompts (2)" }).click();
    await expect.element(page.getByRole("menuitem", { name: /Stash this prompt/ })).toBeVisible();
    await expect.element(page.getByText("1 chip")).toBeVisible();

    await page.getByRole("menuitem", { name: /rewrite the parser/ }).click();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0]?.[0]?.id).toBe("newest");
    await screen.unmount();
  });

  it("deletes an entry without restoring it, and offers no stash action on an empty composer", async () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const screen = await renderStashControl({
      entries: [makeEntry({ id: "only", prompt: "ship the fix" })],
      canStash: false,
      onRestore,
      onDelete,
    });

    await page.getByRole("button", { name: "Stashed prompts (1)" }).click();
    // Nothing typed, so the popover is a list only.
    expect(page.getByRole("menuitem", { name: /Stash this prompt/ }).query()).toBeNull();

    await page.getByRole("button", { name: /Delete stashed prompt/ }).click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    // The delete must not double as an activation of the row it sits in.
    expect(onRestore).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("explains how to fill an empty stash", async () => {
    const screen = await renderStashControl({ entries: [], canStash: false });

    await page.getByRole("button", { name: "Stashed prompts" }).click();
    await expect.element(page.getByText(/Nothing stashed yet/)).toBeVisible();
    await screen.unmount();
  });
});
