import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getOfferedCommands,
  publishCommandHandlers,
  resetCommandHandlersForTests,
  subscribeOfferedCommands,
  withdrawCommandHandlers,
  type CommandHandlerMap,
  type CommandListItem,
} from "./commandHandlers";
import { suggestCommands } from "./commandUsageStore";
import { runCommand } from "./runCommand";

function run(id: Parameters<typeof runCommand>[0]["id"], itemId?: string) {
  const close = vi.fn();
  const recordUse = vi.fn();
  const onError = vi.fn();
  const outcome = runCommand({ id, itemId, close, recordUse, onError, nextFrame: (cb) => cb() });
  return { outcome, close, recordUse, onError };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("command handlers", () => {
  afterEach(resetCommandHandlersForTests);

  it("offers a command while a handler is registered, and not after", () => {
    publishCommandHandlers("composer", { "composer.stash": { run: () => undefined } });
    expect(getOfferedCommands().has("composer.stash")).toBe(true);

    withdrawCommandHandlers("composer");
    expect(getOfferedCommands().has("composer.stash")).toBe(false);
  });

  it("withdraws a command when its guard says no", () => {
    const handlers = (attachmentsDisabled: boolean): CommandHandlerMap => ({
      "composer.stash": attachmentsDisabled ? null : { run: () => undefined },
    });
    publishCommandHandlers("composer", handlers(false));
    publishCommandHandlers("composer", handlers(true));

    expect(getOfferedCommands().has("composer.stash")).toBe(false);
    expect(run("composer.stash").outcome).toBe("unavailable");
  });

  it("tells an open palette about a command registered after it opened", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfferedCommands(listener);
    publishCommandHandlers("route", {});
    expect(listener).not.toHaveBeenCalled();

    publishCommandHandlers("route", {
      "thread.pullRequest": { run: () => undefined, title: "Open pull request #12" },
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(getOfferedCommands().get("thread.pullRequest")?.title).toBe("Open pull request #12");
    unsubscribe();
  });

  it("tells no one when what the palette shows didn't change", () => {
    publishCommandHandlers("chat", { "terminal.new": { run: () => undefined } });
    publishCommandHandlers("terminals-page", { "terminal.new": { run: () => undefined } });
    const listener = vi.fn();
    const unsubscribe = subscribeOfferedCommands(listener);

    // A handler shadowed by a newer owner changes, and an owner of nothing leaves.
    publishCommandHandlers("chat", { "terminal.new": { run: () => undefined, title: "Older" } });
    publishCommandHandlers("empty", {});
    withdrawCommandHandlers("empty");

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("publishes nothing when an owner re-renders with the same description", () => {
    const items: CommandListItem[] = [{ id: "dev", title: "dev", run: () => undefined }];
    publishCommandHandlers("chat", {
      "terminal.toggle": { run: () => undefined },
      "project.runScript": { items },
    });
    const before = getOfferedCommands();

    // A streamed token: new functions, a new (equal) items array, same words.
    publishCommandHandlers("chat", {
      "terminal.toggle": { run: () => undefined },
      "project.runScript": { items: [{ id: "dev", title: "dev", run: () => undefined }] },
    });

    expect(getOfferedCommands()).toBe(before);
  });

  it("shows a renamed list item by its new name, and runs the newest function", async () => {
    const first = vi.fn();
    const second = vi.fn();
    publishCommandHandlers("chat", {
      "project.runScript": { items: [{ id: "dev", title: "dev", run: first }] },
    });
    const listener = vi.fn();
    const unsubscribe = subscribeOfferedCommands(listener);
    publishCommandHandlers("chat", {
      "project.runScript": { items: [{ id: "dev", title: "Dev server", run: second }] },
    });

    // An open list page reads this snapshot, so it redraws with the new name.
    expect(getOfferedCommands().get("project.runScript")?.items?.[0]?.title).toBe("Dev server");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(run("project.runScript", "dev").outcome).toBe("ran");
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("does nothing for a row that has gone", () => {
    publishCommandHandlers("chat", {
      "project.runScript": { items: [{ id: "dev", title: "dev", run: () => undefined }] },
    });
    publishCommandHandlers("chat", { "project.runScript": { items: [] } });

    const gone = run("project.runScript", "dev");
    expect(gone.outcome).toBe("unavailable");
    expect(gone.close).not.toHaveBeenCalled();
  });

  it("counts a run as use unless it was cancelled", async () => {
    publishCommandHandlers("menu", {
      "thread.archive": { run: async () => "cancelled" as const },
      "thread.pin": { run: async () => undefined },
    });

    const cancelled = run("thread.archive");
    const pinned = run("thread.pin");
    await flush();

    expect(cancelled.recordUse).not.toHaveBeenCalled();
    expect(pinned.recordUse).toHaveBeenCalledWith("thread.pin");
  });

  it("counts an item of a list for the list too", async () => {
    publishCommandHandlers("chat", {
      "project.runScript": { items: [{ id: "dev", title: "dev", run: () => undefined }] },
    });

    const ran = run("project.runScript", "dev");
    await flush();

    expect(ran.recordUse.mock.calls).toEqual([["project.runScript"], ["project.runScript:dev"]]);
  });

  it("closes before running, hands focus over for a dialog, and keeps open when asked", () => {
    const order: string[] = [];
    publishCommandHandlers("palette", {
      "project.add": { run: () => void order.push("run"), opensDialog: true },
      "theme.change": { items: [], keepOpen: true },
    });

    const close = vi.fn(() => void order.push("close"));
    runCommand({
      id: "project.add",
      close,
      recordUse: () => undefined,
      onError: () => undefined,
    });
    expect(order).toEqual(["close", "run"]);
    expect(close).toHaveBeenCalledWith({ handingOver: true });
    expect(run("theme.change").outcome).toBe("list");
  });

  it("lets the newest owner of a command answer for it", () => {
    const thread = vi.fn();
    const terminals = vi.fn();
    publishCommandHandlers("chat", { "terminal.new": { run: thread } });
    publishCommandHandlers("terminals-page", { "terminal.new": { run: terminals } });

    run("terminal.new");
    expect(terminals).toHaveBeenCalledOnce();
    expect(thread).not.toHaveBeenCalled();
  });
});

describe("suggested commands", () => {
  it("puts the most used offered commands first, then fills from the fallback", () => {
    const suggested = suggestCommands({
      candidates: ["chat.new", "terminal.toggle", "diff.toggle", "project.add", "chat.find"],
      usage: {
        "chat.find": { count: 5, lastUsedAt: 1 },
        "diff.toggle": { count: 5, lastUsedAt: 2 },
        "navigate.usage": { count: 9, lastUsedAt: 3 },
      },
      fallback: ["chat.new", "terminal.toggle", "diff.toggle", "project.add"],
      limit: 4,
    });
    // navigate.usage is not offered here, so it is never suggested.
    expect(suggested).toEqual(["diff.toggle", "chat.find", "chat.new", "terminal.toggle"]);
  });
});
