import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";

function renderAttachmentMenu(isMobileViewport: boolean) {
  return render(
    <ComposerAttachmentMenu
      canCaptureScreenshot={false}
      isCapturingScreenshot={false}
      isMobileViewport={isMobileViewport}
      disabled={false}
      disabledReason={null}
      onAddImage={vi.fn()}
      onAttachFiles={vi.fn()}
      onCaptureScreenshot={vi.fn()}
    />,
  );
}

describe("ComposerAttachmentMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("combines desktop attachments while retaining mobile's native image and file choices", async () => {
    const desktop = await renderAttachmentMenu(false);
    await page.getByRole("button", { name: "Add attachment" }).click();

    await expect.element(page.getByRole("menuitem", { name: "Attach files" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Add image" }).query()).toBeNull();
    expect(page.getByRole("menuitem", { name: "Add file" }).query()).toBeNull();
    await desktop.unmount();

    const mobile = await renderAttachmentMenu(true);
    await page.getByRole("button", { name: "Add attachment" }).click();

    await expect.element(page.getByRole("menuitem", { name: "Add image" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Add file" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Attach files" }).query()).toBeNull();
    await mobile.unmount();
  });
});
