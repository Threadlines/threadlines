/**
 * A moved room arriving (docs/design/fleet.md, Part 3f, (i)), on the computer
 * it lands on: its agents with this computer's ids (derived from the
 * transfer, so a repeated import names them the same), each as the agent
 * picked here or, when none came for it, as having left; and every room
 * field the move brings, remapped to those ids. Pure: LinkMoves resolves the
 * agents and carries their sessions, then asks this.
 */
import {
  type MessageId,
  type ModelSelection,
  type OrchestrationOutsideWork,
  type OrchestrationThreadActivity,
  type OrchestrationThreadParticipant,
  type PeerMoveRoom,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ThreadImportMessage,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { derivedUuid } from "../orchestration/childRequestIds.ts";

/** A moved room agent's id here: one per transfer and agent there. */
export const movedParticipantId = (transferKey: string, id: string) =>
  ThreadParticipantId.make(derivedUuid("link-move-participant", transferKey, id));

/** How each room agent the move named came out here: its agent, or why it didn't come. */
export type RoomAgentResolution =
  | { readonly selection: ModelSelection }
  | { readonly refused: string };

export interface RoomArrival {
  /** Every agent's record here, those that didn't come marked as having left. */
  readonly participants: ReadonlyArray<OrchestrationThreadParticipant>;
  readonly agentRole?: string | undefined;
  /** The agent's id there → its id here. */
  readonly ids: ReadonlyMap<string, ThreadParticipantId>;
  /** The agents that came (ids there), each with the agent it runs as here. */
  readonly came: ReadonlyMap<string, ModelSelection>;
  /** For the "Moved here" line: who came, and who didn't with why. */
  readonly brought: ReadonlyArray<string>;
  readonly left: ReadonlyArray<string>;
}

const names = (list: ReadonlyArray<string>) =>
  list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]!}`;

/**
 * The room as it lands: `resolved` is what each agent the sender moved here
 * (one with `agent`) resolved to on this computer, `carried` the agents whose
 * sessions this computer took, `hasDriver` whether it has any agent of a
 * driver (to say why one that came with no agent didn't come).
 */
export function roomArrivalOf(input: {
  readonly room: PeerMoveRoom | undefined;
  readonly transferKey: string;
  readonly now: string;
  readonly resolved: ReadonlyMap<string, RoomAgentResolution>;
  readonly carried: ReadonlySet<string>;
  readonly hasDriver: (driver: string) => boolean;
  /** A moved message's id here, from its id there. */
  readonly messageIdHere: (id: MessageId) => MessageId;
}): RoomArrival {
  const room = input.room;
  const ids = new Map<string, ThreadParticipantId>();
  const came = new Map<string, ModelSelection>();
  const left: string[] = [];
  const participants = (room?.participants ?? []).map(
    (participant): OrchestrationThreadParticipant => {
      const id = movedParticipantId(input.transferKey, participant.id);
      ids.set(participant.id, id);
      const resolution = input.resolved.get(participant.id);
      const selection =
        participant.leftAt === null && participant.guest !== true && resolution !== undefined
          ? "selection" in resolution
            ? resolution.selection
            : undefined
          : undefined;
      if (selection !== undefined) came.set(participant.id, selection);
      else if (participant.leftAt === null && participant.guest !== true) {
        const driverName =
          PROVIDER_DISPLAY_NAMES[participant.source.driver as ProviderDriverKind] ??
          participant.source.driver;
        left.push(
          resolution !== undefined && "refused" in resolution
            ? `${participant.handle} didn't come: ${resolution.refused}`
            : input.hasDriver(participant.source.driver)
              ? `${participant.handle} was left out of the move.`
              : `${participant.handle} didn't come: this computer has no ${driverName} agent.`,
        );
      }
      return {
        id,
        handle: participant.handle,
        ...(participant.role !== undefined ? { role: participant.role } : {}),
        // One that didn't come keeps its name and model for its old messages.
        modelSelection:
          selection ??
          ({
            instanceId: participant.agent?.instanceId ?? participant.source.driver,
            model: participant.source.model,
          } as ModelSelection),
        joinedAt: participant.joinedAt,
        leftAt: selection !== undefined ? null : (participant.leftAt ?? input.now),
        ...(participant.guest !== undefined ? { guest: participant.guest } : {}),
        ...(selection !== undefined ? { movedIn: true as const } : {}),
        ...(selection !== undefined && input.carried.has(participant.id)
          ? {
              nativeSession: "carried" as const,
              // How far its own session got: its first turn here catches up from there.
              ...(participant.seenThroughMessageId !== undefined
                ? { movedSeenThrough: input.messageIdHere(participant.seenThroughMessageId) }
                : {}),
            }
          : {}),
      };
    },
  );
  const cameNames = participants.filter((entry) => entry.movedIn === true).map((e) => e.handle);
  return {
    participants,
    ...(room?.agentRole !== undefined ? { agentRole: room.agentRole } : {}),
    ids,
    came,
    brought: cameNames.length > 0 ? [`its agents ${names(cameNames)}`] : [],
    left,
  };
}

