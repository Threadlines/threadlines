import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { TimeZonePicker } from "./time-zone-picker";

function Harness(props: { readonly onChange: (timeZone: string) => void }) {
  const [value, setValue] = useState("America/New_York");
  return (
    <TimeZonePicker
      value={value}
      onChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
      suggestions={[
        { timeZone: "America/New_York", note: "This computer" },
        { timeZone: "Europe/Madrid", note: "You" },
        { timeZone: "UTC" },
      ]}
      aria-label="Time zone"
    />
  );
}

describe("TimeZonePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leads with a short list, and finds any zone by typing, from the keyboard", async () => {
    const onChange = vi.fn();
    const screen = await render(<Harness onChange={onChange} />);
    try {
      const trigger = page.getByRole("combobox", { name: "Time zone" });
      await expect.poll(() => trigger.element().textContent).toMatch(/New York \(UTC−[45]\)/u);
      await trigger.click();

      // The short list: this computer's zone, the viewer's, and UTC, marked.
      const options = page.getByRole("option");
      await expect.poll(() => options.elements().length).toBe(3);
      await expect
        .poll(() => options.nth(0).element().textContent)
        .toMatch(/New York · Eastern Time/u);
      await expect.element(options.nth(0)).toMatchTextContent("This computer");
      await expect.element(options.nth(0)).toMatchTextContent("America/New_York");
      await expect.element(options.nth(1)).toMatchTextContent("You");
      await expect.element(options.nth(2)).toMatchTextContent("UTC");

      // Typing searches every zone, by city; Enter picks the first match.
      await expect.element(page.getByRole("combobox", { name: "Search time zones" })).toHaveFocus();
      await userEvent.keyboard("tokyo");
      await expect.poll(() => options.elements().length).toBe(1);
      await expect.element(options.nth(0)).toMatchTextContent("Asia/Tokyo");
      await userEvent.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("Asia/Tokyo");
      await expect.element(trigger).toMatchTextContent("Tokyo (UTC+9)");

      // By offset too, with a plain hyphen; Escape closes without a change.
      // Typing waits for the search box: the popup focuses it as it opens.
      await trigger.click();
      await expect.element(page.getByRole("combobox", { name: "Search time zones" })).toHaveFocus();
      await userEvent.keyboard("utc+5:30");
      await expect.element(page.getByRole("option", { name: /Kolkata/u })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("option")).not.toBeInTheDocument();
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
