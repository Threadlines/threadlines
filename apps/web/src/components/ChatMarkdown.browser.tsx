import "../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, type EnvironmentApi, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const { filesystemBrowseMock, openInEditorMock, openInPreferredEditorMock, readLocalApiMock } =
  vi.hoisted(() => {
    const filesystemBrowseMock = vi.fn(
      async (): Promise<{
        parentPath: string;
        entries: Array<{ name: string; fullPath: string }>;
      }> => ({ parentPath: "/", entries: [] }),
    );
    const openInEditorMock = vi.fn(async () => undefined);
    const openInPreferredEditorMock = vi.fn(async () => "vscode");
    return {
      filesystemBrowseMock,
      openInEditorMock,
      openInPreferredEditorMock,
      readLocalApiMock: vi.fn(() => ({
        server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
        shell: { openInEditor: openInEditorMock },
        persistence: {
          getClientSettings: vi.fn(async () => null),
          setClientSettings: vi.fn(async () => undefined),
        },
      })),
    };
  });

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: readLocalApiMock,
  readLocalApi: readLocalApiMock,
}));

import ChatMarkdown from "./ChatMarkdown";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { setActiveFileViewerContext, useFileViewerStore } from "../fileViewerStore";
import { toMarkdownFileUrlHref } from "../markdown-links";

const CHAT_MARKDOWN_ENVIRONMENT_ID = EnvironmentId.make("environment-chat-markdown-browser");
const CHAT_MARKDOWN_THREAD_ID = ThreadId.make("thread-chat-markdown-browser");
const CHAT_MARKDOWN_THREAD_REF = scopeThreadRef(
  CHAT_MARKDOWN_ENVIRONMENT_ID,
  CHAT_MARKDOWN_THREAD_ID,
);

function installFilesystemBrowseEnvironment() {
  __setEnvironmentApiOverrideForTests(CHAT_MARKDOWN_ENVIRONMENT_ID, {
    filesystem: { browse: filesystemBrowseMock },
  } as unknown as EnvironmentApi);
}

describe("ChatMarkdown", () => {
  afterEach(() => {
    setActiveFileViewerContext(null);
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
    openInEditorMock.mockClear();
    openInPreferredEditorMock.mockClear();
    filesystemBrowseMock.mockClear();
    __resetEnvironmentApiOverridesForTests();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("renders local file links with copyable file url hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    installFilesystemBrowseEnvironment();
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath})`}
        cwd="/repo/project"
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", toMarkdownFileUrlHref(filePath));
      await expect.element(link).toHaveAttribute("data-entry-kind", "file");
      await vi.waitFor(() => {
        expect(filesystemBrowseMock).toHaveBeenCalledWith({
          partialPath: "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/",
          cwd: "/repo/project",
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect
        .element(link)
        .toHaveAttribute("href", toMarkdownFileUrlHref(filePath, { line: 1 }));
    } finally {
      await screen.unmount();
    }
  });

  it("opens file links through the platform opener when the active viewer cannot handle them", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await link.click();

      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(openInEditorMock).toHaveBeenCalledWith(filePath, "file-manager");
    } finally {
      await screen.unmount();
    }
  });

  it("opens file links in the active project file viewer before using external editors", async () => {
    const cwd = "/repo/project";
    const filePath = "/repo/project/src/utils/permissions/PermissionRule.ts";
    setActiveFileViewerContext({
      environmentId: CHAT_MARKDOWN_ENVIRONMENT_ID,
      cwd,
      threadRef: CHAT_MARKDOWN_THREAD_REF,
    });
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:7](file://${filePath}#L7)`} cwd={cwd} />,
    );

    try {
      const link = page.getByRole("link", { name: /PermissionRule\.ts.*L7/ });
      await expect.element(link).toBeInTheDocument();

      await link.click();

      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.activePath).toBe("src/utils/permissions/PermissionRule.ts");
        expect(state.revealLine).toBe(7);
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(openInEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens Git Bash Windows absolute file links in the active project file viewer", async () => {
    const cwd = "C:/Users/wilfr/OneDrive/Desktop/GitHubCode/badcode";
    const filePath = "/c/Users/wilfr/OneDrive/Desktop/GitHubCode/badcode/AGENTS.md";
    setActiveFileViewerContext({
      environmentId: CHAT_MARKDOWN_ENVIRONMENT_ID,
      cwd,
      threadRef: CHAT_MARKDOWN_THREAD_REF,
    });
    const screen = await render(
      <ChatMarkdown text={`[AGENTS.md:87](file://${filePath}#L87)`} cwd={cwd} />,
    );

    try {
      const link = page.getByRole("link", { name: /AGENTS\.md.*L87/ });
      await expect.element(link).toBeInTheDocument();

      await link.click();

      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.activePath).toBe("AGENTS.md");
        expect(state.revealLine).toBe(87);
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(openInEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect
        .element(link)
        .toHaveAttribute("href", toMarkdownFileUrlHref(filePath, { line: 1, column: 7 }));
    } finally {
      await screen.unmount();
    }
  });

  it("recognizes absolute file paths with encoded spaces as local file links", async () => {
    const encodedHref =
      "/Users/demo/Downloads/Quarterly%20Report%20-%20Q3%20-%20July%207%202026.pdf";
    const decodedPath = "/Users/demo/Downloads/Quarterly Report - Q3 - July 7 2026.pdf";
    const screen = await render(
      <ChatMarkdown text={`[quarterly report](${encodedHref})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", {
        name: "Quarterly Report - Q3 - July 7 2026.pdf",
      });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", toMarkdownFileUrlHref(decodedPath));

      await link.click();
      await vi.waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith(decodedPath, "file-manager");
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("recognizes angle-bracketed absolute directory paths with spaces", async () => {
    const cwd = "/Users/will/Threadlines Marketing Studio";
    const directoryPath = "/Users/will/Threadlines Marketing Studio/Captures/Exports/";
    const resolvedDirectoryPath = directoryPath.slice(0, -1);
    filesystemBrowseMock.mockResolvedValueOnce({
      parentPath: "/Users/will/Threadlines Marketing Studio/Captures",
      entries: [{ name: "Exports", fullPath: resolvedDirectoryPath }],
    });
    installFilesystemBrowseEnvironment();
    setActiveFileViewerContext({
      environmentId: CHAT_MARKDOWN_ENVIRONMENT_ID,
      cwd,
      threadRef: CHAT_MARKDOWN_THREAD_REF,
    });
    const screen = await render(
      <ChatMarkdown
        text={`[Exports](<${directoryPath}>)`}
        cwd={cwd}
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Exports" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", toMarkdownFileUrlHref(directoryPath));
      await expect.element(link).toHaveAttribute("data-entry-kind", "directory");
      expect(filesystemBrowseMock).toHaveBeenCalledWith({
        partialPath: "/Users/will/Threadlines Marketing Studio/Captures/",
        cwd,
      });

      await link.click();
      await vi.waitFor(() => {
        expect(useFileViewerStore.getState()).toMatchObject({
          isOpen: true,
          activePath: null,
          tabs: [],
          treeRevealPath: "Captures/Exports",
        });
      });
      expect(openInEditorMock).not.toHaveBeenCalled();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });
});
