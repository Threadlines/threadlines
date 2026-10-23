import type { ScopedThreadRef } from "@threadlines/contracts";
import { assert, describe, it } from "vite-plus/test";
import {
  ATTENTION_NOTICE_VISIBLE_MS,
  NOTICE_VISIBLE_MS,
  buildVisibleToastLayout,
  resolveHiddenNoticeVisibleMs,
  resolveNoticeVisibleMs,
  selectStackNotices,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";

describe("shouldHideCollapsedToastContent", () => {
  it("keeps a single visible toast readable", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 1), false);
  });

  it("keeps the front-most toast readable in a visible stack", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false);
  });

  it("hides non-front toasts until the stack is expanded", () => {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true);
  });
});

describe("buildVisibleToastLayout", () => {
  it("computes indices and offsets from the visible subset", () => {
    const visibleToasts = [
      { id: "a", height: 48 },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ];

    const layout = buildVisibleToastLayout(visibleToasts);

    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        { id: "a", visibleIndex: 0, offsetY: 0 },
        { id: "b", visibleIndex: 1, offsetY: 48 },
        { id: "c", visibleIndex: 2, offsetY: 120 },
      ],
    );
  });

  it("reflows live toasts forward when the front toast is dismissed", () => {
    const visibleToasts = [
      { id: "a", height: 48, transitionStatus: "ending" as const },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ];

    const layout = buildVisibleToastLayout(visibleToasts);

    // frontmost height should be the first live toast, not the ending one
    assert.equal(layout.frontmostHeight, 72);
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        // Ending toast stays at its front slot; data-ending-style drives its exit
        { id: "a", visibleIndex: 0, offsetY: 0 },
        // Live toasts get fresh indices starting at 0 so they move up in sync
        { id: "b", visibleIndex: 0, offsetY: 0 },
        { id: "c", visibleIndex: 1, offsetY: 72 },
      ],
    );
  });

  it("keeps a non-front ending toast at its current slot so it exits straight", () => {
    const visibleToasts = [
      { id: "a", height: 48 },
      { id: "b", height: 72, transitionStatus: "ending" as const },
      { id: "c", height: 24 },
    ];

    const layout = buildVisibleToastLayout(visibleToasts);

    // front toast stays, so frontmost height is unchanged
    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        // Front live toast — unaffected
        { id: "a", visibleIndex: 0, offsetY: 0 },
        // Ending toast keeps its pre-dismissal slot so its horizontal exit
        // originates from where the user saw it (not from Y=0).
        { id: "b", visibleIndex: 1, offsetY: 48 },
        // Live toast behind "b" slides forward into the vacated slot.
        { id: "c", visibleIndex: 1, offsetY: 48 },
      ],
    );
  });

  it("treats missing heights as zero", () => {
    const layout = buildVisibleToastLayout([
      { id: "a" },
      { id: "b", height: undefined },
      { id: "c", height: 30 },
    ]);

    assert.equal(layout.frontmostHeight, 0);
    assert.deepEqual(
      layout.items.map(({ toast, offsetY }) => ({
        id: toast.id,
        offsetY,
      })),
      [
        { id: "a", offsetY: 0 },
        { id: "b", offsetY: 0 },
        { id: "c", offsetY: 0 },
      ],
    );
  });
});

describe("shouldRenderThreadScopedToast", () => {
  const activeThreadRef = {
    environmentId: "environment-a",
    threadId: "thread-1",
  } as ScopedThreadRef;

  it("renders a toast scoped to the active thread ref", () => {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadRef: activeThreadRef,
        },
        activeThreadRef,
      ),
      true,
    );
  });

  it("hides a scoped toast when the environment differs", () => {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadRef: {
            environmentId: "environment-b",
            threadId: "thread-1",
          } as ScopedThreadRef,
        },
        activeThreadRef,
      ),
      false,
    );
  });

  it("keeps legacy thread-id scoped toasts working", () => {
    assert.equal(
      shouldRenderThreadScopedToast(
        {
          threadId: "thread-1" as never,
        },
        activeThreadRef,
      ),
      true,
    );
  });
});

describe("selectStackNotices", () => {
  it("keeps an error in front of a newer confirmation", () => {
    const newestFirst = [
      { id: "copied", type: "success" },
      { id: "clone-failed", type: "error" },
      { id: "staging", type: "loading" },
      { id: "saved", type: "success" },
    ];
    assert.deepStrictEqual(
      selectStackNotices(newestFirst).map((notice) => notice.id),
      ["clone-failed", "staging", "copied", "saved"],
    );
  });

  it("leaves out notices waiting for a slot but keeps closing ones for their exit", () => {
    const newestFirst = [
      { id: "a", type: "error" },
      { id: "b", type: "success", transitionStatus: "ending" as const },
      { id: "c", type: "success" },
      { id: "d", type: "success", limited: true },
    ];
    assert.deepStrictEqual(
      selectStackNotices(newestFirst).map((notice) => notice.id),
      ["a", "b", "c"],
    );
  });
});

describe("resolveNoticeVisibleMs", () => {
  it("gives a short error ten seconds and a confirmation five", () => {
    assert.equal(
      resolveNoticeVisibleMs({ type: "error", description: "Path is empty." }, false),
      ATTENTION_NOTICE_VISIBLE_MS,
    );
    assert.equal(resolveNoticeVisibleMs({ type: "success" }, false), NOTICE_VISIBLE_MS);
  });

  it("keeps an error with a long reason or a next step until it is closed", () => {
    assert.equal(
      resolveNoticeVisibleMs(
        {
          type: "error",
          description:
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled. Check that you are signed in to GitHub.",
        },
        false,
      ),
      null,
    );
    assert.equal(resolveNoticeVisibleMs({ type: "warning", description: "Bad file." }, true), null);
  });

  it("lets the caller's duration and an explicit timeout of 0 win", () => {
    assert.equal(
      resolveNoticeVisibleMs(
        { type: "error", timeout: 0, data: { dismissAfterVisibleMs: 8_000 } },
        true,
      ),
      8_000,
    );
    assert.equal(resolveNoticeVisibleMs({ type: "success", timeout: 0 }, false), null);
    assert.equal(resolveNoticeVisibleMs({ type: "loading" }, false), null);
  });
});

describe("resolveHiddenNoticeVisibleMs", () => {
  it("counts down a notice for another thread even when it would stay until closed", () => {
    assert.equal(resolveHiddenNoticeVisibleMs({ type: "error" }), ATTENTION_NOTICE_VISIBLE_MS);
    assert.equal(resolveHiddenNoticeVisibleMs({ type: "success" }), NOTICE_VISIBLE_MS);
    assert.equal(resolveHiddenNoticeVisibleMs({ type: "loading" }), null);
  });
});
