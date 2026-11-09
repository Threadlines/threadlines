/**
 * Cancelling an agent's check-backs, from the chat's line under the last turn
 * or the Scheduled page. Nothing drops one schedule from a live agent, so its
 * runtime stops (only that agent's, never the room's others), which ends every
 * check-back it set; work it left running stops with it, which the user is
 * asked about first.
 */
import type {
  EnvironmentId,
  OrchestrationCheckBack,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";

/**
 * Asks first when the cancel would stop work the agent left running (or
 * might: for another agent in the room, nothing here says), then sends it.
 * Resolves false when the user said no or the computer isn't connected;
 * rejects when the computer refused.
 */
export async function cancelCheckBack(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's session: which agent holds it, and what that agent left running. */
  readonly session:
    | {
        readonly participantId?: ThreadParticipantId | undefined;
        readonly pendingBackgroundTaskCount?: number | undefined;
      }
    | null
    | undefined;
  readonly checkBack: OrchestrationCheckBack;
}): Promise<boolean> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return false;
  const { session, checkBack } = input;
  const holdsSlot = (session?.participantId ?? null) === checkBack.participantId;
  const runningWork = holdsSlot ? (session?.pendingBackgroundTaskCount ?? 0) : 0;
  const stopBackgroundWork = runningWork > 0 || !holdsSlot;
  if (stopBackgroundWork) {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        "Cancel the check-back?",
        holdsSlot
          ? `This stops the agent's session, and ${
              runningWork === 1
                ? "the command it left running"
                : `the ${runningWork} commands it left running`
            } with it.`
          : "This stops that agent's session, and anything it left running with it.",
      ].join("\n"),
    );
    if (!confirmed) return false;
  }
  await api.orchestration.dispatchCommand({
    type: "thread.check-back.cancel",
    commandId: newCommandId(),
    threadId: input.threadId,
    participantId: checkBack.participantId,
    stopBackgroundWork,
    createdAt: new Date().toISOString(),
  });
  return true;
}
