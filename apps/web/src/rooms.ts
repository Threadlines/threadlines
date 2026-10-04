/**
 * Client rules for rooms: threads with more than one agent.
 *
 * The thread's own agent is addressed with a null participant id. Every agent
 * is named by its model, the short name the model picker shows ("Opus 5.5",
 * "GPT-6 Astra"). The composer's agent picker says who a message goes to; the
 * choice is remembered per thread in memory and defaults to the agent that
 * worked last, so carrying on with the same agent stays one keystroke.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type {
  MessageAgentModel,
  ModelSelection,
  OrchestrationAgentRequestState,
  OrchestrationAgentRequestStatus,
  OrchestrationSideTurn,
  OrchestrationThreadActivity,
  OrchestrationThreadParticipant,
  ProviderOptionSelection,
  RoomAgentInviteBilling,
  RoomAgentRequestId,
  RoomReviewBasis,
  ScopedThreadRef,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import {
  activeParticipants,
  hasAgentRecords,
  isRoomThread,
  nextRoomAgentName,
  roomAgentKey,
} from "@threadlines/shared/threadParticipants";
import { awaitingInvite } from "@threadlines/shared/roomAgentRequests";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
} from "@threadlines/shared/model";
import { create } from "zustand";

import type { ProviderInstanceEntry } from "./providerInstances";
import { getProviderModelCapabilities } from "./providerModels";
import type { ChatMessage } from "./types";

export interface RoomThreadLike {
  readonly participants?: ReadonlyArray<OrchestrationThreadParticipant> | undefined;
  readonly session?: { readonly participantId?: ThreadParticipantId | null | undefined } | null;
}

const participantsOf = (thread: RoomThreadLike) => ({ participants: thread.participants ?? [] });

/**
 * A room right now: another agent is in the thread besides its own. The room
 * icon, the Rooms filter, the agent picker and sending to an agent follow
 * this, so a thread whose added agents all left reads as a plain thread.
 */
export function isRoom(thread: RoomThreadLike | null | undefined): boolean {
  return thread != null && activeParticipants(participantsOf(thread)).length > 0;
}

/**
 * An agent was ever added, even if all have left: their messages keep their
 * authors, and revert stays off (the server refuses it, since the thread's
 * own conversation never held the other agents' turns). An agent brought in
 * for one review (a guest) does not count.
 */
export function hasRoomHistory(thread: RoomThreadLike | null | undefined): boolean {
  return thread != null && isRoomThread(participantsOf(thread));
}

/**
 * The agent the composer sends to: the user's explicit choice while that
 * agent is still in the thread, otherwise the agent that worked last.
 */
export function resolveRoomRecipient(
  thread: RoomThreadLike,
  chosen: ThreadParticipantId | null | undefined,
): ThreadParticipantId | null {
  const present = new Set(activeParticipants(participantsOf(thread)).map((entry) => entry.id));
  if (chosen !== undefined) {
    return chosen === null || present.has(chosen) ? chosen : null;
  }
  const holder = thread.session?.participantId ?? null;
  return holder !== null && present.has(holder) ? holder : null;
}

