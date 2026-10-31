/**
 * What outside work leaves an agent's Threadlines tools able to do
 * (docs/design/assistants.md, "Build plan: step 3").
 *
 * Outside text that reached an agent marks it on its thread
 * (`OrchestrationOutsideWork`) until it starts fresh. Every call with a
 * marked agent's credential (its subagents and background agents share it,
 * its side answers inherit it) is limited: tools that change something are
 * refused, the app guide and the browser too, and reads stay inside every
 * marking connection's live grant. OpenCode registers tool servers for a
 * whole folder, so there a mark on any session in the folder limits all of
 * them. Read per call, never cached: the mark and the grants change while
 * a runtime lives.
 */
import type {
  OrchestrationOutsideWork,
  OutsideAgentConnectionId,
  ProjectId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OutsideAgentConnections } from "../outsideAgents/OutsideAgentConnections.ts";
import { type McpInvocationScope, mcpSessionRegistry } from "./McpSessionRegistry.ts";

export interface OutsideToolLimit {
  /** The connections whose work limits it, as they signed in; for the refusal's words. */
  readonly names: ReadonlyArray<string>;
  /**
   * The projects reads may reach: inside every marking grant. Null: every
   * project. Empty: none beyond the caller's own thread (a connection was
   * removed, or the mark couldn't be read).
   */
  readonly projectIds: ReadonlySet<ProjectId> | null;
}

const namesText = (names: ReadonlyArray<string>) => {
  if (names.length === 0) return "An outside agent";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and others`;
};

/** Why a tool that changes something is refused while the agent is limited. */
export const outsideLimitDetail = (limit: OutsideToolLimit) =>
  `${namesText(limit.names)}'s work ran in this agent's session, so Threadlines' agent tools can only read until it starts fresh. The user can start it fresh from the thread.`;

/** Why the browser panel is off while the agent is limited. */
export const outsideBrowserDetail = (limit: OutsideToolLimit) =>
  `The browser panel is off for this agent while ${namesText(limit.names)}'s work limits its session. It's back once the agent starts fresh.`;

/** Whether a read of `projectId` stays inside the limit. */
export const limitReaches = (limit: OutsideToolLimit, projectId: ProjectId) =>
  limit.projectIds === null || limit.projectIds.has(projectId);

/** A limit that lets nothing past the caller's own thread: what a failed read falls back to. */
const UNREADABLE: OutsideToolLimit = { names: [], projectIds: new Set() };

/**
 * Reads the limit for a credential, or null when nothing limits it. Built
 * once per endpoint; each call reads the thread and grants again.
 */
export const makeOutsideToolLimits = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const connections = yield* Effect.serviceOption(OutsideAgentConnections);

  /** The connections that marked `scope`'s agent, or null when its thread couldn't be read. */
  const markOf = (scope: Pick<McpInvocationScope, "threadId" | "participantId">) =>
    snapshots.getThreadShellById(scope.threadId).pipe(
      Effect.map((shell) =>
        Option.match(shell, {
          onNone: (): OrchestrationOutsideWork["connections"] => [],
          onSome: (thread) =>
            (thread.outsideWork ?? []).find((entry) => entry.participantId === scope.participantId)
              ?.connections ?? [],
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const forScope = (scope: McpInvocationScope): Effect.Effect<OutsideToolLimit | null> =>
    Effect.gen(function* () {
      const sharing =
        scope.toolDirectory === undefined
          ? []
          : (yield* mcpSessionRegistry.sharingDirectory(scope.toolDirectory)).filter(
              (other) => other.sessionKey !== scope.sessionKey,
            );
      const marks = yield* Effect.forEach([scope, ...sharing], (entry) => markOf(entry), {
        concurrency: 4,
      });
      if (marks.some((mark) => mark === null)) return UNREADABLE;
      const byId = new Map<OutsideAgentConnectionId, string>();
      for (const mark of marks) {
        for (const connection of mark ?? []) byId.set(connection.connectionId, connection.name);
      }
      if (byId.size === 0) return null;
      const names = [...new Set(byId.values())];
      if (Option.isNone(connections)) return { names, projectIds: new Set() };
      let projectIds = null as Set<ProjectId> | null;
      for (const connectionId of byId.keys()) {
        const grant = yield* connections.value.grant(connectionId);
        // Removed: nothing of its grant is left to read inside.
        if (grant === null) return { names, projectIds: new Set() };
        if (grant.projectIds === null) continue;
        const allowed = new Set(grant.projectIds);
        projectIds =
          projectIds === null
            ? allowed
            : new Set([...projectIds].filter((projectId) => allowed.has(projectId)));
      }
      return { names, projectIds };
    });

  return { forScope };
});
