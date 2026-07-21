import { RelaySessionStatusResult } from "@threadlines/contracts/relay";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRelaySessionStatusResult = Schema.decodeUnknownOption(RelaySessionStatusResult);

/**
 * Outcome of probing the relay's session status endpoint. Browser WebSockets
 * cannot observe handshake failures, so this probe is the only way a paired
 * device can distinguish "desktop offline" from "session gone, re-pair".
 */
export type RelaySessionStatusProbe =
  | { readonly kind: "status"; readonly status: RelaySessionStatusResult }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unreachable"; readonly message: string };

/**
 * What a status probe says about the session's viability. "link-invalid" is
 * terminal (deleted, expired, or the relay refused this token/origin) —
 * retrying the WebSocket can never succeed and the user must re-pair.
 */
export type RelaySessionProbeAssessment =
  | "link-invalid"
  | "desktop-offline"
  | "desktop-connected"
  | "indeterminate";

export function assessRelaySessionProbe(
  probe: RelaySessionStatusProbe | null,
): RelaySessionProbeAssessment {
  if (probe === null || probe.kind === "unreachable") {
    return "indeterminate";
  }
  if (probe.kind === "unauthorized") {
    return "link-invalid";
  }
  if (!probe.status.exists || probe.status.expired) {
    return "link-invalid";
  }
  return probe.status.desktopConnected ? "desktop-connected" : "desktop-offline";
}

export function buildRelaySessionStatusUrl(input: {
  readonly relayOrigin: string;
  readonly sessionId: string;
}): string {
  return new URL(
    `/v1/sessions/${encodeURIComponent(input.sessionId)}/status`,
    input.relayOrigin,
  ).toString();
}

export async function probeRelaySessionStatus(input: {
  readonly relayOrigin: string;
  readonly sessionId: string;
  readonly token: string;
  readonly signal?: AbortSignal;
}): Promise<RelaySessionStatusProbe> {
  let response: Response;
  try {
    response = await fetch(buildRelaySessionStatusUrl(input), {
      headers: { Authorization: `Bearer ${input.token}` },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return {
      kind: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (!response.ok) {
    return {
      kind: "unreachable",
      message: `Relay status request failed with HTTP ${response.status}.`,
    };
  }

  const decoded = decodeRelaySessionStatusResult(await response.json().catch(() => null));
  if (Option.isNone(decoded)) {
    return {
      kind: "unreachable",
      message: "Relay status response shape was not recognized.",
    };
  }
  return { kind: "status", status: decoded.value };
}