interface RoomRecipientState {
  /** Explicit choices by scoped thread key; absent means "follow the slot holder". */
  readonly chosen: Readonly<Record<string, ThreadParticipantId | null>>;
  readonly choose: (threadRef: ScopedThreadRef, participantId: ThreadParticipantId | null) => void;
  /**
   * Model options (reasoning and the like) picked for an added agent and not
   * sent yet, by `roomAgentOptionsKey`. The next turn for that agent carries
   * them, and the server keeps them on the agent from then on.
   */
  readonly agentOptions: Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>;
  readonly setAgentOptions: (
    threadRef: ScopedThreadRef,
    participantId: ThreadParticipantId,
    options: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  /**
   * "Send when done" picked for the message being written, by scoped thread
   * key: the turn at work when it was picked. It lapses once that turn is
   * over or the message is sent, so each new message is asked now.
   */
  readonly waitChosen: Readonly<Record<string, string>>;
  readonly chooseWait: (
    threadRef: ScopedThreadRef,
    turnId: TurnId | null | undefined,
    wait: boolean,
  ) => void;
  /**
   * "Add agent" asked for from outside the composer (the command palette):
   * the thread, by scoped key, and when. That thread's agent picker opens its
   * model list and clears it; a picker that was not there to see it in time
   * lets it lapse rather than open later out of nowhere.
   */
  readonly addAgentRequested: { readonly threadKey: string; readonly at: number } | null;
  readonly requestAddAgent: (threadRef: ScopedThreadRef | null) => void;
}

const roomAgentOptionsKey = (threadRef: ScopedThreadRef, participantId: ThreadParticipantId) =>
  `${scopedThreadKey(threadRef)}:${participantId}`;

/** In memory only: a reload falls back to the agent that worked last. */
export const useRoomRecipientStore = create<RoomRecipientState>((set) => ({
  chosen: {},
  choose: (threadRef, participantId) =>
    set((state) => ({
      chosen: { ...state.chosen, [scopedThreadKey(threadRef)]: participantId },
    })),
  agentOptions: {},
  setAgentOptions: (threadRef, participantId, options) =>
    set((state) => {
      const key = roomAgentOptionsKey(threadRef, participantId);
      const { [key]: _previous, ...rest } = state.agentOptions;
      return { agentOptions: options === undefined ? rest : { ...rest, [key]: options } };
    }),
  waitChosen: {},
  chooseWait: (threadRef, turnId, wait) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (!wait && !(key in state.waitChosen)) return state;
      const { [key]: _previous, ...rest } = state.waitChosen;
      return { waitChosen: wait ? { ...rest, [key]: turnId ?? "" } : rest };
    }),
  addAgentRequested: null,
  requestAddAgent: (threadRef) =>
    set({
      addAgentRequested:
        threadRef === null ? null : { threadKey: scopedThreadKey(threadRef), at: Date.now() },
    }),
}));

/** Whether "Send when done" was picked for the message being written. */
export const isRoomWaitChosen = (
  waitChosen: RoomRecipientState["waitChosen"],
  threadRef: ScopedThreadRef,
  /** The thread's latest turn: a pick made during an earlier one has lapsed. */
  turnId: TurnId | null | undefined,
): boolean => waitChosen[scopedThreadKey(threadRef)] === (turnId ?? "");

/**
 * The model selection a turn for an added agent runs with: the one it joined
 * with, plus any options picked since and not sent yet.
 */
export function roomAgentModelSelection(
  threadRef: ScopedThreadRef,
  participant: OrchestrationThreadParticipant,
  pendingOptions?: ReadonlyArray<ProviderOptionSelection>,
): ModelSelection {
  const options =
    pendingOptions ??
    useRoomRecipientStore.getState().agentOptions[roomAgentOptionsKey(threadRef, participant.id)];
  return options === undefined
    ? participant.modelSelection
    : { ...participant.modelSelection, options: [...options] };
}

export function useRoomAgentOptions(
  threadRef: ScopedThreadRef,
  participantId: ThreadParticipantId | null,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return useRoomRecipientStore((state) =>
    participantId === null
      ? undefined
      : state.agentOptions[roomAgentOptionsKey(threadRef, participantId)],
  );
}

export function chosenRoomRecipient(
  threadRef: ScopedThreadRef,
): ThreadParticipantId | null | undefined {
  return useRoomRecipientStore.getState().chosen[scopedThreadKey(threadRef)];
}

/** How an agent is shown in a room: its name and its provider. */
export interface RoomAgentLabel {
  /** What the room calls it: "GPT-6 Astra 2", or "GPT-6 Astra 2 (Reviewer)". */
  readonly name: string;
  /** Its model's name, numbered for repeats, without the user's name. */
  readonly modelName: string;
  /** The name the user gave it, if any (RoomAgentRole). */
  readonly role: string | null;
  /** It has left the room. */
  readonly left: boolean;
  /** Brought in for one review by an agent's invite; never a member. */
  readonly guest: boolean;
  /** How hard its model reasons, as the model picker names it ("High");
   *  null for a model without the setting. The chat shows it by the name. */
  readonly reasoning: string | null;
  readonly entry: ProviderInstanceEntry | undefined;
}

/** "GPT-6 Astra 2 (Reviewer)": the model stays visible next to the user's name. */
export const roomAgentDisplayName = (modelName: string, role: string | null | undefined) =>
  role ? `${modelName} (${role})` : modelName;

/** Which agent's turn each turn was, from its messages; see roomActivityAgent. */
export function roomTurnOwners(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "turnId" | "participantId">>,
): ReadonlyMap<TurnId, ThreadParticipantId | null> {
  const owners = new Map<TurnId, ThreadParticipantId | null>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId != null) {
      owners.set(message.turnId, message.participantId ?? null);
    }
  }
  return owners;
}

