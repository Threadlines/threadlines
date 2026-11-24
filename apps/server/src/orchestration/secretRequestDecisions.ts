/**
 * Agents' requests for keys (docs/design/secret-requests.md): the decider's
 * side. A request goes on its thread's card as `waiting`, bound to its use.
 * Save claims it for the app that pressed it, and only the committed claim
 * authorizes a write; that claim alone ends it (saved, failed, uncertain).
 * Not now declines a waiting one and records the app that said it. Nothing
 * goes back to waiting. Archive, the start of a move, a revert and the asking
 * agent leaving cancel waiting requests inside their own decisions; a
 * claimed one always finishes. Each decision returns the events to plan, or a
 * refusal to report. No command or event here carries a value.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationSecretRequest,
  OrchestrationThread,
  SecretRequestId,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { isOpenSecretRequest, isLiveCommandsSecret } from "@threadlines/shared/secretRequestState";
import {
  MAX_SECRET_REQUESTS_PER_TURN,
  MAX_WAITING_SECRET_REQUESTS,
  secretNameProblem,
  secretReasonProblem,
  secretUseProblem,
} from "@threadlines/shared/secretRequests";
import { activeParticipants } from "@threadlines/shared/threadParticipants";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = (threadId: ThreadId) => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;
type Requests = ReadonlyArray<OrchestrationSecretRequest>;

/** Events to plan, or why the command is refused. */
export type SecretRequestDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

/**
 * A settle's events, and the message to hand its agent in the same decision
 * (the decider steers or queues it as a follow-up), when there is one.
 */
export type SecretRequestSettleDecision =
  | {
      readonly events: ReadonlyArray<PlannedEvent>;
      readonly deliver?: {
        readonly participantId: ThreadParticipantId | null;
        readonly turnId: OrchestrationSecretRequest["turnId"];
        readonly messageId: NonNullable<
          CommandOf<"thread.secret-request.settle">["message"]
        >["messageId"];
        readonly text: string;
      };
    }
  | { readonly refusal: string };

/** Why a waiting request was cancelled, for the agent's note. */
export const SECRET_REQUEST_CANCELLED = {
  archived: "The thread was archived.",
  moving: (computerLabel: string) => `The thread started moving to ${computerLabel}.`,
  reverted: "The turn that asked was undone.",
  agentLeft: "You left the room.",
} as const;

const refuse = (refusal: string) => ({ refusal });

/** A thread's requests; a deleted thread took its requests with it. */
const requestsOf = (thread: Pick<OrchestrationThread, "secretRequests" | "deletedAt">): Requests =>
  thread.deletedAt === null ? (thread.secretRequests ?? []) : [];

const findRequest = (thread: OrchestrationThread, requestId: SecretRequestId) =>
  requestsOf(thread).find((request) => request.requestId === requestId);

/** Same name and use: a newer request replaces the waiting one. */
const sameNameAndUse = (
  a: Pick<OrchestrationSecretRequest, "name" | "use">,
  b: Pick<OrchestrationSecretRequest, "name" | "use">,
) =>
  a.name === b.name &&
  a.use.kind === b.use.kind &&
  (a.use.kind !== "env_file" || (b.use.kind === "env_file" && a.use.path === b.use.path));

function notWaiting(
  requestId: SecretRequestId,
  request: OrchestrationSecretRequest | undefined,
): string {
  if (request === undefined) return `Secret request '${requestId}' is gone from this thread.`;
  if (request.status === "claimed") {
    return `Secret request '${requestId}' was already claimed by another answer.`;
  }
  return `Secret request '${requestId}' already ended (${request.status}).`;
}

/** The asking agent is still in the room (the thread's own agent always is). */
const askerPresent = (thread: OrchestrationThread, request: OrchestrationSecretRequest) =>
  request.participantId === null ||
  activeParticipants(thread).some((participant) => participant.id === request.participantId);

