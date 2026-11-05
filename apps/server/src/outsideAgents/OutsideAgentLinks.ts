/**
 * Outside agents connected on another, linked computer, as this computer
 * sees them (docs/design/assistants.md, "Other computers"). That computer
 * asks for one of its agents to use this one too; this computer's user
 * answers in the same dialog as a sign-in, and a yes is a connection row
 * here (`sign_in = 'linked'`, OutsideAgentVia) with its own grant. The link's
 * calls (`peer.outside.*`, served on `/peer`) then run the agents' tools here
 * as that row, never above what the agent may do there.
 *
 * OutsideAgentConnectionsLive implements it over the same rows and dialog.
 */
import type {
  OutsideAgentConnectionId,
  OutsideAgentConnectionKind,
  PeerOutsideAgent,
  PeerOutsideAskResult,
  PeerOutsideStatusResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ForwardedGrantCap } from "./forwardedCalls.ts";
import type { OutsideAgentCaller } from "./OutsideAgentConnections.ts";

/** The link a call came over: its relay device here, and the computer at its other end. */
export interface OutsideAgentLink {
  readonly deviceId: string;
  readonly environmentId: string;
  readonly computer: string;
}

/** Who a forwarded call runs as here, which door's rules it follows, and its cap; or why it can't. */
export type LinkedCaller =
  | {
      readonly caller: OutsideAgentCaller;
      readonly kind: OutsideAgentConnectionKind;
      readonly cap: ForwardedGrantCap;
    }
  | { readonly refused: string };

export interface OutsideAgentLinksShape {
  /** That computer asks: answered at once when the agent is in already, else it waits for the user. */
  readonly ask: (
    link: OutsideAgentLink,
    agent: PeerOutsideAgent,
  ) => Effect.Effect<PeerOutsideAskResult>;
  /** Which of these agents are in here, or asked about and waiting. */
  readonly status: (
    link: OutsideAgentLink,
    connectionIds: ReadonlyArray<OutsideAgentConnectionId>,
  ) => Effect.Effect<PeerOutsideStatusResult>;
  /** The agent was removed there, or its user took this computer away from it: it goes here too. */
  readonly forget: (
    link: OutsideAgentLink,
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<void>;
  /** The row a forwarded call for `agent` runs as, its name kept up with that computer's. */
  readonly callerFor: (
    link: OutsideAgentLink,
    agent: PeerOutsideAgent,
  ) => Effect.Effect<LinkedCaller>;
  /** The link was removed: every agent it brought, and every ask from it, goes. */
  readonly dropLink: (linkDeviceId: string) => Effect.Effect<void>;
}

export class OutsideAgentLinks extends Context.Service<OutsideAgentLinks, OutsideAgentLinksShape>()(
  "threadlines/outsideAgents/OutsideAgentLinks",
) {}