/**
 * Which agent an activity came from in a room: the added agent it names, or
 * the thread's own agent (null), which names nobody. Activities recorded
 * before added agents' were named go by the agent whose turn it was.
 */
export function roomActivityAgent(
  activity: Pick<OrchestrationThreadActivity, "participantId" | "turnId">,
  turnOwners: ReadonlyMap<TurnId, ThreadParticipantId | null>,
): ThreadParticipantId | null {
  if (activity.participantId != null) {
    return activity.participantId;
  }
  return activity.turnId == null ? null : (turnOwners.get(activity.turnId) ?? null);
}

export { roomAgentKey };

/**
 * Labels for every agent that ever took part in a thread, including ones that
 * left and guests brought in for one review, so their messages keep a name.
 * Each is named by its model; agents on the same model are numbered in the
 * order they joined, the thread's own agent first. Null while the thread's
 * own agent is its only one.
 */
export function buildRoomAgentLabels(
  thread: RoomThreadLike & {
    readonly modelSelection: ModelSelection;
    readonly agentRole?: string | undefined;
  },
  entries: ReadonlyArray<ProviderInstanceEntry>,
  /** The name the model picker shows, so the two always match. */
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): ReadonlyMap<string, RoomAgentLabel> | null {
  if (!hasAgentRecords(participantsOf(thread))) {
    return null;
  }
  const agents = [
    {
      key: roomAgentKey(null),
      selection: thread.modelSelection,
      role: thread.agentRole ?? null,
      left: false,
      guest: false,
    },
    ...(thread.participants ?? []).map((participant) => ({
      key: roomAgentKey(participant.id),
      selection: participant.modelSelection,
      role: participant.role ?? null,
      left: participant.leftAt !== null,
      guest: participant.guest === true,
    })),
  ];
  const labels = new Map<string, RoomAgentLabel>();
  const named: string[] = [];
  for (const agent of agents) {
    const modelName = nextRoomAgentName(
      roomModelName(agent.selection, entries, modelDisplayName),
      named,
    );
    named.push(modelName);
    labels.set(agent.key, agentLabel({ ...agent, modelName }, entries));
  }
  return labels;
}

function agentLabel(
  agent: {
    readonly selection: ModelSelection;
    readonly modelName: string;
    readonly role: string | null;
    readonly left: boolean;
    readonly guest: boolean;
  },
  entries: ReadonlyArray<ProviderInstanceEntry>,
): RoomAgentLabel {
  const entry = entries.find((candidate) => candidate.instanceId === agent.selection.instanceId);
  return {
    name: roomAgentDisplayName(agent.modelName, agent.role),
    modelName: agent.modelName,
    role: agent.role,
    left: agent.left,
    guest: agent.guest,
    reasoning: entry ? roomReasoningLabel(agent.selection, entry) : null,
    entry,
  };
}

/**
 * Names an agent the way a message recorded it (OrchestrationMessage.agentModels):
 * by the model, number and reasoning it had then, under the name the user
 * gives it now. Each stamp keeps one label, so a message's label does not
 * change identity between renders.
 */
export type AgentModelLabeler = (
  participantId: ThreadParticipantId | null,
  asWritten: MessageAgentModel,
) => RoomAgentLabel;

export function createAgentModelLabeler(
  thread: RoomThreadLike & { readonly agentRole?: string | undefined },
  entries: ReadonlyArray<ProviderInstanceEntry>,
  /** The name the model picker shows, so the two always match. */
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): AgentModelLabeler {
  const labels = new WeakMap<MessageAgentModel, Map<string, RoomAgentLabel>>();
  return (participantId, asWritten) => {
    const key = roomAgentKey(participantId);
    let byAgent = labels.get(asWritten);
    if (byAgent === undefined) {
      byAgent = new Map();
      labels.set(asWritten, byAgent);
    }
    const known = byAgent.get(key);
    if (known !== undefined) {
      return known;
    }
    const participant =
      participantId === null
        ? undefined
        : thread.participants?.find((entry) => entry.id === participantId);
    const modelName = roomModelName(asWritten.modelSelection, entries, modelDisplayName);
    const label = agentLabel(
      {
        selection: asWritten.modelSelection,
        modelName: asWritten.nameIndex > 1 ? `${modelName} ${asWritten.nameIndex}` : modelName,
        role: (participantId === null ? thread.agentRole : participant?.role) ?? null,
        left: participant !== undefined && participant.leftAt !== null,
        guest: participant?.guest === true,
      },
      entries,
    );
    byAgent.set(key, label);
    return label;
  };
}

