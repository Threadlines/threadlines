import type { ScopedThreadRef, ThreadId } from "@threadlines/contracts";

export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

/**
 * How many live notices the stack draws at once; Base UI holds back the rest
 * (marking them `limited`) until a slot frees up.
 */
export const NOTICE_STACK_LIMIT = 3;

/** How long a notice stays on screen when its caller doesn't say. */
export const NOTICE_VISIBLE_MS = 5_000;
/** Errors and warnings get longer: they usually have a reason to read. */
export const ATTENTION_NOTICE_VISIBLE_MS = 10_000;
/** A reason this long runs past two lines, more than anyone reads in ten seconds. */
const STICKY_REASON_MIN_CHARS = 100;

type NoticeForStack = {
  type?: string | undefined;
  limited?: boolean | undefined;
  transitionStatus?: "starting" | "ending" | undefined;
};

function isAttentionNotice(type: string | undefined): boolean {
  return type === "error" || type === "warning";
}

/**
 * The notices the stack draws, front first: the ones Base UI hasn't held back,
 * with errors, warnings and work in progress ahead of everything else (newest
 * first within each group), so a "Path copied" never lands on top of an error.
 * Closing notices stay, so their exit animation can finish.
 */
export function selectStackNotices<TNotice extends NoticeForStack>(
  newestFirst: readonly TNotice[],
): TNotice[] {
  const drawn = newestFirst.filter(
    (notice) => notice.transitionStatus === "ending" || !notice.limited,
  );
  const inFront = (notice: TNotice) => isAttentionNotice(notice.type) || notice.type === "loading";
  return [...drawn.filter(inFront), ...drawn.filter((notice) => !inFront(notice))];
}

/**
 * How long a notice stays once it is on screen, or null when it stays until
 * closed. The clock only runs while the notice is drawn, the window is in
 * front, and the pointer or focus isn't on the stack.
 *
 * Work in progress never times out. A caller's `dismissAfterVisibleMs` wins,
 * then an explicit `timeout: 0`. Otherwise errors and warnings stay until
 * closed when they offer a next step (any button) or carry a long reason, and
 * get ten seconds when short; everything else gets five.
 */
export function resolveNoticeVisibleMs(
  notice: {
    readonly type?: string | undefined;
    readonly timeout?: number | undefined;
    readonly description?: unknown;
    readonly data?: { readonly dismissAfterVisibleMs?: number | undefined } | undefined;
  },
  hasNextStep: boolean,
): number | null {
  if (notice.type === "loading") return null;
  const requested = notice.data?.dismissAfterVisibleMs;
  if (requested !== undefined && requested > 0) return requested;
  if (notice.timeout === 0) return null;
  if (isAttentionNotice(notice.type)) {
    const hasLongReason =
      typeof notice.description === "string" &&
      notice.description.length >= STICKY_REASON_MIN_CHARS;
    return hasNextStep || hasLongReason ? null : ATTENTION_NOTICE_VISIBLE_MS;
  }
  return NOTICE_VISIBLE_MS;
}

/**
 * How long a notice for another thread stays while that thread isn't open:
 * as long as a short notice of its kind, even one that would otherwise stay
 * until closed, so it can't hold one of the stack's slots indefinitely. Work
 * in progress still never times out. Back on its thread, the usual rule
 * applies again.
 */
export function resolveHiddenNoticeVisibleMs(notice: {
  readonly type?: string | undefined;
  readonly data?: { readonly dismissAfterVisibleMs?: number | undefined } | undefined;
}): number | null {
  if (notice.type === "loading") return null;
  const requested = notice.data?.dismissAfterVisibleMs;
  if (requested !== undefined && requested > 0) return requested;
  return isAttentionNotice(notice.type) ? ATTENTION_NOTICE_VISIBLE_MS : NOTICE_VISIBLE_MS;
}

