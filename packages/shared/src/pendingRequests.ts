/**
 * Shared accounting for provider prompt requests (tool approvals and
 * structured user-input questions) derived from a thread's activity stream.
 *
 * A request is open once a `*.requested` activity carrying its `requestId`
 * appears, and closes on a matching `*.resolved` activity or a
 * `provider.*.respond.failed` activity whose failure detail shows the request
 * can never be answered (see {@link isStalePendingRequestFailureDetail}).
 *
 * The server projections, the provider command reactor, and the web client
 * must all replay these rules identically — a prompt the server considers
 * closed but the web still renders leaves the user with a Submit button that
 * can never succeed.
 */

export interface PendingRequestActivityKinds {
  readonly requested: string;
  readonly resolved: string;
  readonly respondFailed: string;
}

export const APPROVAL_ACTIVITY_KINDS: PendingRequestActivityKinds = {
  requested: "approval.requested",
  resolved: "approval.resolved",
  respondFailed: "provider.approval.respond.failed",
};

export const USER_INPUT_ACTIVITY_KINDS: PendingRequestActivityKinds = {
  requested: "user-input.requested",
  resolved: "user-input.resolved",
  respondFailed: "provider.user-input.respond.failed",
};

/**
 * `reason` payload value on `*.resolved` activities appended when a pending
 * request is closed because its provider session stopped rather than because
 * the provider answered it.
 */
export const PENDING_REQUEST_EXPIRED_REASON = "session-stopped";

const STALE_PENDING_REQUEST_DETAIL_MARKERS = [
  "no active provider session",
  "stale pending approval request",
  "stale pending user-input request",
  "unknown pending approval request",
  "unknown pending codex approval request",
  "unknown pending permission request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

/**
 * Whether a respond-failure detail proves the pending request is
 * unanswerable (the provider no longer knows the request, or no provider
 * session exists to deliver the answer to), so the request must be treated
 * as closed instead of retried.
 */
export function isStalePendingRequestFailureDetail(detail: string | null | undefined): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return STALE_PENDING_REQUEST_DETAIL_MARKERS.some((marker) => normalized.includes(marker));
}

export function extractPendingRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function extractFailureDetail(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : null;
}

export interface PendingRequestActivityLike {
  readonly kind: string;
  readonly payload?: unknown;
}

export interface OpenPendingRequest<A extends PendingRequestActivityLike> {
  readonly requestId: string;
  /** The latest `requested` activity observed for this request id. */
  readonly activity: A;
}

/**
 * Replays `orderedActivities` (callers must pass them in thread order) and
 * returns the requests that are still open, in the order they were opened.
 */
export function collectOpenPendingRequests<A extends PendingRequestActivityLike>(
  orderedActivities: ReadonlyArray<A>,
  kinds: PendingRequestActivityKinds,
): Array<OpenPendingRequest<A>> {
  const openByRequestId = new Map<string, OpenPendingRequest<A>>();

  for (const activity of orderedActivities) {
    const requestId = extractPendingRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }

    if (activity.kind === kinds.requested) {
      openByRequestId.set(requestId, { requestId, activity });
      continue;
    }

    if (activity.kind === kinds.resolved) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === kinds.respondFailed &&
      isStalePendingRequestFailureDetail(extractFailureDetail(activity.payload))
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}
