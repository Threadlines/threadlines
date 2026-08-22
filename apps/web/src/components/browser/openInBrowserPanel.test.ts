import { scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ProjectId, ThreadId, type ProjectKind } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  registerPreviewWebview,
  resetPreviewWebviewsForTests,
  selectActiveTab,
  selectThreadBrowserState,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStore, type EnvironmentState } from "../../store";
import type { Project, ThreadShell } from "../../types";
import { isPlainPrimaryClick, openUrlInBrowserPanel } from "./openInBrowserPanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-open-in-browser");
const THREAD_ID = ThreadId.make("thread-open-in-browser");
const PROJECT_ID = ProjectId.make("project-open-in-browser");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);

function seedThread(options: { readonly projectKind: ProjectKind | null }): void {
  const projectById =
    options.projectKind === null
      ? {}
      : {
          [PROJECT_ID]: {
            id: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
            kind: options.projectKind,
            name: "Project",
            cwd: "/repo",
          } satisfies Partial<Project>,
        };
  const environmentState = {
    projectIds: options.projectKind === null ? [] : [PROJECT_ID],
    projectById,
    threadShellById: {
      [THREAD_ID]: { id: THREAD_ID, environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    } as Record<ThreadId, Partial<ThreadShell>>,
  } as unknown as EnvironmentState;

  useStore.setState({
    activeEnvironmentId: ENVIRONMENT_ID,
    environmentStateById: { [ENVIRONMENT_ID]: environmentState },
  });
}

function panelState() {
  return selectThreadBrowserState(
    useBrowserPanelStore.getState().browserStateByThreadKey,
    THREAD_REF,
  );
}

describe("openUrlInBrowserPanel", () => {
  beforeEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {},
      browserOwnershipByThreadKey: {},
      visitedUrls: [],
    });
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
    resetPreviewWebviewsForTests();
  });

  afterEach(() => {
    resetPreviewWebviewsForTests();
    vi.unstubAllGlobals();
  });

  it("opens the panel and loads the page into the blank tab already there", () => {
    seedThread({ projectKind: "workspace" });

    expect(openUrlInBrowserPanel(THREAD_REF, "localhost:5173")).toBe(true);

    const panel = panelState();
    expect(panel.open).toBe(true);
    expect(panel.tabs).toHaveLength(1);
    expect(selectActiveTab(panel)?.url).toBe("http://localhost:5173/");
  });

  it("gives a second link its own tab rather than replacing the page in front of you", () => {
    seedThread({ projectKind: "workspace" });
    openUrlInBrowserPanel(THREAD_REF, "localhost:5173");

    expect(openUrlInBrowserPanel(THREAD_REF, "http://localhost:3000/docs")).toBe(true);

    const panel = panelState();
    expect(panel.tabs).toHaveLength(2);
    expect(panel.tabs[0]?.url).toBe("http://localhost:5173/");
    expect(selectActiveTab(panel)?.url).toBe("http://localhost:3000/docs");
  });

  it("arms an attached guest with the approved host before loading it", () => {
    seedThread({ projectKind: "workspace" });
    useBrowserPanelStore.getState().setBrowserOpen(THREAD_REF, true);
    const tab = selectActiveTab(panelState())!;
    const order: string[] = [];
    const previewSetNavigationPolicy = vi.fn(async () => {
      order.push("policy");
    });
    vi.stubGlobal("window", {
      desktopBridge: {
        previewSetNavigationPolicy,
        setClientSettings: vi.fn(async () => undefined),
      },
    });
    registerPreviewWebview(THREAD_REF, tab.id, {
      getWebContentsId: () => 42,
      loadURL: async () => {
        order.push("load");
      },
      getBoundingClientRect: () => ({}) as DOMRect,
    });

    expect(openUrlInBrowserPanel(THREAD_REF, "https://example.com/docs")).toBe(true);
    expect(previewSetNavigationPolicy).toHaveBeenCalledWith({
      webContentsId: 42,
      approvedDomains: expect.arrayContaining(["example.com"]),
    });
    expect(order).toEqual(["policy", "load"]);
  });

  it("intercepts only an unmodified primary click", () => {
    const click = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(isPlainPrimaryClick(click)).toBe(true);
    expect(isPlainPrimaryClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainPrimaryClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainPrimaryClick({ ...click, shiftKey: true })).toBe(false);
  });

  it("leaves general chat threads alone, because they have no browser", () => {
    seedThread({ projectKind: "general-chat" });

    expect(openUrlInBrowserPanel(THREAD_REF, "localhost:5173")).toBe(false);
    expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
  });

  it("does nothing until the thread's project is known", () => {
    expect(openUrlInBrowserPanel(THREAD_REF, "localhost:5173")).toBe(false);
    expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
  });

  it("waits for project metadata instead of briefly treating general chat as a workspace", () => {
    seedThread({ projectKind: "workspace" });
    useStore.setState((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [ENVIRONMENT_ID]: {
          ...state.environmentStateById[ENVIRONMENT_ID]!,
          projectById: {},
        },
      },
    }));

    expect(openUrlInBrowserPanel(THREAD_REF, "localhost:5173")).toBe(false);
    expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
  });

  it("opens links from a pre-send draft thread in its project browser", () => {
    seedThread({ projectKind: "workspace" });
    useStore.setState((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [ENVIRONMENT_ID]: {
          ...state.environmentStateById[ENVIRONMENT_ID]!,
          threadShellById: {},
        },
      },
    }));
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        draft: {
          threadId: THREAD_ID,
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: "draft-project",
          createdAt: "2026-07-28T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
    });

    expect(openUrlInBrowserPanel(THREAD_REF, "localhost:5173")).toBe(true);
    expect(panelState().open).toBe(true);
  });

  it("refuses an address the browser cannot load", () => {
    seedThread({ projectKind: "workspace" });

    expect(openUrlInBrowserPanel(THREAD_REF, "mailto:someone@example.com")).toBe(false);
    expect(useBrowserPanelStore.getState().browserStateByThreadKey).toEqual({});
  });
});
