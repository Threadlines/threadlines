import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const onInput = vi.fn((_data: string) => {});

/** A sign-in panel: the field for the page's final address, and the run's terminal once shown. */
function SignInPanel({ showTerminal }: { readonly showTerminal: boolean }) {
  const [bufferRef] = useState(() => ({ current: "" }));
  const [writeRef] = useState<{ current: ((data: string) => void) | null }>(() => ({
    current: null,
  }));
  return (
    <>
      <input aria-label="Address the browser ended on" />
      {showTerminal ? (
        <ProviderConnectTerminal
          bufferRef={bufferRef}
          writeRef={writeRef}
          onInput={onInput}
          onResize={() => {}}
        />
      ) : null}
    </>
  );
}

const terminalInput = () => page.getByRole("textbox", { name: "Terminal input" });
const addressField = () => page.getByRole("textbox", { name: "Address the browser ended on" });

describe("ProviderConnectTerminal", () => {
  afterEach(() => {
    onInput.mockClear();
    document.body.innerHTML = "";
  });

  it("takes the keyboard when it appears, ready for the run's prompt", async () => {
    const screen = await render(<SignInPanel showTerminal />);
    try {
      await expect.element(terminalInput()).toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it("leaves the keyboard with a field the user is typing in when it appears", async () => {
    const screen = await render(<SignInPanel showTerminal={false} />);
    try {
      await addressField().click();
      // The terminal opens on its own (its chunk landing, the stall threshold)
      // while the user is pasting the address.
      await screen.rerender(<SignInPanel showTerminal />);
      await expect.element(terminalInput()).toBeInTheDocument();
      await expect.element(addressField()).toHaveFocus();

      await userEvent.keyboard("http://localhost:1455/auth/callback");
      await expect.element(addressField()).toHaveValue("http://localhost:1455/auth/callback");
      expect(onInput).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
