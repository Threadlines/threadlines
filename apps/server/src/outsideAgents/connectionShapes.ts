/**
 * What both doors (the local `/mcp/connect` and the assistants door,
 * docs/design/assistants.md) share about a connection: how a row is shown in
 * Settings and named everywhere else, and the rules a grant the user picks
 * must pass.
 */
import type {
  KnownAssistant,
  OutsideAgentAccess,
  OutsideAgentConnection,
  OutsideAgentGrant,
} from "@threadlines/contracts";
import { assistantDisplayName, guessKnownAssistant } from "@threadlines/shared/knownAssistants";

import type { OutsideAgentConnectionRow } from "./OutsideAgentConnectionRepository.ts";

/** A connection row as Settings shows it. */
/**
 * Which known assistant an assistant connection is: the user's pick, else the
 * guess from its sign-in (knownAssistants.ts). Null for local agents and when
 * neither says.
 */
export const assistantOfRow = (
  row: Pick<OutsideAgentConnectionRow, "kind" | "assistantPick" | "identity" | "clientName">,
): KnownAssistant | null => {
  if (row.kind !== "assistant") return null;
  if (row.assistantPick !== null) return row.assistantPick === "none" ? null : row.assistantPick;
  return guessKnownAssistant({ host: row.identity?.host ?? null, name: row.clientName });
};

/** What Threadlines calls a connection everywhere it names it: "Grok Bot", not the "Cursor" it signed in as. */
export const connectionNameOf = (
  row: Pick<OutsideAgentConnectionRow, "kind" | "assistantPick" | "identity" | "clientName">,
) => assistantDisplayName(assistantOfRow(row), row.clientName);

export const connectionOfRow = (row: OutsideAgentConnectionRow): OutsideAgentConnection => ({
  connectionId: row.connectionId,
  name: connectionNameOf(row),
  givenName: connectionNameOf(row) === row.clientName ? null : row.clientName,
  assistant: assistantOfRow(row),
  kind: row.kind,
  signIn: row.signIn,
  identity: row.identity,
  access: row.access,
  maxRuntimeMode: row.maxRuntimeMode,
  projectIds: row.projectIds,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

/**
 * Why a grant the user picked can't be given: more than the sign-in asked
 * for (`requested`; null for a Change or a key), or no projects. No sign-in
 * asks for Work: one that asked to start threads may be given it, one that
 * asked only to see may not.
 */
export const grantRefusal = (
  grant: OutsideAgentGrant,
  requested: OutsideAgentAccess | null,
  who: "agent" | "assistant" = "agent",
): string | null => {
  if (requested === "see" && grant.access !== "see") {
    return `This ${who} asked only to see threads, so it can't be allowed to do more.`;
  }
  if (grant.projectIds !== null && grant.projectIds.length === 0) {
    return "Pick at least one project, or allow all of them.";
  }
  return null;
};

/** The grant as stored: its projects without repeats. */
export const normalizedGrant = (grant: OutsideAgentGrant): OutsideAgentGrant => ({
  access: grant.access,
  maxRuntimeMode: grant.maxRuntimeMode,
  projectIds: grant.projectIds === null ? null : [...new Set(grant.projectIds)],
});
