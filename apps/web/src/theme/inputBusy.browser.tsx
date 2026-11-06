import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../lib/testPage.browser-harness";
import { useInputBusy } from "./inputBusy";

function Probe() {
  const busy = useInputBusy();
  return (
    <div>
      <div data-testid="scroller" style={{ height: 100, overflow: "auto" }}>
        <div style={{ height: 2_000 }} />
      </div>
      <output data-testid="busy">{String(busy)}</output>
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useInputBusy", () => {
  afterEach(async () => {
    await resetTestPage();
  });

  it("counts the user's scrolling as busy, not the page scrolling itself", async () => {
    const screen = await render(<Probe />);
    const scroller = screen.getByTestId("scroller").element() as HTMLElement;
    const busy = () => screen.getByTestId("busy").element().textContent;
    // The chat following a reply as it streams in scrolls itself, again and again.
    for (let step = 0; step < 6; step += 1) {
      scroller.scrollTop += 60;
      await sleep(40);
    }
    expect(busy()).toBe("false");
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
    await expect.poll(busy).toBe("true");
    await expect.poll(busy, { timeout: 2_000 }).toBe("false");
  });
});
