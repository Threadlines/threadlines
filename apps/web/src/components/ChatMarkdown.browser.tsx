import "../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  CommandRunId,
  EnvironmentId,
  type EnvironmentApi,
  MessageId,
  type OrchestrationCommandRun,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
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
import { ExpandedImageViewerHost } from "./chat/ExpandedImageDialog";
import { ThreadPullRequestLinkContext } from "./chat/ThreadPullRequestLinkContext";
import {
  CodeBlockRunScopeContext,
  CommandRunActionsContext,
  type CommandRunActions,
} from "./chat/CommandRuns";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { setActiveFileViewerContext, useFileViewerStore } from "../fileViewerStore";
import { toMarkdownFileUrlHref } from "../markdown-links";
import { readDrawnBlocks } from "./chat/chatFind/chatFindDom";
import { findableMarkdownBlocks } from "./chat/chatFind/chatFindText";

const CHAT_MARKDOWN_ENVIRONMENT_ID = EnvironmentId.make("environment-chat-markdown-browser");
const CHAT_MARKDOWN_THREAD_ID = ThreadId.make("thread-chat-markdown-browser");
const CHAT_MARKDOWN_THREAD_REF = scopeThreadRef(
  CHAT_MARKDOWN_ENVIRONMENT_ID,
  CHAT_MARKDOWN_THREAD_ID,
);
// The pull request the thread route would hand a transcript, with its opener
// mocked so a click can be observed.
const THREAD_PULL_REQUEST_URL = "https://github.com/Threadlines/threadlines/pull/223";
const THREAD_PULL_REQUEST_LINK = {
  pullRequests: [{ number: 223, url: THREAD_PULL_REQUEST_URL }],
  open: vi.fn(),
};

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

function installReadFileEnvironment(
  readFile: EnvironmentApi["projects"]["readFile"],
  searchEntries?: EnvironmentApi["projects"]["searchEntries"],
) {
  __setEnvironmentApiOverrideForTests(CHAT_MARKDOWN_ENVIRONMENT_ID, {
    filesystem: { browse: filesystemBrowseMock },
    projects: { readFile, searchEntries },
  } as unknown as EnvironmentApi);
}

