import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AssistantAlertTargetId,
  IsoDateTime,
  NonNegativeInt,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OutsideAgentAccess, OutsideAgentRef, RuntimeMode } from "./orchestration.ts";

/**
 * Outside agents (docs/design/outside-agents.md): coding agents running
 * outside Threadlines (Claude Code, Codex, Gemini CLI, Cursor, the
 * `threadlines` command) that sign in to this computer's `/mcp/connect` once
 * the user approves them in the app. These are the shapes Settings' Agents
 * group and the approval dialog show, and the owner-only RPCs behind them.
 */

/** What the user granted a connection; the one authority every call is checked against. */
export const OutsideAgentGrant = Schema.Struct({
  access: OutsideAgentAccess,
  /**
   * The highest access a thread may have for this connection to start a
   * turn, send or answer in it. New threads it starts get at most this. Kept
   * with `see` too, so switching up later has a value; it allows nothing there.
   */
  maxRuntimeMode: RuntimeMode,
  /** The projects it may see and start threads in; null: all of them. */
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
});
export type OutsideAgentGrant = typeof OutsideAgentGrant.Type;

/**
 * Where a connection comes in. `local`: an agent on this computer, through
 * `/mcp/connect`. `assistant`: an always-on assistant in someone else's cloud,
 * through the relay's public door (docs/design/assistants.md).
 */
export const OutsideAgentConnectionKind = Schema.Literals(["local", "assistant"]);
export type OutsideAgentConnectionKind = typeof OutsideAgentConnectionKind.Type;

/** How it signs in: OAuth with the approval dialog, or a key made in Settings (assistants only). */
export const OutsideAgentSignInMethod = Schema.Literals(["oauth", "key"]);
export type OutsideAgentSignInMethod = typeof OutsideAgentSignInMethod.Type;

/**
 * Who an assistant signed in as, as far as the relay could tell: `verified`
 * when its client id is a metadata document the relay fetched from `host`;
 * otherwise `host` is where its sign-in returns to and its name is its own
 * claim. `known`: on the relay's short list of known assistants.
 */
export const OutsideAgentIdentity = Schema.Struct({
  host: TrimmedNonEmptyString,
  verified: Schema.Boolean,
  known: Schema.Boolean,
});
export type OutsideAgentIdentity = typeof OutsideAgentIdentity.Type;

export const OutsideAgentConnection = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  /** The name the agent gave when it signed in ("Claude Code"), or the key's name: shown as given, never verified. */
  name: TrimmedNonEmptyString,
  kind: OutsideAgentConnectionKind,
  signIn: OutsideAgentSignInMethod,
  /** Assistants signed in with OAuth; null for local agents and keys. */
  identity: Schema.NullOr(OutsideAgentIdentity),
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

/**
 * An assistant's sign-in waiting for the user: its page typed this computer's
 * code. Approve and Deny take its `requestId` like a local sign-in's.
 */
