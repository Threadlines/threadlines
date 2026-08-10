// The rows truncate and reveal their discard button from CSS, so the
// production stylesheet is part of the behaviour under test.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId, ProjectId, ThreadId } from "@threadlines/contracts";
import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { SidebarDraftBlock, type SidebarDraftProjectInfo } from "./SidebarDrafts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-badcode");
const OTHER_PROJECT_ID = ProjectId.make("project-marketing");
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
const OTHER_PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, OTHER_PROJECT_ID);

const PROJECT_INFO = new Map<string, SidebarDraftProjectInfo>([
  [
    scopedProjectKey(PROJECT_REF),
    {
      projectKey: scopedProjectKey(PROJECT_REF),
      displayName: "badcode",
      cwd: "/Users/test/badcode",
      isGeneralChat: false,
    },
  ],
  [
    scopedProjectKey(OTHER_PROJECT_REF),
    {
      projectKey: scopedProjectKey(OTHER_PROJECT_REF),
      displayName: "marketing",
      cwd: "/Users/test/marketing",
      isGeneralChat: false,
    },
  ],
]);

function seedDraft(input: {
  draftId: DraftId;
  projectRef: typeof PROJECT_REF;
  createdAt: string;
  prompt?: string;
}): void {
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(input.projectRef, input.draftId, {
    threadId: ThreadId.make(`thread-${input.draftId}`),
    createdAt: input.createdAt,
  });
  if (input.prompt !== undefined) {
    store.setPrompt(input.draftId, input.prompt);
  }
}

function renderDraftBlock(input: {
  routeDraftId?: string | null;
  onNavigateToDraft?: (draftId: DraftId) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The route the user is on is the one prop that changes under this block, so
  // the harness owns it — that is what freezes the open draft's row.
  function Harness() {
    const [routeDraftId, setRouteDraftId] = useState<string | null>(input.routeDraftId ?? null);
    return (
      <QueryClientProvider client={queryClient}>
        <button type="button" data-testid="leave-draft" onClick={() => setRouteDraftId(null)}>
          Leave draft
        </button>
        <SidebarDraftBlock
          projectInfoByScopedRef={PROJECT_INFO}
          scopedProjectKey={null}
          routeDraftId={routeDraftId}
          onNavigateToDraft={input.onNavigateToDraft ?? vi.fn()}
        />
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}

describe("SidebarDraftBlock", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("lists invested drafts newest first and navigates back to one on click", async () => {
    seedDraft({
      draftId: DraftId.make("draft-old"),
      projectRef: PROJECT_REF,
      createdAt: "2026-08-01T00:00:00.000Z",
      prompt: "older idea\nsecond line",
    });
    seedDraft({
      draftId: DraftId.make("draft-new"),
      projectRef: OTHER_PROJECT_REF,
      createdAt: "2026-08-02T00:00:00.000Z",
      prompt: "newer idea",
    });
    // Settings alone are not user content, so this one earns no row.
    seedDraft({
      draftId: DraftId.make("draft-empty"),
      projectRef: PROJECT_REF,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const onNavigateToDraft = vi.fn();

    renderDraftBlock({ onNavigateToDraft });

    const previews = page.getByTestId("sidebar-draft-preview");
    await expect.element(previews.first()).toHaveTextContent("newer idea");
    expect(await previews.all()).toHaveLength(2);
    // Only the first line of a multi-line prompt.
    await expect.element(previews.nth(1)).toHaveTextContent("older idea");
    await expect.element(previews.nth(1)).not.toHaveTextContent("second line");

    await page.getByTestId("sidebar-draft-row").first().click();

    expect(onNavigateToDraft).toHaveBeenCalledWith(DraftId.make("draft-new"));
  });

  it("confirms before discarding a draft", async () => {
    seedDraft({
      draftId: DraftId.make("draft-old"),
      projectRef: PROJECT_REF,
      createdAt: "2026-08-01T00:00:00.000Z",
      prompt: "typed work worth keeping",
    });

    renderDraftBlock({});

    await page.getByTestId("sidebar-draft-discard").click();
    await expect.element(page.getByText("Discard draft?")).toBeVisible();
    // The draft is still there while the dialog is open.
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("draft-old"))).not.toBe(
      null,
    );

    await page.getByRole("button", { name: "Discard" }).click();

    await expect.element(page.getByTestId("sidebar-draft-row")).not.toBeInTheDocument();
    expect(useComposerDraftStore.getState().getDraftSession(DraftId.make("draft-old"))).toBe(null);
  });

  it("shows no row for the open draft until the user navigates away from it", async () => {
    const draftId = DraftId.make("draft-open");
    seedDraft({
      draftId,
      projectRef: PROJECT_REF,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    renderDraftBlock({ routeDraftId: draftId });

    // Typing in the draft you are looking at must not push a row into the
    // sidebar under your cursor.
    useComposerDraftStore.getState().setPrompt(draftId, "still writing this");
    await expect.element(page.getByTestId("sidebar-draft-row")).not.toBeInTheDocument();

    await page.getByTestId("leave-draft").click();

    await expect
      .element(page.getByTestId("sidebar-draft-preview"))
      .toHaveTextContent("still writing this");
  });
});
