import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";

import { ProviderConnectTerminal } from "./ProviderConnectTerminal";
import { resetTestPage } from "../../lib/testPage.browser-harness";
import { endThemeTrial, startThemeTrial } from "../../theme/themeStore";

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
  afterEach(async () => {
    onInput.mockClear();
    await resetTestPage();
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

  it("takes a same-base theme switch: new text and terminal colors without a remount", async () => {
    const theme = (hash: string, foreground: string, red: string): ThemeManifest => ({
      format: THEME_FILE_FORMAT,
      base: "dark",
      colors: {
        background: "#0a1029",
        foreground,
        mutedForeground: "#a3aed2",
        accent: "#2fd6b0",
        accentForeground: "#03231c",
      },
      terminal: ["#000000", red, ...Array.from({ length: 14 }, () => "#cccccc")],
      name: `Night ${hash.slice(0, 1)}`,
    });
    const first = startThemeTrial({
      choice: { kind: "unsaved", hash: "a".repeat(64), name: "Night a" },
      manifest: theme("a", "#e7ecff", "#ff5577"),
    });
    const screen = await render(<SignInPanel showTerminal />);
    // xterm writes its colors into a style element of its own.
    const terminalCss = () =>
      [...document.querySelectorAll(".xterm style")].map((style) => style.textContent).join("");
    try {
      await expect.poll(terminalCss).toContain("#ff5577");
      const second = startThemeTrial({
        choice: { kind: "unsaved", hash: "b".repeat(64), name: "Night b" },
        manifest: theme("b", "#ffd6e8", "#ee2233"),
      });
      await expect.poll(terminalCss).toContain("#ee2233");
      expect(terminalCss()).toContain("#ffd6e8");
      endThemeTrial(second.id);
    } finally {
      endThemeTrial(first.id);
      await screen.unmount();
    }
  });
});