/**
 * The labels for one message's lines: the room's, with each agent the
 * message names as it was when the message was written. The room's own map
 * when the message names nobody that way.
 */
export function messageAgentLabels(
  labels: ReadonlyMap<string, RoomAgentLabel> | null,
  message: Pick<ChatMessage, "agentModels">,
  labeler: AgentModelLabeler | null,
): ReadonlyMap<string, RoomAgentLabel> | null {
  const stamps = message.agentModels;
  if (labels === null || stamps === undefined || labeler === null) {
    return labels;
  }
  const overlaid = new Map(labels);
  for (const [key, asWritten] of Object.entries(stamps)) {
    overlaid.set(
      key,
      labeler(key === roomAgentKey(null) ? null : (key as ThreadParticipantId), asWritten),
    );
  }
  return overlaid;
}

/**
 * How the chat names the thread's own agent outside a room: by the model each
 * turn ran on, so switching models partway leaves earlier work under the model
 * that did it.
 */
export interface OwnAgentLabels {
  readonly byTurn: ReadonlyMap<TurnId, RoomAgentLabel>;
  /** A turn with no record of its model. Records only fall out of the
   *  activity window from the oldest end, so it takes the oldest record's. */
  readonly unrecorded: RoomAgentLabel;
  /** The live turn's, and work no turn names: the newest model sent, or the
   *  thread's model before anything was sent. */
  readonly latest: RoomAgentLabel;
}

export function buildOwnAgentLabels(
  thread: { readonly modelSelection: ModelSelection; readonly agentRole?: string | undefined },
  /** What each turn was sent with (deriveTurnDispatchedModelSelections). */
  sent: {
    readonly byTurn: ReadonlyMap<TurnId, ModelSelection>;
    readonly latest: ModelSelection | null;
  },
  entries: ReadonlyArray<ProviderInstanceEntry>,
  /** The name the model picker shows, so the two always match. */
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): OwnAgentLabels {
  // Turns sent with the same settings share one label.
  const bySelection = new Map<string, RoomAgentLabel>();
  const labelOf = (selection: ModelSelection) => {
    const key = JSON.stringify([selection.instanceId, selection.model, selection.options ?? []]);
    let label = bySelection.get(key);
    if (label === undefined) {
      label = agentLabel(
        {
          selection,
          modelName: roomModelName(selection, entries, modelDisplayName),
          role: thread.agentRole ?? null,
          left: false,
          guest: false,
        },
        entries,
      );
      bySelection.set(key, label);
    }
    return label;
  };
  const byTurn = new Map<TurnId, RoomAgentLabel>();
  for (const [turnId, selection] of sent.byTurn) {
    byTurn.set(turnId, labelOf(selection));
  }
  const latest = labelOf(sent.latest ?? thread.modelSelection);
  return { byTurn, unrecorded: byTurn.values().next().value ?? latest, latest };
}

/** The option each provider keeps its reasoning level in. */
const REASONING_OPTION_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
]);

/**
 * A model's reasoning level as the model picker names it ("High"), from the
 * selection's own choice or the model's default. Null when the model has no
 * such setting, or the provider does not list the model.
 */
export function roomReasoningLabel(
  selection: ModelSelection,
  entry: ProviderInstanceEntry,
): string | null {
  const caps = getProviderModelCapabilities(entry.models, selection.model, entry.driverKind);
  const descriptor = getProviderOptionDescriptors({ caps, selections: selection.options }).find(
    (candidate) => candidate.type === "select" && REASONING_OPTION_IDS.has(candidate.id),
  );
  return getProviderOptionCurrentLabel(descriptor) ?? null;
}

