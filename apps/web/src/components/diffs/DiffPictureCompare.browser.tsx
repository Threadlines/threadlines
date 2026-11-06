import "../../index.css";

import { EnvironmentId, type EnvironmentApi, ThreadId } from "@threadlines/contracts";
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
import { resetMediaThumbnailsForTests } from "../media/mediaThumbnails";
import { DiffPictureCompare, type DiffPictureSource } from "./DiffPictureCompare";

const ENVIRONMENT_ID = EnvironmentId.make("environment-diff-picture-browser");
const THREAD_ID = ThreadId.make("thread-diff-picture-browser");
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function installApi() {
  const picture = async (input: { readonly path: string }) => ({
    kind: "image" as const,
    relativePath: input.path,
    mimeType: "image/png",
    base64: PIXEL_PNG,
    size: 68,
  });
  const getTurnFile = vi.fn(picture);
  const readRepositoryFile = vi.fn(picture);
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    orchestration: { getTurnFile },
    vcs: { readRepositoryFile },
  } as unknown as EnvironmentApi);
  return { getTurnFile, readRepositoryFile };
}

function renderCompare(props: {
  readonly change: "new" | "deleted" | "changed";
  readonly source: DiffPictureSource;
  readonly previousPath?: string;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DiffPictureCompare
      environmentId={ENVIRONMENT_ID}
      path="art/hero.png"
      previousPath={props.previousPath}
      change={props.change}
      source={props.source}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <div style={{ width: 480 }}>{children}</div>
        </QueryClientProvider>
      ),
    },
  );
}

const shownPictures = () =>
  document.querySelectorAll<HTMLImageElement>("[data-diff-picture-compare] img").length;

describe("DiffPictureCompare", () => {
  afterEach(async () => {
    resetMediaThumbnailsForTests();
    __resetEnvironmentApiOverridesForTests();
    await resetTestPage();
  });

  it("shows a turn's picture before and after, from that turn's snapshots", async () => {
    const api = installApi();
    await renderCompare({
      change: "changed",
      source: { kind: "turns", threadId: THREAD_ID, range: { kind: "turn", turnCount: 2 } },
    });

    await vi.waitFor(() => expect(shownPictures()).toBe(2));
    expect(api.getTurnFile).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      range: { kind: "turn", turnCount: 2 },
      side: "before",
      path: "art/hero.png",
    });
    expect(api.getTurnFile).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      range: { kind: "turn", turnCount: 2 },
      side: "after",
      path: "art/hero.png",
    });
    await expect.element(page.getByText("Before · 1×1 · 68 B")).toBeVisible();
  });

  it("reads an uncommitted rename's Before from the last commit under its old name", async () => {
    const api = installApi();
    await renderCompare({
      change: "changed",
      previousPath: "art/old-hero.png",
      source: { kind: "workingTree", cwd: "/repo", revision: "1" },
    });

    await vi.waitFor(() => expect(shownPictures()).toBe(2));
    expect(api.readRepositoryFile).toHaveBeenCalledWith({
      cwd: "/repo",
      path: "art/old-hero.png",
      source: "head",
    });
    expect(api.readRepositoryFile).toHaveBeenCalledWith({
      cwd: "/repo",
      path: "art/hero.png",
      source: "worktree",
    });
  });

  it("shows a new picture's After alone", async () => {
    const api = installApi();
    await renderCompare({
      change: "new",
      source: { kind: "turns", threadId: THREAD_ID, range: { kind: "thread", toTurnCount: 3 } },
    });

    await vi.waitFor(() => expect(shownPictures()).toBe(1));
    await expect.element(page.getByText("New file")).toBeVisible();
    expect(api.getTurnFile).toHaveBeenCalledTimes(1);
    expect(api.getTurnFile).toHaveBeenCalledWith(expect.objectContaining({ side: "after" }));
  });
});
