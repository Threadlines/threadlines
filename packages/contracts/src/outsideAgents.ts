import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OutsideAgentRef, RuntimeMode } from "./orchestration.ts";

/**
 * Outside agents (docs/design/outside-agents.md): coding agents running
 * outside Threadlines (Claude Code, Codex, Gemini CLI, Cursor, the
 * `threadlines` command) that sign in to this computer's `/mcp/connect` once
 * the user approves them in the app. These are the shapes Settings' Agents
 * group and the approval dialog show, and the owner-only RPCs behind them.
 */

/**
 * What a connection may do. `see`: projects, agents, and every thread's
 * status and messages in its projects. `start`: that, plus start threads and
 * send to or stop the threads it started.
 */
export const OutsideAgentAccess = Schema.Literals(["see", "start"]);
export type OutsideAgentAccess = typeof OutsideAgentAccess.Type;

/** What the user granted a connection; the one authority every call is checked against. */
export const OutsideAgentGrant = Schema.Struct({
  access: OutsideAgentAccess,
  /**
   * The highest access a thread may have for this connection to start a
   * turn in it. New threads it starts get at most this. Kept with `see` too,
   * so switching to `start` later has a value; it allows nothing there.
   */
  maxRuntimeMode: RuntimeMode,
  /** The projects it may see and start threads in; null: all of them. */
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
});
export type OutsideAgentGrant = typeof OutsideAgentGrant.Type;

export const OutsideAgentConnection = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  /** The name the agent gave when it signed in ("Claude Code"): shown as given, never verified. */
  name: TrimmedNonEmptyString,
  ...OutsideAgentGrant.fields,
  createdAt: IsoDateTime,
  /** When it last called a tool; null: not yet. Updated at most once a minute. */
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type OutsideAgentConnection = typeof OutsideAgentConnection.Type;

/** A sign-in waiting for the user: what the approval dialog shows. */
export const OutsideAgentPendingRequest = Schema.Struct({
  requestId: OutsideAgentRequestId,
  name: TrimmedNonEmptyString,
  /** Shown here and on the browser page the agent opened ("K4D-82P"), so the user matches the two. */
  code: TrimmedNonEmptyString,
  /** The loopback port on this computer the approval goes back to. */
  callbackPort: PositiveInt,
  /** The most it asked for: `see` when it asked only for `threads:read`. Approval can't grant more. */
  requestedAccess: OutsideAgentAccess,
  /** The same agent's earlier connection, which approving replaces; null: none. */
  replaces: Schema.NullOr(OutsideAgentRef),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type OutsideAgentPendingRequest = typeof OutsideAgentPendingRequest.Type;

/** Settings' Agents group, again on every change. */
export const OutsideAgentsSnapshot = Schema.Struct({
  /** This computer's address for agents: `http://127.0.0.1:<port>/mcp/connect`. */
  address: TrimmedNonEmptyString,
  /** Live connections, newest first. A removed one is gone at once. */
  connections: Schema.Array(OutsideAgentConnection),
  /** Sign-ins waiting for the user, oldest first. */
  pending: Schema.Array(OutsideAgentPendingRequest),
  /** After Deny all: new sign-ins are turned away until then. Null: taking them. */
  quietUntil: Schema.NullOr(IsoDateTime),
});
export type OutsideAgentsSnapshot = typeof OutsideAgentsSnapshot.Type;

export const OutsideAgentApproveInput = Schema.Struct({
  requestId: OutsideAgentRequestId,
  ...OutsideAgentGrant.fields,
});
export type OutsideAgentApproveInput = typeof OutsideAgentApproveInput.Type;

export const OutsideAgentRequestInput = Schema.Struct({ requestId: OutsideAgentRequestId });
export type OutsideAgentRequestInput = typeof OutsideAgentRequestInput.Type;

export const OutsideAgentUpdateInput = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  ...OutsideAgentGrant.fields,
});
export type OutsideAgentUpdateInput = typeof OutsideAgentUpdateInput.Type;

export const OutsideAgentConnectionInput = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
});
export type OutsideAgentConnectionInput = typeof OutsideAgentConnectionInput.Type;

export class OutsideAgentError extends Schema.TaggedError<OutsideAgentError>()(
  "OutsideAgentError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