export const OutsideAgentAssistantSignIn = Schema.Struct({
  requestId: OutsideAgentRequestId,
  /** The name the assistant gave ("Grok Bot"): its own claim unless `identity.verified`. */
  name: TrimmedNonEmptyString,
  identity: OutsideAgentIdentity,
  /** Roughly where the sign-in page was opened ("Austin, US"), information only; null: unknown. */
  place: Schema.NullOr(TrimmedNonEmptyString),
  requestedAccess: OutsideAgentAccess,
  /** The same assistant's earlier connection, which approving replaces; null: none. */
  replaces: Schema.NullOr(OutsideAgentRef),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type OutsideAgentAssistantSignIn = typeof OutsideAgentAssistantSignIn.Type;

/** What an alert is about (docs/design/assistants.md, step 4): `thread.<kind>` events. */
export const AssistantAlertKind = Schema.Literals(["needs_you", "finished", "failed"]);
export type AssistantAlertKind = typeof AssistantAlertKind.Type;

/**
 * A web address the computer sends signed alerts to (a Grok routine's
 * webhook, say). `on` sends; `off` the user turned it off; `gone` the
 * receiver answered 410. Turning it on again never sends what it missed.
 */
export const AssistantAlertTarget = Schema.Struct({
  targetId: AssistantAlertTargetId,
  url: TrimmedNonEmptyString,
  kinds: Schema.Array(AssistantAlertKind),
  /** Null: every project. */
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
  /** Skip threads someone is looking at in Threadlines. */
  skipViewed: Schema.Boolean,
  state: Schema.Literals(["on", "off", "gone"]),
  /** An Authorization header is set (its value is never sent to the app). */
  hasAuthorization: Schema.Boolean,
  /** The receiver answered 401 or 403 three times in a row, since then; null: not refusing. */
  refusedSince: Schema.NullOr(IsoDateTime),
  lastSentAt: Schema.NullOr(IsoDateTime),
  /** The latest problem in Threadlines' words, until a send works. */
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  /** Alerts waiting for another try. */
  retrying: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type AssistantAlertTarget = typeof AssistantAlertTarget.Type;

/**
 * The assistants door as this computer sees it.
 * - `ready`: the relay's door is on, and this computer is registered with it.
 * - `off`: the relay's door is turned off, or this computer's relay is turned off.
 * - `unreachable`: the relay couldn't be asked; Settings says so and keeps trying.
 */
export const OutsideAgentAssistantsState = Schema.Struct({
  status: Schema.Literals(["ready", "off", "unreachable"]),
  /** What the user pastes into an assistant (`https://connect.threadlines.dev/mcp`); null until known. */
  address: Schema.NullOr(TrimmedNonEmptyString),
  /** This computer's sign-in code while one is showing, as typed (`K4D82PQX`); null: none. */
  code: Schema.NullOr(
    Schema.Struct({
      code: TrimmedNonEmptyString,
      expiresAt: IsoDateTime,
    }),
  ),
  /** Assistant sign-ins waiting for the user, oldest first. */
  signIns: Schema.Array(OutsideAgentAssistantSignIn),
  /** Web addresses alerts go to, oldest first. */
  alertTargets: Schema.Array(AssistantAlertTarget).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OutsideAgentAssistantsState = typeof OutsideAgentAssistantsState.Type;

/** Settings' Agents and Assistants groups, again on every change. */
export const OutsideAgentsSnapshot = Schema.Struct({
  /** This computer's address for agents: `http://127.0.0.1:<port>/mcp/connect`. */
  address: TrimmedNonEmptyString,
  /** Live connections of both kinds, newest first. A removed one is gone at once. */
  connections: Schema.Array(OutsideAgentConnection),
  /** Local agents' sign-ins waiting for the user, oldest first. */
  pending: Schema.Array(OutsideAgentPendingRequest),
  /** After Deny all: new sign-ins of both kinds are turned away until then. Null: taking them. */
  quietUntil: Schema.NullOr(IsoDateTime),
  assistants: OutsideAgentAssistantsState,
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

/** A key for an assistant that can't sign in (Muse), with the same choices as the dialog. */
export const OutsideAgentCreateKeyInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  ...OutsideAgentGrant.fields,
});
export type OutsideAgentCreateKeyInput = typeof OutsideAgentCreateKeyInput.Type;

/** The key is in this result only: the computer keeps a hash. */
export const OutsideAgentCreateKeyResult = Schema.Struct({
  connection: OutsideAgentConnection,
  key: TrimmedNonEmptyString,
  /** The address to paste with it. */
  address: TrimmedNonEmptyString,
});
export type OutsideAgentCreateKeyResult = typeof OutsideAgentCreateKeyResult.Type;

/** The fields Add and Edit share. */
const AssistantAlertTargetFields = {
  url: TrimmedNonEmptyString,
  kinds: Schema.Array(AssistantAlertKind),
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
  skipViewed: Schema.Boolean,
};

export const AssistantAlertTargetCreateInput = Schema.Struct({
  ...AssistantAlertTargetFields,
  /** The Authorization header's whole value (`Bearer crsr_…`); null: none. */
  authorization: Schema.NullOr(TrimmedNonEmptyString),
});
export type AssistantAlertTargetCreateInput = typeof AssistantAlertTargetCreateInput.Type;

export const AssistantAlertTargetUpdateInput = Schema.Struct({
  targetId: AssistantAlertTargetId,
  ...AssistantAlertTargetFields,
  /** Keep the Authorization header as it is, replace it, or clear it. */
  authorization: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("keep") }),
    Schema.Struct({ kind: Schema.Literal("set"), value: TrimmedNonEmptyString }),
    Schema.Struct({ kind: Schema.Literal("clear") }),
  ]),
});
export type AssistantAlertTargetUpdateInput = typeof AssistantAlertTargetUpdateInput.Type;

export const AssistantAlertTargetInput = Schema.Struct({ targetId: AssistantAlertTargetId });
export type AssistantAlertTargetInput = typeof AssistantAlertTargetInput.Type;

/** Turn sending on or off. On again starts from now: nothing it missed is sent. */
export const AssistantAlertTargetSetOnInput = Schema.Struct({
  targetId: AssistantAlertTargetId,
  on: Schema.Boolean,
});
export type AssistantAlertTargetSetOnInput = typeof AssistantAlertTargetSetOnInput.Type;

/** What a test send came to, in Threadlines' words. */
export const AssistantAlertTargetTestResult = Schema.Struct({
  outcome: Schema.Literals(["sent", "refused", "failed"]),
  /** The receiver's HTTP status, when it answered. */
  status: Schema.NullOr(Schema.Int),
  detail: TrimmedNonEmptyString,
});
export type AssistantAlertTargetTestResult = typeof AssistantAlertTargetTestResult.Type;

/** The target's signing secret (`whsec_…`), for the receiver to check signatures with. */
export const AssistantAlertTargetSecretResult = Schema.Struct({ secret: TrimmedNonEmptyString });
export type AssistantAlertTargetSecretResult = typeof AssistantAlertTargetSecretResult.Type;

export class OutsideAgentError extends Schema.TaggedError<OutsideAgentError>()(
  "OutsideAgentError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