/**
 * Whether a notice shows its whole title and reason, with any buttons in a row
 * underneath. Errors and warnings with a reason do, so the reason is never cut
 * short; so does any notice with a button, so the buttons never squeeze the
 * words beside them, and anything built with `stackedThreadToast`. The rest
 * keep the title and reason to a line each until clicked.
 */
export function shouldStackNoticeBody(notice: {
  readonly type?: string | undefined;
  readonly hasDescription: boolean;
  readonly hasButtons: boolean;
  readonly requestsStackedLayout: boolean;
}): boolean {
  return (
    notice.requestsStackedLayout ||
    notice.hasButtons ||
    (isAttentionNotice(notice.type) && notice.hasDescription)
  );
}

type ToastWithHeight = {
  height?: number | null | undefined;
};

type ToastWithTransitionStatus = {
  transitionStatus?: "starting" | "ending" | undefined;
};

type ToastWithLayoutProps = ToastWithHeight & ToastWithTransitionStatus;

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithLayoutProps)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithLayoutProps>[];
} {
  // Two parallel cursors:
  //   - `full*`  advances on every toast, so an ending toast keeps the slot it
  //     occupied before dismissal and its data-ending-style exit transform
  //     originates from the correct position (critical for dismissing a
  //     non-front toast in the expanded stack — otherwise it would snap to
  //     Y=0 and slide off diagonally).
  //   - `live*`  advances only on non-ending toasts, so live toasts reflow
  //     past the vacated slot in parallel with the exit animation instead of
  //     waiting for it to finish (which caused a visible "stop and bump").
  let fullIndex = 0;
  let fullOffsetY = 0;
  let liveIndex = 0;
  let liveOffsetY = 0;

  const items: VisibleToastLayoutItem<TToast & ToastWithLayoutProps>[] = visibleToasts.map(
    (toast) => {
      const height = normalizeToastHeight(toast.height);

      if (toast.transitionStatus === "ending") {
        const item = {
          toast,
          visibleIndex: fullIndex,
          offsetY: fullOffsetY,
        };
        fullOffsetY += height;
        fullIndex += 1;
        return item;
      }

      const item = {
        toast,
        visibleIndex: liveIndex,
        offsetY: liveOffsetY,
      };

      fullOffsetY += height;
      fullIndex += 1;
      liveOffsetY += height;
      liveIndex += 1;
      return item;
    },
  );

  // Frontmost height should reflect the first non-ending (live) toast so the
  // stack sizes to what's actually staying on screen.
  const frontmostLiveToast = visibleToasts.find((toast) => toast.transitionStatus !== "ending");

  return {
    frontmostHeight: normalizeToastHeight(frontmostLiveToast?.height),
    items,
  };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}

/** True unless `activeThreadRef` is the same thread as `threadRef`. */
export function isAnotherThread(
  threadRef: ScopedThreadRef,
  activeThreadRef: ScopedThreadRef | null,
): boolean {
  return (
    activeThreadRef === null ||
    threadRef.environmentId !== activeThreadRef.environmentId ||
    threadRef.threadId !== activeThreadRef.threadId
  );
}

export function shouldRenderThreadScopedToast(
  data:
    | {
        threadRef?: ScopedThreadRef | null;
        threadId?: ThreadId | null;
      }
    | undefined,
  activeThreadRef: ScopedThreadRef | null,
): boolean {
  if (data?.threadRef) {
    return !isAnotherThread(data.threadRef, activeThreadRef);
  }

  const toastThreadId = data?.threadId;
  if (!toastThreadId) {
    return true;
  }

  return activeThreadRef?.threadId === toastThreadId;
}

/**
 * The reason a failure notice shows for a raw error: its message without a
 * leading type tag ("TypeError: Failed to fetch" reads "Failed to fetch").
 */
export function describeFailureReason(message: string): string {
  return message.trim().replace(/^[A-Z][A-Za-z]*Error:\s*/, "") || "Something went wrong.";
}
