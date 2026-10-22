import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DatePicker } from "./date-picker";

function DatePickerHarness(props: {
  readonly initial: string;
  readonly min?: string;
  readonly onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(props.initial);

  return (
    <DatePicker
      value={value}
      onChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
      min={props.min}
      today="2026-10-21"
      aria-label="Run date"
    />
  );
}

describe("DatePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("arrows across a month boundary and picks the focused day with Enter", async () => {
    const onChange = vi.fn();
    const screen = await render(<DatePickerHarness initial="2026-10-30" onChange={onChange} />);

    try {
      const trigger = page.getByRole("button", { name: "Run date" });
      await expect.element(trigger).toMatchTextContent("Fri, Oct 30, 2026");

      await trigger.click();
      await expect.element(page.getByRole("grid", { name: "October 2026" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Friday, October 30, 2026" }))
        .toHaveFocus();

      // A week down from Oct 30 lands in November, and the calendar follows.
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(page.getByRole("grid", { name: "November 2026" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Friday, November 6, 2026" }))
        .toHaveFocus();

      await userEvent.keyboard("{ArrowLeft}");
      await expect
        .element(page.getByRole("button", { name: "Thursday, November 5, 2026" }))
        .toHaveFocus();

      await userEvent.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-11-05");
      await expect.element(page.getByRole("grid")).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      await expect.element(trigger).toMatchTextContent("Thu, Nov 5, 2026");
    } finally {
      await screen.unmount();
    }
  });

  it("closes on Escape without changing the date", async () => {
    const onChange = vi.fn();
    const screen = await render(<DatePickerHarness initial="2026-10-30" onChange={onChange} />);

    try {
      const trigger = page.getByRole("button", { name: "Run date" });
      await trigger.click();
      await expect
        .element(page.getByRole("button", { name: "Friday, October 30, 2026" }))
        .toHaveFocus();

      await userEvent.keyboard("{PageDown}");
      await expect
        .element(page.getByRole("button", { name: "Monday, November 30, 2026" }))
        .toHaveFocus();

      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("grid")).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      await expect.element(trigger).toMatchTextContent("Fri, Oct 30, 2026");
      expect(onChange).not.toHaveBeenCalled();

      // Reopening starts from the chosen day again, not where focus was left.
      await trigger.click();
      await expect
        .element(page.getByRole("button", { name: "Friday, October 30, 2026" }))
        .toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps days before min out of reach and marks today", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <DatePickerHarness initial="2026-10-25" min="2026-10-21" onChange={onChange} />,
    );

    try {
      await page.getByRole("button", { name: "Run date" }).click();
      await expect
        .element(page.getByRole("gridcell", { name: "Sunday, October 25, 2026" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("button", { name: "Wednesday, October 21, 2026" }))
        .toHaveAttribute("aria-current", "date");
      await expect.element(page.getByRole("button", { name: "Previous month" })).toBeDisabled();

      const beforeMin = page.getByRole("button", { name: "Tuesday, October 20, 2026" });
      await expect.element(beforeMin).toHaveAttribute("aria-disabled", "true");
      (beforeMin.element() as HTMLElement).click();
      expect(onChange).not.toHaveBeenCalled();
      await expect.element(page.getByRole("grid")).toBeVisible();

      // A week up from Oct 25 would be Oct 18, so focus stops at min.
      await userEvent.keyboard("{ArrowUp}");
      await expect
        .element(page.getByRole("button", { name: "Wednesday, October 21, 2026" }))
        .toHaveFocus();

      await page.getByRole("button", { name: "Wednesday, October 28, 2026" }).click();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-10-28");
      await expect.element(page.getByRole("grid")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