/** A room agent's id here, or (one the room never had) none. Null: the thread's own agent. */
const mapped = (ids: ReadonlyMap<string, ThreadParticipantId>, id: string | null | undefined) =>
  id === null || id === undefined ? id : ids.get(id);

/** A moved message's room fields with this computer's agent ids; one naming no agent of the room loses them. */
export function remapRoomMessage(
  message: ThreadImportMessage,
  ids: ReadonlyMap<string, ThreadParticipantId>,
): ThreadImportMessage {
  const {
    participantId: fromParticipant,
    fromAgent,
    agentModels,
    requestId,
    requestKind,
    requestOutcome,
    requestError,
    ...rest
  } = message;
  const participantId = mapped(ids, fromParticipant);
  const fromId = fromAgent === undefined ? undefined : mapped(ids, fromAgent.participantId);
  const keptRequest = fromAgent === undefined || fromId !== undefined;
  return {
    ...rest,
    ...(participantId !== undefined ? { participantId } : {}),
    ...(fromAgent !== undefined && fromId !== undefined
      ? { fromAgent: { participantId: fromId } }
      : {}),
    ...(agentModels !== undefined
      ? {
          agentModels: Object.fromEntries(
            Object.entries(agentModels).flatMap(([key, value]) => {
              if (key === "primary") return [[key, value]];
              const id = ids.get(key);
              return id === undefined ? [] : [[id, value]];
            }),
          ),
        }
      : {}),
    ...(keptRequest && requestId !== undefined ? { requestId } : {}),
    ...(keptRequest && requestKind !== undefined ? { requestKind } : {}),
    ...(keptRequest && requestOutcome !== undefined ? { requestOutcome } : {}),
    ...(keptRequest && requestError !== undefined ? { requestError } : {}),
  };
}

/** A moved activity's agent with this computer's id; one naming no agent of the room loses it. */
export function remapRoomActivity(
  activity: OrchestrationThreadActivity,
  ids: ReadonlyMap<string, ThreadParticipantId>,
): OrchestrationThreadActivity {
  const { participantId, ...rest } = activity;
  const id = mapped(ids, participantId);
  return id === undefined ? rest : { ...rest, participantId: id };
}

/**
 * The outside-work marks with this computer's agent ids: an agent limited
 * there is limited here. One for an agent that didn't come goes: it never
 * runs here.
 */
export function remapOutsideWork(
  marks: ReadonlyArray<OrchestrationOutsideWork> | undefined,
  ids: ReadonlyMap<string, ThreadParticipantId>,
  came: ReadonlyMap<string, ModelSelection>,
): ReadonlyArray<OrchestrationOutsideWork> {
  return (marks ?? []).flatMap((mark) => {
    if (mark.participantId === null) return [mark];
    const id = ids.get(mark.participantId);
    return id !== undefined && came.has(mark.participantId) ? [{ ...mark, participantId: id }] : [];
  });
}
