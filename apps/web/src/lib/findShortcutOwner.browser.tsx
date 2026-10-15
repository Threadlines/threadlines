import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useChatFindStore } from "../chatFindStore";
import { installFindRegionTracking, resolveFindShortcutOwner } from "./findShortcutOwner";

/**
 * The page as the app lays it out for this question: the chat, the browser
 * panel beside it, the terminal under them, and something else entirely (a
 * file open in the side panel).
 */
function mountRegions() {
  document.body.innerHTML = `
    <div data-find-region="chat">
      <p id="chat-text">Some chat text</p>
      <textarea id="composer"></textarea>
    </div>
    <section data-find-region="browser"><input id="address" /></section>
    <div class="thread-terminal-drawer"><div class="xterm"><textarea id="terminal" class="xterm-helper-textarea"></textarea></div></div>
    <div><input id="file-editor" /></div>
  `;
  const byId = (id: string) => document.getElementById(id)!;
  return {
    composer: byId("composer"),
    chatText: byId("chat-text"),
    address: byId("address"),
    terminal: byId("terminal"),
    fileEditor: byId("file-editor"),
  };
}

describe("resolveFindShortcutOwner", () => {
  let uninstall: () => void = () => {};
  beforeEach(() => {
    uninstall = installFindRegionTracking();
    useChatFindStore.setState({ available: true });
  });
  afterEach(() => {
    uninstall();
    useChatFindStore.setState({ available: false, open: false });
    document.body.innerHTML = "";
  });

  it("gives the key to the region holding focus", () => {
    const regions = mountRegions();
    regions.composer.focus();
    expect(resolveFindShortcutOwner()).toBe("chat");
    regions.address.focus();
    expect(resolveFindShortcutOwner()).toBe("browser");
    regions.terminal.focus();
    expect(resolveFindShortcutOwner()).toBeNull();
    regions.fileEditor.focus();
    expect(resolveFindShortcutOwner()).toBeNull();
  });

  it("goes by the region last pointed at when nothing has focus", () => {
    const regions = mountRegions();
    regions.address.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(resolveFindShortcutOwner()).toBe("browser");
    regions.chatText.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(resolveFindShortcutOwner()).toBe("chat");
  });

  it("leaves the key to the page's find where the chat's cannot open", () => {
    const regions = mountRegions();
    useChatFindStore.setState({ available: false });
    regions.composer.focus();
    expect(resolveFindShortcutOwner()).toBe("browser");
  });
});
