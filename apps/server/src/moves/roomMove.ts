/**
 * A room's agents when it moves (docs/design/fleet.md, Part 3f, (i)), on the
 * computer it leaves: which of them move, the agent each would be on the
 * other computer (`suggestRoomAgent`: the same driver and model, else that
 * driver's default model), and the agent each moves as once the user picked
 * (`resolveRoomAgents`). Pure: ThreadMoves reads the thread and the other
 * computer, and asks these.
 */
import {
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadParticipant,
  type PeerDescriptor,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ThreadMoveRoomAgentChoice,
  type ThreadMoveTargetPreview,
  type ThreadParticipantId,
} from "@threadlines/contracts";
import { roomAgentKey } from "@threadlines/shared/threadParticipants";

/** The driver and model a room agent runs with on this computer. */
export interface RoomAgentSource {
  readonly participantId: ThreadParticipantId;
  readonly handle: string;
  readonly driver: string;
  readonly model: string;
}

/**
 * The agents of the room that move with it: those still in it. Ones that
 * left and guests (one review each) come only as records, so their messages
 * keep their author.
 */
export const movingRoomAgents = (
  thread: Pick<OrchestrationThread, "participants">,
): ReadonlyArray<OrchestrationThreadParticipant> =>
  thread.participants.filter((participant) => participant.leftAt === null && !participant.guest);

/**
 * The agent on `peer` to move a room agent as: the same driver with the same
 * model, else that driver's default model (the computer's default agent when
 * it is that driver, else its first agent's first model). None when the
 * computer has no agent of that driver.
 */
export function suggestRoomAgent(
  peer: Pick<PeerDescriptor, "agents" | "defaultAgent">,
  source: Pick<RoomAgentSource, "driver" | "model">,
): ModelSelection | undefined {
  const sameDriver = peer.agents.filter((agent) => agent.driver === source.driver);
  for (const agent of sameDriver) {
    if (agent.models.some((model) => model.model === source.model)) {
      return { instanceId: agent.instanceId, model: source.model } as ModelSelection;
    }
  }
  const fallback = peer.defaultAgent;
  if (fallback !== null && sameDriver.some((agent) => agent.instanceId === fallback.instanceId)) {
    return fallback as ModelSelection;
  }
  const first = sameDriver[0];
  const model = first?.models[0]?.model;
  return first !== undefined && model !== undefined
    ? ({ instanceId: first.instanceId, model } as ModelSelection)
    : undefined;
}

/** "Sol can't come: Windows PC has no Codex agent." */
export const cantComeWords = (handle: string, peerLabel: string, driver: string) =>
  `${handle} can't come: ${peerLabel} has no ${
    PROVIDER_DISPLAY_NAMES[driver as ProviderDriverKind] ?? driver
  } agent.`;

/**
 * The agent each of a room's moving agents (`participantIds`) moves as on
 * `target`: the user's pick where they made one (null leaves the agent out),
 * else what the computer suggests (ThreadMoveTargetPreview.roomAgents), else
 * none (null: it arrives as having left). A pick the computer doesn't have
 * is refused, with why.
 */
export function resolveRoomAgents(
  target: Pick<ThreadMoveTargetPreview, "label" | "agents" | "roomAgents">,
  participantIds: ReadonlyArray<ThreadParticipantId>,
  chosen: ReadonlyArray<ThreadMoveRoomAgentChoice> | undefined,
):
  | { readonly roomAgents: ReadonlyArray<ThreadMoveRoomAgentChoice> }
  | { readonly refusal: string } {
  const roomAgents: ThreadMoveRoomAgentChoice[] = [];
  for (const participantId of participantIds) {
    const pick = chosen?.find((entry) => entry.participantId === participantId);
    if (pick === undefined) {
      const suggested = target.roomAgents?.find(
        (entry) => entry.participantId === participantId,
      )?.suggestedAgent;
      roomAgents.push({ participantId, agent: suggested ?? null });
      continue;
    }
    const agent = pick.agent;
    if (agent !== null) {
      const offered = target.agents.find((entry) => entry.instanceId === agent.instanceId);
      if (offered === undefined || !offered.models.some((model) => model.model === agent.model)) {
        return { refusal: `${target.label} has no such agent or model for a room agent.` };
      }
    }
    roomAgents.push({ participantId, agent });
  }
  return { roomAgents };
}

/**
 * The last of the moved messages (`movedIds`) an agent's own session saw
 * (Part 3f, (i)): everything up to its room context cursor when it has one,
 * else up to its own last reply. A carried session resumes holding that
 * much, and is caught up on the rest. None: nothing says how far it got.
 */
export function seenThroughOf(
  thread: Pick<OrchestrationThread, "messages" | "roomContext">,
  participantId: ThreadParticipantId | null,
  movedIds: ReadonlySet<string>,
): OrchestrationThread["messages"][number]["id"] | undefined {
  const moved = thread.messages.filter((message) => movedIds.has(message.id));
  const cursor = thread.roomContext?.[roomAgentKey(participantId)];
  const seen =
    cursor !== undefined
      ? moved.findLast((message) => (message.eventSequence ?? 0) <= cursor.throughSequence)
      : moved.findLast(
          (message) =>
            message.role === "assistant" && (message.participantId ?? null) === participantId,
        );
  return seen?.id;
}
