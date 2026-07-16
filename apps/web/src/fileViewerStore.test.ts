import { EnvironmentId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isPathWithinCwd,
  openDirectoryInViewer,
  openFileInViewer,
  relativePathWithinCwd,
  useFileViewerStore,
} from "./fileViewerStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-file-viewer-store");
const WINDOWS_CWD = "C:/Users/wilfr/OneDrive/Desktop/GitHubCode/badcode";
const GIT_BASH_AGENTS_PATH = "/c/Users/wilfr/OneDrive/Desktop/GitHubCode/badcode/AGENTS.md";

function resetFileViewerStore(): void {
  useFileViewerStore.setState({
    isOpen: false,
    context: null,
    tabs: [],
    activePath: null,
    previewPath: null,
    treeRevealPath: null,
    treeRevealRequestId: 0,
    revealLine: null,
    revealEndLine: null,
    revealRequestId: 0,
    editMode: false,
    editSeed: null,
    editSaveState: {},
    coarsePointerWordWrap: null,
  });
}

describe("fileViewerStore", () => {
  beforeEach(resetFileViewerStore);
  afterEach(resetFileViewerStore);

  it("relativizes Git Bash Windows absolute paths against a Windows cwd", () => {
    expect(relativePathWithinCwd(GIT_BASH_AGENTS_PATH, WINDOWS_CWD)).toBe("AGENTS.md");
  });

  it("distinguishes Windows paths outside the active workspace", () => {
    expect(isPathWithinCwd("C:/Users/wilfr/.claude/CLAUDE.md", WINDOWS_CWD)).toBe(false);
    expect(isPathWithinCwd(`${WINDOWS_CWD}/AGENTS.md`, WINDOWS_CWD)).toBe(true);
  });

  it("opens Git Bash Windows absolute paths with line suffixes in the viewer", () => {
    expect(
      openFileInViewer({
        environmentId: TEST_ENVIRONMENT_ID,
        cwd: WINDOWS_CWD,
        path: `${GIT_BASH_AGENTS_PATH}:87`,
      }),
    ).toBe(true);

    expect(useFileViewerStore.getState()).toMatchObject({
      isOpen: true,
      activePath: "AGENTS.md",
      revealLine: 87,
    });
  });

  it("reveals nested directories without opening them as file tabs", () => {
    expect(
      openDirectoryInViewer({
        environmentId: TEST_ENVIRONMENT_ID,
        cwd: "/Users/will/badcode",
        path: "/Users/will/badcode/apps/server/",
      }),
    ).toBe(true);

    expect(useFileViewerStore.getState()).toMatchObject({
      isOpen: true,
      activePath: null,
      tabs: [],
      treeRevealPath: "apps/server",
      treeRevealRequestId: 1,
    });
  });

  it("opens workspace-root directory links without creating a file tab", () => {
    expect(
      openDirectoryInViewer({
        environmentId: TEST_ENVIRONMENT_ID,
        cwd: "/Users/will/badcode",
        path: "/Users/will/badcode/",
      }),
    ).toBe(true);

    expect(useFileViewerStore.getState()).toMatchObject({
      isOpen: true,
      activePath: null,
      tabs: [],
      treeRevealPath: "",
    });
  });

  it("hands an edit seed to exactly one claim for the seeded path", () => {
    const seed = { path: "src/a.ts", line: 4, character: 0, insertText: "x" };
    useFileViewerStore.getState().setEditMode(true, seed);
    expect(useFileViewerStore.getState()).toMatchObject({ editMode: true, editSeed: seed });

    expect(useFileViewerStore.getState().claimEditSeed("src/other.ts")).toBeNull();
    expect(useFileViewerStore.getState().editSeed).toEqual(seed);

    expect(useFileViewerStore.getState().claimEditSeed("src/a.ts")).toEqual(seed);
    expect(useFileViewerStore.getState().claimEditSeed("src/a.ts")).toBeNull();
  });

  it("buffers pre-attach keystrokes onto the pending seed, then stops once claimed", () => {
    useFileViewerStore
      .getState()
      .setEditMode(true, { path: "src/a.ts", line: 4, character: 0, insertText: "x" });

    expect(useFileViewerStore.getState().appendToEditSeed("src/other.ts", "n")).toBe(false);
    expect(useFileViewerStore.getState().appendToEditSeed("src/a.ts", "y")).toBe(true);
    expect(useFileViewerStore.getState().appendToEditSeed("src/a.ts", "z")).toBe(true);
    expect(useFileViewerStore.getState().claimEditSeed("src/a.ts")).toEqual({
      path: "src/a.ts",
      line: 4,
      character: 0,
      insertText: "xyz",
    });
    expect(useFileViewerStore.getState().appendToEditSeed("src/a.ts", "w")).toBe(false);
  });

  it("starts a caret-only seed's buffered input from the keystroke itself", () => {
    useFileViewerStore.getState().setEditMode(true, { path: "src/a.ts", line: 2, character: 7 });
    expect(useFileViewerStore.getState().appendToEditSeed("src/a.ts", "q")).toBe(true);
    expect(useFileViewerStore.getState().claimEditSeed("src/a.ts")).toEqual({
      path: "src/a.ts",
      line: 2,
      character: 7,
      insertText: "q",
    });
  });

  it("reuses the preview tab's slot for successive preview opens", () => {
    const store = useFileViewerStore.getState();
    store.openFile("src/a.ts");
    store.openFile("src/b.ts");
    expect(useFileViewerStore.getState()).toMatchObject({
      tabs: ["src/b.ts"],
      activePath: "src/b.ts",
      previewPath: "src/b.ts",
    });
  });

  it("keeps pinned tabs out of the preview slot and replaces the preview in place", () => {
    const store = useFileViewerStore.getState();
    store.openFile("src/a.ts");
    store.openFile("src/pinned.ts", { pinned: true });
    store.openFile("src/c.ts");
    expect(useFileViewerStore.getState()).toMatchObject({
      tabs: ["src/c.ts", "src/pinned.ts"],
      activePath: "src/c.ts",
      previewPath: "src/c.ts",
    });
  });

  it("never demotes a permanent tab re-opened as a preview", () => {
    const store = useFileViewerStore.getState();
    store.openFile("src/a.ts", { pinned: true });
    store.openFile("src/a.ts");
    expect(useFileViewerStore.getState()).toMatchObject({
      tabs: ["src/a.ts"],
      previewPath: null,
    });
  });

  it("promotes the preview tab on pin, pinned re-open, edit entry, and unsaved changes", () => {
    const store = useFileViewerStore.getState();

    store.openFile("src/a.ts");
    store.pinTab("src/a.ts");
    expect(useFileViewerStore.getState().previewPath).toBeNull();

    store.openFile("src/b.ts");
    store.openFile("src/b.ts", { pinned: true });
    expect(useFileViewerStore.getState().previewPath).toBeNull();

    store.openFile("src/c.ts");
    store.setEditMode(true);
    expect(useFileViewerStore.getState().previewPath).toBeNull();
    store.setEditMode(false);

    store.openFile("src/d.ts");
    store.setEditSaveState("src/d.ts", "pending");
    expect(useFileViewerStore.getState().previewPath).toBeNull();

    expect(useFileViewerStore.getState().tabs).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("clears the preview slot when the preview tab closes", () => {
    const store = useFileViewerStore.getState();
    store.openFile("src/a.ts", { pinned: true });
    store.openFile("src/b.ts");
    store.closeTab("src/b.ts");
    expect(useFileViewerStore.getState()).toMatchObject({
      tabs: ["src/a.ts"],
      activePath: "src/a.ts",
      previewPath: null,
    });
  });

  it("opens external file references (chat/diff) into the preview slot", () => {
    useFileViewerStore.getState().openFile("src/a.ts");
    expect(
      openFileInViewer({
        environmentId: TEST_ENVIRONMENT_ID,
        cwd: "/Users/will/badcode",
        path: "/Users/will/badcode/AGENTS.md",
      }),
    ).toBe(true);
    expect(useFileViewerStore.getState()).toMatchObject({
      tabs: ["AGENTS.md"],
      activePath: "AGENTS.md",
      previewPath: "AGENTS.md",
    });
  });

  it("drops any pending seed when edit mode is entered plainly or left", () => {
    const seed = { path: "src/a.ts", line: 1, character: 2 };
    useFileViewerStore.getState().setEditMode(true, seed);
    useFileViewerStore.getState().setEditMode(false);
    expect(useFileViewerStore.getState().editSeed).toBeNull();

    useFileViewerStore.getState().setEditMode(true, seed);
    useFileViewerStore.getState().setEditMode(true);
    expect(useFileViewerStore.getState()).toMatchObject({ editMode: true, editSeed: null });
  });
});
