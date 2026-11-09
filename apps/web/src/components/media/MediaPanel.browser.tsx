import "../../index.css";

import {
  EnvironmentId,
  type EnvironmentApi,
  MessageId,
  type OrchestrationChatMediaEntry,
  type OrchestrationProjectMediaEntry,
  ProjectId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { resetTestPage } from "../../lib/testPage.browser-harness";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { closeExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { ExpandedImageViewerHost } from "../chat/ExpandedImageViewerHost";
import { MediaPanel } from "./MediaPanel";
import {
  primeMediaThumbnail,
  resetMediaThumbnailsForTests,
  videoPosterKey,
} from "./mediaThumbnails";

const ENVIRONMENT_ID = EnvironmentId.make("environment-media-browser");
const PROJECT_ID = ProjectId.make("project-media-browser");
const THREAD_ID = ThreadId.make("thread-media-browser");
/** A 1x1 PNG, enough for the browser to decode and shrink. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function mediaEntry(
  overrides: Partial<OrchestrationProjectMediaEntry> &
    Pick<OrchestrationProjectMediaEntry, "relativePath">,
): OrchestrationProjectMediaEntry {
  return {
    threadId: THREAD_ID,
    threadTitle: "Refresh the screenshots",
    cwd: "/repo",
    repositoryPath: `app/${overrides.relativePath}`,
    mediaKind: "picture",
    change: "added",
    turnId: TurnId.make("turn-3"),
    checkpointTurnCount: 3,
    changedAt: "2026-03-01T00:03:00.000Z",
    assistantMessageId: null,
    size: 68,
    version: `${overrides.size ?? 68}-1`,
    ...overrides,
  } as OrchestrationProjectMediaEntry;
}

const THREAD_MEDIA = [
  mediaEntry({ relativePath: "shots/hero.png" }),
  // Listed, then deleted before its picture was read.
  mediaEntry({ relativePath: "shots/gone.png" }),
  mediaEntry({ relativePath: "shots/sidebar.png", change: "modified" }),
  mediaEntry({ relativePath: "docs/brief.pdf", mediaKind: "document", size: 2048 }),
  mediaEntry({ relativePath: "media/demo.mp4", mediaKind: "video", size: 4096 }),
  mediaEntry({ relativePath: "shots/logo.svg" }),
];
/** An SVG that carries a script, as a hostile repository might. */
const SCRIPTED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#36c"/><script>window.top.pwned = true</script></svg>';
/** One page that says "Hello PDF". */
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
const OTHER_THREAD_MEDIA = [
  mediaEntry({
    relativePath: "shots/retry-chart.png",
    threadId: ThreadId.make("thread-other"),
    threadTitle: "Checkout recovery",
  }),
];

function chatEntry(
  overrides: Partial<OrchestrationChatMediaEntry> &
    Pick<OrchestrationChatMediaEntry, "id" | "name" | "origin" | "source">,
): OrchestrationChatMediaEntry {
  return {
    threadId: THREAD_ID,
    threadTitle: "Refresh the screenshots",
    cwd: "/repo",
    mediaKind: "picture",
    sharedAt: "2026-03-01T00:04:00.000Z",
    messageId: MessageId.make("message-reply"),
    size: 68,
    version: "1",
    ...overrides,
  } as OrchestrationChatMediaEntry;
}

const CHAT_MEDIA = [
  chatEntry({
    id: "activity:shot#0000",
    name: "browser_screenshot.png",
    origin: "tool",
    source: { kind: "inline", mimeType: "image/png" },
  }),
  chatEntry({
    id: "message:reply#0000",
    name: "shot.png",
    origin: "reply",
    source: { kind: "file", path: "/tmp/shots/shot.png" },
  }),
  chatEntry({
    id: "message:ask#0000",
    name: "mock.png",
    origin: "attached",
    source: {
      kind: "attachment",
      attachment: {
        type: "image",
        id: "attachment-mock",
        name: "mock.png",
        mimeType: "image/png",
        sizeBytes: 68,
      },
    },
  }),
  chatEntry({
    id: "message:ask#0001",
    name: "brief.pdf",
    origin: "attached",
    mediaKind: "document",
    source: {
      kind: "attachment",
      attachment: {
        type: "file",
        kind: "pdf",
        id: "attachment-brief",
        name: "brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: 900,
      },
    },
  }),
];

function installApi(options: { readonly chat?: ReadonlyArray<OrchestrationChatMediaEntry> } = {}) {
  const listProjectMedia = vi.fn(async (input: { readonly threadId?: ThreadId }) => ({
    entries: input.threadId ? THREAD_MEDIA : [...THREAD_MEDIA, ...OTHER_THREAD_MEDIA],
    truncated: false,
    ...(options.chat ? { chat: options.chat, chatTruncated: false, chatIndexing: true } : {}),
  }));
  const readChatMedia = vi.fn(async () => ({
    kind: "image" as const,
    mimeType: "image/png",
    base64: PIXEL_PNG,
    size: 68,
  }));
  const readAttachment = vi.fn(async (input: { readonly attachmentId: string }) =>
    input.attachmentId === "attachment-brief"
      ? {
          attachmentId: input.attachmentId,
          mimeType: "application/pdf",
          base64: btoa(TINY_PDF),
          sizeBytes: TINY_PDF.length,
        }
      : {
          attachmentId: input.attachmentId,
          mimeType: "image/png",
          base64: PIXEL_PNG,
          sizeBytes: 68,
        },
  );
  const getTurnFile = vi.fn(async (input: { readonly path: string }) => ({
    kind: "image" as const,
    relativePath: input.path,
    mimeType: "image/png",
    base64: PIXEL_PNG,
    size: 68,
  }));
  const readFile = vi.fn(async (input: { readonly relativePath: string }) =>
    input.relativePath === "shots/gone.png"
      ? { kind: "missing" as const, relativePath: input.relativePath }
      : input.relativePath.endsWith(".svg")
        ? {
            kind: "image" as const,
            relativePath: input.relativePath,
            mimeType: "image/svg+xml",
            base64: btoa(SCRIPTED_SVG),
            size: SCRIPTED_SVG.length,
          }
        : input.relativePath.endsWith(".pdf")
          ? {
              kind: "document" as const,
              relativePath: input.relativePath,
              mimeType: "application/pdf",
              base64: btoa(TINY_PDF),
              size: TINY_PDF.length,
            }
          : {
              kind: "image" as const,
              relativePath: input.relativePath,
              mimeType: "image/png",
              base64: PIXEL_PNG,
              size: 68,
            },
  );
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    orchestration: { listProjectMedia, getTurnFile, readChatMedia },
    projects: { readFile },
    attachments: { read: readAttachment },
  } as unknown as EnvironmentApi);
  return { listProjectMedia, getTurnFile, readFile, readChatMedia, readAttachment };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <>
      <MediaPanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        turnsRevision="3"
        visible
        onGoToChat={() => undefined}
      />
      <ExpandedImageViewerHost />
    </>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AppAtomRegistryProvider>
          <QueryClientProvider client={queryClient}>
            <div style={{ width: 420, height: 720, display: "flex" }}>{children}</div>
          </QueryClientProvider>
        </AppAtomRegistryProvider>
      ),
    },
  );
}

