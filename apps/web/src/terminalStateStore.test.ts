import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import { ThreadId, type TerminalEvent, type TerminalTab } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  shouldMakeTerminal,
  migratePersistedTerminalStateStoreState,
  noteTerminalLineEntered,
  noteTerminalMadeOnServer,
  selectBusyTerminals,
  selectTerminalActivityCommand,
  selectThreadTerminalState,
  terminalKey,
  terminalLineRecentlyEntered,
  terminalTabNumbers,
  useTerminalStateStore,
} from "./terminalStateStore";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "./types";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/tmp/workspace",
          worktreePath: null,
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalTabsByThreadKey: {},
      pendingTerminalIdsByThreadKey: {},
      terminalActivityCommandByKey: {},
      terminalActivityStartedAtByKey: {},
      terminalCommandPendingByKey: {},
    });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState).toEqual({
      terminalOpen: false,
      terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
    });
  });

  it("marks a tab busy while an entered command is pending, until activity settles it", () => {
    const store = useTerminalStateStore.getState();
    // Entered here: busy before the server has said anything about it. Word
    // that the tab is idle may be about an earlier line.
    noteTerminalLineEntered(THREAD_REF, "default");
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: false, commandPending: false }),
    );
    expect(terminalLineRecentlyEntered(THREAD_REF, "default")).toBe(true);
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: false, commandPending: true }),
    );
    const key = terminalKey(THREAD_REF, "default");
    expect(useTerminalStateStore.getState().terminalCommandPendingByKey[key]).toBe(true);
    expect(terminalLineRecentlyEntered(THREAD_REF, "default")).toBe(false);
    expect(
      migratePersistedTerminalStateStoreState(useTerminalStateStore.getState(), 2),
    ).not.toHaveProperty("terminalCommandPendingByKey");

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: false, commandPending: false }),
    );
    expect(useTerminalStateStore.getState().terminalCommandPendingByKey[key]).toBeUndefined();
  });

  it("stores and clears terminal activity command fallbacks from activity events", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", {
        hasRunningSubprocess: true,
        command: "node scripts/dev-runner.ts dev:desktop",
      }),
    );

    expect(
      selectTerminalActivityCommand(
        useTerminalStateStore.getState().terminalActivityCommandByKey,
        THREAD_REF,
        "default",
      ),
    ).toBe("node scripts/dev-runner.ts dev:desktop");

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: false }),
    );

    expect(
      selectTerminalActivityCommand(
        useTerminalStateStore.getState().terminalActivityCommandByKey,
        THREAD_REF,
        "default",
      ),
    ).toBeNull();
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"] },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { open: true, active: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "setup-setup"]);
    expect(terminalState.activeTerminalId).toBe("setup-setup");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["default", "env-b-terminal"]);
  });

  it("migrates v1 persisted terminal state using the stored version", () => {
    const migrated = migratePersistedTerminalStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
        },
      },
      1,
    );

    expect(migrated).toEqual({
      terminalStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
    });
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.setTerminalActivity(THREAD_REF, "terminal-2", true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_REF, "terminal-2", false);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_REF, "default");

    expect(
      useTerminalStateStore.getState().terminalStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("never switches tabs or opens the drawer for a shell started elsewhere", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, false);
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("started", {
        terminalId: "setup-bootstrap",
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "setup-bootstrap",
          cwd: "/tmp/worktree",
          worktreePath: "/tmp/worktree",
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.activeTerminalId).toBe("default");
  });

  it("applies activity and exited terminal events to subprocess state", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "terminal-2", { open: true, active: true });

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: true,
      }),
    );
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("exited", {
        terminalId: "terminal-2",
        exitCode: 0,
        exitSignal: null,
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.runningTerminalIds).toEqual([]);
  });

  it("is a no-op when clearing terminal state for a thread with no state or buffered events", () => {
    const store = useTerminalStateStore.getState();
    const before = useTerminalStateStore.getState();

    store.clearTerminalState(THREAD_REF);

    expect(useTerminalStateStore.getState()).toBe(before);
  });

  it("takes a thread's tabs from the server, keeping this device's splits and active tab", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1), serverTab("terminal-2", 2)]);
    // Another device opened a tab: it joins the list, and nothing else moves.
    store.applyTerminalTabs(THREAD_REF, [
      serverTab("default", 1),
      serverTab("terminal-2", 2),
      serverTab("terminal-other", 3),
    ]);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2", "terminal-other"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
      { id: "group-terminal-other", terminalIds: ["terminal-other"] },
    ]);
  });

  it("keeps a tab this device just opened until the server lists it", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1)]);
    store.newTerminal(THREAD_REF, "terminal-new");
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1)]);

    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["default", "terminal-new"]);
  });

  it("drops a tab closed on another device and moves to its neighbor", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.applyTerminalTabs(THREAD_REF, [
      serverTab("default", 1),
      serverTab("terminal-2", 2),
      serverTab("terminal-3", 3),
    ]);
    store.setActiveTerminal(THREAD_REF, "terminal-2");
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1), serverTab("terminal-3", 3)]);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3"]);
    expect(terminalState.activeTerminalId).toBe("terminal-3");
  });

  it("empties the tab lists of threads a server's catalog no longer has", () => {
    const store = useTerminalStateStore.getState();
    const newThreadRef = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("thread-2"));
    store.setTerminalOpen(THREAD_REF, true);
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1), serverTab("terminal-2", 2)]);
    store.setTerminalOpen(newThreadRef, true);
    store.applyTerminalCatalog(THREAD_REF.environmentId, []);

    const state = useTerminalStateStore.getState().terminalStateByThreadKey;
    // Its tabs were closed elsewhere: the drawer closes rather than start a
    // shell that undoes that.
    expect(selectThreadTerminalState(state, THREAD_REF)).toMatchObject({
      terminalIds: ["default"],
      terminalOpen: false,
    });
    // A drawer just opened on a thread without tabs gets its first one.
    expect(selectThreadTerminalState(state, newThreadRef)).toMatchObject({
      terminalIds: ["default"],
      terminalOpen: true,
    });
  });

  it("asks for a first tab when its drawer opens on a thread without tabs", () => {
    const store = useTerminalStateStore.getState();
    const listedThreadRef = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("thread-2"));
    store.applyTerminalTabs(listedThreadRef, [serverTab("default", 1)]);
    store.setTerminalOpen(THREAD_REF, true);
    store.setTerminalOpen(listedThreadRef, true);

    expect(shouldMakeTerminal(THREAD_REF, "default")).toBe(true);
    expect(shouldMakeTerminal(listedThreadRef, "default")).toBe(false);

    // A tab the server made for a script is shown, never made again.
    noteTerminalMadeOnServer(THREAD_REF, "terminal-script");
    store.newTerminal(THREAD_REF, "terminal-script");
    expect(shouldMakeTerminal(THREAD_REF, "terminal-script")).toBe(false);
  });

  it("counts a server's terminals that run something or just had a command entered", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1), serverTab("terminal-2", 2)]);
    store.applyTerminalTabs(OTHER_THREAD_REF, [serverTab("default", 1)]);
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: true, command: "npm run dev" }),
    );
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: false,
        commandPending: true,
      }),
    );
    store.applyTerminalEvent(
      OTHER_THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: true, command: "cargo watch" }),
    );

    expect(
      selectBusyTerminals(useTerminalStateStore.getState(), THREAD_REF.environmentId).map(
        (terminal) => [terminal.terminalId, terminal.command],
      ),
    ).toEqual([
      ["default", "npm run dev"],
      ["terminal-2", null],
    ]);
  });

  it("forgets what a tab ran once the server says its shell is gone", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalTabs(THREAD_REF, [serverTab("default", 1)]);
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", { hasRunningSubprocess: true, command: "npm run dev" }),
    );
    // The server restarted: its tabs come back with nothing running.
    store.applyTerminalTabs(THREAD_REF, [{ ...serverTab("default", 1), status: "stopped" }]);

    const state = useTerminalStateStore.getState();
    expect(
      selectThreadTerminalState(state.terminalStateByThreadKey, THREAD_REF).runningTerminalIds,
    ).toEqual([]);
    expect(
      selectTerminalActivityCommand(state.terminalActivityCommandByKey, THREAD_REF, "default"),
    ).toBeNull();
  });

  it("names tabs by the server's numbers, giving tabs it doesn't list yet the lowest free one", () => {
    expect(
      terminalTabNumbers(
        ["default", "terminal-3", "terminal-new"],
        [serverTab("default", 1), serverTab("terminal-3", 3)],
      ),
    ).toEqual(
      new Map([
        ["default", 1],
        ["terminal-3", 3],
        ["terminal-new", 2],
      ]),
    );
  });
});

function serverTab(terminalId: string, number: number): TerminalTab {
  return {
    terminalId,
    number,
    cwd: "/tmp/workspace",
    status: "running",
    exitCode: null,
    exitSignal: null,
    createdAt: "2026-04-02T20:00:00.000Z",
  };
}
