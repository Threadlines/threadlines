/**
 * Agents outside Threadlines (docs/design/outside-agents.md) and assistants
 * (docs/design/assistants.md), in the words the app shows them: what a
 * connection may do, where, how it signs in and when it last called; how each
 * client connects; the sign-ins waiting, oldest first; the choices the
 * approval dialog starts from and the grant they make; when a new sign-in
 * earns a system notification; and what a thread says while their work limits
 * its agents' tools. Pure, so Settings, the dialog and the labels say it
 * alike.
 */
import type {
  OutsideAgentAccess,
  OutsideAgentAssistantSignIn,
  OutsideAgentConnection,
  OutsideAgentGrant,
  OutsideAgentIdentity,
  OutsideAgentPendingRequest,
  OutsideAgentRef,
  OutsideAgentsSnapshot,
  OrchestrationOutsideWork,
  ProjectId,
  RuntimeMode,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { runtimeModeConfig } from "../../runtimeModeOptions";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/** What a connection may do, as a choice in the dialog. */
export const OUTSIDE_AGENT_ACCESS_CHOICES: Record<OutsideAgentAccess, string> = {
  see: "See threads",
  start: "Start threads",
  work: "Work with all threads",
};

/** The same on its row, said of the connection. */
const OUTSIDE_AGENT_ACCESS_ON_ROW: Record<OutsideAgentAccess, string> = {
  see: "Sees threads",
  start: "Starts threads",
  work: "Works with all threads",
};

/**
 * What a connection's grant allows, on its row: "Sees threads", "Starts
 * threads · Supervised", "Works with all threads · Auto". The highest access
 * shows wherever it limits something, which is every level past See.
 */
export function describeOutsideAgentAccess(
  grant: Pick<OutsideAgentGrant, "access" | "maxRuntimeMode">,
): string {
  const doing = OUTSIDE_AGENT_ACCESS_ON_ROW[grant.access];
  return grant.access === "see"
    ? doing
    : `${doing} · ${runtimeModeConfig[grant.maxRuntimeMode].label}`;
}

/**
 * Whether the dialog may give `access` to a sign-in that asked for
 * `requestedAccess`. One that asked only to see threads stays at See. One
 * that asked to start them may get any level: no sign-in asks for Work, only
 * the user grants it. Keys and Change ask as Start.
 */
export function outsideAgentAccessAllowed(
  access: OutsideAgentAccess,
  requestedAccess: OutsideAgentAccess,
): boolean {
  return access === "see" || requestedAccess !== "see";
}

/**
 * The projects a connection may use, by name: "All projects", "web",
 * "web, api", "web, api and 2 more". A project removed since keeps no name.
 */
export function describeOutsideAgentProjects(
  projectIds: OutsideAgentGrant["projectIds"],
  projectNames: ReadonlyMap<ProjectId, string>,
): string {
  if (projectIds === null) return "All projects";
  const names = projectIds.flatMap((projectId) => {
    const name = projectNames.get(projectId);
    return name === undefined ? [] : [name];
  });
  if (names.length === 0) return "No projects";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** When a connection last called: "Used 2m ago", "Not used yet". */
export function describeOutsideAgentLastUse(lastUsedAt: string | null, nowMs: number): string {
  return lastUsedAt === null
    ? "Not used yet"
    : `Used ${formatRelativeTimeLabel(lastUsedAt, nowMs)}`;
}

/**
 * How an assistant connection signs in, on its row: "Signs in from cursor.sh"
 * when the relay checked who it is, "Sign-in returns to cursor.sh" when only
 * where its sign-in goes back to is known, "Key" for a key made in Settings.
 * Null for local agents, which all sign in the same way.
 */
export function describeOutsideAgentSignIn(
  connection: Pick<OutsideAgentConnection, "kind" | "signIn" | "identity">,
): string | null {
  if (connection.kind !== "assistant") return null;
  if (connection.signIn === "key") return "Key";
  if (connection.identity === null) return null;
  return connection.identity.verified
    ? `Signs in from ${connection.identity.host}`
    : `Sign-in returns to ${connection.identity.host}`;
}

/**
 * Who an assistant signing in is, as its approval dialog says it: checked by
 * the relay, or only the name it gave and where its sign-in returns to.
 */
export function describeAssistantIdentity(identity: OutsideAgentIdentity): string {
  return identity.verified
    ? `Signs in from ${identity.host}.`
    : `Name given by the assistant. Sign-in returns to ${identity.host}.`;
}

/** A sign-in waiting for the user: a local agent's, or an assistant's. */
export type OutsideAgentWaitingSignIn =
  | (OutsideAgentPendingRequest & { readonly kind: "local" })
  | (OutsideAgentAssistantSignIn & { readonly kind: "assistant" });

/** Every sign-in waiting for the user, local agents' and assistants' together, oldest first. */
export function waitingOutsideAgentSignIns(
  snapshot: Pick<OutsideAgentsSnapshot, "pending" | "assistants">,
): ReadonlyArray<OutsideAgentWaitingSignIn> {
  const waiting: Array<OutsideAgentWaitingSignIn> = [
    ...snapshot.pending.map((request) => ({ ...request, kind: "local" as const })),
    ...snapshot.assistants.signIns.map((signIn) => ({ ...signIn, kind: "assistant" as const })),
  ];
  // Stable, so each kind keeps the server's order among equal times.
  return waiting.toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

/** An assistant sign-in code as the server gives it: 8 characters, no dash, and when it runs out. */
export type AssistantSignInCode = NonNullable<OutsideAgentsSnapshot["assistants"]["code"]>;

/**
 * The code Settings shows after a snapshot: the snapshot's while it has one.
 * Once it leaves, the last one stays only if it had run out by then, so
 * Settings can say it expired; one that leaves before running out was used
 * (the approval dialog takes over) or cancelled, and is gone.
 */
export function nextShownAssistantCode(
  shown: AssistantSignInCode | null,
  live: AssistantSignInCode | null,
  nowMs: number,
): AssistantSignInCode | null {
  if (live !== null) return live;
  return shown !== null && Date.parse(shown.expiresAt) <= nowMs ? shown : null;
}

/** Whole minutes left in Deny all's quiet period, at least 1; null when it isn't on. */
export function outsideAgentQuietMinutesLeft(
  quietUntil: string | null,
  nowMs: number,
): number | null {
  if (quietUntil === null) return null;
  const leftMs = Date.parse(quietUntil) - nowMs;
  if (!Number.isFinite(leftMs) || leftMs <= 0) return null;
  return Math.max(1, Math.ceil(leftMs / 60_000));
}

/** "1 more waiting", "2 more waiting": the sign-ins behind the one on screen. */
export function describeOutsideAgentsWaiting(count: number): string {
  return `${count} more waiting`;
}

/** The small label on a thread an outside agent started: "from Claude Code". */
export function outsideOriginLabel(origin: Pick<OutsideAgentRef, "name">): string {
  return `from ${origin.name}`;
}

/** The same, said in full for a tooltip or a screen reader. */
export function outsideOriginDescription(origin: Pick<OutsideAgentRef, "name">): string {
  return `Started by ${origin.name}, an agent outside Threadlines`;
}

/** "A", "A and B", "A, B and others": a list that stays short. */
function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and others`;
}

/**
 * The thread's notice while outside work limits its agents' tools
 * (OrchestrationOutsideWork), as one sentence in two parts: who worked here
 * (`lead`), and whose Threadlines tools it limits until when (`detail`).
 * `agentName` names a room's agents; null while the thread has only its own,
 * which the notice calls "this agent". Null when nothing is marked.
 */
export function describeOutsideWork(
  work: ReadonlyArray<OrchestrationOutsideWork>,
  agentName: ((participantId: ThreadParticipantId | null) => string) | null,
): { readonly lead: string; readonly detail: string } | null {
  if (work.length === 0) return null;
  const connections = new Map<string, string>();
  for (const entry of work) {
    for (const connection of entry.connections) {
      if (!connections.has(connection.connectionId)) {
        connections.set(connection.connectionId, connection.name);
      }
    }
  }
  const names = [...new Set(connections.values())];
  const lead =
    names.length > 2
      ? `${joinNames(names)}' work ran here,`
      : `${joinNames(names)}'s work ran here,`;
  const agents =
    agentName === null ? [] : [...new Set(work.map((entry) => agentName(entry.participantId)))];
  // A room's names can end in a role ("GPT-6 Astra 2 (Reviewer)"): no
  // possessive after them.
  const detail =
    agents.length === 0
      ? "so this agent's Threadlines tools are limited until it starts fresh."
      : `so the Threadlines tools of ${joinNames(agents)} are limited until ${agents.length === 1 ? "it starts" : "they start"} fresh.`;
  return { lead, detail };
}

export type OutsideAgentClientId = "claude" | "codex" | "gemini" | "cursor";

/** How one client connects to this computer: what to run (or paste), and one line of help. */
export interface OutsideAgentConnectGuide {
  readonly id: OutsideAgentClientId;
  readonly label: string;
  /** Each to copy on its own, in order. */
  readonly commands: ReadonlyArray<string>;
  readonly hint: string;
}

/** The clients Settings shows how to connect, with this computer's address in each command. */
export function outsideAgentConnectGuides(
  address: string,
): ReadonlyArray<OutsideAgentConnectGuide> {
  return [
    {
      id: "claude",
      label: "Claude Code",
      commands: [`claude mcp add --transport http threadlines ${address}`],
      hint: "Then sign in from /mcp in Claude Code.",
    },
    {
      id: "codex",
      label: "Codex",
      commands: [`codex mcp add threadlines --url ${address}`, "codex mcp login threadlines"],
      hint: "The second command signs it in.",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      commands: [`gemini mcp add --transport http threadlines ${address}`],
      hint: "Then sign in with /mcp auth threadlines in Gemini CLI.",
    },
    {
      id: "cursor",
      label: "Cursor",
      commands: [JSON.stringify({ mcpServers: { threadlines: { url: address } } })],
      hint: "Add this to ~/.cursor/mcp.json.",
    },
  ];
}

/** The approval dialog's choices while the user makes them. */
export interface OutsideAgentGrantDraft {
  readonly access: OutsideAgentAccess;
  /** False: only `projectIds`. */
  readonly allProjects: boolean;
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly maxRuntimeMode: RuntimeMode;
}

/** A new sign-in starts at the least: See threads, all projects, Supervised if it may start. */
const NEW_REQUEST_DRAFT: OutsideAgentGrantDraft = {
  access: "see",
  allProjects: true,
  projectIds: new Set(),
  maxRuntimeMode: "approval-required",
};

/** Where the dialog starts: a connection's grant for Change, the least for a new sign-in. */
export function initialOutsideAgentDraft(grant: OutsideAgentGrant | null): OutsideAgentGrantDraft {
  if (grant === null) return NEW_REQUEST_DRAFT;
  return {
    access: grant.access,
    allProjects: grant.projectIds === null,
    projectIds: new Set(grant.projectIds ?? []),
    maxRuntimeMode: grant.maxRuntimeMode,
  };
}

/**
 * The grant the dialog's choices make, or null while they make none (some
 * projects, none of them picked). Only a level the sign-in allows
 * (outsideAgentAccessAllowed), and only projects this computer still has.
 */
export function outsideAgentGrantFromDraft(
  draft: OutsideAgentGrantDraft,
  input: {
    readonly requestedAccess: OutsideAgentAccess;
    readonly availableProjectIds: ReadonlyArray<ProjectId>;
  },
): OutsideAgentGrant | null {
  const access: OutsideAgentAccess = outsideAgentAccessAllowed(draft.access, input.requestedAccess)
    ? draft.access
    : "see";
  if (draft.allProjects) {
    return { access, maxRuntimeMode: draft.maxRuntimeMode, projectIds: null };
  }
  const projectIds = input.availableProjectIds.filter((projectId) =>
    draft.projectIds.has(projectId),
  );
  return projectIds.length === 0
    ? null
    : { access, maxRuntimeMode: draft.maxRuntimeMode, projectIds };
}

/** At most one system notification for new sign-ins this often. */
export const OUTSIDE_AGENT_NOTIFY_INTERVAL_MS = 30_000;

/**
 * Whether new sign-ins earn a system notification, and for which: the
 * newest one this app hasn't seen, while nobody is looking at the window and
 * none was shown in the last 30 seconds. Every waiting sign-in counts as seen
 * afterwards, notified or not, so one is never announced twice; `seen` keeps
 * only the ones still waiting.
 */
export function nextOutsideAgentNotification<
  TSignIn extends { readonly requestId: string },
>(input: {
  readonly pending: ReadonlyArray<TSignIn>;
  readonly seen: ReadonlySet<string>;
  readonly lastNotifiedAtMs: number | null;
  readonly nowMs: number;
  readonly attended: boolean;
}): { readonly notify: TSignIn | null; readonly seen: ReadonlySet<string> } {
  const seen = new Set(input.pending.map((request) => request.requestId));
  const fresh = input.pending.filter((request) => !input.seen.has(request.requestId));
  const throttled =
    input.lastNotifiedAtMs !== null &&
    input.nowMs - input.lastNotifiedAtMs < OUTSIDE_AGENT_NOTIFY_INTERVAL_MS;
  return { notify: input.attended || throttled ? null : (fresh.at(-1) ?? null), seen };
}
