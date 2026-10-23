import "../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  ProjectId,
  ThreadId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalStreamEvent,
  type TerminalSubscribeInput,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

interface TestTerminalLink {
  text: string;
  activate: (event: MouseEvent) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
}

/** The handler the viewport gives xterm for links a program marks up (OSC 8). */
interface TestTerminalLinkHandler {
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
}

interface TestTerminalLinkProvider {
  provideLinks: (
    bufferLineNumber: number,
    callback: (links?: ReadonlyArray<TestTerminalLink>) => void,
  ) => void;
}

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
  linkProviderRef,
  terminalOptionsRef,
  terminalBufferLinesRef,
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
          persistence?: { setClientSettings: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
    persistence: { setClientSettings: vi.fn(async () => undefined) },
  })),
  linkProviderRef: {
    current: null as TestTerminalLinkProvider | null,
  },
  terminalOptionsRef: {
    current: null as { linkHandler?: TestTerminalLinkHandler } | null,
  },
  terminalBufferLinesRef: {
    current: [] as string[],
  },
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
    options: { theme?: unknown; linkHandler?: TestTerminalLinkHandler } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: (index: number) => {
          const text = terminalBufferLinesRef.current[index];
          if (text === undefined) return null;
          return { isWrapped: false, translateToString: () => text };
        },
      },
    };

    constructor(options: unknown) {
      terminalConstructorSpy(options);
      terminalOptionsRef.current = this.options;
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

    registerLinkProvider(provider: NonNullable<typeof linkProviderRef.current>) {
      linkProviderRef.current = provider;
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
  ensureEnvironmentApi: (environmentId: string) => {
    const api = readEnvironmentApiMock(environmentId);
    if (!api) {
      throw new Error(`ensureEnvironmentApi: no environment api for ${environmentId}`);
    }
    return api;
  },
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    const api = readLocalApiMock();
    if (!api) {
      throw new Error("ensureLocalApi not implemented in browser test");
    }
    return api;
  }),
  readLocalApi: readLocalApiMock,
}));

// The link-into-browser-panel route only exists inside the desktop app.
vi.mock("../env", () => ({ isElectron: true }));

import { TerminalViewport } from "./ThreadTerminalDrawer";
import { updateSettings } from "../hooks/useSettings";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  connectTerminalStreams,
  resetTerminalStreamsForTests,
  useTerminalThreadStream,
} from "../terminalStreams";
import {
  selectActiveTab,
  selectThreadBrowserState,
  useBrowserPanelStore,
} from "../browserPanelStore";
import { useStore, type EnvironmentState } from "../store";

const THREAD_ID = ThreadId.make("thread-terminal-browser");
const PROJECT_ID = ProjectId.make("project-terminal-browser");

function seedWorkspaceThread(environmentId: string): void {
  const environmentState = {
    projectIds: [PROJECT_ID],
    projectById: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        environmentId,
        kind: "workspace",
        name: "Project",
        cwd: "/repo/project",
      },
    },
    threadShellById: {
      [THREAD_ID]: { id: THREAD_ID, environmentId, projectId: PROJECT_ID },
    },
  } as unknown as EnvironmentState;
  useStore.setState({
    activeEnvironmentId: environmentId as never,
    environmentStateById: { [environmentId]: environmentState },
  });
}

function provideTerminalLinks(line: string): ReadonlyArray<TestTerminalLink> {
  terminalBufferLinesRef.current = [line];
  let provided: ReadonlyArray<TestTerminalLink> | undefined;
  linkProviderRef.current?.provideLinks(1, (links) => {
    provided = links;
  });
  return provided ?? [];
}

function linkActivationEvent(): MouseEvent {
  return new MouseEvent(
    "click",
    /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true },
  );
}

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

/**
 * A stand-in server behind the real stream module: it answers each
 * subscription the way a server with tab lists does, and lets a test push
 * events down a thread's stream.
 */
