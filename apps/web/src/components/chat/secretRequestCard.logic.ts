/**
 * The card for an agent's request for a key (docs/design/secret-requests.md):
 * which card the dock shows, how it stands for this app, what an answer
 * means for the typed text, and what the timeline's saved row says. Pure, so
 * the card, its answer and the row read the same rules. Nothing here keeps a
 * value: the typed text lives only in the card's own React state.
 */
import type {
  OrchestrationSecretRequest,
  SecretRequestAnswer,
  SecretRequestClaim,
  SecretRequestRespondInput,
} from "@threadlines/contracts";
import { isLiveCommandsSecret, shownSecretRequests } from "@threadlines/shared/secretRequestState";
import * as Redacted from "effect/Redacted";

import { sentence } from "./settingsChangeCard.logic";

/** The card the dock shows: the oldest open request, and where it stands among them ("1 of 2"). */
export function dockedSecretRequest(
  requests: ReadonlyArray<OrchestrationSecretRequest> | undefined,
): {
  readonly request: OrchestrationSecretRequest;
  readonly position: number;
  readonly count: number;
} | null {
  const shown = shownSecretRequests(requests);
  const request = shown[0];
  return request === undefined ? null : { request, position: 1, count: shown.length };
}

/**
 * How a card stands for this app. `typing`: waiting, the field is open.
 * `saving`: this app's claim holds it while the computer writes. `elsewhere`:
 * another app's claim holds it.
 */
export type SecretCardPhase =
  | { readonly kind: "typing" }
  | { readonly kind: "saving" }
  | { readonly kind: "elsewhere"; readonly deviceLabel: string };

export function secretCardPhase(
  request: Pick<OrchestrationSecretRequest, "status" | "claim">,
  ownClaimId: string | null,
): SecretCardPhase {
  if (request.status === "waiting") return { kind: "typing" };
  if (request.claim !== undefined && request.claim.claimId !== ownClaimId) {
    return { kind: "elsewhere", deviceLabel: request.claim.deviceLabel };
  }
  return { kind: "saving" };
}

/** A toast an answer, or a card that went away, ends with. */
export interface SecretRequestNotice {
  readonly type: "info" | "warning";
  readonly title: string;
  readonly description?: string;
}

/**
 * What an answer means for the card. `done`: saved or Not now; the card goes
 * and the timeline says the rest. `retry`: the use can't hold the value as
 * typed; the card and the field stay with the detail under it. `ended`:
 * nothing more to do here; the field clears and a notice says why.
 */
export type SecretAnswerEffect =
  | { readonly kind: "done" }
  | { readonly kind: "retry"; readonly detail: string }
  | { readonly kind: "ended"; readonly notice: SecretRequestNotice };

export function secretAnswerEffect(
  answer: Pick<SecretRequestAnswer, "outcome" | "detail" | "by">,
  name: string,
): SecretAnswerEffect {
  switch (answer.outcome) {
    case "saved":
    case "declined":
      return { kind: "done" };
    case "rejected":
      return {
        kind: "retry",
        detail: answer.detail !== undefined ? sentence(answer.detail) : "This key can't be saved.",
      };
    case "failed":
      return {
        kind: "ended",
        notice: {
          type: "warning",
          title: `Couldn't save ${name}`,
          description: answer.detail !== undefined ? sentence(answer.detail) : "Nothing was saved.",
        },
      };
    case "uncertain":
      return {
        kind: "ended",
        notice: {
          type: "warning",
          title: `Check ${name}`,
          description:
            answer.detail !== undefined
              ? sentence(answer.detail)
              : "Threadlines couldn't tell whether it was saved.",
        },
      };
    case "already_answered":
      return {
        kind: "ended",
        notice: {
          type: "info",
          title: `Answered on ${answer.by ?? "another device"}`,
          description: "Nothing was sent from here.",
        },
      };
    case "replaced":
      return {
        kind: "ended",
        notice: {
          type: "info",
          title: `The agent asked for ${name} again`,
          description: "Type it on the new card.",
        },
      };
    case "cancelled":
      return {
        kind: "ended",
        notice: {
          type: "info",
          title: "Request cancelled",
          description:
            answer.detail !== undefined
              ? sentence(answer.detail)
              : `The agent's request for ${name} was cancelled. Nothing was sent.`,
        },
      };
    case "gone":
      return {
        kind: "ended",
        notice: {
          type: "info",
          title: "Request gone",
          description: `The agent's request for ${name} isn't open anymore. Nothing was sent.`,
        },
      };
  }
}

