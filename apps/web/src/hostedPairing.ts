import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

const DEFAULT_HOSTED_APP_URL = "https://app.threadlines.dev";

export interface HostedPairingRequest {
  readonly kind: "direct";
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export interface HostedRelayPairingRequest {
  readonly kind: "relay";
  readonly relayOrigin: string;
  readonly sessionId: string;
  readonly token: string;
  readonly label: string;
}

export type AnyHostedPairingRequest = HostedPairingRequest | HostedRelayPairingRequest;

export type HostedAppChannel = "latest" | "nightly";

function configuredHostedAppUrl(): string {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || DEFAULT_HOSTED_APP_URL;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hostedStaticOrigins(): ReadonlySet<string> {
  return new Set(
    [configuredHostedAppUrl(), DEFAULT_HOSTED_APP_URL]
      .map(originFromUrl)
      .filter((origin): origin is string => origin !== null),
  );
}

export function isHostedStaticApp(url: URL = new URL(window.location.href)): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  return hostedStaticOrigins().has(url.origin);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function buildRelayDeviceSocketUrl(input: {
  readonly relayOrigin: string;
  readonly sessionId: string;
}): string {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(input.sessionId)}/connect`,
    input.relayOrigin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "device");
  url.searchParams.set("mode", "raw");
  return url.toString();
}

export function readHostedPairingRequest(
  url: URL = new URL(window.location.href),
): AnyHostedPairingRequest | null {
  const relayOrigin = url.searchParams.get("relay")?.trim() ?? "";
  const sessionId = url.searchParams.get("session")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (relayOrigin || sessionId) {
    if (!relayOrigin || !sessionId || !token) {
      return null;
    }

    let normalizedRelayOrigin: string;
    try {
      normalizedRelayOrigin = normalizeOrigin(relayOrigin);
    } catch {
      return null;
    }

    return {
      kind: "relay",
      relayOrigin: normalizedRelayOrigin,
      sessionId,
      token,
      label,
    } satisfies HostedRelayPairingRequest;
  }

  const host = url.searchParams.get("host")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    kind: "direct",
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function hasHostedPairingRouteIntent(url: URL = new URL(window.location.href)): boolean {
  return (
    Boolean(url.searchParams.get("host")?.trim()) ||
    Boolean(url.searchParams.get("relay")?.trim()) ||
    Boolean(url.searchParams.get("session")?.trim())
  );
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedRelayPairingUrl(input: {
  readonly relayOrigin: string;
  readonly sessionId: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("relay", normalizeOrigin(input.relayOrigin));
  url.searchParams.set("session", input.sessionId);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}
