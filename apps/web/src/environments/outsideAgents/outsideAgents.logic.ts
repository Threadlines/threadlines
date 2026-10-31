/**
 * Agents outside Threadlines (docs/design/outside-agents.md) and assistants
 * (docs/design/assistants.md), in the words the app shows them: what a
 * connection may do, where, how it signs in and when it last called; how each
 * client connects; the sign-ins waiting, oldest first; the choices the
 * approval dialog starts from and the grant they make; when a new sign-in
 * earns a system notification; what a thread says while their work limits
 * its agents' tools; and the web addresses assistants' alerts go to, with
 * their dialog's choices. Pure, so Settings, the dialogs and the labels say
 * it alike.
 */
import {
  AssistantAlertKind,
  type AssistantAlertTarget,
  type AssistantAlertTargetCreateInput,
  type AssistantAlertTargetId,
  type AssistantAlertTargetUpdateInput,
} from "@threadlines/contracts";
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
  // Short enough to read on a phone; the button's tooltip says the rest.
  const lead = `${joinNames(names)} worked here.`;
  const agents =
    agentName === null ? [] : [...new Set(work.map((entry) => agentName(entry.participantId)))];
  // A room's names can end in a role ("GPT-6 Astra 2 (Reviewer)"): no
  // possessive after them.
  const detail =
    agents.length === 0
      ? "Tools are limited until a fresh start."
      : `Tools of ${joinNames(agents)} are limited until a fresh start.`;
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

/** All projects, or only the ones ticked: the project picker the dialogs share. */
export interface OutsideAgentProjectsChoice {
  /** False: only `projectIds`. */
  readonly allProjects: boolean;
  readonly projectIds: ReadonlySet<ProjectId>;
}

/**
 * The projects a choice picks: null for all of them (projects added later
 * too), or the ones ticked that this computer still has, in its order. Empty
 * while none is ticked, which picks nothing.
 */
export function chosenProjectIds(
  choice: OutsideAgentProjectsChoice,
  availableProjectIds: ReadonlyArray<ProjectId>,
): ReadonlyArray<ProjectId> | null {
  if (choice.allProjects) return null;
  return availableProjectIds.filter((projectId) => choice.projectIds.has(projectId));
}

/** The approval dialog's choices while the user makes them. */
export interface OutsideAgentGrantDraft extends OutsideAgentProjectsChoice {
  readonly access: OutsideAgentAccess;
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
  const projectIds = chosenProjectIds(draft, input.availableProjectIds);
  return projectIds?.length === 0
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

/** What an alert is about, as the dialog's checkboxes say it. */
export const ASSISTANT_ALERT_KIND_LABELS: Record<AssistantAlertKind, string> = {
  needs_you: "Needs you",
  finished: "Finished",
  failed: "Failed",
};

/**
 * The kinds a web address gets, in their usual order, as its row says them:
 * "Needs you, finished and failed", "Finished and failed", "Needs you".
 */
export function describeAssistantAlertKinds(kinds: ReadonlyArray<AssistantAlertKind>): string {
  const words = AssistantAlertKind.literals
    .filter((kind) => kinds.includes(kind))
    .map((kind, index) => {
      const label = ASSISTANT_ALERT_KIND_LABELS[kind];
      return index === 0 ? label : label.toLowerCase();
    });
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A web address's host and path, or null when it doesn't read as one. */
function parseAlertAddress(url: string): { readonly host: string; readonly path: string } | null {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname === "/" ? "" : parsed.pathname };
  } catch {
    return null;
  }
}

/**
 * Each web address's row title: its host ("hooks.example.com"), or its host
 * and path where two share a host (two routines at one service), so the rows
 * tell apart.
 */
export function assistantAlertTargetTitles(
  targets: ReadonlyArray<Pick<AssistantAlertTarget, "targetId" | "url">>,
): ReadonlyMap<AssistantAlertTargetId, string> {
  const parsed = targets.map((target) => ({ target, address: parseAlertAddress(target.url) }));
  const hostCounts = new Map<string, number>();
  for (const { address } of parsed) {
    if (address !== null) hostCounts.set(address.host, (hostCounts.get(address.host) ?? 0) + 1);
  }
  return new Map(
    parsed.map(({ target, address }) => {
      if (address === null) return [target.targetId, target.url] as const;
      const shared = (hostCounts.get(address.host) ?? 0) > 1;
      return [target.targetId, shared ? `${address.host}${address.path}` : address.host] as const;
    }),
  );
}

/** How a web address is doing, as its row says it. */
export interface AssistantAlertTargetStatus {
  /** Said after its kinds and projects: "Last sent 2m ago · retrying 2", "Nothing sent yet", "Off". */
  readonly quiet: string | null;
  /** Worth a look, in the warning tone: the receiver refused or turned it off, and the last problem. */
  readonly warning: string | null;
}

