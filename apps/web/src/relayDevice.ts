import {
  RelayDeviceStatusResult,
  type RelayDeviceKind,
  type RelayJoinerDescription,
  RelayJoinResult,
} from "@threadlines/contracts/relay";
import {
  type RelayInviteLink,
  RelayRequestError,
  relayFetch,
  type RelayJoinSecrets,
} from "@threadlines/shared/relayJoin";
import * as Schema from "effect/Schema";

import { hostedAppUrlForChannel } from "./hostedPairing";

/**
 * Client helpers for "Connect a device" (relay v2): the relay address, the QR
 * link format, joiner secrets, and the device status probe. Pure functions
 * over fetch; saved-computer state lives in `environments/runtime/relayJoins`.
 */

const DEFAULT_RELAY_URL = "https://threadlines-relay.threadlines.workers.dev";

/** The relay this client joins through. Self-hosters set `VITE_RELAY_URL`. */
export function configuredRelayOrigin(): string {
  const configured = import.meta.env.VITE_RELAY_URL?.trim();
  try {
    return new URL(configured || DEFAULT_RELAY_URL).origin;
  } catch {
    return new URL(DEFAULT_RELAY_URL).origin;
  }
}

export {
  cancelRelayRequest,
  generateRelaySecret,
  getRelayRequestStatus,
  postRelayInviteClaim,
  postRelayReveal,
  relayDeviceSocketUrl,
  RelayRequestError,
  relaySecretHash,
  type RelayInviteLink,
} from "@threadlines/shared/relayJoin";

const JOIN_PATH = "/join";

/**
 * QR / link target: the hosted app's `/join` route. The invite secret and the
 * host's key ride in the fragment, which browsers never send to a server.
 */
export function buildRelayJoinUrl(invite: RelayInviteLink): string {
  const url = new URL(JOIN_PATH, hostedAppUrlForChannel());
  url.searchParams.set("relay", invite.relayOrigin);
  url.searchParams.set("hostId", invite.hostId);
  url.searchParams.set("invite", invite.inviteId);
  url.hash = new URLSearchParams([
    ["secret", invite.inviteSecret],
    ["key", invite.hostPublicKey],
  ]).toString();
  return url.toString();
}

export function readRelayJoinUrl(url: URL = new URL(window.location.href)): RelayInviteLink | null {
  if (url.pathname !== JOIN_PATH) return null;
  const relay = url.searchParams.get("relay")?.trim() ?? "";
  const hostId = url.searchParams.get("hostId")?.trim() ?? "";
  const inviteId = url.searchParams.get("invite")?.trim() ?? "";
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const inviteSecret = fragment.get("secret")?.trim() ?? "";
  const hostPublicKey = fragment.get("key")?.trim() ?? "";
  if (!relay || !hostId || !inviteId || !inviteSecret || !hostPublicKey) return null;
  try {
    return { relayOrigin: new URL(relay).origin, hostId, inviteId, inviteSecret, hostPublicKey };
  } catch {
    return null;
  }
}

export function relayRequestWatchUrl(input: {
  readonly relayOrigin: string;
  readonly hostId: string;
  readonly requestId: string;
}): string {
  const url = new URL(
    `/v2/hosts/${encodeURIComponent(input.hostId)}/requests/${encodeURIComponent(input.requestId)}/watch`,
    input.relayOrigin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** How a browser (the hosted app on a phone, mostly) introduces itself to the host. */
export function describeThisBrowser(
  userAgent: string = navigator.userAgent,
): RelayJoinerDescription {
  const ua = userAgent;
  if (/iPhone/u.test(ua)) return { label: "iPhone", platform: "iOS", kind: "phone" };
  if (/iPad/u.test(ua) || (/Macintosh/u.test(ua) && navigator.maxTouchPoints > 1)) {
    return { label: "iPad", platform: "iPadOS", kind: "tablet" };
  }
  if (/Android/u.test(ua)) {
    return /Mobile/u.test(ua)
      ? { label: "Android phone", platform: "Android", kind: "phone" }
      : { label: "Android tablet", platform: "Android", kind: "tablet" };
  }
  const browser = /Edg\//u.test(ua)
    ? "Edge"
    : /Firefox\//u.test(ua)
      ? "Firefox"
      : /Chrome\//u.test(ua)
        ? "Chrome"
        : /Safari\//u.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/u.test(ua)
    ? "Windows"
    : /Mac OS X/u.test(ua)
      ? "macOS"
      : /Linux/u.test(ua)
        ? "Linux"
        : undefined;
  return {
    label: os ? `${browser} on ${os}` : browser,
    ...(os ? { platform: os } : {}),
    kind: "browser",
  };
}

export function joinerKindForThisBrowser(): RelayDeviceKind {
  return describeThisBrowser().kind;
}

// ----- relay HTTP ---------------------------------------------------------------

const decodeJoinResult = Schema.decodeUnknownOption(RelayJoinResult);
const decodeDeviceStatus = Schema.decodeUnknownOption(RelayDeviceStatusResult);

/** Code join straight to the relay. Only the hosted app uses this; other clients go through their server. */
export function postRelayCodeJoin(
  relayOrigin: string,
  input: RelayJoinSecrets & { readonly code: string; readonly commitment: string },
) {
  return relayFetch(
    new URL("/v2/join", relayOrigin).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    decodeJoinResult,
  );
}

export type RelayDeviceStatusProbe =
  | { readonly kind: "status"; readonly status: RelayDeviceStatusResult }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unreachable"; readonly message: string };

/** Tells "computer offline" from "access removed" from "daily limit", which a WebSocket can't. */
export async function probeRelayDeviceStatus(input: {
  readonly relayOrigin: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly deviceSecret: string;
  readonly signal?: AbortSignal;
}): Promise<RelayDeviceStatusProbe> {
  try {
    const status = await relayFetch(
      new URL(
        `/v2/hosts/${encodeURIComponent(input.hostId)}/devices/${encodeURIComponent(input.deviceId)}/status`,
        input.relayOrigin,
      ).toString(),
      {
        headers: { authorization: `Bearer ${input.deviceSecret}` },
        ...(input.signal ? { signal: input.signal } : {}),
      },
      decodeDeviceStatus,
    );
    return { kind: "status", status };
  } catch (error) {
    if (error instanceof RelayRequestError && (error.status === 401 || error.status === 404)) {
      return { kind: "unauthorized" };
    }
    return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
}
