import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../lib/testPage.browser-harness";
import { useLayoutBusy } from "./layoutBusy";

function Probe() {
  const busy = useLayoutBusy();
  return (
    <div>
      <div data-testid="scroller" style={{ height: 100, overflow: "auto" }}>
        <div style={{ height: 2_000 }} />
      </div>
      <input data-testid="field" />
      <div data-testid="divider" role="separator" style={{ width: 8, height: 40 }} />
      <output data-testid="busy">{String(busy)}</output>
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useLayoutBusy", () => {
  afterEach(async () => {
    await resetTestPage();
  });

  it("holds for a divider drag, not for typing, scrolling or other drags", async () => {
    const screen = await render(<Probe />);
    const scroller = screen.getByTestId("scroller").element() as HTMLElement;
    const field = screen.getByTestId("field").element() as HTMLInputElement;
    const divider = screen.getByTestId("divider").element() as HTMLElement;
    const busy = () => screen.getByTestId("busy").element().textContent;
    const drag = (from: Element) => {
      from.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
      from.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1 }));
      from.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    };

    // Typing, the wheel, the page scrolling itself, and a drag that selects text.
    for (let step = 0; step < 6; step += 1) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      field.dispatchEvent(new InputEvent("input", { bubbles: true }));
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
      scroller.scrollTop += 60;
      drag(field);
      await sleep(40);
    }
    expect(busy()).toBe("false");

    drag(divider);
    await expect.poll(busy).toBe("true");
    await expect.poll(busy, { timeout: 2_000 }).toBe("false");
  });
});
