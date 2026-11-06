import { EnvironmentId, type EnvironmentApi } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "./environmentApi";
import {
  FILE_REFERENCE_SEARCH_LIMIT,
  findReferencedFile,
  isPathWithinCwd,
  openDirectoryInViewer,
  openFileInViewer,
  parseChatFileReference,
  placeChatFileReference,
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

  it("does not mistake dotted telemetry identifiers for bare file names", () => {
    expect(parseChatFileReference("telemetry.step")).toBeNull();
    expect(parseChatFileReference("tool.started")).toBeNull();
    expect(parseChatFileReference("tool.output.updated")).toBeNull();
    expect(parseChatFileReference("AgentsPanel.tsx:300")).toEqual({
      path: "AgentsPanel.tsx",
      line: 300,
    });
    // An explicit path is still actionable even when its extension is niche.
    expect(parseChatFileReference("fixtures/workflow.step:4")).toEqual({
      path: "fixtures/workflow.step",
      line: 4,
    });
  });

  it("resolves a bare file name only to a file with exactly that name", () => {
    // Search order: the fuzzy hits a project without the file still returns.
    const fuzzyHits = [
      { path: "docs/read-me-notes.txt", kind: "file" as const },
      { path: "README.md", kind: "file" as const },
    ];
    expect(findReferencedFile(fuzzyHits, "README.txt")).toEqual({ status: "none" });

    const withExactMatch = [
      ...fuzzyHits,
      { path: "packaging/readme.txt", kind: "directory" as const },
      { path: "packaging/win/README.txt", kind: "file" as const },
      { path: "packaging/mac/README.txt", kind: "file" as const },
    ];
    expect(findReferencedFile(withExactMatch, "README.txt")).toEqual({
      status: "found",
      path: "packaging/win/README.txt",
    });
  });

  it("resolves a path from inside a subfolder only to the one file ending in it", () => {
    const moduleFile = "shop/app/code/Buyfire/ReturnForm/Model/ReturnForm.php";
    const hits = [
      { path: moduleFile, kind: "file" as const },
      {
        path: "shop/app/code/Buyfire/ReturnForm/Model/ReturnFormLegacy.php",
        kind: "file" as const,
      },
    ];
    expect(findReferencedFile(hits, "Model/ReturnForm.php")).toEqual({
      status: "found",
      path: moduleFile,
    });
    // Two modules each have one, and nothing says which the agent meant.
    const helpers = [
      { path: "shop/app/code/Buyfire/Analytics/Helper/Data.php", kind: "file" as const },
      { path: "shop/app/code/Buyfire/ReturnForm/Helper/Data.php", kind: "file" as const },
    ];
    expect(findReferencedFile(helpers, "Helper/Data.php")).toEqual({ status: "ambiguous" });
    // The file at the path as written wins over others ending the same way.
    expect(
      findReferencedFile(
        [
          { path: "packages/a/src/index.ts", kind: "file" as const },
          { path: "src/index.ts", kind: "file" as const },
        ],
        "src/index.ts",
      ),
    ).toEqual({ status: "found", path: "src/index.ts" });
    // Exact spelling first: on a case-sensitive disk these are two files.
    expect(
      findReferencedFile(
        [
          { path: "src/index.ts", kind: "file" as const },
          { path: "src/Index.ts", kind: "file" as const },
        ],
        "src/Index.ts",
      ),
    ).toEqual({ status: "found", path: "src/Index.ts" });
  });

  it("places a cited path past a page of namesakes and a folder at the path as written", async () => {
    // A folder sits where the path says, so the server refuses to read it.
    const readFile = vi.fn(async () => {
      throw new Error("Cannot read entry of type 'Directory' as a file.");
    });
    const searchEntries = vi.fn(async (input: { query: string }) => {
      if (input.query === "Form.php") {
        return { entries: [{ path: "module/Model/Form.php", kind: "file" }], truncated: false };
      }
      if (input.query === "Data.php") {
        // More files share the name than one page holds, none under Helper/.
        const namesakes = Array.from({ length: FILE_REFERENCE_SEARCH_LIMIT }, (_, index) => ({
          path: `vendor/lib${index}/Data.php`,
          kind: "file",
        }));
        return { entries: namesakes, truncated: true };
      }
      return {
        entries: [
          { path: "shop/Analytics/Helper/Data.php", kind: "file" },
          { path: "shop/Banner/Helper/Data.php", kind: "file" },
        ],
        truncated: true,
      };
    });
    // The environment API is only handed out in a window.
    vi.stubGlobal("window", {});
    __setEnvironmentApiOverrideForTests(TEST_ENVIRONMENT_ID, {
      projects: { readFile, searchEntries },
    } as unknown as EnvironmentApi);
    const place = (path: string) =>
      placeChatFileReference({
        environmentId: TEST_ENVIRONMENT_ID,
        cwd: "/repo",
        projectRoot: null,
        reference: { path, line: 3 },
      });

    try {
      await expect(place("Model/Form.php")).resolves.toEqual({
        status: "found",
        file: { cwd: "/repo", relativePath: "module/Model/Form.php", line: 3 },
      });
      // The page of namesakes is full, so the whole path is searched too, and
      // turns up two files ending in it.
      await expect(place("Helper/Data.php")).resolves.toEqual({ status: "ambiguous" });
      expect(searchEntries.mock.calls.map(([input]) => input.query)).toEqual([
        "Form.php",
        "Data.php",
        "Helper/Data.php",
      ]);
    } finally {
      __resetEnvironmentApiOverridesForTests();
      vi.unstubAllGlobals();
    }
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
