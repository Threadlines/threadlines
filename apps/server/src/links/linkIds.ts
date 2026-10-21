/**
 * Ids for work one computer asks of another over a link (docs/design/fleet.md),
 * derived from the asking link's device id and the request id, so the asking
 * computer knows the child's thread and message ids before the other one
 * answers, and every retry on either side lands on the same work.
 */
import { ChildRequestId, CommandId, MessageId, ThreadId } from "@threadlines/contracts";

import { derivedUuid } from "../orchestration/childRequestIds.ts";

/** The key a request's setup runs under on the child's computer (its command ids, its branch). */
export const linkBootstrapKey = (linkDeviceId: string, requestId: string): ChildRequestId =>
  ChildRequestId.make(derivedUuid("link-request", linkDeviceId, requestId));

/** The thread a start request makes on the child's computer. */
export const linkThreadId = (linkDeviceId: string, requestId: string): ThreadId =>
  ThreadId.make(derivedUuid("link-thread", linkDeviceId, requestId));

/** The message a start or send writes into that thread. */
export const linkMessageId = (linkDeviceId: string, requestId: string): MessageId =>
  MessageId.make(derivedUuid("link-message", linkDeviceId, requestId));

/** A command the child's computer dispatches for one request's step. */
export const linkCommandId = (linkDeviceId: string, requestId: string, step: string): CommandId =>
  CommandId.make(`server:link-request:${derivedUuid(linkDeviceId, requestId)}:${step}`);
