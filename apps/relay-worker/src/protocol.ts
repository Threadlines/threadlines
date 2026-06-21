import type {
  RelayClientMessage,
  RelayConnectionRole,
  RelayForwardTarget,
} from "@threadlines/contracts/relay";
import {
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
} from "@threadlines/contracts/relay";

export { RELAY_TOKEN_PROTOCOL_PREFIX, RELAY_WEBSOCKET_PROTOCOL };

export interface RelayTokenProtocolResult {
  readonly selectedProtocol: string | null;
  readonly token: string | null;
}

export function parseRelayTokenProtocol(header: string | null): RelayTokenProtocolResult {
  if (!header) {
    return { selectedProtocol: null, token: null };
  }

  const protocols = header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const tokenProtocol = protocols.find((protocol) =>
    protocol.startsWith(RELAY_TOKEN_PROTOCOL_PREFIX),
  );

  return {
    selectedProtocol: protocols.includes(RELAY_WEBSOCKET_PROTOCOL)
      ? RELAY_WEBSOCKET_PROTOCOL
      : (tokenProtocol ?? null),
    token: tokenProtocol?.slice(RELAY_TOKEN_PROTOCOL_PREFIX.length) ?? null,
  };
}

export function isRelayConnectionRole(value: string | null): value is RelayConnectionRole {
  return value === "desktop" || value === "device";
}

export function isRelayForwardTarget(value: unknown): value is RelayForwardTarget {
  return value === "desktop" || value === "devices";
}

export function parseRelayClientMessage(value: unknown): RelayClientMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }

  if (record.type === "relay.ping") {
    return { version: 1, type: "relay.ping" };
  }

  if (record.type === "relay.forward" && isRelayForwardTarget(record.target)) {
    return {
      version: 1,
      type: "relay.forward",
      target: record.target,
      payload: record.payload,
    };
  }

  return null;
}

export function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