/** A 1x1 PNG, for reads that should come back as a picture. */
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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

  it("opens the thread's own pull request in its tab and leaves deeper links alone", async () => {
    const { open } = THREAD_PULL_REQUEST_LINK;
    const pullRequestUrl = THREAD_PULL_REQUEST_URL;
    open.mockClear();
    const screen = await render(
      <ThreadPullRequestLinkContext.Provider value={THREAD_PULL_REQUEST_LINK}>
        <ChatMarkdown
          text={`Opened [the PR](${pullRequestUrl}); see [its files](${pullRequestUrl}/files).`}
          cwd="/repo/project"
          environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
          threadId={CHAT_MARKDOWN_THREAD_ID}
        />
      </ThreadPullRequestLinkContext.Provider>,
    );

    // A click the link leaves alone bubbles past React's root to the window,
    // still unclaimed; catching it there keeps the test page from actually
    // leaving. A click the link claims is stopped before it gets here.
    let leftAlone = false;
    const observeClick = (event: Event) => {
      leftAlone = !event.defaultPrevented;
      event.preventDefault();
    };
    window.addEventListener("click", observeClick);

    try {
      // Both links are chips now, so their text is the number the chip prints
      // followed by the words the author wrote.
      const click = (name: string) => {
        const anchor = Array.from(document.querySelectorAll("a")).find((candidate) =>
          candidate.textContent?.includes(name),
        );
        if (!anchor) {
          throw new Error(`No link named ${name}`);
        }
        leftAlone = false;
        return anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      };

      expect(click("the PR")).toBe(false);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenLastCalledWith(223);

      click("its files");
      expect(leftAlone).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("click", observeClick);
      await screen.unmount();
    }
  });

  it("renders a pull request address as a numbered chip that opens its tab", async () => {
    const { open } = THREAD_PULL_REQUEST_LINK;
    const pullRequestUrl = THREAD_PULL_REQUEST_URL;
    open.mockClear();
    const screen = await render(
      <ThreadPullRequestLinkContext.Provider value={THREAD_PULL_REQUEST_LINK}>
        <ChatMarkdown
          text={`Opened ${pullRequestUrl}, see [PR 223](${pullRequestUrl}) for [the migration fix](${pullRequestUrl}).`}
          cwd="/repo/project"
          environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
          threadId={CHAT_MARKDOWN_THREAD_ID}
        />
      </ThreadPullRequestLinkContext.Provider>,
    );

    try {
      const chips = Array.from(document.querySelectorAll("a")).filter((anchor) =>
        anchor.getAttribute("href")?.startsWith(pullRequestUrl),
      );
      expect(chips).toHaveLength(3);
      // The bare address and text that only restates the number both give way
      // to the chip; anything the author actually wrote is kept beside it.
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "#223",
        "#223",
        "#223the migration fix",
      ]);
      // A chip, not a URL: the state glyph plus the number.
      expect(chips[0]?.querySelector("svg")).toBeTruthy();

      chips[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenCalledTimes(1);
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
      // The highlighter and its TypeScript grammar are chunks of their own:
      // their first load on a busy CI runner can outlast waitFor's one second.
      await vi.waitFor(
        () => {
          const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre.shiki");
          expect(pre).not.toBeNull();
          expect(pre!.querySelector('span[style*="color"]')).not.toBeNull();
          // The one-shot HTML carries the theme background inline; the streamed
          // block does not, so this is still the open fence being tokenized.
          expect(pre!.style.backgroundColor).toBe("");
        },
        { timeout: 10_000 },
      );

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

  it("draws math the ways models write it and leaves prices and shell variables alone", async () => {
    const text = [
      "Sorting is $O(n \\log n)$ and \\(a+b\\) is short.",
      "",
      "\\[",
      "\\int_0^1 x\\,dx",
      "\\]",
      "",
      "It costs $5 and $10, and $HOME/$USER is a path.",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={text} cwd="/repo" />);
    try {
      // KaTeX is a chunk of its own: its first load on a busy CI runner can
      // outlast waitFor's one second.
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll(".chat-markdown-math .katex")).toHaveLength(2);
          expect(
            document.querySelector(".chat-markdown-math-display .katex-display"),
          ).not.toBeNull();
        },
        { timeout: 10_000 },
      );
      // The drawn formula keeps its TeX for screen readers and copying.
      expect(document.querySelector(".chat-markdown-math annotation")?.textContent).toBe(
        "O(n \\log n)",
      );
      expect(document.body.textContent).toContain(
        "It costs $5 and $10, and $HOME/$USER is a path.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows TeX it can't draw as written", async () => {
    const screen = await render(<ChatMarkdown text={"See $\\frac{1}{$ here."} cwd="/repo" />);
    try {
      await vi.waitFor(() => {
        const source = document.querySelector<HTMLElement>("code.chat-markdown-math-source");
        expect(source?.textContent).toBe("\\frac{1}{");
        expect(source?.title).toContain("couldn't be drawn");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("draws a finished mermaid block as a diagram, with its code a click away", async () => {
    const diagram = "```mermaid\nflowchart LR\n  Start --> Done\n```";
    // Still being written: the code, as it arrives.
    const screen = await render(
      <ChatMarkdown text={diagram.slice(0, -4)} cwd="/repo" isStreaming />,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(document.querySelector("[data-chat-markdown-diagram] svg")).toBeNull();
      expect(document.querySelector(".chat-markdown-codeblock pre")?.textContent).toContain(
        "Start --> Done",
      );

      // Closed, with nothing after it yet: drawn.
      await screen.rerender(<ChatMarkdown text={diagram} cwd="/repo" isStreaming />);
      await vi.waitFor(() => {
        expect(document.querySelector("[data-chat-markdown-diagram] svg")).not.toBeNull();
      });

      // And it stays drawn while the reply goes on.
      await screen.rerender(
        <ChatMarkdown text={`${diagram}\nThat is the`} cwd="/repo" isStreaming />,
      );
      await vi.waitFor(() => {
        const svg = document.querySelector("[data-chat-markdown-diagram] svg");
        expect(svg).not.toBeNull();
        expect(svg?.textContent).toContain("Start");
      });

      await page.getByRole("button", { name: "Show code" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-chat-markdown-diagram]")).toBeNull();
        expect(document.querySelector(".chat-markdown-codeblock pre")?.textContent).toContain(
          "flowchart LR",
        );
      });
      await page.getByRole("button", { name: "Show diagram" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-chat-markdown-diagram] svg")).not.toBeNull();
      });

      // The full-size view draws it at its own width, not the column's.
      await page.getByRole("button", { name: "View full size" }).click();
      await vi.waitFor(() => {
        const full = document.querySelector<HTMLElement>(".chat-markdown-diagram-full");
        expect(full?.querySelector("svg")).not.toBeNull();
        expect(full?.style.width).toMatch(/^\d+(\.\d+)?px$/);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a diagram it can't read as code, with the reason", async () => {
    const screen = await render(
      <ChatMarkdown text={"```mermaid\nflowchart LR\n  A -->\n```"} cwd="/repo" />,
    );
    try {
      await vi.waitFor(() => {
        expect(document.querySelector("[data-chat-markdown-diagram-error]")?.textContent).toMatch(
          /^Couldn't draw this diagram/,
        );
      });
      expect(document.querySelector("[data-chat-markdown-diagram]")).toBeNull();
      expect(document.querySelector(".chat-markdown-codeblock pre")?.textContent).toContain(
        "A -->",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("opens a picture from the web in the image viewer on a click or a pinch, not one in a link", async () => {
    const picture = `${location.origin}/apple-touch-icon.png`;
    const screen = await render(
      <>
        <ChatMarkdown
          text={`![Chart](${picture})\n\n[![Badge](${picture})](https://example.com/badge)`}
          cwd={undefined}
        />
        <ExpandedImageViewerHost />
      </>,
    );
    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    const chart = page.getByRole("button", { name: "Preview Chart" });
    const closeViewer = async () => {
      await userEvent.keyboard("{Escape}");
      await expect.element(viewer).not.toBeInTheDocument();
    };

    try {
      await chart.click();
      await expect.element(viewer.getByText("Chart")).toBeVisible();
      await closeViewer();

      // From the keyboard too.
      chart.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(viewer).toBeVisible();
      await closeViewer();

      // A trackpad pinch: a wheel with Ctrl held, spreading.
      chart
        .element()
        .dispatchEvent(
          new WheelEvent("wheel", { ctrlKey: true, deltaY: -8, bubbles: true, cancelable: true }),
        );
      await expect.element(viewer).toBeVisible();
      await closeViewer();

      // Two fingers spreading on a touch screen.
      const box = chart.element().getBoundingClientRect();
      const touch = (type: string, pointerId: number, x: number) =>
        chart.element().dispatchEvent(
          new PointerEvent(type, {
            pointerId,
            pointerType: "touch",
            clientX: box.left + x,
            clientY: box.top + box.height / 2,
            bubbles: true,
          }),
        );
      touch("pointerdown", 1, box.width / 2 - 10);
      touch("pointerdown", 2, box.width / 2 + 10);
      touch("pointermove", 2, box.width / 2 + 30);
      await expect.element(viewer).toBeVisible();
      await closeViewer();

      // In a link, a click is the link's.
      await page.getByRole("img", { name: "Badge" }).click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(viewer.elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("shows a picture for an image path an agent wrote in prose", async () => {
    const readFile = vi.fn(async (_input: { cwd: string; relativePath: string }) => ({
      kind: "image" as const,
      relativePath: "../Temp/shot.png",
      mimeType: "image/png",
      base64: PIXEL_PNG_BASE64,
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
        .toHaveAttribute("src", `data:image/png;base64,${PIXEL_PNG_BASE64}`);
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
      const chip = page.getByRole("link", { name: "before" });
      await expect.element(chip).toBeInTheDocument();
      // The chip says the file is gone; no thumbnail and no error box.
      await expect.element(chip, { timeout: 5_000 }).toHaveAttribute("data-missing");
      expect(readFile).toHaveBeenCalled();
      expect(document.querySelector('img[alt="before"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Preview before"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a sentence whole and dims its chips when the images it names are nowhere", async () => {
    // The agent named its screenshots but not the folder outside the project
    // it saved them to: the search turns up only a lookalike, the root nothing.
    const searchEntries = vi.fn(async () => ({
      entries: [{ path: "apps/web/public/left-arrow.png", kind: "file" as const }],
      truncated: false,
    }));
    const readFile = vi.fn(async (input: { cwd: string; relativePath: string }) => ({
      kind: "missing" as const,
      relativePath: input.relativePath,
    }));
    installReadFileEnvironment(
      readFile as unknown as EnvironmentApi["projects"]["readFile"],
      searchEntries as unknown as EnvironmentApi["projects"]["searchEntries"],
    );

    const screen = await renderWithQueryClient(
      <div style={{ width: 900 }}>
        <ChatMarkdown
          text="Cut into `1-left.png`, `2-right.png`, then `3-bottom.png`, in that order."
          cwd="/repo/project"
          environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
        />
      </div>,
    );

    try {
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("a.chat-markdown-file-link[data-missing]")).toHaveLength(
            3,
          );
        },
        { timeout: 5_000 },
      );
      expect(readFile.mock.calls.map(([input]) => input.relativePath).toSorted()).toEqual([
        "1-left.png",
        "2-right.png",
        "3-bottom.png",
      ]);
      // With no pictures to show, the chips stay on the sentence's one line.
      const chipTops = [...document.querySelectorAll("a.chat-markdown-file-link")].map(
        (chip) => chip.getBoundingClientRect().top,
      );
      expect(new Set(chipTops).size).toBe(1);
    } finally {
      await screen.unmount();
    }
  });

  it("finds an image cited by bare name wherever the project keeps it", async () => {
    const cwd = "/repo/project";
    setActiveFileViewerContext({
      environmentId: CHAT_MARKDOWN_ENVIRONMENT_ID,
      cwd,
      threadRef: CHAT_MARKDOWN_THREAD_REF,
    });
    // Search order puts a fuzzy lookalike first; only the exact name counts.
    const searchEntries = vi.fn(async () => ({
      entries: [
        { path: "docs/home-old.png", kind: "file" as const },
        { path: "docs/shots/home.png", kind: "file" as const },
      ],
      truncated: false,
    }));
    const readFile = vi.fn(async (input: { cwd: string; relativePath: string }) => ({
      kind: "image" as const,
      relativePath: input.relativePath,
      mimeType: "image/png",
      base64: PIXEL_PNG_BASE64,
      size: 70,
    }));
    installReadFileEnvironment(
      readFile as unknown as EnvironmentApi["projects"]["readFile"],
      searchEntries as unknown as EnvironmentApi["projects"]["searchEntries"],
    );

    const screen = await renderWithQueryClient(
      <ChatMarkdown
        text="The new layout is in `home.png`."
        cwd={cwd}
        environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
      />,
    );

    try {
      await expect
        .element(page.getByRole("img", { name: "home.png" }), { timeout: 5_000 })
        .toBeInTheDocument();
      expect(readFile.mock.calls.map(([input]) => input.relativePath)).toEqual([
        "docs/shots/home.png",
      ]);

      // Placed, the chip opens that file itself instead of searching again.
      await page.getByRole("link", { name: "home.png" }).click();
      await vi.waitFor(() => {
        expect(useFileViewerStore.getState().activePath).toBe("docs/shots/home.png");
      });
      expect(searchEntries).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("turns an absolute path in inline code into a chip that opens like a link", async () => {
    const cwd = "C:/Users/wilfr/OneDrive/Desktop/GitHubCode/badcode";
    const filePath = String.raw`C:\Users\wilfr\OneDrive\Desktop\Threadlines X posts\split-app\README.txt`;
    const screen = await render(<ChatMarkdown text={`Notes are in \`${filePath}\`.`} cwd={cwd} />);

    try {
      const chip = page.getByRole("link", { name: "README.txt" });
      await expect.element(chip).toHaveAttribute("href", toMarkdownFileUrlHref(filePath));
      await expect.element(chip).toHaveAttribute("data-workspace-scope", "external");

      // Outside the project and not a picture, so it goes to the editor, the
      // same as a markdown link to it would.
      await chip.click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock.mock.calls[0]?.[1]).toBe(filePath);
      });
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

  it("centers the copy button on a one-line code block", async () => {
    const screen = await render(<ChatMarkdown text={"```\nOne line\n```"} cwd="/repo/project" />);

    try {
      const copyButton = page.getByRole("button", { name: "Copy code block" });
      await expect.element(copyButton).toBeVisible();
      const block = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre")!;
      const blockRect = block.getBoundingClientRect();
      const buttonRect = copyButton.element().getBoundingClientRect();
      const blockMiddle = blockRect.top + blockRect.height / 2;
      const buttonMiddle = buttonRect.top + buttonRect.height / 2;
      expect(Math.abs(buttonMiddle - blockMiddle)).toBeLessThan(1);
    } finally {
      await screen.unmount();
    }
  });
});

/**
 * Find in chat counts matches from a model of what ChatMarkdown draws
 * (chatFindText) and paints them on what it actually drew (chatFindDom). The
 * two must agree block for block, or the count and the highlights drift
 * apart. This renders documents covering what the renderer turns into
 * something else and compares the model with the drawn text.
 */
describe("find in chat reads what ChatMarkdown draws", () => {
  const normalize = (blocks: ReadonlyArray<string>) =>
    blocks.map((block) => block.replace(/\s+/g, " ").trim());

  const corpus: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
    {
      name: "prose, emphasis, entities and escapes",
      text: "Plain *em* and **strong** and ~~struck~~ text.\n\nAT&amp;T and \\*stars\\* and a\nsoft break.\n\nLine one  \nline two after a hard break.",
    },
    {
      name: "links and chips",
      text: [
        "See [the docs](https://example.com/guide) and <https://example.com/bare>.",
        "",
        "Open [the reader](/repo/src/reader.ts), `src/writer.ts:12` and `src/a/index.ts` beside `src/b/index.ts`.",
        "",
        "Merged [Fix the flake](https://github.com/acme/app/pull/12) and https://github.com/acme/app/pull/13 too.",
        "",
        "Plain `inline code` and `http://localhost:5173/app` and http://localhost:3000 bare.",
      ].join("\n"),
    },
    {
      name: "lists, quotes, headings and tables",
      text: [
        "# Heading one",
        "",
        "- tight item",
        "- tight item with **bold**",
        "  - nested item",
        "",
        "1. loose item",
        "",
        "   second paragraph of the loose item",
        "",
        "2. another loose item",
        "",
        "> quoted line",
        "> still quoted",
        "",
        "| Step | Result |",
        "| --- | --- |",
        "| build | ok |",
        "| test | `3 failed` |",
        "",
        "---",
        "",
        "## Heading two",
      ].join("\n"),
    },
    {
      name: "code and raw HTML",
      text: [
        "```ts",
        "export function answer(): number {",
        "  return 42;",
        "}",
        "```",
        "",
        "Inline <b>tags</b> stay as text, and so does a block:",
        "",
        "<div>",
        "block html",
        "</div>",
      ].join("\n"),
    },
    {
      name: "math and diagrams",
      text: [
        "Sorting costs $O(n \\log n)$, not $5 or $10.",
        "",
        "$$",
        "\\sum_{i=1}^n i",
        "$$",
        "",
        "```mermaid",
        "flowchart LR",
        "  Start --> Done",
        "```",
        "",
        "And the end.",
      ].join("\n"),
    },
    {
      name: "images and skills",
      text: [
        "A remote image ![a flow diagram](https://example.invalid/flow.png) in a sentence.",
        "",
        "Run $review-pr next, then $unknown-skill.",
        "",
        "Example <!-- $review-pr --> end.",
      ].join("\n"),
    },
  ];

  for (const document of corpus) {
    it(`agrees on ${document.name}`, async () => {
      const skills = [{ name: "review-pr", displayName: "Review PR" }];
      const screen = await renderWithQueryClient(
        <div data-timeline-row-id="row">
          <div data-chat-find-body="">
            <ChatMarkdown
              text={document.text}
              cwd="/repo"
              environmentId={CHAT_MARKDOWN_ENVIRONMENT_ID}
              threadId={CHAT_MARKDOWN_THREAD_ID}
              skills={skills}
            />
          </div>
        </div>,
      );
      try {
        const expected = normalize(
          findableMarkdownBlocks({
            text: document.text,
            cwd: "/repo",
            skills,
            isStreaming: false,
            visualizations: true,
          }),
        );
        expect(expected.length).toBeGreaterThan(1);
        const row = window.document.querySelector('[data-timeline-row-id="row"]')!;
        // Code highlights and failed images land a few frames late.
        await vi.waitFor(() => {
          expect(normalize(readDrawnBlocks(row).map((block) => block.text))).toEqual(expected);
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(normalize(readDrawnBlocks(row).map((block) => block.text))).toEqual(expected);
      } finally {
        await screen.unmount();
      }
    });
  }
});

describe("ChatMarkdown code block commands", () => {
  const REPLY = MessageId.make("reply-1");
  const actionsWith = (runs: ReadonlyArray<OrchestrationCommandRun> = []): CommandRunActions => ({
    supported: true,
    dialect: "posix",
    cwdLabel: "~/repo",
    runs,
    startRun: vi.fn(),
    sendOutput: vi.fn(),
    setRequestDismissed: vi.fn(),
    showTerminal: vi.fn(),
    terminalLabel: () => "Terminal 2",
    agentLabel: () => "Codex",
  });
  const renderReply = (text: string, actions: CommandRunActions) =>
    renderWithQueryClient(
      <CommandRunActionsContext value={actions}>
        <CodeBlockRunScopeContext value={{ messageId: REPLY, participantId: null, text }}>
          <ChatMarkdown text={text} cwd="/repo" />
        </CodeBlockRunScopeContext>
      </CommandRunActionsContext>,
    );

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("runs an everyday command, and only puts a risky one in the terminal", async () => {
    const actions = actionsWith();
    const screen = await renderReply(
      "Run this:\n\n```bash\n# deps\npnpm install\n```\n\nThen:\n\n```bash\ngit reset --hard origin/main\n```\n",
      actions,
    );
    try {
      await page.getByRole("button", { name: "Run in terminal" }).click();
      expect(actions.startRun).toHaveBeenCalledWith({
        command: "pnpm install",
        mode: "run",
        source: { kind: "message", messageId: REPLY },
      });
      await expect.element(page.getByText("Throws away uncommitted changes.")).toBeInTheDocument();
      await page.getByRole("button", { name: "Put in terminal" }).click();
      expect(actions.startRun).toHaveBeenLastCalledWith({
        command: "git reset --hard origin/main",
        mode: "insert",
        source: { kind: "message", messageId: REPLY },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("finds a command in a block that names no shell, and skips a title", async () => {
    const actions: CommandRunActions = { ...actionsWith(), dialect: "powershell" };
    // The indented block is a code block too, but the server only reads
    // fenced ones, so it gets no button the server would refuse.
    const screen = await renderReply(
      "Push it:\n\n```\ngit push -u origin feat/board\n```\n\nTitle:\n\n```\nOne Board field per card\n```\n\nOr:\n\n    git status\n",
      actions,
    );
    try {
      await page.getByRole("button", { name: "Put in terminal" }).click();
      expect(actions.startRun).toHaveBeenCalledWith({
        command: "git push -u origin feat/board",
        mode: "insert",
        source: { kind: "message", messageId: REPLY },
      });
      expect(document.querySelectorAll(".chat-markdown-run-button")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows how the block's last run went and sends its output", async () => {
    const runId = CommandRunId.make("run-1");
    const actions = actionsWith([
      {
        runId,
        terminalId: "terminal-run",
        mode: "run",
        dialect: "posix",
        command: "pnpm install",
        source: { kind: "message", messageId: REPLY },
        turnId: TurnId.make("turn-1"),
        participantId: null,
        cwd: "/repo",
        autoSend: false,
        status: "finished",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:14.000Z",
        exitCode: 0,
        error: null,
        hasOutput: true,
        heldReason: null,
        outputSentAt: null,
        outputMessageId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:14.000Z",
      },
    ]);
    const screen = await renderReply("```bash\npnpm install\n```\n", actions);
    try {
      await expect.element(page.getByText("Finished in Terminal 2 · 14s")).toBeInTheDocument();
      await page.getByRole("button", { name: "Send output to Codex" }).click();
      expect(actions.sendOutput).toHaveBeenCalledWith(runId);
      await page.getByRole("button", { name: "Show terminal" }).click();
      expect(actions.showTerminal).toHaveBeenCalledWith("terminal-run");
      await expect.element(page.getByRole("button", { name: "Run again" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("leaves code blocks alone outside a settled agent reply", async () => {
    const screen = await renderWithQueryClient(
      <CommandRunActionsContext value={actionsWith()}>
        <ChatMarkdown text={"```bash\npnpm install\n```\n"} cwd="/repo" />
      </CommandRunActionsContext>,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Copy code block" }))
        .toBeInTheDocument();
      expect(document.querySelector(".chat-markdown-run-button")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