/** A model's name as the model picker shows it, or its id when unknown here. */
export function roomModelName(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelDisplayName: (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => string,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  return model && entry ? modelDisplayName(model, entry) : selection.model;
}

/**
 * The model of the agent a room's inbox row names as working or last at
 * work. Null outside rooms, where the row just says "working".
 */
export function roomSlotModelSelection(
  thread: RoomThreadLike & { readonly modelSelection: ModelSelection },
): ModelSelection | null {
  if (!isRoom(thread)) {
    return null;
  }
  const holderId = thread.session?.participantId ?? null;
  const holder =
    holderId === null ? undefined : thread.participants?.find((entry) => entry.id === holderId);
  return holder?.modelSelection ?? thread.modelSelection;
}

/** The user's name for the agent a room's inbox row names as working. */
export function roomSlotRole(
  thread: RoomThreadLike & { readonly agentRole?: string | undefined },
): string | null {
  if (!isRoom(thread)) {
    return null;
  }
  const holderId = thread.session?.participantId ?? null;
  return holderId === null
    ? (thread.agentRole ?? null)
    : (thread.participants?.find((entry) => entry.id === holderId)?.role ?? null);
}

/** The user's name for the agent answering on the side, if any. */
export function roomSideRole(
  thread: RoomThreadLike & {
    readonly agentRole?: string | undefined;
    readonly sideTurn?: OrchestrationSideTurn | null | undefined;
  },
): string | null {
  const sideTurn = thread.sideTurn ?? null;
  if (sideTurn === null) {
    return null;
  }
  return sideTurn.participantId === null
    ? (thread.agentRole ?? null)
    : (thread.participants?.find((entry) => entry.id === sideTurn.participantId)?.role ?? null);
}

/**
 * The model of the agent answering on the side, for the inbox row's
 * "GPT-6 Astra · answering". Null when nobody is.
 */
export function roomSideModelSelection(
  thread: RoomThreadLike & {
    readonly modelSelection: ModelSelection;
    readonly sideTurn?: OrchestrationSideTurn | null | undefined;
  },
): ModelSelection | null {
  const sideTurn = thread.sideTurn ?? null;
  if (sideTurn === null) {
    return null;
  }
  if (sideTurn.participantId === null) {
    return thread.modelSelection;
  }
  return (
    thread.participants?.find((entry) => entry.id === sideTurn.participantId)?.modelSelection ??
    null
  );
}

/**
 * The thread's session while its own agent holds the slot; null while an
 * added agent does. The composer's model controls, the provider lock and
 * native review all belong to the thread's own agent, and must not read
 * another agent's runtime as if it were its own.
 */
export function ownAgentSession<
  Session extends { readonly participantId?: ThreadParticipantId | null | undefined },
>(thread: { readonly session?: Session | null | undefined } | null | undefined): Session | null {
  const session = thread?.session ?? null;
  return session !== null && (session.participantId ?? null) === null ? session : null;
}

/**
 * Who a send goes to in a room, and the model it runs with: the composer's
 * choice, which defaults to the agent that worked last. Null recipient: the
 * thread's own agent, whose model the composer controls. Every send path uses
 * this, so a plan follow-up and a typed message route the same way.
 */
export function resolveRoomSend(input: {
  readonly enabled: boolean;
  readonly thread: RoomThreadLike;
  readonly threadRef: ScopedThreadRef;
}): {
  readonly active: boolean;
  readonly recipient: OrchestrationThreadParticipant | null;
  readonly modelSelection: ModelSelection | null;
} {
  if (!input.enabled || !isRoom(input.thread)) {
    return { active: false, recipient: null, modelSelection: null };
  }
  const chosenId = resolveRoomRecipient(input.thread, chosenRoomRecipient(input.threadRef));
  const recipient =
    (input.thread.participants ?? []).find((entry) => entry.id === chosenId) ?? null;
  return {
    active: true,
    recipient,
    modelSelection: recipient ? roomAgentModelSelection(input.threadRef, recipient) : null,
  };
}

/**
 * Providers whose agents can answer on the side: in a locked-down, read-only
 * copy of their conversation (docs/design/rooms-slice-2.md). The server
 * refuses the rest; this keeps the composer from offering it.
 */
const SIDE_ANSWER_DRIVER_KINDS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

export const canAnswerOnTheSide = (driverKind: string | undefined): boolean =>
  driverKind !== undefined && SIDE_ANSWER_DRIVER_KINDS.has(driverKind);

/**
 * How a message goes out in a room. "direct": to the agent at work (a steer)
 * or while nobody works (a turn). While another agent works: "ask" answers it
 * now, read-only, on the side; "queue" waits for the one at work to finish.
 * Asking is the default; waiting is picked per message (`chooseWait`), apart
 * from the "Steer now" / "Send when done" setting of a lone agent. An agent
 * that cannot answer on the side always queues. The send button and the send
 * path both read this, so they agree.
 */
export function resolveRoomDelivery(input: {
  readonly recipientId: ThreadParticipantId | null;
  readonly holderId: ThreadParticipantId | null;
  /** The agent holding the thread has a turn in flight or background work. */
  readonly holderBusy: boolean;
  readonly recipientDriverKind: string | undefined;
  /** The user picked "Send when done" for this message. */
  readonly waitChosen: boolean;
}): "direct" | "ask" | "queue" {
  if (!input.holderBusy || input.recipientId === input.holderId) {
    return "direct";
  }
  return !input.waitChosen && canAnswerOnTheSide(input.recipientDriverKind) ? "ask" : "queue";
}

/**
 * Room agents whose name matches what was typed after "@" in the composer:
 * "@astra", "@gpt6", "@opus". Only letters and digits count, so the spaces
 * and dashes in a model's name never get in the way. Nothing typed: all.
 */
export function matchRoomAgents<Agent extends { readonly name: string }>(
  agents: ReadonlyArray<Agent>,
  query: string,
): Agent[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = normalize(query);
  return agents.filter((agent) => normalize(agent.name).includes(wanted));
}

/** The tag every part of an independent review carries in the chat. */
export const ROOM_REVIEW_TAG = "Independent review · no room context";

/** What an agent's message in a room says about itself, for its meta line. */
export interface RoomAgentMessageDescription {
  /** The agent that wrote it. */
  readonly from: string;
  /** The agent it is for. */
  readonly to: string;
  /** "question on the side", "handed off", "reply"; null for a review, which has its tag. */
  readonly kind: string | null;
  readonly review: boolean;
  /** How a request ended without an answer: "Stopped before GPT-6 Astra 2 answered." */
  readonly outcomeNote: string | null;
}

/**
 * Describes a user-role message an agent wrote through a room tool: who to
 * whom, what it is, and how its request ended when that was not an answer.
 * Null for the user's own messages.
 */
export function describeRoomAgentMessage(input: {
  readonly message: Pick<
    ChatMessage,
    "fromAgent" | "participantId" | "requestKind" | "requestOutcome" | "requestError"
  >;
  readonly labels: ReadonlyMap<string, RoomAgentLabel> | null;
  /** The request's status while it is still open. */
  readonly openStatus: OrchestrationAgentRequestStatus | null;
}): RoomAgentMessageDescription | null {
  const { message } = input;
  if (message.fromAgent === undefined) {
    return null;
  }
  const nameOf = (participantId: ThreadParticipantId | null | undefined) =>
    input.labels?.get(roomAgentKey(participantId))?.name ?? "an agent";
  const from = nameOf(message.fromAgent.participantId);
  const to = nameOf(message.participantId);
  const kind =
    message.requestKind === "ask"
      ? "question on the side"
      : message.requestKind === "hand_off"
        ? input.openStatus === "pending"
          ? `handed off, starts when ${from} finishes`
          : input.openStatus === "queued"
            ? "handed off, waiting in the queue"
            : "handed off"
        : message.requestKind === "reply"
          ? "reply"
          : null;
  const targetLeft = input.labels?.get(roomAgentKey(message.participantId))?.left ?? false;
  // The server's reason, when it gave one ("The server restarted before this finished.").
  const reason = message.requestError !== undefined ? ` ${message.requestError}` : "";
  const outcomeNote =
    message.requestKind === "reply"
      ? message.requestOutcome === "cancelled"
        ? `Stopped before ${to} got it.`
        : null
      : message.requestOutcome === "stopped"
        ? `Stopped before ${to} answered.`
        : message.requestOutcome === "timeout"
          ? `Timed out before ${to} answered.`
          : message.requestOutcome === "failed"
            ? `${to} couldn't answer.${reason}`
            : message.requestOutcome === "cancelled"
              ? targetLeft
                ? `Cancelled: ${to} left the room.`
                : `Cancelled before ${to} answered.${reason}`
              : null;
  return { from, to, kind, review: message.requestKind === "review", outcomeNote };
}

/** An agent's invite waiting for the user, as the card above the message box shows it. */
export interface PendingRoomInvite {
  readonly requestId: RoomAgentRequestId;
  readonly fromName: string;
  readonly toName: string;
  readonly reason: string;
  /** What the invited agent will be asked. */
  readonly requestText: string;
  readonly billing: RoomAgentInviteBilling;
  readonly suggestion: "review" | "teammate";
  /** Adding it makes the thread a room for the first time (revert turns off). */
  readonly joinsRoom: boolean;
}

/** The invite waiting for the user in this thread, if any. */
export function pendingRoomInvite(
  thread: RoomThreadLike & {
    readonly agentRequests?: OrchestrationAgentRequestState | undefined;
    readonly messages: ReadonlyArray<ChatMessage>;
  },
  labels: ReadonlyMap<string, RoomAgentLabel> | null,
): PendingRoomInvite | null {
  const request = thread.agentRequests ? awaitingInvite(thread.agentRequests) : undefined;
  const message =
    request === undefined
      ? undefined
      : thread.messages.find((entry) => entry.id === request.requestMessageId);
  if (request === undefined || message?.invite === undefined) {
    return null;
  }
  const nameOf = (participantId: ThreadParticipantId | null | undefined) =>
    labels?.get(roomAgentKey(participantId))?.name ?? "An agent";
  return {
    requestId: request.requestId,
    fromName: nameOf(request.from.participantId),
    toName: nameOf(request.to.participantId),
    reason: message.invite.reason,
    requestText: message.text,
    billing: message.invite.billing,
    suggestion: message.invite.suggestion,
    joinsRoom: !hasRoomHistory(thread),
  };
}

/** What an invite's line in the chat says about it. */
export interface RoomInviteDescription {
  readonly from: string;
  readonly to: string;
  /** "waiting for you", "review only", "added to the thread", "not now". */
  readonly status: string;
  /** How it ended without its review, when it did. */
  readonly outcomeNote: string | null;
}

/** Describes an agent's invite message (requestKind `invite`). */
export function describeRoomInvite(input: {
  readonly message: Pick<
    ChatMessage,
    "fromAgent" | "participantId" | "invite" | "requestOutcome" | "requestError"
  >;
  readonly labels: ReadonlyMap<string, RoomAgentLabel> | null;
  readonly openStatus: OrchestrationAgentRequestStatus | null;
}): RoomInviteDescription {
  const { message } = input;
  const nameOf = (participantId: ThreadParticipantId | null | undefined) =>
    input.labels?.get(roomAgentKey(participantId))?.name ?? "an agent";
  const from = nameOf(message.fromAgent?.participantId);
  const to = nameOf(message.participantId);
  const choice = message.invite?.choice;
  const withoutAsking = message.invite?.automatic === true ? ", without asking" : "";
  const status =
    input.openStatus === "awaiting_user"
      ? "wants a review, waiting for you"
      : choice === "review"
        ? `review only${withoutAsking}`
        : choice === "teammate"
          ? `added to the thread${withoutAsking}`
          : message.requestOutcome === "declined"
            ? "not now"
            : "wants a review";
  const reason = message.requestError !== undefined ? ` ${message.requestError}` : "";
  const outcomeNote =
    message.requestOutcome === "stopped"
      ? `Stopped before ${to} answered.`
      : message.requestOutcome === "timeout"
        ? `Timed out before ${to} answered.`
        : message.requestOutcome === "failed"
          ? `${to} couldn't review.${reason}`
          : message.requestOutcome === "cancelled"
            ? `Cancelled.${reason}`
            : null;
  return { from, to, status, outcomeNote };
}

const shortRevision = (revision: string) =>
  /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;

/**
 * What an independent review was shown, in a line: "Uncommitted changes,
 * 4 files, captured 10:32", with ", cut to fit" when the diff was trimmed.
 */
export function describeRoomReviewBasis(
  basis: RoomReviewBasis,
  formatTime: (iso: string) => string,
): string {
  const what =
    basis.kind === "uncommitted"
      ? "Uncommitted changes"
      : basis.base === undefined
        ? "Committed changes"
        : basis.head === undefined
          ? `Changes since ${shortRevision(basis.base)}`
          : `Changes from ${shortRevision(basis.base)} to ${shortRevision(basis.head)}`;
  const files = `${basis.files} ${basis.files === 1 ? "file" : "files"}`;
  const cut = basis.truncated ? ", cut to fit" : "";
  return `${what}, ${files}, captured ${formatTime(basis.capturedAt)}${cut}`;
}
