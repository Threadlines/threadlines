import "../../index.css";

import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SegmentedControl, SegmentedControlItem } from "./segmented-control";

type Layout = "stacked" | "split";

function SegmentedControlHarness(props: { readonly onChange: (value: Layout) => void }) {
  const [value, setValue] = useState<Layout>("stacked");

  return (
    <SegmentedControl
      value={value}
      onValueChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
      aria-label="Diff layout"
    >
      <SegmentedControlItem value="stacked">Stacked</SegmentedControlItem>
      <SegmentedControlItem value="split">Split</SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("SegmentedControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("always keeps one option chosen", async () => {
    const onChange = vi.fn();
    const screen = await render(<SegmentedControlHarness onChange={onChange} />);

    try {
      const stacked = page.getByRole("button", { name: "Stacked" });
      const split = page.getByRole("button", { name: "Split" });
      await expect.element(stacked).toHaveAttribute("aria-pressed", "true");

      // Clicking the chosen option does not clear the choice.
      await stacked.click();
      expect(onChange).not.toHaveBeenCalled();
      await expect.element(stacked).toHaveAttribute("aria-pressed", "true");

      await split.click();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("split");
      await expect.element(split).toHaveAttribute("aria-pressed", "true");
      await expect.element(stacked).toHaveAttribute("aria-pressed", "false");
    } finally {
      await screen.unmount();
    }
  });
});
