import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_COMMANDS,
  appCommandForKeybinding,
  appCommandTitle,
  type AppCommandId,
} from "./appCommands.ts";

const ids = Object.keys(APP_COMMANDS) as AppCommandId[];

describe("app command catalog", () => {
  it("gives every command its own title, so no two rows read the same", () => {
    const titles = ids.map((id) => APP_COMMANDS[id].title);
    expect(titles.filter((title, index) => titles.indexOf(title) !== index)).toEqual([]);
  });

  it("puts a number placeholder in exactly the numbered families", () => {
    for (const id of ids) {
      const spec: { readonly title: string; readonly numbered?: true } = APP_COMMANDS[id];
      expect(spec.title.includes("{n}"), id).toBe(spec.numbered === true);
    }
  });

  it("labels each numbered shortcut with its own number", () => {
    const labels = [
      ...THREAD_JUMP_KEYBINDING_COMMANDS,
      ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
    ].map((command) => {
      const named = appCommandForKeybinding(command);
      return named ? appCommandTitle(named.id, named.number) : null;
    });
    expect(labels).toContain("Jump to thread 1");
    expect(labels).toContain("Jump to thread 9");
    expect(labels).toContain("Choose model 4");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names a plain shortcut command by its own id, and a script by none", () => {
    expect(appCommandForKeybinding("terminal.toggle")).toEqual({
      id: "terminal.toggle",
      number: null,
    });
    expect(appCommandForKeybinding("script.dev.run")).toBeNull();
  });
});
