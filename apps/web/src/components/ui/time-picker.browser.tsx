import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { type TimeOfDay, TimePicker } from "./time-picker";

function TimePickerHarness(props: {
  readonly initial: TimeOfDay;
  readonly hour12: boolean;
  readonly minuteStep?: number;
  readonly onChange: (value: TimeOfDay) => void;
}) {
  const [value, setValue] = useState(props.initial);

  return (
    <TimePicker
      value={value}
      onChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
      hour12={props.hour12}
      minuteStep={props.minuteStep}
      aria-label="Run time"
    />
  );
}

function chosenOption(column: string) {
  return page.getByRole("listbox", { name: column }).getByRole("option", { selected: true });
}

describe("TimePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("changes each column with Up/Down, moves between columns with Left/Right, and closes on Enter", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <TimePickerHarness initial={{ hour: 9, minute: 45 }} hour12 onChange={onChange} />,
    );

    try {
      const trigger = page.getByRole("button", { name: "Run time" });
      await expect.element(trigger).toHaveTextContent("9:45 AM");

      await trigger.click();
      await expect.element(chosenOption("Hour")).toHaveTextContent("9");
      await expect.element(chosenOption("Hour")).toHaveFocus();
      // A minute far down its column is scrolled into view on open.
      await expect.element(chosenOption("Minute")).toBeInViewport();

      await userEvent.keyboard("{ArrowDown}");
      expect(onChange).toHaveBeenLastCalledWith({ hour: 10, minute: 45 });
      await expect.element(chosenOption("Hour")).toHaveTextContent("10");
      await expect.element(chosenOption("Hour")).toHaveFocus();

      await userEvent.keyboard("{ArrowRight}");
      await expect.element(chosenOption("Minute")).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(onChange).toHaveBeenLastCalledWith({ hour: 10, minute: 44 });

      // Switching to PM keeps 10 o'clock.
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(chosenOption("AM or PM")).toHaveFocus();
      await userEvent.keyboard("{ArrowDown}");
      expect(onChange).toHaveBeenLastCalledWith({ hour: 22, minute: 44 });
      await expect.element(chosenOption("Hour")).toHaveTextContent("10");

      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(chosenOption("Minute")).toHaveFocus();

      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("listbox", { name: "Hour" })).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      await expect.element(trigger).toHaveTextContent("10:44 PM");
    } finally {
      await screen.unmount();
    }
  });

  it("applies a click at once and stays open, keeping the hour across AM and PM", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <TimePickerHarness initial={{ hour: 9, minute: 5 }} hour12 onChange={onChange} />,
    );

    try {
      await page.getByRole("button", { name: "Run time" }).click();
      await page
        .getByRole("listbox", { name: "AM or PM" })
        .getByRole("option", { name: "PM" })
        .click();

      expect(onChange).toHaveBeenCalledExactlyOnceWith({ hour: 21, minute: 5 });
      await expect.element(chosenOption("AM or PM")).toHaveTextContent("PM");
      await expect.element(chosenOption("Hour")).toHaveTextContent("9");
      await expect
        .element(page.getByRole("button", { name: "Run time" }))
        .toHaveTextContent("9:05 PM");
    } finally {
      await screen.unmount();
    }
  });

  it("has no AM/PM column in 24-hour mode, wraps, and keeps the value on Escape", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <TimePickerHarness
        initial={{ hour: 21, minute: 45 }}
        hour12={false}
        minuteStep={15}
        onChange={onChange}
      />,
    );

    try {
      const trigger = page.getByRole("button", { name: "Run time" });
      await expect.element(trigger).toHaveTextContent("21:45");

      await trigger.click();
      await expect.element(chosenOption("Hour")).toHaveTextContent("21");
      await expect.element(chosenOption("Hour")).toHaveFocus();
      await expect.element(page.getByRole("listbox", { name: "AM or PM" })).not.toBeInTheDocument();
      expect(
        page.getByRole("listbox", { name: "Minute" }).getByRole("option").elements(),
      ).toHaveLength(4);

      // The last minute choice wraps to the first.
      await userEvent.keyboard("{ArrowRight}{ArrowDown}");
      expect(onChange).toHaveBeenLastCalledWith({ hour: 21, minute: 0 });

      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("listbox", { name: "Hour" })).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      await expect.element(trigger).toHaveTextContent("21:00");
    } finally {
      await screen.unmount();
    }
  });
});
