/**
 * What both doors (the local `/mcp/connect` and the assistants door,
 * docs/design/assistants.md) share about a connection: how a row is shown in
 * Settings, and the rules a grant the user picks must pass.
 */
import type {
  OutsideAgentAccess,
  OutsideAgentConnection,
  OutsideAgentGrant,
} from "@threadlines/contracts";

import type { OutsideAgentConnectionRow } from "./OutsideAgentConnectionRepository.ts";

/** A connection row as Settings shows it. */
export const connectionOfRow = (row: OutsideAgentConnectionRow): OutsideAgentConnection => ({
  connectionId: row.connectionId,
  name: row.clientName,
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
 * for (`requested`; null for a Change or a key), or no projects.
 */
export const grantRefusal = (
  grant: OutsideAgentGrant,
  requested: OutsideAgentAccess | null,
  who: "agent" | "assistant" = "agent",
): string | null => {
  if (requested === "see" && grant.access === "start") {
    return `This ${who} asked only to see threads, so it can't be allowed to start them.`;
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
