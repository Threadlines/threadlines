import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  className = "";
  disabled = false;
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  focus() {
    (document as unknown as FakeDocument).activeElement = this;
  }

  get isConnected() {
    return this.parent !== null;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("takes focus for the keyboard, walks it with the arrows, and gives it back", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const opener = new FakeElement("button");
    fakeDocument.body.appendChild(opener);
    opener.focus();
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "pin", label: "Pin", disabled: true },
      { id: "move", label: "Move to another computer" },
    ]);

    // The menu holds focus, with no item picked, until an arrow picks one.
    const menu = findButton("Rename")?.parent;
    expect(fakeDocument.activeElement).toBe(menu);
    const press = (key: string) => fakeDocument.dispatchEvent(new FakeDomEvent("keydown", { key }));
    press("ArrowDown");
    expect(fakeDocument.activeElement).toBe(findButton("Rename"));
    // Past the item that takes no press, and round from the last to the first.
    press("ArrowDown");
    expect(fakeDocument.activeElement).toBe(findButton("Move to another computer"));
    press("ArrowDown");
    expect(fakeDocument.activeElement).toBe(findButton("Rename"));

    press("Escape");
    await expect(selectionPromise).resolves.toBeNull();
    expect(fakeDocument.activeElement).toBe(opener);
  });

  it("opens and leaves a submenu from the keyboard", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      { id: "copy", label: "Copy path" },
      {
        id: "open:submenu",
        label: "Open in",
        children: [
          { id: "open:cursor", label: "Cursor" },
          { id: "open:zed", label: "Zed" },
        ],
      },
    ]);
    const press = (key: string) => fakeDocument.dispatchEvent(new FakeDomEvent("keydown", { key }));
    const parent = findButton("Open in")!;

    // The right arrow on its item opens it, with its first item focused.
    parent.focus();
    press("ArrowRight");
    expect(fakeDocument.activeElement).toBe(findButton("Cursor"));
    // The left arrow closes it and goes back to the item that opened it.
    press("ArrowLeft");
    expect(findButton("Cursor")).toBeUndefined();
    expect(fakeDocument.activeElement).toBe(parent);

    // Enter or Space on the item (a click with no press) opens it too; Escape
    // there closes only the submenu.
    parent.dispatchEvent(new FakeDomEvent("click", { detail: 0 }));
    expect(fakeDocument.activeElement).toBe(findButton("Cursor"));
    press("Escape");
    expect(findButton("Cursor")).toBeUndefined();
    expect(fakeDocument.activeElement).toBe(parent);

    // Down in the submenu, and Enter picks.
    press("ArrowRight");
    press("ArrowDown");
    expect(fakeDocument.activeElement).toBe(findButton("Zed"));
    findButton("Zed")!.dispatchEvent(new FakeDomEvent("click", { detail: 0 }));
    await expect(selectionPromise).resolves.toBe("open:zed");
  });
});