describe("MediaPanel", () => {
  afterEach(async () => {
    closeExpandedImagePreview();
    resetMediaThumbnailsForTests();
    __resetEnvironmentApiOverridesForTests();
    await resetTestPage();
  });

  it("lists this thread's pictures and files, then every thread's", async () => {
    const api = installApi();
    await renderPanel();

    await expect.element(page.getByRole("button", { name: "Preview hero.png" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /brief\.pdf/ })).toBeVisible();
    expect(api.listProjectMedia).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      includeChat: true,
    });
    // A tile asks for its picture and shows a shrunk copy of it.
    await vi.waitFor(() => {
      const image = document.querySelector<HTMLImageElement>(
        '[data-media-tile="shots/hero.png"] img',
      );
      expect(image?.src.startsWith("blob:")).toBe(true);
    });
    // An SVG's tile holds pixels only, never its markup (which may carry
    // scripts) behind one of the app's own blob URLs.
    let svgTile: HTMLImageElement | null = null;
    await vi.waitFor(() => {
      svgTile = document.querySelector<HTMLImageElement>('[data-media-tile="shots/logo.svg"] img');
      expect(svgTile?.src.startsWith("blob:")).toBe(true);
    });
    const svgBlob = await (await fetch(svgTile!.src)).blob();
    expect(svgBlob.type).toBe("image/webp");
    expect(await svgBlob.text()).not.toContain("<script");
    // A file gone by the time its picture is read says so, and nothing else breaks.
    await expect.element(page.getByText("No longer on disk")).toBeVisible();
    // A PDF's tile shows its first page, read as a document.
    // pdf.js loads on first use, which takes a moment.
    await vi.waitFor(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          '[data-media-tile="docs/brief.pdf"] img',
        );
        expect(image?.src.startsWith("blob:")).toBe(true);
      },
      { timeout: 15_000 },
    );
    expect(api.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "docs/brief.pdf", documents: true }),
    );
    // A video never downloads to draw its tile; it shows its first frame
    // once a player has kept one.
    const videoTile = () =>
      document.querySelector<HTMLImageElement>('[data-media-tile="media/demo.mp4"] img');
    await expect.element(page.getByRole("button", { name: "Play demo.mp4" })).toBeVisible();
    expect(videoTile()).toBeNull();
    expect(api.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "media/demo.mp4" }),
    );
    primeMediaThumbnail(videoPosterKey(ENVIRONMENT_ID, "/repo/media/demo.mp4", "4096-1"), {
      blob: new Blob([Uint8Array.from(atob(PIXEL_PNG), (char) => char.charCodeAt(0))], {
        type: "image/png",
      }),
      size: 4096,
    });
    await vi.waitFor(() => expect(videoTile()?.src.startsWith("blob:")).toBe(true));

    await page.getByRole("button", { name: "All threads" }).click();
    await expect
      .element(page.getByRole("button", { name: "Preview retry-chart.png" }))
      .toBeVisible();
    expect(api.listProjectMedia).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      includeChat: true,
    });
    // Every thread's view says which thread made each file.
    await expect.element(page.getByText("Checkout recovery")).toBeVisible();
  });

  it("lists what was shared in chat after the files, read where the chat reads it", async () => {
    const api = installApi({ chat: CHAT_MEDIA });
    await renderPanel();

    const shared = page.getByRole("region", { name: "Shared in chat" });
    await expect.element(shared).toBeVisible();
    await expect.element(shared.getByText("Still looking through older chats.")).toBeVisible();
    for (const name of ["browser_screenshot.png", "shot.png", "mock.png", "brief.pdf"]) {
      await vi.waitFor(
        () => {
          const image = document.querySelector<HTMLImageElement>(`[data-media-tile="${name}"] img`);
          expect(image?.src.startsWith("blob:")).toBe(true);
        },
        { timeout: 15_000 },
      );
    }
    // A screenshot from the chat itself, a file from the thread's folder as
    // the chat reads it, and attachments from where they are stored.
    expect(api.readChatMedia).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      mediaId: "activity:shot#0000",
    });
    expect(api.readFile).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "/tmp/shots/shot.png",
    });
    expect(api.readAttachment).toHaveBeenCalledWith({ attachmentId: "attachment-mock" });
    await expect.element(shared.getByText("From a tool · ", { exact: false })).toBeVisible();

    // The viewer steps from the files into what was shared in chat.
    await page.getByRole("button", { name: "Preview browser_screenshot.png" }).click();
    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(viewer.getByText("From a tool · Refresh the screenshots")).toBeVisible();
    await expect
      .element(viewer.getByRole("button", { name: "Before", exact: true }))
      .not.toBeInTheDocument();
  });

  it("opens a changed picture full size, with its Before from the thread's start", async () => {
    const api = installApi();
    await renderPanel();

    await page.getByRole("button", { name: "Preview sidebar.png" }).click();
    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(viewer).toBeVisible();
    await expect
      .element(viewer.getByText("Changed in turn 3 · Refresh the screenshots"))
      .toBeVisible();

    await viewer.getByRole("button", { name: "Before" }).click();
    await vi.waitFor(() =>
      expect(api.getTurnFile).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        range: { kind: "thread", toTurnCount: 3 },
        side: "before",
        path: "app/shots/sidebar.png",
      }),
    );
    await expect.element(viewer.getByRole("img", { name: "sidebar.png, before" })).toBeVisible();
  });
});
