import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

// A picture far bigger than the window, so the viewer shows it fitted.
const BIG_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="2400"><rect width="3200" height="2400" fill="teal"/></svg>',
)}`;

const drawnWidth = (element: Element) => element.getBoundingClientRect().width;

describe("ExpandedImageDialog", () => {
  it("shows a picture at its own pixels on a click, and fitted again on the next", async () => {
    await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: BIG_PICTURE, name: "Screen" }], index: 0 }}
        onClose={() => {}}
      />,
    );
    const picture = page.getByAltText("Screen");
    const element = picture.element() as HTMLImageElement;
    await vi.waitFor(() => expect(element.naturalWidth).toBe(3200));
    const fitted = drawnWidth(element);
    expect(fitted).toBeLessThan(window.innerWidth);

    await picture.click();
    await vi.waitFor(() => expect(drawnWidth(element)).toBeCloseTo(3200, 0));

    await picture.click();
    await vi.waitFor(() => expect(drawnWidth(element)).toBeCloseTo(fitted, 0));
  });

  it("closes on Escape before a dialog under it hears the key", async () => {
    const onClose = vi.fn();
    const underneath = vi.fn();
    // Where a dialog under the viewer (a page opened full size) listens.
    document.addEventListener("keydown", underneath, true);
    try {
      await render(
        <ExpandedImageDialog
          preview={{ images: [{ src: BIG_PICTURE, name: "Screen" }], index: 0 }}
          onClose={onClose}
        />,
      );
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledOnce();
      expect(underneath).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", underneath, true);
    }
  });
});
