/**
 * The model stamps a message carries (OrchestrationMessage.agentModels), so
 * the chat keeps naming each agent the way it was when the message was
 * written, after its model or options change.
 *
 * Where each stamp's model comes from:
 * - an assistant message: the author's side answer's model, or the model
 *   recorded when the author's last turn was asked for (`sentModels`, which
 *   is what the reactor sends the turn with);
 * - a message to an agent: the model its turn is asked with, or the one it is
 *   working with when it is steered;
 * - an agent's request: the asker's last turn's model, and the model the
 *   agent asked runs with.
 *
 * Pure: the decider calls it, and the stamps ride on the events, so replays
 * project the same thing.
 */
import type {
  MessageAgentModel,
  ModelSelection,
  OrchestrationThread,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { roomAgentKey } from "@threadlines/shared/threadParticipants";

type AgentModelThread = Pick<
  OrchestrationThread,
  "modelSelection" | "participants" | "sentModels" | "sideTurn"
>;

/** An agent's own model setting: what its next turn runs with. */
export function currentAgentModel(
  thread: AgentModelThread,
  participantId: ThreadParticipantId | null,
): ModelSelection {
  return (
    (participantId === null
      ? undefined
      : thread.participants.find((entry) => entry.id === participantId)?.modelSelection) ??
    thread.modelSelection
  );
}

/**
 * The model an agent's work is running with: the one its last turn was sent
 * with, or its setting when no turn of it was recorded.
 */
export function sentAgentModel(
  thread: AgentModelThread,
  participantId: ThreadParticipantId | null,
): ModelSelection {
  return (
    thread.sentModels?.[roomAgentKey(participantId)] ?? currentAgentModel(thread, participantId)
  );
}

/**
 * The model an assistant message was written with: its side answer's, or its
 * author's last turn's.
 */
export function assistantMessageModel(
  thread: AgentModelThread,
  author: ThreadParticipantId | null,
  sideTurnId: string | undefined,
): ModelSelection {
  const sideTurn = thread.sideTurn;
  return sideTurnId !== undefined &&
    sideTurn?.sideTurnId === sideTurnId &&
    sideTurn.modelSelection !== undefined
    ? sideTurn.modelSelection
    : sentAgentModel(thread, author);
}

/**
 * Stamps for the agents a message names. Each agent's `nameIndex` counts the
 * agents before it on the same model, in the order the room's labels number
 * them: the thread's own agent, then every added agent as it joined (those
 * that left and guests included). A guest joining with this message goes
 * after all of them.
 */
export function messageAgentModels(
  thread: AgentModelThread,
  agents: ReadonlyArray<{
    readonly participantId: ThreadParticipantId | null;
    readonly modelSelection: ModelSelection;
  }>,
): Record<string, MessageAgentModel> {
  const order: ReadonlyArray<ThreadParticipantId | null> = [
    null,
    ...thread.participants.map((entry) => entry.id),
  ];
  const stamps: Record<string, MessageAgentModel> = {};
  for (const agent of agents) {
    const position = order.indexOf(agent.participantId);
    const before = position < 0 ? order : order.slice(0, position);
    const sameModel = before.filter(
      (other) => currentAgentModel(thread, other).model === agent.modelSelection.model,
    ).length;
    stamps[roomAgentKey(agent.participantId)] = {
      modelSelection: agent.modelSelection,
      nameIndex: sameModel + 1,
    };
  }
  return stamps;
}
