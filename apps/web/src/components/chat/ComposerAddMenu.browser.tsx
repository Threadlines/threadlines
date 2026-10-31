import "../../index.css";

import { ThreadId } from "@threadlines/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { PromptStashEntry } from "../../promptStashStore";
import { ComposerAddMenu } from "./ComposerAddMenu";

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

function renderAddMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  canStash: boolean;
  isMobileViewport?: boolean;
  canReferenceProjectFiles?: boolean;
  onRestore?: (entry: PromptStashEntry) => void;
  onDelete?: (entry: PromptStashEntry) => void;
  onReferenceProjectFile?: () => void;
  onTakePhoto?: () => void;
}) {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [stashListOpen, setStashListOpen] = useState(false);
    return (
      <ComposerAddMenu
        isMobileViewport={props.isMobileViewport ?? false}
        disabled={false}
        disabledReason={null}
        canReferenceProjectFiles={props.canReferenceProjectFiles ?? true}
        onAttachFiles={vi.fn()}
        onAddPhotos={vi.fn()}
        onTakePhoto={props.onTakePhoto ?? vi.fn()}
        onReferenceProjectFile={props.onReferenceProjectFile ?? vi.fn()}
        stash={{
          entries: props.entries,
          canStash: props.canStash,
          stashShortcutLabel: "⌘S",
          onStash: vi.fn(),
          onRestore: props.onRestore ?? vi.fn(),
          onDelete: props.onDelete ?? vi.fn(),
        }}
        open={open}
        onOpenChange={setOpen}
        stashListOpen={stashListOpen}
        onStashListOpenChange={setStashListOpen}
      />
    );
  }
  return render(<Harness />);
}

describe("ComposerAddMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lists stashed prompts with their chip count and restores the row that was clicked", async () => {
    const onRestore = vi.fn();
    const screen = await renderAddMenu({
      entries: [
        makeEntry({ id: "newest", prompt: "rewrite the parser", withChip: true }),
        makeEntry({ id: "older", prompt: "add a retry" }),
      ],
      canStash: true,
      onRestore,
    });

    await page.getByRole("button", { name: "Add to message" }).click();
    await expect.element(page.getByRole("menuitem", { name: /Files and images/ })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /Stash this prompt/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /Stashed prompts/ }).click();
    await expect.element(page.getByText("1 chip")).toBeVisible();

    await page.getByRole("menuitem", { name: /rewrite the parser/ }).click();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0]?.[0]?.id).toBe("newest");
    await screen.unmount();
  });

  it("deletes an entry only after confirmation, and offers no stash action on an empty composer", async () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const screen = await renderAddMenu({
      entries: [makeEntry({ id: "only", prompt: "ship the fix" })],
      canStash: false,
      onRestore,
      onDelete,
    });

    await page.getByRole("button", { name: "Add to message" }).click();
    // Nothing typed, so there is nothing to stash.
    expect(page.getByRole("menuitem", { name: /Stash this prompt/ }).query()).toBeNull();
    await page.getByRole("menuitem", { name: /Stashed prompts/ }).click();

    // The X on the row asks first; a stray click must not lose the prompt.
    await page.getByRole("button", { name: /Delete stashed prompt/ }).click();
    expect(onDelete).not.toHaveBeenCalled();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    // The menu stayed open behind the dialog, so the same row is still there.
    await page.getByRole("button", { name: /Delete stashed prompt/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]?.id).toBe("only");
    // The delete must not double as an activation of the row it sits in.
    expect(onRestore).not.toHaveBeenCalled();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("types an @ for a project file", async () => {
    const onReferenceProjectFile = vi.fn();
    const screen = await renderAddMenu({ entries: [], canStash: false, onReferenceProjectFile });
    await page.getByRole("button", { name: "Add to message" }).click();
    await page.getByRole("menuitem", { name: /Project file/ }).click();
    expect(onReferenceProjectFile).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("leaves out Project file where the thread has no project, and explains an empty stash", async () => {
    const screen = await renderAddMenu({
      entries: [],
      canStash: false,
      canReferenceProjectFiles: false,
    });
    await page.getByRole("button", { name: "Add to message" }).click();
    await expect.element(page.getByRole("menuitem", { name: /Files and images/ })).toBeVisible();
    expect(page.getByRole("menuitem", { name: /Project file/ }).query()).toBeNull();
    await page.getByRole("menuitem", { name: /Stashed prompts/ }).click();
    await expect.element(page.getByText(/Nothing stashed yet/)).toBeVisible();
    await screen.unmount();
  });

  it("opens a phone sheet with the camera and the stash list", async () => {
    const onTakePhoto = vi.fn();
    const screen = await renderAddMenu({
      entries: [makeEntry({ id: "only", prompt: "ship the fix" })],
      canStash: false,
      isMobileViewport: true,
      onTakePhoto,
    });

    await page.getByRole("button", { name: "Add to message" }).click();
    await expect.element(page.getByRole("button", { name: "Photos" })).toBeVisible();
    await page.getByRole("button", { name: "Stashed prompts" }).click();
    await expect.element(page.getByRole("button", { name: /^ship the fix/ })).toBeVisible();
    await page.getByRole("button", { name: "Stashed prompts" }).click();
    await page.getByRole("button", { name: "Take photo" }).click();
    expect(onTakePhoto).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
