import { EnvironmentId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
