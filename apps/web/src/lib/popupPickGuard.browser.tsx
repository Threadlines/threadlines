import "../index.css";

import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { installPopupPickGuard } from "./popupPickGuard";

/** A menu over a button that fills the page, so anything falling through hits it. */
function MenuOverAButton(props: { onPick: () => void; onUnderneath: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <>
      <button
        className="fixed inset-0"
        data-testid="underneath"
        onClick={props.onUnderneath}
        type="button"
      />
      <Menu>
        <MenuTrigger className="relative z-10" render={<button type="button" />}>
          Open
        </MenuTrigger>
        <MenuPopup backdrop={false}>
          <MenuItem onClick={props.onPick}>Pick</MenuItem>
          <MenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
            Keep open: {checked ? "on" : "off"}
          </MenuCheckboxItem>
        </MenuPopup>
      </Menu>
    </>
  );
}

describe("installPopupPickGuard", () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installPopupPickGuard();
  });
  afterEach(() => {
    uninstall();
  });

  it("keeps the second click of a double-click off what was under the popup", async () => {
    const onPick = vi.fn();
    const onUnderneath = vi.fn();
    await render(<MenuOverAButton onPick={onPick} onUnderneath={onUnderneath} />);

    await page.getByRole("button", { name: "Open" }).click();
    await userEvent.dblClick(page.getByRole("menuitem", { name: "Pick" }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onUnderneath).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
    });

    // Once the double-click is over, the page takes clicks again.
    await new Promise((resolve) => setTimeout(resolve, 550));
    await page.getByTestId("underneath").click();
    expect(onUnderneath).toHaveBeenCalledTimes(1);
  });

  // A closed dropdown stays in the page, unlike a closed menu.
  it("does the same for a dropdown", async () => {
    const onUnderneath = vi.fn();
    const onValueChange = vi.fn();
    await render(
      <>
        <button
          className="fixed inset-0"
          data-testid="underneath"
          onClick={onUnderneath}
          type="button"
        />
        <Select defaultValue="auto" onValueChange={onValueChange}>
          <SelectTrigger aria-label="Access" className="relative z-10">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="full">Full access</SelectItem>
          </SelectPopup>
        </Select>
      </>,
    );

    await page.getByRole("combobox", { name: "Access" }).click();
    await userEvent.dblClick(page.getByRole("option", { name: "Full access" }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onUnderneath).not.toHaveBeenCalled();
  });

  it("leaves repeat clicks alone in a popup that stays open", async () => {
    await render(<MenuOverAButton onPick={vi.fn()} onUnderneath={vi.fn()} />);

    await page.getByRole("button", { name: "Open" }).click();
    const item = page.getByRole("menuitemcheckbox");
    await item.click();
    await expect.element(item).toHaveTextContent("Keep open: on");
    await item.click();
    await expect.element(item).toHaveTextContent("Keep open: off");
  });
});