/**
 * An agent's request goes on the card. The waiting one with the same name and
 * use is replaced, whichever agent asked; a claimed one never is. A moving
 * or moved thread is refused before this, by `threadMoveGuardRefusal`.
 */
export function decideSecretRequest(
  thread: OrchestrationThread,
  command: CommandOf<"thread.secret-request.request">,
  baseFor: EventBase,
): SecretRequestDecision {
  if (thread.deletedAt !== null) return refuse("This thread was deleted.");
  if (thread.archivedAt !== null) return refuse("This thread is archived.");
  const problem =
    secretNameProblem(command.name) ??
    secretReasonProblem(command.reason) ??
    secretUseProblem(command.use);
  if (problem !== null) return refuse(problem);
  if (
    command.use.kind === "env_file" &&
    (command.folder === undefined || command.parent === undefined)
  ) {
    return refuse("An env file request needs the folders it is bound to.");
  }
  const requests = requestsOf(thread);
  if (requests.some((request) => request.requestId === command.requestId)) {
    return refuse(`Secret request '${command.requestId}' was already asked for.`);
  }
  const thisTurn = requests.filter(
    (request) =>
      request.participantId === command.participantId && request.turnId === command.turnId,
  ).length;
  if (thisTurn >= MAX_SECRET_REQUESTS_PER_TURN) {
    return refuse(`An agent can ask for at most ${MAX_SECRET_REQUESTS_PER_TURN} keys in one turn.`);
  }
  const claimedSame = requests.find(
    (request) => request.status === "claimed" && sameNameAndUse(request, command),
  );
  if (claimedSame !== undefined) {
    return refuse(`The user is saving ${command.name} right now. Wait for their answer.`);
  }
  const replaces = requests
    .filter((request) => request.status === "waiting" && sameNameAndUse(request, command))
    .map((request) => request.requestId);
  const waiting = requests.filter((request) => request.status === "waiting").length;
  if (waiting - replaces.length >= MAX_WAITING_SECRET_REQUESTS) {
    return refuse(
      `${MAX_WAITING_SECRET_REQUESTS} keys are already waiting for the user on this thread. Wait for their answers.`,
    );
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.secret-request-created",
      payload: {
        threadId: thread.id,
        ...(replaces.length > 0 ? { replaces } : {}),
        request: {
          requestId: command.requestId,
          participantId: command.participantId,
          turnId: command.turnId,
          name: command.name,
          reason: command.reason.trim(),
          use: command.use,
          replaces: command.replaces,
          ...(command.folder !== undefined ? { folder: command.folder } : {}),
          ...(command.parent !== undefined ? { parent: command.parent } : {}),
          status: "waiting",
          createdAt: command.createdAt,
          noted: false,
        },
      },
    },
  ];
}