/**
 * Why a card the user had typed into went away without this app answering
 * it, read from the request's state then (undefined: gone from the thread),
 * or null when it still waits (the user only left the thread) or this app's
 * own claim holds it (its answer says the rest).
 */
export function secretCardEndedNotice(
  request: Pick<OrchestrationSecretRequest, "name" | "status" | "claim" | "detail"> | undefined,
  name: string,
  ownClaimId: string | null,
): SecretRequestNotice | null {
  if (request === undefined) return noticeOf(secretAnswerEffect({ outcome: "gone" }, name));
  if (request.status === "waiting") return null;
  if (request.claim !== undefined && request.claim.claimId === ownClaimId) return null;
  if (request.status === "replaced") {
    return noticeOf(secretAnswerEffect({ outcome: "replaced" }, name));
  }
  if (request.status === "cancelled") {
    return noticeOf(secretAnswerEffect({ outcome: "cancelled", detail: request.detail }, name));
  }
  return noticeOf(
    secretAnswerEffect({ outcome: "already_answered", by: request.claim?.deviceLabel }, name),
  );
}

const noticeOf = (effect: SecretAnswerEffect): SecretRequestNotice | null =>
  effect.kind === "ended" ? effect.notice : null;

/**
 * The answer as it goes on the wire. The value is wrapped so it prints
 * `<redacted>` wherever the input is logged; the RPC client unwraps it only
 * to encode the frame.
 */
export function secretRespondInput(input: {
  readonly threadId: SecretRequestRespondInput["threadId"];
  readonly requestId: SecretRequestRespondInput["requestId"];
  readonly claim: SecretRequestClaim;
  readonly answer: { readonly type: "save"; readonly value: string } | { readonly type: "decline" };
}): SecretRequestRespondInput {
  return {
    threadId: input.threadId,
    requestId: input.requestId,
    claimId: input.claim.claimId,
    deviceLabel: input.claim.deviceLabel,
    answer:
      input.answer.type === "save"
        ? { type: "save", value: Redacted.make(input.answer.value, { label: "secret" }) }
        : { type: "decline" },
  };
}

/**
 * The timeline row for the message that told the asking agent how its
 * request ended (`secret-answer:<requestId>`), from the request on the
 * thread. `removal`: a `commands` key's file, gone at a time or already gone.
 * `removable`: Remove now still has a file to remove. Null request: pruned
 * from the thread, so only that a key was saved is known.
 */
export type SecretAnswerRow =
  | {
      readonly kind: "saved";
      readonly name: string;
      /** After the name: "to .env.local", "for the agent's commands". */
      readonly where: string;
      readonly removal:
        | { readonly kind: "at"; readonly iso: string }
        | { readonly kind: "removed" }
        | null;
      readonly removable: boolean;
    }
  | { readonly kind: "failed"; readonly name: string; readonly detail: string }
  | { readonly kind: "unknown" };

export function secretAnswerRow(
  request: OrchestrationSecretRequest | undefined | null,
): SecretAnswerRow {
  if (request === undefined || request === null) return { kind: "unknown" };
  if (request.status === "failed" || request.status === "uncertain") {
    return {
      kind: "failed",
      name: request.name,
      detail: request.detail ?? "nothing was saved.",
    };
  }
  if (request.status !== "saved") return { kind: "unknown" };
  if (request.use.kind === "env_file") {
    return {
      kind: "saved",
      name: request.name,
      where: `to ${request.use.path}`,
      removal: null,
      removable: false,
    };
  }
  const live = isLiveCommandsSecret(request);
  return {
    kind: "saved",
    name: request.name,
    where: "for the agent's commands",
    removal: !live
      ? { kind: "removed" }
      : request.expiresAt !== undefined
        ? { kind: "at", iso: request.expiresAt }
        : null,
    removable: live,
  };
}
