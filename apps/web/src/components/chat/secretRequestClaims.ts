/**
 * Answering an agent's request for a key from this app
 * (docs/design/secret-requests.md, "Answering"). Save and Not now go straight
 * to the thread's own computer under this app's claim: one claim per request,
 * made on the first answer and sent again on retries, so a retry after a lost
 * answer gets the stored result instead of a second write.
 *
 * Claims hold ids and a device label only. The typed value passes through
 * once, wrapped in Redacted, and is never kept, logged or put in a notice.
 */
import type {
  ScopedThreadRef,
  SecretRequestAnswer,
  SecretRequestClaim,
  SecretRequestId,
} from "@threadlines/contracts";
import { scopedThreadKey } from "@threadlines/client-runtime";

import { readEnvironmentConnection } from "~/environments/runtime";
import { randomUUID } from "~/lib/utils";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";
import { failureNotice, toastManager } from "../ui/toast";
import { secretRespondInput } from "./secretRequestCard.logic";

const claims = new Map<string, SecretRequestClaim>();

const claimKey = (threadRef: ScopedThreadRef, requestId: SecretRequestId) =>
  `${scopedThreadKey(threadRef)}\u0000${requestId}`;

/** This app's claim id on a request, if it has answered it this session. */
export function readSecretClaimId(
  threadRef: ScopedThreadRef,
  requestId: SecretRequestId,
): string | null {
  return claims.get(claimKey(threadRef, requestId))?.claimId ?? null;
}

function claimFor(
  threadRef: ScopedThreadRef,
  requestId: SecretRequestId,
  deviceLabel: string,
): SecretRequestClaim {
  const key = claimKey(threadRef, requestId);
  const existing = claims.get(key);
  if (existing !== undefined) return existing;
  const claim = { claimId: randomUUID(), deviceLabel };
  claims.set(key, claim);
  return claim;
}

/**
 * How sending went. `answer`: the computer answered. `offline`: this app
 * isn't connected to it. `failed`: the answer never came back (the claim
 * stays for a retry); `detail` is fixed text or the server's own words,
 * never anything that could quote the value.
 */
export type SecretAnswerResult =
  | { readonly kind: "answer"; readonly answer: SecretRequestAnswer }
  | { readonly kind: "offline" }
  | { readonly kind: "failed"; readonly detail: string | null };

/** The server's own fixed-text refusal, if that is what came back. */
function serverDetail(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const tagged = error as { readonly _tag?: unknown; readonly detail?: unknown };
  return tagged._tag === "SecretRequestError" && typeof tagged.detail === "string"
    ? tagged.detail
    : null;
}

/** Sends Save (with the value) or Not now to the thread's own computer, once. */
export async function answerSecretRequest(input: {
  readonly threadRef: ScopedThreadRef;
  readonly requestId: SecretRequestId;
  readonly deviceLabel: string;
  readonly answer: { readonly type: "save"; readonly value: string } | { readonly type: "decline" };
}): Promise<SecretAnswerResult> {
  const connection = readEnvironmentConnection(input.threadRef.environmentId);
  if (!connection) return { kind: "offline" };
  const claim = claimFor(input.threadRef, input.requestId, input.deviceLabel);
  try {
    const answer = await connection.client.secretRequest.respond(
      secretRespondInput({
        threadId: input.threadRef.threadId,
        requestId: input.requestId,
        claim,
        answer: input.answer,
      }),
    );
    return { kind: "answer", answer };
  } catch (error) {
    return { kind: "failed", detail: serverDetail(error) };
  }
}

/** Remove now: a saved `commands` key's file goes before its 24 hours are up. */
export async function removeSecretNow(
  threadRef: ScopedThreadRef,
  requestId: SecretRequestId,
): Promise<void> {
  const connection = readEnvironmentConnection(threadRef.environmentId);
  if (!connection) {
    addComputerNotConnectedNotice({
      environmentId: threadRef.environmentId,
      fallbackLabel: "This computer",
    });
    return;
  }
  try {
    await connection.client.secretRequest.remove({ threadId: threadRef.threadId, requestId });
  } catch (error) {
    toastManager.add(failureNotice({ title: "Couldn't remove the key", error }));
  }
}
