/**
 * Agents' settings changes (docs/design/agent-settings-changes.md): the
 * decider's side. A request goes on its thread's card as `waiting`; the app
 * that pressed Change claims it, and only that claim ends it (changed,
 * failed, uncertain) and reports its device changes; Not now declines a
 * waiting one. Nothing goes back to waiting. Archive, the start of a move and
 * a revert cancel waiting requests inside their own decisions; a claimed one
 * always finishes, so its settle and report pass an archived or frozen thread.
 * Each decision returns the events to plan, or a refusal to report.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationSettingsChangeRequest,
  OrchestrationThread,
  SettingsChangeEnding,
  SettingsChangeRequestId,
  ThreadId,
} from "@threadlines/contracts";
import { TurnId } from "@threadlines/contracts";
import { isOpenSettingsChange } from "@threadlines/shared/settingsChangeState";
import { checkEdits } from "@threadlines/shared/settingsEdits";
import { revertMessages } from "@threadlines/shared/transcriptRevert";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = (threadId: ThreadId) => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;
type Requests = ReadonlyArray<OrchestrationSettingsChangeRequest>;

/** Events to plan, or why the command is refused. */
export type SettingsChangeDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

/** The most settings changes one agent may ask for in one turn. */
export const MAX_SETTINGS_REQUESTS_PER_TURN = 5;

/** Why a waiting request was cancelled, for the agent's note. */
export const SETTINGS_CHANGE_CANCELLED = {
  archived: "The thread was archived.",
  moving: (computerLabel: string) => `The thread started moving to ${computerLabel}.`,
  reverted: "The turn that asked was undone.",
} as const;

const refuse = (refusal: string) => ({ refusal });

/** A thread's requests; a deleted thread took its requests with it. */
const requestsOf = (
  thread: Pick<OrchestrationThread, "settingsRequests" | "deletedAt">,
): Requests => (thread.deletedAt === null ? (thread.settingsRequests ?? []) : []);

const findRequest = (thread: OrchestrationThread, requestId: SettingsChangeRequestId) =>
  requestsOf(thread).find((request) => request.requestId === requestId);

/** Why a request can't be claimed or declined: it is gone, claimed, or over. */
function notWaiting(
  requestId: SettingsChangeRequestId,
  request: OrchestrationSettingsChangeRequest | undefined,
): string {
  if (request === undefined) return `Settings change '${requestId}' is gone from this thread.`;
  if (request.status === "claimed") {
    return `Settings change '${requestId}' was already claimed by another answer.`;
  }
  return `Settings change '${requestId}' already ended (${request.status}).`;
}

const settledEvent = (
  thread: OrchestrationThread,
  requestId: SettingsChangeRequestId,
  ending: SettingsChangeEnding,
  detail: string | undefined,
  settledAt: string,
  baseFor: EventBase,
): PlannedEvent => ({
  ...baseFor(thread.id),
  type: "thread.settings-change-settled",
  payload: {
    threadId: thread.id,
    requestId,
    ending,
    ...(detail !== undefined ? { detail } : {}),
    settledAt,
  },
});

/**
 * An agent's request goes on the card; its waiting one, if any, is replaced
 * (the reducer does that from this one event). A moving or moved thread is
 * refused before this, by `threadMoveGuardRefusal`.
 */
export function decideSettingsChangeRequest(
  thread: OrchestrationThread,
  command: CommandOf<"thread.settings-change.request">,
  baseFor: EventBase,
): SettingsChangeDecision {
  if (thread.deletedAt !== null) return refuse("This thread was deleted.");
  if (thread.archivedAt !== null) return refuse("This thread is archived.");
  const checked = checkEdits(command.changes);
  if ("refused" in checked) return refuse(checked.refused.detail);
  const requests = requestsOf(thread);
  if (requests.some((request) => request.requestId === command.requestId)) {
    return refuse(`Settings change '${command.requestId}' was already asked for.`);
  }
  const thisTurn = requests.filter(
    (request) =>
      request.participantId === command.participantId && request.turnId === command.turnId,
  ).length;
  if (thisTurn >= MAX_SETTINGS_REQUESTS_PER_TURN) {
    return refuse(
      `An agent can ask for at most ${MAX_SETTINGS_REQUESTS_PER_TURN} settings changes in one turn.`,
    );
  }
  const replaces = requestsOf(thread)
    .filter(
      (request) => request.status === "waiting" && request.participantId === command.participantId,
    )
    .map((request) => request.requestId);
  return [
    {
      ...baseFor(thread.id),
      type: "thread.settings-change-requested",
      payload: {
        threadId: thread.id,
        ...(replaces.length > 0 ? { replaces } : {}),
        request: {
          requestId: command.requestId,
          participantId: command.participantId,
          turnId: command.turnId,
          changes: command.changes,
          status: "waiting",
          createdAt: command.createdAt,
          noted: false,
        },
      },
    },
  ];
}

/** The first app to press Change wins; any other answer after it is refused. */
export function decideSettingsChangeClaim(
  thread: OrchestrationThread,
  command: CommandOf<"thread.settings-change.claim">,
  baseFor: EventBase,
): SettingsChangeDecision {
  const request = findRequest(thread, command.requestId);
  if (request?.status !== "waiting") return refuse(notWaiting(command.requestId, request));
  return [
    {
      ...baseFor(thread.id),
      type: "thread.settings-change-claimed",
      payload: {
        threadId: thread.id,
        requestId: request.requestId,
        claim: command.claim,
        claimedAt: command.createdAt,
      },
    },
  ];
}

