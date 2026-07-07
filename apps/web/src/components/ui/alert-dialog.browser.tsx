import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "./button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./alert-dialog";

function AlertDialogHarness(props: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open confirmation</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm action?</AlertDialogTitle>
            <AlertDialogDescription>This verifies keyboard activation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" onClick={props.onCancel} />}>
              Cancel
            </AlertDialogClose>
            <Button
              onClick={() => {
                props.onConfirm();
                setOpen(false);
              }}
            >
              Primary action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

describe("AlertDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the primary footer action so Enter confirms instead of cancelling", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const mounted = await render(<AlertDialogHarness onCancel={onCancel} onConfirm={onConfirm} />);

    try {
      await page.getByRole("button", { name: "Open confirmation" }).click();
      await expect.element(page.getByRole("alertdialog")).toBeVisible();

      const primaryAction = document.querySelector<HTMLButtonElement>(
        '[data-slot="alert-dialog-footer"] button:last-of-type',
      );

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(primaryAction);
      });

      await userEvent.keyboard("{Enter}");

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
