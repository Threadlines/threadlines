/**
 * Keys agents asked the user for on a thread (docs/design/secret-requests.md),
 * folded from its events. The projector, the projection pipeline and the web
 * store all fold with these, so a snapshot and live events agree on the card,
 * the saved rows and Pending Approval. Each returns the same array when
 * nothing changed. Nothing here ever holds a value.
 */
import type {
  OrchestrationEvent,
  OrchestrationSecretRequest,
  SecretRequestId,
  ThreadParticipantId,
  ThreadSecretRequestClaimedPayload,
  ThreadSecretRequestCreatedPayload,
  ThreadSecretRequestNotesDeliveredPayload,
  ThreadSecretRequestRemovedPayload,
  ThreadSecretRequestSettledPayload,
} from "@threadlines/contracts";

type Requests = ReadonlyArray<OrchestrationSecretRequest>;

/** Settled requests kept beyond the ones still needed, newest first. */
export const SETTLED_SECRET_REQUESTS_KEPT = 20;

/** On its card, or being saved: not settled yet. */
export const isOpenSecretRequest = (request: OrchestrationSecretRequest): boolean =>
  request.status === "waiting" || request.status === "claimed";

/** A saved `commands` key whose file is still there: Remove now and its expiry need it. */
export const isLiveCommandsSecret = (request: OrchestrationSecretRequest): boolean =>
  request.status === "saved" && request.use.kind === "commands" && request.removedAt === undefined;

/** Kept whatever its age: open, a live file, or a note still owed. */
const isNeeded = (request: OrchestrationSecretRequest): boolean =>
  isOpenSecretRequest(request) || isLiveCommandsSecret(request) || !request.noted;

/** Keeps every needed request and the newest settled others, in the order they were asked. */
function pruned(requests: Requests): Requests {
  const others = requests.filter((request) => !isNeeded(request));
  if (others.length <= SETTLED_SECRET_REQUESTS_KEPT) return requests;
  const newest = new Set(
    [...others]
      .sort((a, b) => (b.settledAt ?? b.createdAt).localeCompare(a.settledAt ?? a.createdAt))
      .slice(0, SETTLED_SECRET_REQUESTS_KEPT),
  );
  return requests.filter((request) => isNeeded(request) || newest.has(request));
}

function update(
  requests: Requests,
  requestId: SecretRequestId,
  change: (request: OrchestrationSecretRequest) => OrchestrationSecretRequest | null,
): Requests {
  let changed = false;
  const next = requests.map((request) => {
    if (request.requestId !== requestId) return request;
    const updated = change(request);
    if (updated === null || updated === request) return request;
    changed = true;
    return updated;
  });
  return changed ? next : requests;
}

export const secretRequestStateOn = {
  /** A new card; the waiting ones it names are replaced by it (no note: the newer one stands). */
  created(requests: Requests, payload: typeof ThreadSecretRequestCreatedPayload.Type): Requests {
    const { request } = payload;
    if (requests.some((existing) => existing.requestId === request.requestId)) return requests;
    const replaced = new Set<string>(payload.replaces ?? []);
    const next = requests.map((existing) =>
      existing.status === "waiting" && replaced.has(existing.requestId)
        ? { ...existing, status: "replaced" as const, settledAt: request.createdAt, noted: true }
        : existing,
    );
    return pruned([...next, request]);
  },

  claimed(requests: Requests, payload: typeof ThreadSecretRequestClaimedPayload.Type): Requests {
    return update(requests, payload.requestId, (request) =>
      request.status === "waiting" ? { ...request, status: "claimed", claim: payload.claim } : null,
    );
  },

  settled(requests: Requests, payload: typeof ThreadSecretRequestSettledPayload.Type): Requests {
    const next = update(requests, payload.requestId, (request) =>
      isOpenSecretRequest(request)
        ? {
            ...request,
            status: payload.ending,
            settledAt: payload.settledAt,
            ...(payload.claim !== undefined ? { claim: payload.claim } : {}),
            ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
            ...(payload.savedAt !== undefined ? { savedAt: payload.savedAt } : {}),
            ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
            noted: payload.noted ?? false,
          }
        : null,
    );
    return next === requests ? requests : pruned(next);
  },

  removed(requests: Requests, payload: typeof ThreadSecretRequestRemovedPayload.Type): Requests {
    const next = update(requests, payload.requestId, (request) =>
      isLiveCommandsSecret(request) ? { ...request, removedAt: payload.removedAt } : null,
    );
    return next === requests ? requests : pruned(next);
  },

  notesDelivered(
    requests: Requests,
    payload: typeof ThreadSecretRequestNotesDeliveredPayload.Type,
  ): Requests {
    const delivered = new Set<string>(payload.requestIds);
    let changed = false;
    const next = requests.map((request) => {
      if (!delivered.has(request.requestId) || request.noted || isOpenSecretRequest(request)) {
        return request;
      }
      changed = true;
      return { ...request, noted: true };
    });
    return changed ? pruned(next) : requests;
  },
};

/** Whether a card waits on the user, or a key is being saved: Pending Approval. */
export const hasPendingSecretRequest = (requests: Requests | undefined): boolean =>
  (requests ?? []).some(isOpenSecretRequest);

/** The cards to show, oldest first: waiting, or being saved. */
export const shownSecretRequests = (requests: Requests | undefined): Requests =>
  (requests ?? []).filter(isOpenSecretRequest);

/** Settled requests one agent hasn't been told about yet, oldest first. */
export const secretRequestNotesFor = (
  requests: Requests | undefined,
  participantId: ThreadParticipantId | null,
): Requests =>
  (requests ?? []).filter(
    (request) =>
      !isOpenSecretRequest(request) && !request.noted && request.participantId === participantId,
  );

/** The events that change a thread's secret requests. */
export type SecretRequestEvent = Extract<
  OrchestrationEvent,
  { readonly type: `thread.secret-request-${string}` }
>;

/** Folds one of those events: what the projector, the projection pipeline and the web store share. */
export function applySecretRequestEvent(requests: Requests, event: SecretRequestEvent): Requests {
  switch (event.type) {
    case "thread.secret-request-created":
      return secretRequestStateOn.created(requests, event.payload);
    case "thread.secret-request-claimed":
      return secretRequestStateOn.claimed(requests, event.payload);
    case "thread.secret-request-settled":
      return secretRequestStateOn.settled(requests, event.payload);
    case "thread.secret-request-removed":
      return secretRequestStateOn.removed(requests, event.payload);
    case "thread.secret-request-notes-delivered":
      return secretRequestStateOn.notesDelivered(requests, event.payload);
  }
}
