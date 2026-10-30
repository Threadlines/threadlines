/**
 * Outside agents' connections (docs/design/outside-agents.md), as
 * `/mcp/connect` sees them. The sign-in side implements it
 * (OutsideAgentConnectionsLive: OAuth, the approval dialog's RPCs, the
 * connection rows); the MCP endpoint and its tools use it.
 *
 * - `authenticate` checks an access token against the resource the request
 *   came to (outsideAgentResource): its mac, its connection row (present, not
 *   removed, same token generation, used within 90 days). It stamps
 *   `last_used_at` at most once a minute. Null: refuse with a 401.
 * - `grant` is the connection's live grant, read again on every tool call so
 *   Change and Remove apply to the next call. Null: removed.
 */
import type {
  OutsideAgentConnectionId,
  OutsideAgentGrant,
  OutsideAgentRef,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http";

import { isLoopbackAddress, requestRemoteAddress } from "../auth/utils.ts";

export const OUTSIDE_AGENT_MCP_PATH = "/mcp/connect";

/** OAuth scopes: `threads:read` is See threads; adding `threads:start` is Start threads. */
export const OUTSIDE_AGENT_SCOPES = ["threads:read", "threads:start"] as const;

/**
 * Headers a proxy in front of the server adds (Tailscale Serve, a reverse
 * proxy). A request carrying any came from somewhere else, even though its
 * socket is local.
 */
const PROXY_HEADERS = [
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "tailscale-user-login",
  "tailscale-user-name",
];

/**
 * The origin a sign-in or an agent's call may arrive under, or null to refuse
 * it: approval promises the agent runs on this computer. All three must hold:
 * - the socket's own address is loopback (a network-exposed server can't be
 *   reached from the LAN by claiming `Host: 127.0.0.1`);
 * - no proxy header (Tailscale Serve and reverse proxies connect from
 *   loopback for someone else);
 * - Host is one of this computer's loopback names on the server's own port
 *   (a DNS-rebinding page's Host fails).
 */
export function outsideAgentOrigin(input: {
  readonly host: string | undefined;
  readonly port: number;
  /** The socket's remote address (auth/utils.ts requestRemoteAddress). */
  readonly remoteAddress: string | undefined;
  /** Request headers, names lowercased. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.remoteAddress === undefined || !isLoopbackAddress(input.remoteAddress)) return null;
  if (PROXY_HEADERS.some((name) => input.headers[name] !== undefined)) return null;
  const host = input.host?.trim().toLowerCase();
  if (host === undefined || host.length === 0) return null;
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    if (host === `${name}:${input.port}`) return `http://${name}:${input.port}`;
  }
  return null;
}

/** outsideAgentOrigin for a request this server got on `port`. */
export const outsideAgentRequestOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  port: number,
): string | null =>
  outsideAgentOrigin({
    host: request.headers.host,
    port,
    remoteAddress: requestRemoteAddress(request),
    headers: request.headers,
  });

/** The resource (RFC 8707) an access token is bound to: `<origin>/mcp/connect`. */
export const outsideAgentResource = (origin: string): string =>
  `${origin}${OUTSIDE_AGENT_MCP_PATH}`;

/** The connection behind a call, as the token named it. */
export type OutsideAgentCaller = OutsideAgentRef;

export interface OutsideAgentLiveGrant extends OutsideAgentGrant {
  readonly connectionId: OutsideAgentConnectionId;
  readonly name: string;
}

export interface OutsideAgentConnectionsShape {
  readonly authenticate: (input: {
    readonly token: string;
    readonly resource: string;
  }) => Effect.Effect<OutsideAgentCaller | null>;
  readonly grant: (
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<OutsideAgentLiveGrant | null>;
}

export class OutsideAgentConnections extends Context.Service<
  OutsideAgentConnections,
  OutsideAgentConnectionsShape
>()("threadlines/outsideAgents/OutsideAgentConnections") {}
