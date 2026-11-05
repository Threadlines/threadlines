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
  OutsideAgentRef,
} from "@threadlines/contracts";
import {
  assistantDisplayName,
  assistantOfKeyLabel,
  assistantOfSignInHost,
} from "@threadlines/shared/knownAssistants";

import type { OutsideAgentConnectionRow } from "./OutsideAgentConnectionRepository.ts";

/** A connection row as Settings shows it. */
type NamedRow = Pick<
  OutsideAgentConnectionRow,
  "kind" | "signIn" | "assistantPick" | "identity" | "clientName"
>;

/**
 * Which known assistant an assistant connection is: the user's pick, else the
 * guess (knownAssistants.ts): a sign-in's from the site it returns to, never
 * from the name it gave; a key's from the label the user typed. Null for
 * local agents and when nothing says.
 */
export const assistantOfRow = (row: NamedRow): KnownAssistant | null => {
  if (row.kind !== "assistant") return null;
  if (row.assistantPick !== null) return row.assistantPick === "none" ? null : row.assistantPick;
  if (row.signIn === "key") return assistantOfKeyLabel(row.clientName);
  return row.identity === null ? null : assistantOfSignInHost(row.identity.host);
};

/**
 * What Threadlines calls a connection everywhere it names it: "Grok Bot", not
 * the "Cursor" it signed in as. A key keeps the label the user typed ("Muse
 * work"): the user named it, and two keys must stay apart.
 */
export const connectionNameOf = (row: NamedRow) =>
  row.kind === "assistant" && row.signIn === "key"
    ? row.clientName
    : assistantDisplayName(assistantOfRow(row), row.clientName);

/** Who a call comes from, as threads and messages remember it: id, name and, when known, which assistant. */
export const connectionRefOf = (
  row: NamedRow & Pick<OutsideAgentConnectionRow, "connectionId">,
): OutsideAgentRef => {
  const assistant = assistantOfRow(row);
  return {
    connectionId: row.connectionId,
    name: connectionNameOf(row),
    ...(assistant !== null ? { assistant } : {}),
  };
};

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