/**
 * How a card ends: Not now from waiting only; changed, failed or uncertain
 * from claimed only, and only by the claim that holds it.
 */
export function decideSettingsChangeSettle(
  thread: OrchestrationThread,
  command: CommandOf<"thread.settings-change.settle">,
  baseFor: EventBase,
): SettingsChangeDecision {
  const request = findRequest(thread, command.requestId);
  if (command.ending === "declined") {
    if (request?.status !== "waiting") return refuse(notWaiting(command.requestId, request));
  } else {
    if (request === undefined) return refuse(notWaiting(command.requestId, request));
    if (request.status === "waiting") {
      return refuse(`Settings change '${command.requestId}' isn't claimed yet.`);
    }
    if (request.status !== "claimed") return refuse(notWaiting(command.requestId, request));
    if (command.claimId === undefined || request.claim?.claimId !== command.claimId) {
      return refuse(`Settings change '${command.requestId}' is claimed by another answer.`);
    }
  }
  return [
    settledEvent(
      thread,
      command.requestId,
      command.ending,
      command.detail,
      command.createdAt,
      baseFor,
    ),
  ];
}

/**
 * The claiming app's device report: once, from that claim, after the
 * request ended from it, naming only the request's own settings.
 */
export function decideSettingsChangeDeviceReport(
  thread: OrchestrationThread,
  command: CommandOf<"thread.settings-change.report-device">,
  baseFor: EventBase,
): SettingsChangeDecision {
  const request = findRequest(thread, command.requestId);
  if (request === undefined) return refuse(notWaiting(command.requestId, request));
  if (request.claim?.claimId !== command.claimId) {
    return refuse(`Settings change '${command.requestId}' wasn't claimed by this answer.`);
  }
  if (request.status === "claimed") {
    return refuse(`Settings change '${command.requestId}' hasn't ended yet.`);
  }
  if (request.device !== undefined) {
    return refuse(`Settings change '${command.requestId}' already has its device report.`);
  }
  const asked = new Set<string>(request.changes.map((change) => change.place));
  const stray = [
    ...command.device.applied,
    ...command.device.failed.map((entry) => entry.place),
  ].find((place) => !asked.has(place));
  if (stray !== undefined) {
    return refuse(`'${stray}' isn't one of the settings in '${command.requestId}'.`);
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.settings-change-device-reported",
      payload: {
        threadId: thread.id,
        requestId: request.requestId,
        device: command.device,
        reportedAt: command.createdAt,
      },
    },
  ];
}

/** The asking agents were told: only settled requests not noted yet are marked. */
export function decideSettingsChangeNotesDelivered(
  thread: OrchestrationThread,
  command: CommandOf<"thread.settings-change.deliver-notes">,
  baseFor: EventBase,
): SettingsChangeDecision {
  const named = new Set<string>(command.requestIds);
  const requestIds = requestsOf(thread)
    .filter(
      (request) => named.has(request.requestId) && !isOpenSettingsChange(request) && !request.noted,
    )
    .map((request) => request.requestId);
  if (requestIds.length === 0) {
    return refuse("None of these settings changes has a note left to deliver.");
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.settings-change-notes-delivered",
      payload: { threadId: thread.id, requestIds, deliveredAt: command.createdAt },
    },
  ];
}

/**
 * `cancelled` for every waiting request on `thread` that `which` picks (all
 * of them by default), saying why. Claimed requests are left to finish.
 */
export function cancelWaitingSettingsChanges(
  thread: OrchestrationThread,
  detail: string,
  settledAt: string,
  baseFor: EventBase,
  which: (request: OrchestrationSettingsChangeRequest) => boolean = () => true,
): ReadonlyArray<PlannedEvent> {
  return requestsOf(thread)
    .filter((request) => request.status === "waiting" && which(request))
    .map((request) =>
      settledEvent(thread, request.requestId, "cancelled", detail, settledAt, baseFor),
    );
}

/**
 * `thread.revert.complete`'s `keptTurnIds`, read from the thread as the revert
 * loaded it (the engine's own read model has no checkpoints after a restart):
 * the turns with a checkpoint it keeps and any a kept message is stamped with.
 * Naming what stays means a card from a turn this read never saw (asked for
 * while the revert ran, or a turn with no checkpoint) goes with what is
 * removed. That holds even when this read saw nothing to remove: new work can
 * arrive before the revert ends, and the transcript cut will take it. A card
 * wrongly cancelled can simply be asked for again.
 */
export function settingsChangeTurnsRevertKeeps(
  thread: Pick<OrchestrationThread, "checkpoints" | "messages">,
  turnCount: number,
): ReadonlyArray<TurnId> {
  const { keptTurnIds } = revertMessages({
    messages: thread.messages,
    idOf: (message) => message.id,
    retainedTurnIds: new Set(
      thread.checkpoints
        .filter((checkpoint) => checkpoint.checkpointTurnCount <= turnCount)
        .map((checkpoint) => checkpoint.turnId),
    ),
    turnCount,
  });
  return [...keptTurnIds].map((turnId) => TurnId.make(turnId));
}