/**
 * A web address's status: when it last sent and how many alerts wait for
 * another try while it's on, or Off; and, as a warning, the receiver
 * refusing it or turning it off (a 410), with the last problem in
 * Threadlines' words.
 */
export function describeAssistantAlertTargetStatus(
  target: Pick<
    AssistantAlertTarget,
    "state" | "refusedSince" | "lastSentAt" | "lastError" | "retrying"
  >,
  nowMs: number,
): AssistantAlertTargetStatus {
  const sent =
    target.lastSentAt === null
      ? "Nothing sent yet"
      : `Last sent ${formatRelativeTimeLabel(target.lastSentAt, nowMs)}`;
  const quiet =
    target.state === "off"
      ? "Off"
      : target.state === "gone"
        ? null
        : target.retrying > 0
          ? `${sent} · retrying ${target.retrying}`
          : sent;
  const label =
    target.state === "gone"
      ? "Turned off by the receiver"
      : target.refusedSince !== null
        ? "Refused by the receiver"
        : null;
  const warning = [label, target.lastError].filter((part) => part !== null).join(". ");
  return { quiet, warning: warning.length > 0 ? warning : null };
}

/**
 * The Authorization header as the dialog holds it, never its saved value:
 * kept as it is (Edit, with one set), being typed (empty: none, or unchanged
 * in Edit), or cleared on save.
 */
export type AssistantAlertAuthorizationDraft =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "clear" };

/** The Add and Edit dialog's choices while the user makes them. */
export interface AssistantAlertTargetDraft extends OutsideAgentProjectsChoice {
  readonly url: string;
  readonly kinds: ReadonlySet<AssistantAlertKind>;
  readonly skipViewed: boolean;
  readonly authorization: AssistantAlertAuthorizationDraft;
}

/**
 * Where the dialog starts: a web address's own choices for Edit; for Add,
 * every kind, all projects, and skipping threads you're looking at.
 */
export function initialAssistantAlertTargetDraft(
  target: AssistantAlertTarget | null,
): AssistantAlertTargetDraft {
  if (target === null) {
    return {
      url: "",
      kinds: new Set(AssistantAlertKind.literals),
      allProjects: true,
      projectIds: new Set(),
      skipViewed: true,
      authorization: { kind: "set", value: "" },
    };
  }
  return {
    url: target.url,
    kinds: new Set(target.kinds),
    allProjects: target.projectIds === null,
    projectIds: new Set(target.projectIds ?? []),
    skipViewed: target.skipViewed,
    authorization: target.hasAuthorization ? { kind: "keep" } : { kind: "set", value: "" },
  };
}

/**
 * The fields Add and Edit share, or null while the choices can't be saved:
 * no address, no kind ticked, or only some projects with none ticked. The
 * server checks the address itself (https, and not a private one).
 */
function assistantAlertTargetFields(
  draft: AssistantAlertTargetDraft,
  availableProjectIds: ReadonlyArray<ProjectId>,
): Omit<AssistantAlertTargetCreateInput, "authorization"> | null {
  const url = draft.url.trim();
  const kinds = AssistantAlertKind.literals.filter((kind) => draft.kinds.has(kind));
  const projectIds = chosenProjectIds(draft, availableProjectIds);
  if (url.length === 0 || kinds.length === 0 || projectIds?.length === 0) return null;
  return { url, kinds, projectIds, skipViewed: draft.skipViewed };
}

/** The header's value as typed, trimmed; null when nothing is. */
function typedAuthorization(draft: AssistantAlertTargetDraft): string | null {
  const value = draft.authorization.kind === "set" ? draft.authorization.value.trim() : "";
  return value.length > 0 ? value : null;
}

/** What Add sends, or null while the choices can't be saved. */
export function assistantAlertTargetCreateInput(
  draft: AssistantAlertTargetDraft,
  availableProjectIds: ReadonlyArray<ProjectId>,
): AssistantAlertTargetCreateInput | null {
  const fields = assistantAlertTargetFields(draft, availableProjectIds);
  return fields === null ? null : { ...fields, authorization: typedAuthorization(draft) };
}

/** What Edit sends, or null while the choices can't be saved. An empty header field keeps the one set. */
export function assistantAlertTargetUpdateInput(
  targetId: AssistantAlertTargetId,
  draft: AssistantAlertTargetDraft,
  availableProjectIds: ReadonlyArray<ProjectId>,
): AssistantAlertTargetUpdateInput | null {
  const fields = assistantAlertTargetFields(draft, availableProjectIds);
  if (fields === null) return null;
  const typed = typedAuthorization(draft);
  return {
    targetId,
    ...fields,
    authorization:
      draft.authorization.kind === "clear"
        ? { kind: "clear" }
        : typed !== null
          ? { kind: "set", value: typed }
          : { kind: "keep" },
  };
}
