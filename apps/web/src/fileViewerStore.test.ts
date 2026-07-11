import { EnvironmentId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
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
    treeRevealPath: null,
    treeRevealRequestId: 0,
    revealLine: null,
    revealEndLine: null,
    revealRequestId: 0,
    editMode: false,
    editSeed: null,
    coarsePointerWordWrap: null,
  });
}

describe("fileViewerStore", () => {
  beforeEach(resetFileViewerStore);
  afterEach(resetFileViewerStore);

  it("relativizes Git Bash Windows absolute paths against a Windows cwd", () => {
    expect(relativePathWithinCwd(GIT_BASH_AGENTS_PATH, WINDOWS_CWD)).toBe("AGENTS.md");
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
