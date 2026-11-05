/**
 * Outside agents on other computers (docs/design/assistants.md, "Other
 * computers"): what a call forwarded from a linked computer carries while its
 * tool runs here. The agent is connected there; this computer's user let it
 * in here with a grant of its own, and on every call it gets no more here
 * than it has there now, so a Change there applies here at once.
 */
import type {
  OutsideAgentAccess,
  OutsideAgentConnectionId,
  RuntimeMode,
} from "@threadlines/contracts";
import { saferRuntimeMode } from "@threadlines/shared/runtimeMode";
import * as Context from "effect/Context";

import type { OutsideAgentLiveGrant } from "./OutsideAgentConnections.ts";

/** What the agent may do on the computer it is connected on, for the connection here that is it. */
export interface ForwardedGrantCap {
  readonly connectionId: OutsideAgentConnectionId;
  readonly access: OutsideAgentAccess;
  readonly maxRuntimeMode: RuntimeMode;
}

/**
 * Set while a forwarded call runs (OutsideToolRunner); null for a call that
 * came to this computer itself. Forked work (an assistant's setup after its
 * answer) keeps it.
 */
export const ForwardedGrantCap = Context.Reference<ForwardedGrantCap | null>(
  "threadlines/outsideAgents/ForwardedGrantCap",
  { defaultValue: () => null },
);

const ACCESS_ORDER: ReadonlyArray<OutsideAgentAccess> = ["see", "start", "work"];

/** The lower of two levels. */
export const lowerAccess = (a: OutsideAgentAccess, b: OutsideAgentAccess): OutsideAgentAccess =>
  ACCESS_ORDER.indexOf(a) <= ACCESS_ORDER.indexOf(b) ? a : b;

/** Whether `access` is more than `cap`. */
export const accessAbove = (access: OutsideAgentAccess, cap: OutsideAgentAccess): boolean =>
  ACCESS_ORDER.indexOf(access) > ACCESS_ORDER.indexOf(cap);

/** The grant here, no more than the cap when the call is forwarded for that connection. */
export const cappedGrant = (
  grant: OutsideAgentLiveGrant | null,
  cap: ForwardedGrantCap | null,
): OutsideAgentLiveGrant | null =>
  grant === null || cap === null || cap.connectionId !== grant.connectionId
    ? grant
    : {
        ...grant,
        access: lowerAccess(grant.access, cap.access),
        maxRuntimeMode: saferRuntimeMode(grant.maxRuntimeMode, cap.maxRuntimeMode),
      };