function connectFakeTerminalServer(environmentId: string) {
  const listeners = new Map<string, (event: TerminalStreamEvent) => void>();
  const client = {
    terminal: {
      onEvent: (input: TerminalSubscribeInput, listener: (event: TerminalStreamEvent) => void) => {
        const key = input.mode === "thread" ? `thread:${input.threadId}` : "metadata";
        listeners.set(key, listener);
        return () => {
          listeners.delete(key);
        };
      },
    },
  };
  const disconnect = connectTerminalStreams(environmentId as never, client, () => undefined);
  listeners.get("metadata")?.({
    type: "catalog",
    createdAt: "2026-04-07T00:00:00.000Z",
    threads: [],
  });
  const emit = (event: TerminalStreamEvent) => listeners.get(`thread:${THREAD_ID}`)?.(event);
  return {
    emit,
    /** The thread's stream (re)subscribed: open tabs are drawn from the server again. */
    subscribed: (createdAt = "2026-04-07T00:00:00.000Z") =>
      emit({ type: "subscribed", threadId: THREAD_ID, createdAt }),
    disconnect,
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

type ViewportOverrides = Partial<
  Pick<
    Parameters<typeof TerminalViewport>[0],
    "cwd" | "launchCwd" | "onRestart" | "onClose" | "onGone" | "onSessionExited"
  >
> & {
  /** This device just opened the tab (the server doesn't list it yet). */
  pending?: boolean;
};

/** The viewport as the drawer mounts it: holding its thread's stream. */
function ViewportUnderTest(
  props: { threadRef: ReturnType<typeof scopeThreadRef> } & ViewportOverrides & {
      onAddTerminalContext: Parameters<typeof TerminalViewport>[0]["onAddTerminalContext"];
    },
) {
  const stream = useTerminalThreadStream(props.threadRef.environmentId, THREAD_ID);
  return (
    <TerminalViewport
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      terminalId="default"
      terminalLabel="Terminal"
      cwd={props.cwd ?? "/repo/project"}
      launchCwd={props.launchCwd ?? null}
      stream={stream}
      onSessionExited={props.onSessionExited ?? (() => undefined)}
      onGone={props.onGone ?? (() => undefined)}
      onRestart={props.onRestart ?? (() => undefined)}
      onClose={props.onClose ?? (() => undefined)}
      onAddTerminalContext={props.onAddTerminalContext}
      focusRequestId={0}
      autoFocus={false}
      findOpen={false}
      onFindOpen={() => undefined}
      onFindClose={() => undefined}
      showKeyRow={false}
      fontSize={12}
      screenReaderMode={false}
      keybindings={[]}
    />
  );
}

async function mountTerminalViewport(
  props: {
    threadRef: ReturnType<typeof scopeThreadRef>;
    drawerBackgroundColor?: string;
    drawerTextColor?: string;
    onAddTerminalContext?: Parameters<typeof TerminalViewport>[0]["onAddTerminalContext"];
  } & ViewportOverrides,
) {
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

  const server = connectFakeTerminalServer(props.threadRef.environmentId);
  if (props.pending) useTerminalStateStore.getState().newTerminal(props.threadRef, "default");
  const {
    drawerBackgroundColor: _bg,
    drawerTextColor: _fg,
    pending: _pending,
    ...viewportProps
  } = props;
  const onAddTerminalContext = props.onAddTerminalContext ?? (() => undefined);
  const screen = await render(
    <ViewportUnderTest {...viewportProps} onAddTerminalContext={onAddTerminalContext} />,
    { container: host },
  );
  server.subscribed();

  return {
    server,
    host,
    rerender: async (
      nextProps: { threadRef: ReturnType<typeof scopeThreadRef> } & ViewportOverrides,
    ) => {
      await screen.rerender(
        <ViewportUnderTest
          {...viewportProps}
          {...nextProps}
          onAddTerminalContext={onAddTerminalContext}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      server.disconnect();
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
    linkProviderRef.current = null;
    terminalOptionsRef.current = null;
    terminalBufferLinesRef.current = [];
    updateSettings({ openLinksIn: "browser-panel" });
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {},
      browserOwnershipByThreadKey: {},
      visitedUrls: [],
    });
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalTabsByThreadKey: {},
      pendingTerminalIdsByThreadKey: {},
      terminalActivityCommandByKey: {},
      terminalActivityStartedAtByKey: {},
      terminalCommandPendingByKey: {},
    });
    resetTerminalStreamsForTests();
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

      const serverB = connectFakeTerminalServer("environment-b");
      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });
      serverB.subscribed();

      await vi.waitFor(() => {
        expect(environmentB.terminal.open).toHaveBeenCalledTimes(1);
      });
      serverB.disconnect();
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

  it("sends what is typed to the server", async () => {
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
          lineStart: 1,
          lineEnd: 2,
          text: "vp lint\nFound 0 warnings",
        });
      });
      expect(terminalClearSelectionSpy).toHaveBeenCalledTimes(1);
      expect(terminalFocusSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens an activated terminal url in the thread's browser panel", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    seedWorkspaceThread("environment-a");
    const localApi = {
      contextMenu: { show: vi.fn(async () => null) },
      shell: { openExternal: vi.fn(async () => undefined) },
    };
    readLocalApiMock.mockReturnValueOnce(localApi);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(linkProviderRef.current).not.toBeNull();
      });

      const links = provideTerminalLinks("  Local   http://localhost:4321/");
      expect(links).toHaveLength(1);
      links[0]?.activate(linkActivationEvent());

      const panel = selectThreadBrowserState(
        useBrowserPanelStore.getState().browserStateByThreadKey,
        threadRef,
      );
      expect(panel.open).toBe(true);
      expect(selectActiveTab(panel)?.url).toBe("http://localhost:4321/");
      expect(localApi.shell.openExternal).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the external browser when the thread has no browser panel", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const localApi = {
      contextMenu: { show: vi.fn(async () => null) },
      shell: { openExternal: vi.fn(async () => undefined) },
    };
    readLocalApiMock.mockReturnValueOnce(localApi);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(linkProviderRef.current).not.toBeNull();
      });

      const links = provideTerminalLinks("Docs at https://example.com/docs");
      links[0]?.activate(linkActivationEvent());

      expect(localApi.shell.openExternal).toHaveBeenCalledWith("https://example.com/docs");
      expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers the external browser from a link's right-click menu", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    seedWorkspaceThread("environment-a");
    const localApi = {
      contextMenu: { show: vi.fn(async () => "open-external") },
      shell: { openExternal: vi.fn(async () => undefined) },
    };
    readLocalApiMock.mockReturnValueOnce(localApi);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(linkProviderRef.current).not.toBeNull();
      });

      const links = provideTerminalLinks("Docs at https://example.com/docs");
      links[0]?.hover?.(new MouseEvent("mousemove"), "https://example.com/docs");

      const terminalMount = document.querySelector<HTMLElement>(
        "[data-terminal-viewport-mount='true']",
      );
      expect(terminalMount).not.toBeNull();
      terminalMount?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 60,
        }),
      );

      await vi.waitFor(() => {
        expect(localApi.contextMenu.show).toHaveBeenCalledWith(
          [
            { id: "open-external", label: "Open in external browser" },
            { id: "copy-link", label: "Copy link address" },
          ],
          { x: 120, y: 60 },
        );
        expect(localApi.shell.openExternal).toHaveBeenCalledWith("https://example.com/docs");
      });
      // The activated route stayed untouched: nothing landed in the panel.
      expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends links outside when that is the choice, with the panel one right-click away", async () => {
    updateSettings({ openLinksIn: "external" });
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    seedWorkspaceThread("environment-a");
    const localApi = {
      contextMenu: { show: vi.fn(async () => "open-browser-panel") },
      shell: { openExternal: vi.fn(async () => undefined) },
    };
    readLocalApiMock.mockReturnValueOnce(localApi);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(linkProviderRef.current).not.toBeNull();
      });

      const links = provideTerminalLinks("  Local   http://localhost:4321/");
      links[0]?.activate(linkActivationEvent());
      expect(localApi.shell.openExternal).toHaveBeenCalledWith("http://localhost:4321/");
      expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});

      links[0]?.hover?.(new MouseEvent("mousemove"), "http://localhost:4321/");
      document.querySelector<HTMLElement>("[data-terminal-viewport-mount='true']")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 8,
          clientY: 8,
        }),
      );

      await vi.waitFor(() => {
        expect(localApi.contextMenu.show).toHaveBeenCalledWith(
          [
            { id: "open-browser-panel", label: "Open in browser panel" },
            { id: "open-external", label: "Open in external browser" },
            { id: "copy-link", label: "Copy link address" },
          ],
          { x: 8, y: 8 },
        );
        const panel = selectThreadBrowserState(
          useBrowserPanelStore.getState().browserStateByThreadKey,
          threadRef,
        );
        expect(selectActiveTab(panel)?.url).toBe("http://localhost:4321/");
      });
      expect(localApi.shell.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a link a program marked up (OSC 8) like any other terminal link", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    seedWorkspaceThread("environment-a");
    const localApi = {
      contextMenu: { show: vi.fn(async () => null) },
      shell: { openExternal: vi.fn(async () => undefined) },
    };
    readLocalApiMock.mockReturnValueOnce(localApi);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
        expect(terminalOptionsRef.current?.linkHandler).toBeDefined();
      });
      const linkHandler = terminalOptionsRef.current?.linkHandler;

      // A plain click is for selecting text, as with any terminal link.
      linkHandler?.activate(new MouseEvent("click"), "http://localhost:4321/docs");
      expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});

      linkHandler?.activate(linkActivationEvent(), "http://localhost:4321/docs");
      const panel = selectThreadBrowserState(
        useBrowserPanelStore.getState().browserStateByThreadKey,
        threadRef,
      );
      expect(selectActiveTab(panel)?.url).toBe("http://localhost:4321/docs");
      expect(localApi.shell.openExternal).not.toHaveBeenCalled();
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
    // Output that comes while `open` is on its way is drawn after the snapshot.
    let release: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = environment.terminal.open.getMockImplementation();
    environment.terminal.open.mockImplementation(async () => {
      await opened;
      return respond!();
    });

    let injectedDuringReplay = false;
    let server: ReturnType<typeof connectFakeTerminalServer> | null = null;
    onTerminalWriteRef.current = (data) => {
      if (data !== "first" || injectedDuringReplay) return;
      injectedDuringReplay = true;
      server?.emit(terminalOutputEvent("second", "2026-04-07T00:00:02.000Z"));
    };

    const mounted = await mountTerminalViewport({
      threadRef,
    });
    server = mounted.server;
    mounted.server.emit(terminalOutputEvent("first", "2026-04-07T00:00:01.000Z"));
    release();

    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("second");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("never draws output its snapshot already holds when it arrives after the snapshot", async () => {
    // The server published this output before it answered `open`, but this
    // client got the snapshot (which holds it) first.
    const environment = createEnvironmentApi({
      history: "On branch master\r\n",
      updatedAt: "2026-04-07T00:00:01.000Z",
    });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("\u001bcOn branch master\r\n");
      });
      terminalWriteSpy.mockClear();
      mounted.server.emit(
        terminalOutputEvent("On branch master\r\n\u001b[6n", "2026-04-07T00:00:01.000Z"),
      );
      mounted.server.emit(terminalOutputEvent("% ", "2026-04-07T00:00:01.001Z"));

      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("% ");
      });
      // Only the cursor query from the late chunk reaches the terminal, which must answer it.
      expect(terminalWriteSpy.mock.calls.map(([data]) => data)).toEqual(["\u001b[6n", "% "]);
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
      mounted.server.emit(terminalOutputEvent("late output", "2026-04-07T00:00:01.000Z"));

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
  it("draws a tab again from the server when its thread's stream subscribes again", async () => {
    const environment = createEnvironmentApi({ history: "before\r\n" });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      // A reconnect, or a server that restarted: what was printed meanwhile
      // comes back with the snapshot.
      environment.terminal.open.mockImplementation(async () => ({
        threadId: THREAD_ID,
        terminalId: "default",
        cwd: "/repo/project",
        worktreePath: null,
        status: "running" as const,
        pid: 124,
        history: "before\r\nwhile away\r\n",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-04-07T00:00:05.000Z",
      }));
      mounted.server.subscribed("2026-04-07T00:00:05.000Z");

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
        expect(terminalWriteSpy).toHaveBeenCalledWith("\u001bcbefore\r\nwhile away\r\n");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a tab as the server has it, and forgets it once the server no longer has it", async () => {
    const environment = createEnvironmentApi();
    environment.terminal.open.mockImplementation(async () => {
      throw Object.assign(new Error("Unknown terminal"), { _tag: "TerminalSessionLookupError" });
    });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const onGone = vi.fn();
    const mounted = await mountTerminalViewport({ threadRef, onGone });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledWith(
          expect.objectContaining({ attach: true }),
        );
        expect(onGone).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("makes a tab on the server only when this device asked for it", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const mounted = await mountTerminalViewport({ threadRef, pending: true });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(environment.terminal.open).not.toHaveBeenCalledWith(
        expect.objectContaining({ attach: true }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a tab whose shell failed and says how it ended", async () => {
    const environment = createEnvironmentApi({
      status: "exited",
      exitCode: 2,
      history: "make: *** [build] Error 2\r\n",
    });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const onRestart = vi.fn();
    const mounted = await mountTerminalViewport({ threadRef, onRestart });

    try {
      await expect.element(page.getByText("The shell exited with code 2.")).toBeInTheDocument();
      await page.getByRole("button", { name: "Restart", exact: true }).click();
      expect(onRestart).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers to restart a tab in the thread's folder when its shell started elsewhere", async () => {
    const environment = createEnvironmentApi({ cwd: "/repo/project" });
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const onRestart = vi.fn();
    const mounted = await mountTerminalViewport({
      threadRef,
      cwd: "/repo/worktrees/feature",
      onRestart,
    });

    try {
      await expect
        .element(page.getByText("Started in project. The thread is now in feature."))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Restart here" }).click();
      expect(onRestart).toHaveBeenCalledTimes(1);
      // Opening it never asked the server to move it.
      expect(environment.terminal.open).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/repo/worktrees/feature" }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the add-to-chat actions up while output keeps coming", async () => {
    const environment = createEnvironmentApi();
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    environmentApiById.set("environment-a", environment);
    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      terminalSelectionStateRef.current = {
        text: "Error: port 3000 in use",
        position: { start: { y: 2 } },
      };
      document
        .querySelector<HTMLElement>("[data-terminal-viewport-mount='true']")
        ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          button: 0,
          bubbles: true,
          clientX: 200,
          clientY: 120,
          detail: 1,
        }),
      );
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeInTheDocument();

      mounted.server.emit(terminalOutputEvent("GET / 200\r\n", "2026-04-07T00:00:03.000Z"));
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("GET / 200\r\n");
      });
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
