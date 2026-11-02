/**
 * Agents' settings changes on a thread (docs/design/agent-settings-changes.md),
 * folded from its events. The projector, the projection pipeline and the web
 * store all fold with these, so a snapshot and live events agree on the card
 * and on Pending Approval. Each returns the same array when nothing changed.
 */
import type {
  OrchestrationSettingsChangeRequest,
  SettingsChangeRequestId,
  ThreadParticipantId,
  ThreadSettingsChangeClaimedPayload,
  ThreadSettingsChangeDeviceReportedPayload,
  ThreadSettingsChangeNotesDeliveredPayload,
  ThreadSettingsChangeSettledPayload,
} from "@threadlines/contracts";

type Requests = ReadonlyArray<OrchestrationSettingsChangeRequest>;

/** Settled requests kept beside the open ones, newest first. */
export const SETTLED_SETTINGS_REQUESTS_KEPT = 20;

/** On its card, or being made: not settled yet. */
export const isOpenSettingsChange = (request: OrchestrationSettingsChangeRequest): boolean =>
  request.status === "waiting" || request.status === "claimed";

/** Keeps every open request and the newest settled ones, in the order they were asked. */
function pruned(requests: Requests): Requests {
  const settled = requests.filter((request) => !isOpenSettingsChange(request));
  if (settled.length <= SETTLED_SETTINGS_REQUESTS_KEPT) return requests;
  const newest = new Set(
    [...settled]
      .sort((a, b) => (b.settledAt ?? b.createdAt).localeCompare(a.settledAt ?? a.createdAt))
      .slice(0, SETTLED_SETTINGS_REQUESTS_KEPT),
  );
  return requests.filter((request) => isOpenSettingsChange(request) || newest.has(request));
}

function update(
  requests: Requests,
  requestId: SettingsChangeRequestId,
  change: (
    request: OrchestrationSettingsChangeRequest,
  ) => OrchestrationSettingsChangeRequest | null,
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

export const settingsChangeStateOn = {
  /** A new card; the same agent's waiting one is replaced by it (the agent knows, no note). */
  requested(requests: Requests, request: OrchestrationSettingsChangeRequest): Requests {
    if (requests.some((existing) => existing.requestId === request.requestId)) return requests;
    const next = requests.map((existing) =>
      existing.status === "waiting" && existing.participantId === request.participantId
        ? { ...existing, status: "replaced" as const, settledAt: request.createdAt, noted: true }
        : existing,
    );
    return pruned([...next, request]);
  },

  claimed(requests: Requests, payload: typeof ThreadSettingsChangeClaimedPayload.Type): Requests {
    return update(requests, payload.requestId, (request) =>
      request.status === "waiting" ? { ...request, status: "claimed", claim: payload.claim } : null,
    );
  },

  settled(requests: Requests, payload: typeof ThreadSettingsChangeSettledPayload.Type): Requests {
    const next = update(requests, payload.requestId, (request) =>
      isOpenSettingsChange(request)
        ? {
            ...request,
            status: payload.ending,
            settledAt: payload.settledAt,
            ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
          }
        : null,
    );
    return next === requests ? requests : pruned(next);
  },

  deviceReported(
    requests: Requests,
    payload: typeof ThreadSettingsChangeDeviceReportedPayload.Type,
  ): Requests {
    return update(requests, payload.requestId, (request) =>
      request.claim !== undefined && request.device === undefined
        ? { ...request, device: payload.device }
        : null,
    );
  },

  notesDelivered(
    requests: Requests,
    payload: typeof ThreadSettingsChangeNotesDeliveredPayload.Type,
  ): Requests {
    const delivered = new Set<string>(payload.requestIds);
    let changed = false;
    const next = requests.map((request) => {
      if (!delivered.has(request.requestId) || request.noted || isOpenSettingsChange(request)) {
        return request;
      }
      changed = true;
      return { ...request, noted: true };
    });
    return changed ? next : requests;
  },
};

/** Whether a card waits on the user, or a change is being made: Pending Approval. */
export const hasPendingSettingsChange = (requests: Requests | undefined): boolean =>
  (requests ?? []).some(isOpenSettingsChange);

/** The card to show: the oldest one still waiting, or being made. */
export const shownSettingsChange = (
  requests: Requests | undefined,
): OrchestrationSettingsChangeRequest | null => (requests ?? []).find(isOpenSettingsChange) ?? null;

/** Settled requests one agent hasn't been told about yet, oldest first. */
export const settingsChangeNotesFor = (
  requests: Requests | undefined,
  participantId: ThreadParticipantId | null,
): Requests =>
  (requests ?? []).filter(
    (request) =>
      !isOpenSettingsChange(request) && !request.noted && request.participantId === participantId,
  );
