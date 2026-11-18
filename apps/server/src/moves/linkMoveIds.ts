/**
 * The ids a move across a computer link is known by on the computer it
 * arrives at (docs/design/fleet.md, Part 3c), derived from the link and the
 * transfer, so every retry there lands on the same thread. The computer the
 * thread left derives them too, from its own device on that computer: a
 * thread coming back is the copy its move made there only when its id is
 * this one (Part 3f, (h)).
 */
import { ThreadId } from "@threadlines/contracts";
import { createHash } from "node:crypto";

import { derivedUuid } from "../orchestration/childRequestIds.ts";

/** hash(link, transfer): every resource a move makes there is named from it. */
export const linkMoveKey = (linkDeviceId: string, transferId: string) =>
  createHash("sha256").update(`${linkDeviceId}\u0000${transferId}`).digest("hex");

/** The thread a move becomes there. */
export const linkMoveThreadId = (transferKey: string) =>
  ThreadId.make(derivedUuid("link-move-thread", transferKey));

/**
 * The copy the move `transferId` made on the computer where this computer's
 * device is `deviceId` (a lone move: a family member's is named from its family).
 */
export const linkMoveCopyThreadId = (deviceId: string, transferId: string) =>
  linkMoveThreadId(linkMoveKey(deviceId, transferId));
