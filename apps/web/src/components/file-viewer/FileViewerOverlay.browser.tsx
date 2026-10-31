import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EnvironmentId,
  type EnvironmentApi,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ServerConfig,
  ThreadId,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const { openInEditorMock } = vi.hoisted(() => ({
  openInEditorMock: vi.fn(async () => undefined),
}));

vi.mock("../../localApi", () => {
  const api = {
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openInEditor: openInEditorMock },
    server: { getConfig: vi.fn(async () => ({ availableEditors: [] })) },
    persistence: {
      getClientSettings: vi.fn(async () => null),
      setClientSettings: vi.fn(async () => undefined),
    },
  };
  return { readLocalApi: () => api, ensureLocalApi: () => api };
});

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import { useFileViewerStore } from "../../fileViewerStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import FileViewerOverlay from "./FileViewerOverlay";

const ENVIRONMENT_ID = EnvironmentId.make("environment-file-viewer-browser");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-file-viewer-browser"));
const CWD = "/Users/me/project";

/** One page that says "Hello PDF": enough for pdf.js to lay out and search. */
const TINY_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
  "4 0 obj<</Length 44>>stream",
  "BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET",
  "endstream endobj",
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

function installProjects(projects: Partial<EnvironmentApi["projects"]>) {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    projects: {
      listEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      searchEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      ...projects,
    },
  } as unknown as EnvironmentApi);
}

async function renderViewerAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useFileViewerStore
    .getState()
    .open(
      { environmentId: ENVIRONMENT_ID, cwd: CWD, threadRef: THREAD_REF },
      { kind: "file", path },
    );
  return render(<FileViewerOverlay />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppAtomRegistryProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </AppAtomRegistryProvider>
    ),
  });
}

describe("FileViewerOverlay", () => {
  afterEach(() => {
    useFileViewerStore.setState({
      isOpen: false,
      context: null,
      tabs: [],
      activePath: null,
      previewPath: null,
      editMode: false,
      editSaveState: {},
    });
    __resetEnvironmentApiOverridesForTests();
    resetServerStateForTests();
    writePrimaryEnvironmentDescriptor(null);
    openInEditorMock.mockClear();
    document.body.innerHTML = "";
  });

  it("opens a file outside the project, lists it apart, and puts its original back", async () => {
    const path = "/Users/me/.claude/CLAUDE.md";
    const edited: ProjectReadFileResult = {
      kind: "text",
      relativePath: path,
      content: "# Edited\n",
      size: 9,
      truncated: false,
      contentHash: "hash-edited",
      original: { savedAt: "2026-10-29T16:12:00.000Z" },
    };
    const readFile = vi.fn(async () => edited);
    const restoreOriginal = vi.fn(async () => ({
      kind: "restored" as const,
      relativePath: path,
      content: "# Original\n",
      contentHash: "hash-original",
      size: 11,
    }));
    installProjects({ readFile, restoreOriginal } as unknown as Partial<
      EnvironmentApi["projects"]
    >);
    const screen = await renderViewerAt(path);

    try {
      await expect.element(page.getByText("Outside this project")).toBeInTheDocument();
      // The header names it from home, the way people write it.
      await expect.element(page.getByText("~/.claude/CLAUDE.md")).toBeInTheDocument();

      await page.getByRole("button", { name: "Edit file" }).click();
      await expect
        .element(page.getByText("All changes saved · outside this project, not tracked by git"))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Restore original" }).click();

      await vi.waitFor(() => {
        expect(restoreOriginal).toHaveBeenCalledWith({
          cwd: CWD,
          relativePath: path,
          expectedContentHash: "hash-edited",
        });
      });
      // Used up: nothing left to restore until the next save.
      await expect
        .element(page.getByRole("button", { name: "Restore original" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("says why a file can't be edited", async () => {
    installProjects({
      readFile: vi.fn(async () => ({
        kind: "text" as const,
        relativePath: "/etc/hosts",
        content: "127.0.0.1 localhost\n",
        size: 20,
        truncated: false,
        contentHash: "hash-hosts",
        editBlock: "read-only" as const,
      })),
    } as unknown as Partial<EnvironmentApi["projects"]>);
    const screen = await renderViewerAt("/etc/hosts");

    try {
      const edit = page.getByRole("button", { name: "Edit file" });
      await expect.element(edit).toHaveAttribute("aria-disabled", "true");
      // The reason shows on hover, and a click doesn't start editing.
      await edit.hover();
      await expect
        .element(page.getByText("This file is read-only on disk"), { timeout: 3_000 })
        .toBeInTheDocument();
      // Forced: the test browser won't click what says it is unavailable,
      // but a person's mouse can.
      await edit.click({ force: true });
      expect(useFileViewerStore.getState().editMode).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("offers Reveal and Copy path for a file it can't show", async () => {
    const path = "/Users/me/Desktop/Proposal.docx";
    setServerConfigSnapshot({ availableEditors: ["file-manager"] } as unknown as ServerConfig);
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_ID,
      label: "This Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.8.0",
      capabilities: { repositoryIdentity: true },
    });
    installProjects({
      readFile: vi.fn(async () => ({ kind: "binary" as const, relativePath: path, size: 20_480 })),
    } as unknown as Partial<EnvironmentApi["projects"]>);
    const screen = await renderViewerAt(path);

    try {
      await expect
        .element(page.getByText("Proposal.docx can't be shown here (20 KB)."))
        .toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
      // The card's own button (the header's open button reveals too when the
      // file manager is the only app there is).
      await page.getByRole("button", { name: "Reveal in Finder" }).last().click();
      await vi.waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith(path, "file-manager", CWD);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows an SVG as a picture, with its source a click away", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    const readFile = vi.fn(async (input: ProjectReadFileInput) =>
      input.as === "text"
        ? {
            kind: "text" as const,
            relativePath: "logo.svg",
            content: svg,
            size: svg.length,
            truncated: false,
            contentHash: "hash-svg",
          }
        : {
            kind: "image" as const,
            relativePath: "logo.svg",
            mimeType: "image/svg+xml",
            base64: btoa(svg),
            size: svg.length,
          },
    );
    installProjects({ readFile } as unknown as Partial<EnvironmentApi["projects"]>);
    const screen = await renderViewerAt("logo.svg");

    try {
      await expect
        .element(page.getByRole("button", { name: "Preview logo.svg" }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Show source" }).click();
      await expect.element(page.getByText("SVG source")).toBeInTheDocument();
      expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ as: "text" }));

      // Editing keeps the way back to the picture, and taking it ends editing.
      await page.getByRole("button", { name: "Edit file" }).click();
      await expect.element(page.getByText("Changes save automatically")).toBeInTheDocument();
      await expect.element(page.getByText("SVG source")).toBeInTheDocument();
      await page.getByRole("button", { name: "Show picture" }).click();
      await expect
        .element(page.getByRole("button", { name: "Preview logo.svg" }))
        .toBeInTheDocument();
      expect(useFileViewerStore.getState().editMode).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("lays a PDF out and finds words in it", async () => {
    installProjects({
      readFile: vi.fn(async () => ({
        kind: "document" as const,
        relativePath: "spec.pdf",
        mimeType: "application/pdf",
        base64: btoa(TINY_PDF),
        size: TINY_PDF.length,
      })),
    } as unknown as Partial<EnvironmentApi["projects"]>);
    const screen = await renderViewerAt("spec.pdf");

    try {
      await expect.element(page.getByText("Page 1 of 1"), { timeout: 15_000 }).toBeInTheDocument();
      await expect.element(page.getByLabelText("Find in spec.pdf")).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });
});
