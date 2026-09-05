import "../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, type EnvironmentApi, ThreadId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const {
  contextMenuShowMock,
  filesystemBrowseMock,
  openInEditorMock,
  openInPreferredEditorMock,
  readLocalApiMock,
} = vi.hoisted(() => {
  const contextMenuShowMock = vi.fn(async () => null as string | null);
  const filesystemBrowseMock = vi.fn(
    async (): Promise<{
      parentPath: string;
      entries: Array<{ name: string; fullPath: string }>;
    }> => ({ parentPath: "/", entries: [] }),
  );
  const openInEditorMock = vi.fn(async () => undefined);
  const openInPreferredEditorMock = vi.fn(async (_api: unknown, _targetPath: string) => "vscode");
  return {
    contextMenuShowMock,
    filesystemBrowseMock,
    openInEditorMock,
    openInPreferredEditorMock,
    readLocalApiMock: vi.fn(() => ({
      contextMenu: { show: contextMenuShowMock },
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

// The inline image loader reads files through react-query, so those renders
// need the provider the app root supplies.
function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function installReadFileEnvironment(readFile: EnvironmentApi["projects"]["readFile"]) {
  __setEnvironmentApiOverrideForTests(CHAT_MARKDOWN_ENVIRONMENT_ID, {
    filesystem: { browse: filesystemBrowseMock },
    projects: { readFile },
  } as unknown as EnvironmentApi);
}

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
    contextMenuShowMock.mockClear();
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

  it("opens file links in the preferred editor when the active viewer cannot handle them", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await link.click();

      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(openInPreferredEditorMock).toHaveBeenCalledTimes(1);
      expect(openInPreferredEditorMock.mock.calls[0]?.[1]).toBe(filePath);
      expect(openInEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("offers external actions for Windows file links outside the active project", async () => {
    const cwd = "C:/Users/wilfr/OneDrive/Desktop/GitHubCode/claude-dotfiles";
    const filePath = "C:/Users/wilfr/.claude/CLAUDE.md";
    const screen = await render(<ChatMarkdown text={`[CLAUDE.md](${filePath})`} cwd={cwd} />);

    try {
      const link = document.querySelector('a[data-workspace-scope="external"]');
      expect(link).toBeInstanceOf(HTMLAnchorElement);

      link?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 44,
          clientY: 88,
        }),
      );

      await vi.waitFor(() => {
        expect(contextMenuShowMock).toHaveBeenCalledWith(
          [
            { id: "open-external", label: "Open in editor" },
            { id: "reveal", label: "Reveal in file manager" },
            { id: "copy-full", label: "Copy full path" },
          ],
          { x: 44, y: 88 },
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("links web addresses, including dev servers written without a scheme", async () => {
    const screen = await render(
      <ChatMarkdown
        text="See [the docs](https://example.com/docs), [the app](localhost:4173), or open localhost:5173 now."
        cwd="/repo/project"
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
        threadId={CHAT_MARKDOWN_THREAD_ID}
      />,
    );

    try {
      const docsLink = page.getByRole("link", { name: "the docs" });
      await expect.element(docsLink).toHaveAttribute("href", "https://example.com/docs");
      await expect.element(docsLink).toHaveAttribute("target", "_blank");

      const devServerLink = page.getByRole("link", { name: "localhost:5173" });
      await expect.element(devServerLink).toHaveAttribute("href", "http://localhost:5173");

      const markdownDevServerLink = page.getByRole("link", { name: "the app" });
      await expect.element(markdownDevServerLink).toHaveAttribute("href", "http://localhost:4173");

      document
        .querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]')
        ?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 48,
          }),
        );
      await vi.waitFor(() => {
        expect(contextMenuShowMock).toHaveBeenCalledWith(
          [
            { id: "open-external", label: "Open in external browser" },
            { id: "copy-link", label: "Copy link address" },
          ],
          { x: 24, y: 48 },
        );
      });
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
        expect(openInPreferredEditorMock.mock.calls[0]?.[1]).toBe(decodedPath);
      });
      expect(openInEditorMock).not.toHaveBeenCalled();
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

  /** Prose that cites one file as a backticked path, another as a markdown link,
   *  and a tool name that is not a file at all. */
  const MIXED_REFERENCE_PROSE =
    "The gutter is set in `apps/web/src/components/chat/AgentsPanel.tsx:300`, and " +
    "[AgentsPanel.tsx](file:///repo/project/docs/AgentsPanel.tsx) documents it. " +
    "Call `spawn_agent` to start one.";

  it("renders inline-code file references as the chip a file link gets", async () => {
    const cwd = "/repo/project";
    setActiveFileViewerContext({
      environmentId: CHAT_MARKDOWN_ENVIRONMENT_ID,
      cwd,
      threadRef: CHAT_MARKDOWN_THREAD_REF,
    });
    const screen = await render(<ChatMarkdown text={MIXED_REFERENCE_PROSE} cwd={cwd} />);

    try {
      // Both citations went through one pre-pass, so the two namesakes carry the
      // parent suffix that tells them apart -- the inline one included.
      const chip = page.getByRole("link", { name: "AgentsPanel.tsx · components/chat · L300" });
      await expect.element(chip).toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "AgentsPanel.tsx · project/docs" }))
        .toBeInTheDocument();

      // The tool name is the only thing left as inline code.
      expect(
        [...document.querySelectorAll(".chat-markdown code")].map((el) => el.textContent),
      ).toEqual(["spawn_agent"]);

      await chip.click();
      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.activePath).toBe("apps/web/src/components/chat/AgentsPanel.tsx");
        expect(state.revealLine).toBe(300);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("leaves dotted event and telemetry identifiers as ordinary inline code", async () => {
    const screen = await render(
      <ChatMarkdown
        text="The stream reports `tool.started`, `tool.output.updated`, and `telemetry.step`."
        cwd="/repo/project"
      />,
    );

    try {
      expect(
        [...document.querySelectorAll(".chat-markdown code")].map((element) =>
          element.textContent?.trim(),
        ),
      ).toEqual(["tool.started", "tool.output.updated", "telemetry.step"]);
      expect(document.querySelector(".chat-markdown-file-link")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps references as written while a search hit is highlighted", async () => {
    // A chip drops the highlight and shortens the path, so the characters the
    // reader searched for could leave the page entirely.
    const screen = await render(
      <ChatMarkdown
        text={MIXED_REFERENCE_PROSE}
        cwd="/repo/project"
        searchHighlightQuery="components/chat"
      />,
    );

    try {
      await expect
        .element(
          page.getByRole("button", { name: "apps/web/src/components/chat/AgentsPanel.tsx:300" }),
        )
        .toBeInTheDocument();
      // The searched characters are still on the page, which a shortened label
      // could not promise.
      expect(document.body.textContent).toContain("components/chat");
    } finally {
      await screen.unmount();
    }
  });

  it("leaves inline-code file references alone when there is no workspace to resolve against", async () => {
    const screen = await render(
      <ChatMarkdown
        text="The gutter is set in `apps/web/src/AgentsPanel.tsx:300`."
        cwd={undefined}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "apps/web/src/AgentsPanel.tsx:300" }))
        .toBeInTheDocument();
      expect(document.querySelectorAll("a.chat-markdown-file-link")).toHaveLength(0);
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

  it("renders Codex inline visualization directives in a script-only sandbox", async () => {
    const readVisualization = vi.fn(async () => ({
      file: "connection-map.html",
      contents: '<div id="connection-map"><button type="button">Explore</button></div>',
      sizeBytes: 72,
    }));
    __setEnvironmentApiOverrideForTests(CHAT_MARKDOWN_ENVIRONMENT_ID, {
      visualizations: { read: readVisualization },
    } as unknown as EnvironmentApi);
    const screen = await render(
      <ChatMarkdown
        text={'Overview\n\n::codex-inline-vis{file="connection-map.html"}'}
        cwd="/repo/project"
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
        threadId={CHAT_MARKDOWN_THREAD_ID}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(readVisualization).toHaveBeenCalledWith({
          threadId: CHAT_MARKDOWN_THREAD_ID,
          file: "connection-map.html",
        });
      });
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[title="Interactive visualization: connection map"]',
      );
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(iframe?.srcdoc).toContain("Content-Security-Policy");
      expect(iframe?.srcdoc).toContain('id="connection-map"');
      expect(document.body.textContent).not.toContain("::codex-inline-vis");
    } finally {
      await screen.unmount();
    }
  });

  it("grows a streaming message without remounting the DOM it already rendered", async () => {
    const opening = "Reading [the plan](https://example.com/plan) now";
    const screen = await render(<ChatMarkdown text={opening} cwd="/repo/project" isStreaming />);

    try {
      const paragraph = document.querySelector<HTMLParagraphElement>(".chat-markdown p");
      expect(paragraph?.textContent).toContain("Reading");
      const link = paragraph!.querySelector("a");
      expect(link).not.toBeNull();

      await screen.rerender(
        <ChatMarkdown
          text={`${opening} and checking the rest of it.`}
          cwd="/repo/project"
          isStreaming
        />,
      );
      await vi.waitFor(() => {
        expect(document.querySelector(".chat-markdown p")?.textContent).toContain(
          "checking the rest of it",
        );
      });

      // The delta appended text; it did not rebuild the paragraph around it.
      expect(paragraph!.isConnected).toBe(true);
      expect(document.querySelector(".chat-markdown p")).toBe(paragraph);
      expect(paragraph!.querySelector("a")).toBe(link);
    } finally {
      await screen.unmount();
    }
  });

  it("colors an open fence while it streams and keeps the color when it settles", async () => {
    const openFence = "```ts\nconst answer = 1;\nfunction identity(value) {}";
    const screen = await render(<ChatMarkdown text={openFence} cwd="/repo/project" isStreaming />);

    try {
      await vi.waitFor(() => {
        const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre.shiki");
        expect(pre).not.toBeNull();
        expect(pre!.querySelector('span[style*="color"]')).not.toBeNull();
        // The one-shot HTML carries the theme background inline; the streamed
        // block does not, so this is still the open fence being tokenized.
        expect(pre!.style.backgroundColor).toBe("");
      });

      await screen.rerender(
        <ChatMarkdown text={`${openFence}\n\`\`\``} cwd="/repo/project" isStreaming={false} />,
      );

      // The frame the fence closed on: still the streamed tokens, never plain.
      const settling = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre");
      expect(settling?.classList.contains("shiki")).toBe(true);
      expect(settling?.querySelector('span[style*="color"]')).not.toBeNull();

      await vi.waitFor(() => {
        const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre.shiki");
        expect(pre?.style.backgroundColor).not.toBe("");
        expect(pre?.textContent).toContain("function identity(value) {}");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows a picture for an image path an agent wrote in prose", async () => {
    const pixelBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const readFile = vi.fn(async (_input: { cwd: string; relativePath: string }) => ({
      kind: "image" as const,
      relativePath: "../Temp/shot.png",
      mimeType: "image/png",
      base64: pixelBase64,
      size: 70,
    }));
    installReadFileEnvironment(readFile as unknown as EnvironmentApi["projects"]["readFile"]);

    const screen = await renderWithQueryClient(
      <ChatMarkdown
        text="Saved the screenshot to /tmp/Temp/shot.png for review."
        cwd="/tmp/project"
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
      />,
    );

    try {
      const thumbnail = page.getByRole("img", { name: "shot.png" });
      await expect.element(thumbnail).toBeInTheDocument();
      await expect
        .element(thumbnail)
        .toHaveAttribute("src", `data:image/png;base64,${pixelBase64}`);
      // The chip stays under the picture and still opens the file.
      await expect.element(page.getByRole("link", { name: "shot.png" })).toBeInTheDocument();
      expect(readFile.mock.calls[0]?.[0]).toEqual({
        cwd: "/tmp/project",
        relativePath: "../Temp/shot.png",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows only the chip when a referenced image is gone", async () => {
    const readFile = vi.fn(async () => ({
      kind: "missing" as const,
      relativePath: "shots/gone.png",
    }));
    installReadFileEnvironment(readFile as unknown as EnvironmentApi["projects"]["readFile"]);

    const screen = await renderWithQueryClient(
      <ChatMarkdown
        text="![before](shots/gone.png)"
        cwd="/repo/project"
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
      />,
    );

    try {
      await expect.element(page.getByRole("link", { name: "before" })).toBeInTheDocument();
      await vi.waitFor(() => {
        expect(readFile).toHaveBeenCalled();
      });
      // Only the chip's file-type glyph; no thumbnail and no error box.
      expect(document.querySelector('img[alt="before"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Preview before"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("wraps long fenced text and shows copy feedback", async () => {
    const code = `Please run ${"a-very-long-unbroken-value".repeat(20)} when ready.`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const screen = await render(
      <div style={{ width: 260 }}>
        <ChatMarkdown text={`\`\`\`text\n${code}\n\`\`\``} cwd="/repo/project" isStreaming />
      </div>,
    );

    try {
      const copyButton = page.getByRole("button", { name: "Copy code block" });
      await expect.element(copyButton).toBeVisible();

      const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre");
      expect(pre).not.toBeNull();
      expect(getComputedStyle(pre!).whiteSpace).toBe("pre-wrap");
      expect(pre!.scrollWidth).toBeLessThanOrEqual(pre!.clientWidth + 1);

      await copyButton.click();

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(`${code}\n`);
        expect(document.querySelector(".chat-markdown-copy-button .text-success")).not.toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });
});
