import "../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import { ThreadId, type TerminalEvent, type TerminalSessionSnapshot } from "@threadlines/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  terminalWriteSpy,
  terminalClearSelectionSpy,
  terminalFocusSpy,
  terminalScrollToBottomSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
  onTerminalWriteRef,
  terminalOnDataRef,
  pendingTerminalWriteCallbacks,
  deferTerminalWriteCallbacksRef,
  terminalSelectionStateRef,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
  terminalWriteSpy: vi.fn(),
  terminalClearSelectionSpy: vi.fn(),
  terminalFocusSpy: vi.fn(),
  terminalScrollToBottomSpy: vi.fn(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  environmentApiById: new Map<string, { terminal: { open: ReturnType<typeof vi.fn> } }>(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
  readLocalApiMock: vi.fn<
    () =>
      | {
          contextMenu: { show: ReturnType<typeof vi.fn> };
          shell: { openExternal: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
  })),
  onTerminalWriteRef: {
    current: null as ((data: string) => void) | null,
  },
  terminalOnDataRef: {
    current: null as ((data: string) => void) | null,
  },
  pendingTerminalWriteCallbacks: [] as Array<() => void>,
  deferTerminalWriteCallbacksRef: {
    current: false,
  },
  terminalSelectionStateRef: {
    current: null as {
      text: string;
      position: { start: { y: number } };
    } | null,
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = fitAddonFitSpy;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => null),
      },
    };

    constructor(options: unknown) {
      terminalConstructorSpy(options);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
    }

    open() {}

    write(data: string, callback?: () => void) {
      terminalWriteSpy(data);
      onTerminalWriteRef.current?.(data);
      if (!callback) return;
      if (deferTerminalWriteCallbacksRef.current) {
        pendingTerminalWriteCallbacks.push(callback);
        return;
      }
      callback();
    }

    clear() {}

    clearSelection() {
      terminalClearSelectionSpy();
      terminalSelectionStateRef.current = null;
    }

    focus() {
      terminalFocusSpy();
    }

    refresh() {}

    scrollToBottom() {
      terminalScrollToBottomSpy();
    }

    hasSelection() {
      return terminalSelectionStateRef.current !== null;
    }

    getSelection() {
      return terminalSelectionStateRef.current?.text ?? "";
    }

    getSelectionPosition() {
      return terminalSelectionStateRef.current?.position ?? null;
    }

    attachCustomKeyEventHandler() {
      return true;
    }

    registerLinkProvider() {
      return { dispose: vi.fn() };
    }

    onData(listener: (data: string) => void) {
      terminalOnDataRef.current = listener;
      return { dispose: vi.fn() };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import { TerminalViewport } from "./ThreadTerminalDrawer";
import { selectTerminalSubmittedCommand, useTerminalStateStore } from "../terminalStateStore";

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createEnvironmentApi(snapshot?: Partial<TerminalSessionSnapshot>) {
  return {
    terminal: {
      open: vi.fn(async () => ({
        threadId: THREAD_ID,
        terminalId: "default",
        cwd: "/repo/project",
        worktreePath: null,
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-04-07T00:00:00.000Z",
        ...snapshot,
      })),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  };
}

function terminalOutputEvent(data: string, createdAt: string): TerminalEvent {
  return {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt,
    type: "output",
    data,
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
  onAddTerminalContext?: Parameters<typeof TerminalViewport>[0]["onAddTerminalContext"];
}) {
  const drawer = document.createElement("div");
  drawer.className = "thread-terminal-drawer";
  if (props.drawerBackgroundColor) {
    drawer.style.backgroundColor = props.drawerBackgroundColor;
  }
  if (props.drawerTextColor) {
    drawer.style.color = props.drawerTextColor;
  }

  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "400px";
  drawer.append(host);
  document.body.append(drawer);

  const screen = await render(
    <TerminalViewport
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/repo/project"
      onSessionExited={() => undefined}
      onAddTerminalContext={props.onAddTerminalContext ?? (() => undefined)}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    rerender: async (nextProps: { threadRef: ReturnType<typeof scopeThreadRef> }) => {
      await screen.rerender(
        <TerminalViewport
          threadRef={nextProps.threadRef}
          threadId={THREAD_ID}
          terminalId="default"
          terminalLabel="Terminal"
          cwd="/repo/project"
          onSessionExited={() => undefined}
          onAddTerminalContext={props.onAddTerminalContext ?? (() => undefined)}
          focusRequestId={0}
          autoFocus={false}
          resizeEpoch={0}
          drawerHeight={320}
          keybindings={[]}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

describe("TerminalViewport", () => {
  afterEach(() => {
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    terminalWriteSpy.mockClear();
    terminalClearSelectionSpy.mockClear();
    terminalFocusSpy.mockClear();
    terminalScrollToBottomSpy.mockClear();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
    onTerminalWriteRef.current = null;
    terminalOnDataRef.current = null;
    pendingTerminalWriteCallbacks.length = 0;
    deferTerminalWriteCallbacksRef.current = false;
    terminalSelectionStateRef.current = null;
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalEventEntriesByKey: {},
      terminalSubmittedCommandByKey: {},
      terminalActivityCommandByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("does not create a terminal when APIs are unavailable", async () => {
    readEnvironmentApiMock.mockReturnValueOnce(undefined);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).not.toHaveBeenCalled();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reopens the terminal when the scoped thread reference changes", async () => {
    const environmentA = createEnvironmentApi();
    const environmentB = createEnvironmentApi();
    environmentApiById.set("environment-a", environmentA);
    environmentApiById.set("environment-b", environmentB);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environmentA.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environmentB.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reopen the terminal when the scoped thread reference values stay the same", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the drawer surface colors for the terminal theme", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      drawerBackgroundColor: "rgb(24, 28, 36)",
      drawerTextColor: "rgb(228, 232, 240)",
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      expect(terminalConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({
            background: "rgb(24, 28, 36)",
            foreground: "rgb(228, 232, 240)",
          }),
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("records submitted commands from terminal input", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(terminalOnDataRef.current).not.toBeNull();
      });

      terminalOnDataRef.current?.("vp run dev:desktop\r");

      await vi.waitFor(() => {
        expect(environment.terminal.write).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          terminalId: "default",
          data: "vp run dev:desktop\r",
        });
      });
      expect(
        selectTerminalSubmittedCommand(
          useTerminalStateStore.getState().terminalSubmittedCommandByKey,
          threadRef,
          "default",
        ),
      ).toBe("vp run dev:desktop");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders terminal selection actions and attaches selected output to chat", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    const onAddTerminalContext = vi.fn();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({ threadRef, onAddTerminalContext });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      terminalSelectionStateRef.current = {
        text: "vp lint\nFound 0 warnings",
        position: { start: { y: 6 } },
      };

      const terminalMount = document.querySelector<HTMLElement>(
        "[data-terminal-viewport-mount='true']",
      );
      expect(terminalMount).not.toBeNull();
      terminalMount?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          button: 0,
          bubbles: true,
          clientX: 260,
          clientY: 180,
          detail: 1,
        }),
      );

      await expect
        .element(page.getByRole("button", { name: "Copy selected terminal text" }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Add to chat" }).click();

      await vi.waitFor(() => {
        expect(onAddTerminalContext).toHaveBeenCalledWith({
          terminalId: "default",
          terminalLabel: "Terminal",
          lineStart: 7,
          lineEnd: 8,
          text: "vp lint\nFound 0 warnings",
        });
      });
      expect(terminalClearSelectionSpy).toHaveBeenCalledTimes(1);
      expect(terminalFocusSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("drains terminal output received while hydration is replaying buffered events", async () => {
    const environment = createEnvironmentApi({
      updatedAt: "2026-04-07T00:00:00.500Z",
    });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    useTerminalStateStore
      .getState()
      .recordTerminalEvent(threadRef, terminalOutputEvent("first", "2026-04-07T00:00:01.000Z"));

    let injectedDuringReplay = false;
    onTerminalWriteRef.current = (data) => {
      if (data !== "first" || injectedDuringReplay) return;
      injectedDuringReplay = true;
      useTerminalStateStore
        .getState()
        .recordTerminalEvent(threadRef, terminalOutputEvent("second", "2026-04-07T00:00:02.000Z"));
    };

    const mounted = await mountTerminalViewport({
      threadRef,
    });

    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("second");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("ignores terminal write callbacks after unmount", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    deferTerminalWriteCallbacksRef.current = true;

    const mounted = await mountTerminalViewport({
      threadRef,
    });
    let cleanedUp = false;

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      terminalScrollToBottomSpy.mockClear();
      useTerminalStateStore
        .getState()
        .recordTerminalEvent(
          threadRef,
          terminalOutputEvent("late output", "2026-04-07T00:00:01.000Z"),
        );

      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("late output");
      });

      const deferredCallbacks = pendingTerminalWriteCallbacks.splice(0);
      await mounted.cleanup();
      cleanedUp = true;
      for (const callback of deferredCallbacks) {
        callback();
      }

      expect(terminalScrollToBottomSpy).not.toHaveBeenCalled();
    } finally {
      if (!cleanedUp) {
        await mounted.cleanup();
      }
    }
  });
});
