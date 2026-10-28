import {
  TOOL_LIFECYCLE_ITEM_TYPES,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@threadlines/contracts";

import type { AnalyticsSessionStartKind } from "../telemetry/AnalyticsProperties.ts";

const AGENT_OUTPUT_ITEM_TYPES: ReadonlySet<CanonicalItemType> = new Set([
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
]);

/**
 * True when a runtime event is the agent visibly answering: text, reasoning,
 * a plan, a tool starting or a question for the user. Session and turn
 * bookkeeping, the echoed user message and compaction are not answers.
 */
export const isAgentOutputEvent = (event: ProviderRuntimeEvent): boolean => {
  switch (event.type) {
    case "content.delta":
    case "turn.plan.updated":
    case "turn.proposed.delta":
    case "request.opened":
    case "user-input.requested":
      return true;
    case "item.started":
    case "item.updated":
    case "item.completed":
      return AGENT_OUTPUT_ITEM_TYPES.has(event.payload.itemType);
    default:
      return false;
  }
};

/** How long one turn kept its sender waiting, measured from when the message reached the server. */
export interface TurnLatencySample {
  readonly provider: string;
  /** See `ProviderInstance.communityAgentId`. */
  readonly communityAgentId?: string | undefined;
  readonly model: string | undefined;
  readonly attachmentCount: number;
  /** The agent's session started after the message arrived, so the wait includes its startup. */
  readonly sessionStarted: boolean;
  /** The agent's session was started early, while the user typed, and this was its first turn. */
  readonly sessionStartedEarly: boolean;
  /**
   * The start behind `sessionStarted` or `sessionStartedEarly`: what kind it
   * was and how long the provider took to start. A start for the message falls
   * within `handoffMs`, and the rest of the hand-off is Threadlines' own; an
   * early one began before the message, so some or all of it was not waited on.
   */
  readonly sessionStart?: SessionStartTiming | undefined;
  /** Until Threadlines handed the message to the agent. */
  readonly handoffMs: number;
  /** Until the agent's first visible output. */
  readonly firstOutputMs: number;
}

/** One provider session start, as the latency samples describe it. */
export interface SessionStartTiming {
  readonly kind: AnalyticsSessionStartKind;
  /** From asking the provider to start until it had started. */
  readonly startMs: number;
}

/** A session start the tracker can attribute to a later turn. */
interface RecordedSessionStart {
  /** When the start was asked for and when it finished, on the server's clock. */
  readonly beganAtMs: number;
  readonly atMs: number;
  readonly instanceId: string;
  readonly timing: SessionStartTiming;
}

/**
 * A message that waited longer than this before going out was held on
 * purpose (a queue, a hand-over, a restart), not slowed down: it is not
 * followed.
 */
const MAX_FOLLOWED_HANDOFF_MS = 10 * 60_000;

interface PendingTurn extends Omit<TurnLatencySample, "firstOutputMs"> {
  /** Which send this is; a send that finishes after a newer one began settles nothing. */
  readonly sendId: number;
  readonly requestedAtMs: number;
  /** The provider instance running the turn; another one's exit is not this turn's. */
  readonly instanceId: string;
  /** Unknown until the adapter accepts the turn. */
  readonly turnId: TurnId | undefined;
  /**
   * While the turn id is unknown, what each turn the session reported did
   * meanwhile: its first output, or that it ended first. Other turns (a late
   * one, or a provider's own) report here too, and are dropped once the id is
   * known.
   */
  readonly early: Map<TurnId, { readonly firstOutputAtMs: number | undefined }>;
}

/**
 * Follows each sent turn, by session key, from the moment its message reached
 * the server until the agent's first output, for the turn latency telemetry.
 * Only events that name their turn count. A turn that ends, or a session that
 * exits, before any output is dropped.
 */
export const makeTurnLatencyTracker = () => {
  const sessionStarts = new Map<string, RecordedSessionStart>();
  const pending = new Map<string, PendingTurn>();
  let lastSendId = 0;

  const sampleOf = (turn: PendingTurn, firstOutputAtMs: number): TurnLatencySample => ({
    provider: turn.provider,
    communityAgentId: turn.communityAgentId,
    model: turn.model,
    attachmentCount: turn.attachmentCount,
    sessionStarted: turn.sessionStarted,
    sessionStartedEarly: turn.sessionStartedEarly,
    ...(turn.sessionStart !== undefined ? { sessionStart: turn.sessionStart } : {}),
    handoffMs: turn.handoffMs,
    firstOutputMs: Math.max(0, firstOutputAtMs - turn.requestedAtMs),
  });

  return {
    /** The provider finished starting a session for `sessionKey`. */
    sessionStarted: (sessionKey: string, start: RecordedSessionStart) => {
      sessionStarts.set(sessionKey, start);
    },

    /** The session was stopped or its thread deleted. */
    sessionStopped: (sessionKey: string) => {
      sessionStarts.delete(sessionKey);
      pending.delete(sessionKey);
    },

    /**
     * A turn is about to go to the agent. Call before the adapter sends it,
     * so output that arrives before the send returns still counts. Returns
     * the hand-off wait, and the send's id for `sent` or `notSent`.
     */
    sending: (
      sessionKey: string,
      input: Omit<
        PendingTurn,
        "sendId" | "handoffMs" | "sessionStarted" | "sessionStart" | "turnId" | "early"
      > & {
        readonly nowMs: number;
      },
    ): { readonly handoffMs: number; readonly sendId: number } => {
      const { nowMs, ...turn } = input;
      const handoffMs = Math.max(0, nowMs - turn.requestedAtMs);
      lastSendId += 1;
      const sendId = lastSendId;
      if (handoffMs > MAX_FOLLOWED_HANDOFF_MS) {
        pending.delete(sessionKey);
        return { handoffMs, sendId };
      }
      const start = sessionStarts.get(sessionKey);
      const ownStart =
        start !== undefined && start.instanceId === turn.instanceId ? start : undefined;
      // Named only when all of it was this turn's wait, or it was this turn's
      // early start: one already underway when the message came is neither.
      const namedStart =
        ownStart !== undefined &&
        (ownStart.beganAtMs >= turn.requestedAtMs || turn.sessionStartedEarly)
          ? ownStart.timing
          : undefined;
      pending.set(sessionKey, {
        ...turn,
        sendId,
        handoffMs,
        sessionStarted: ownStart !== undefined && ownStart.atMs >= turn.requestedAtMs,
        ...(namedStart !== undefined ? { sessionStart: namedStart } : {}),
        turnId: undefined,
        early: new Map(),
      });
      return { handoffMs, sendId };
    },

    /**
     * The adapter accepted the turn under `turnId`. Returns the sample when
     * the turn's first output already arrived while it was being sent.
     */
    sent: (sessionKey: string, sendId: number, turnId: TurnId): TurnLatencySample | undefined => {
      const turn = pending.get(sessionKey);
      if (turn === undefined || turn.sendId !== sendId || turn.turnId !== undefined) {
        return undefined;
      }
      const early = turn.early.get(turnId);
      if (early === undefined) {
        pending.set(sessionKey, { ...turn, turnId, early: new Map() });
        return undefined;
      }
      pending.delete(sessionKey);
      return early.firstOutputAtMs === undefined
        ? undefined
        : sampleOf(turn, early.firstOutputAtMs);
    },

    /** The adapter refused the turn. */
    notSent: (sessionKey: string, sendId: number) => {
      if (pending.get(sessionKey)?.sendId === sendId) {
        pending.delete(sessionKey);
      }
    },

    /** Returns a sample when `event` is the waiting turn's first output. */
    observe: (event: ProviderRuntimeEvent, nowMs: number): TurnLatencySample | undefined => {
      if (event.type === "session.exited") {
        // A replaced runtime can exit after its successor started: on another
        // instance, or on this one. An exit stamped before the latest start
        // ended is taken as the replaced one's; if it was the new runtime dying
        // while it started, its turn stays followed until the next send or stop.
        const start = sessionStarts.get(event.threadId);
        if (start !== undefined && Date.parse(event.createdAt) < start.atMs) {
          return undefined;
        }
        if (start?.instanceId === event.providerInstanceId) {
          sessionStarts.delete(event.threadId);
        }
        if (pending.get(event.threadId)?.instanceId === event.providerInstanceId) {
          pending.delete(event.threadId);
        }
        return undefined;
      }
      const turn = pending.get(event.threadId);
      if (turn === undefined || event.turnId === undefined) {
        return undefined;
      }
      const ended = event.type === "turn.completed" || event.type === "turn.aborted";
      if (!ended && !isAgentOutputEvent(event)) {
        return undefined;
      }
      if (turn.turnId === undefined) {
        if (!turn.early.has(event.turnId)) {
          turn.early.set(event.turnId, { firstOutputAtMs: ended ? undefined : nowMs });
        }
        return undefined;
      }
      if (event.turnId !== turn.turnId) {
        return undefined;
      }
      pending.delete(event.threadId);
      return ended ? undefined : sampleOf(turn, nowMs);
    },
  };
};