/** The first app to press Save wins; any other answer after it is refused. */
export function decideSecretRequestClaim(
  thread: OrchestrationThread,
  command: CommandOf<"thread.secret-request.claim">,
  baseFor: EventBase,
): SecretRequestDecision {
  const request = findRequest(thread, command.requestId);
  if (request?.status !== "waiting") return refuse(notWaiting(command.requestId, request));
  if (thread.archivedAt !== null) return refuse("This thread is archived.");
  return [
    {
      ...baseFor(thread.id),
      type: "thread.secret-request-claimed",
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
 * How a card ends: Not now from waiting only, recording the app that said
 * it; saved, failed or uncertain from claimed only, and only by the claim
 * that holds it. A saved or failed answer carries the asking agent's message:
 * handed over in the same decision while the agent is still here and the
 * thread can take it. An agent that left gets nothing (nobody is left to use
 * the key); an archived or moving thread hears it as a note at its next turn.
 */
export function decideSecretRequestSettle(
  thread: OrchestrationThread,
  command: CommandOf<"thread.secret-request.settle">,
  baseFor: EventBase,
): SecretRequestSettleDecision {
  const request = findRequest(thread, command.requestId);
  if (command.ending === "declined") {
    if (request?.status !== "waiting") return refuse(notWaiting(command.requestId, request));
  } else {
    if (request === undefined) return refuse(notWaiting(command.requestId, request));
    if (request.status === "waiting") {
      return refuse(`Secret request '${command.requestId}' isn't claimed yet.`);
    }
    if (request.status !== "claimed") return refuse(notWaiting(command.requestId, request));
    if (request.claim?.claimId !== command.claim.claimId) {
      return refuse(`Secret request '${command.requestId}' is claimed by another answer.`);
    }
  }
  const present = askerPresent(thread, request);
  const canDeliver =
    command.message !== undefined &&
    present &&
    thread.archivedAt === null &&
    (thread.move ?? null) === null;
  const noted = canDeliver || !present;
  const settled: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.secret-request-settled",
    payload: {
      threadId: thread.id,
      requestId: request.requestId,
      ending: command.ending,
      claim: command.claim,
      ...(command.detail !== undefined ? { detail: command.detail } : {}),
      ...(command.savedAt !== undefined ? { savedAt: command.savedAt } : {}),
      ...(command.expiresAt !== undefined ? { expiresAt: command.expiresAt } : {}),
      ...(noted ? { noted: true } : {}),
      settledAt: command.createdAt,
    },
  };
  if (!canDeliver || command.message === undefined) return { events: [settled] };
  return {
    events: [settled],
    deliver: {
      participantId: request.participantId,
      turnId: request.turnId,
      messageId: command.message.messageId,
      text: command.message.text,
    },
  };
}

/** A saved `commands` key's file went: Remove now, its expiry, or the thread's cleanup. */
export function decideSecretRequestRemove(
  thread: OrchestrationThread,
  command: CommandOf<"thread.secret-request.remove">,
  baseFor: EventBase,
): SecretRequestDecision {
  const request = findRequest(thread, command.requestId);
  if (request === undefined || !isLiveCommandsSecret(request)) {
    return refuse(`Secret request '${command.requestId}' has no file to remove.`);
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.secret-request-removed",
      payload: { threadId: thread.id, requestId: request.requestId, removedAt: command.createdAt },
    },
  ];
}

/** The asking agents were told: only settled requests not noted yet are marked. */
export function decideSecretRequestNotesDelivered(
  thread: OrchestrationThread,
  command: CommandOf<"thread.secret-request.deliver-notes">,
  baseFor: EventBase,
): SecretRequestDecision {
  const named = new Set<string>(command.requestIds);
  const requestIds = requestsOf(thread)
    .filter(
      (request) => named.has(request.requestId) && !isOpenSecretRequest(request) && !request.noted,
    )
    .map((request) => request.requestId);
  if (requestIds.length === 0) {
    return refuse("None of these secret requests has a note left to deliver.");
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.secret-request-notes-delivered",
      payload: { threadId: thread.id, requestIds, deliveredAt: command.createdAt },
    },
  ];
}

/**
 * `cancelled` for every waiting request on `thread` that `which` picks (all
 * of them by default), saying why. Claimed requests are left to finish.
 * `noted` when nobody is left to tell (the asking agent is leaving).
 */
export function cancelWaitingSecretRequests(
  thread: OrchestrationThread,
  detail: string,
  settledAt: string,
  baseFor: EventBase,
  which: (request: OrchestrationSecretRequest) => boolean = () => true,
  options?: { readonly noted?: boolean },
): ReadonlyArray<PlannedEvent> {
  return requestsOf(thread)
    .filter((request) => request.status === "waiting" && which(request))
    .map((request): PlannedEvent => ({
      ...baseFor(thread.id),
      type: "thread.secret-request-settled",
      payload: {
        threadId: thread.id,
        requestId: request.requestId,
        ending: "cancelled",
        detail,
        ...(options?.noted === true ? { noted: true } : {}),
        settledAt,
      },
    }));
}
