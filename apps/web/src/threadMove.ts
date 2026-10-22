/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3), as the
 * app words and decides it: when the move is offered, what a move takes with
 * it, how far one got, and whether one can still finish. Pure: the dialog,
 * the composer notice, the sidebar and the request rows read the same rules.
 *
 * @module threadMove
 */
import type {
  ModelSelection,
  OrchestrationThreadMove,
  OutboundComputerLink,
  ThreadMoveChanges,
  ThreadMoveTargetPreview,
} from "@threadlines/contracts";

import type { ThreadMoveStatus } from "./types";

/**
 * The boundary on a thread that moved here: one activity after the imported
 * history, payload `{ fromEnvironmentId, fromLabel, fromThreadId, movedAt }`.
 */
export const THREAD_MOVED_IN_ACTIVITY_KIND = "thread.moved-in";
/**
 * A move that was dropped, on the thread that stayed: "Couldn't move to …",
 * payload `{ targetLabel, reason }`.
 */
export const THREAD_MOVE_FAILED_ACTIVITY_KIND = "thread.move-failed";

/** "moving" until the other computer took it, "moved" after; undefined for neither. */
export function threadMoveStatus(
  move: OrchestrationThreadMove | null | undefined,
): ThreadMoveStatus | undefined {
  if (!move) return undefined;
  return move.movedAway ? "moved" : "moving";
}

/**
 * Whether to offer "Move to another computer" for a thread: its computer
 * moves threads, links to at least one computer right now, and the thread
 * isn't moving or moved already. Everything else (a room, live work, a
 * computer that can't take it) the dialog shows with its reason.
 */
export function isThreadMoveOffered(input: {
  readonly supportsThreadMove: boolean;
  /** The thread's computer's own links, as last heard; null when not heard. */
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
  readonly moveStatus: ThreadMoveStatus | undefined;
}): boolean {
  return (
    input.supportsThreadMove &&
    input.moveStatus === undefined &&
    (input.outbound ?? []).some((link) => link.state === "active")
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What a move takes with it, in one line: "12 messages · branch fix/x · 3
 * changed files · 1 new file · 2 commits not pushed". Counts of zero are left
 * out; the messages and the branch always show. The dialog's preview and a
 * move request (ComputerLinkPendingRequest.move) read alike.
 */
export function formatThreadMoveChanges(
  changes: Pick<
    ThreadMoveChanges,
    "messageCount" | "branch" | "trackedFiles" | "untrackedFiles" | "unpushedCommits"
  >,
): string {
  return [
    plural(changes.messageCount, "message", "messages"),
    changes.branch === null ? "not on a branch" : `branch ${changes.branch}`,
    changes.trackedFiles > 0 ? plural(changes.trackedFiles, "changed file", "changed files") : null,
    changes.untrackedFiles > 0 ? plural(changes.untrackedFiles, "new file", "new files") : null,
    changes.unpushedCommits > 0
      ? plural(changes.unpushedCommits, "commit not pushed", "commits not pushed")
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** "Full access" as it reads after "with up to": "Full access", "Auto access". */
export function formatThreadMoveAccess(accessLabel: string): string {
  return /\baccess$/iu.test(accessLabel) ? accessLabel : `${accessLabel} access`;
}

/** How much of a move's data the other computer has, 0 to 100; null before it's known. */
export function threadMoveSentPercent(move: OrchestrationThreadMove): number | null {
  const total = move.totalBytes;
  if (total === undefined || total <= 0) return null;
  // Floored, so 100% only shows once every byte is there.
  return Math.min(100, Math.max(0, Math.floor(((move.sentBytes ?? 0) / total) * 100)));
}

/** Where an unfinished move is, in a few words: the composer notice's lead. */
export function describeThreadMoveProgress(move: OrchestrationThreadMove): string {
  const label = move.target.label;
  if (move.cancelRequested) return "Stopping the move…";
  switch (move.phase) {
    case "exporting":
      return `Getting ready to move to ${label}…`;
    case "awaiting_approval":
      return `Waiting for ${label} to allow the move`;
    case "sending": {
      const percent = threadMoveSentPercent(move);
      return percent === null ? `Sending to ${label}…` : `Sending to ${label} · ${percent}%`;
    }
    case "importing":
      return `Setting up on ${label}…`;
  }
}

/** Why a moving or moved thread takes no message here: the locked composer's placeholder. */
export function threadMoveLockReason(move: OrchestrationThreadMove): string {
  return move.movedAway
    ? `This thread moved to ${move.target.label}`
    : `This thread is moving to ${move.target.label}`;
}

/**
 * An unfinished move that can't go on: this computer's link to the other one
 * is gone, isn't active, or can't reach it. The move then can neither finish
 * nor stop until they reconnect, since only the other computer can confirm
 * either. `outbound` null (links not heard) says nothing.
 */
export function isThreadMoveStalled(input: {
  readonly move: OrchestrationThreadMove | null | undefined;
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
}): boolean {
  const { move, outbound } = input;
  if (!move || move.movedAway || outbound === null) return false;
  const link = outbound.find(
    (candidate) => candidate.remoteEnvironmentId === move.target.environmentId,
  );
  return link === undefined || link.state !== "active" || link.connection === "offline";
}

/** The computer to offer first: the first that can take the thread, else the first. */
export function pickDefaultMoveTarget(
  targets: ReadonlyArray<ThreadMoveTargetPreview>,
): ThreadMoveTargetPreview | null {
  return targets.find((target) => target.refusal === undefined) ?? targets[0] ?? null;
}

/** One of a target's agents and models, as the agent picker holds it. */
export interface ThreadMoveAgentChoice {
  readonly instanceId: string;
  readonly model: string;
}

const AGENT_KEY_SEPARATOR = "\u0000";

export const threadMoveAgentKey = (choice: ThreadMoveAgentChoice) =>
  `${choice.instanceId}${AGENT_KEY_SEPARATOR}${choice.model}`;

/** The agent to preselect: the target's suggestion when it has it, else its first model. */
export function pickDefaultMoveAgent(
  target: Pick<ThreadMoveTargetPreview, "agents" | "suggestedAgent">,
): ThreadMoveAgentChoice | null {
  const suggested = target.suggestedAgent;
  if (
    suggested &&
    target.agents.some(
      (agent) =>
        agent.instanceId === suggested.instanceId &&
        agent.models.some((model) => model.model === suggested.model),
    )
  ) {
    return { instanceId: suggested.instanceId, model: suggested.model };
  }
  for (const agent of target.agents) {
    const model = agent.models[0];
    if (model) return { instanceId: agent.instanceId, model: model.model };
  }
  return null;
}

/**
 * The agent a move asks for: the target's suggestion as it came (its options
 * included) when that is the one picked, else the picked agent and model.
 */
export function threadMoveAgentSelection(
  target: Pick<ThreadMoveTargetPreview, "suggestedAgent">,
  choice: ThreadMoveAgentChoice,
): ModelSelection {
  const suggested = target.suggestedAgent;
  if (suggested && suggested.instanceId === choice.instanceId && suggested.model === choice.model) {
    return suggested;
  }
  return { instanceId: choice.instanceId as ModelSelection["instanceId"], model: choice.model };
}
