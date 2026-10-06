/**
 * One agent's state and its single next step, shared by the setup screen and
 * the Providers settings page so the two never describe the same agent two
 * ways.
 *
 * Inputs are what the client already holds: the user's intent (`enabled` in
 * settings, which flips before the server catches up) and the server's
 * snapshot. Status language comes from `getProviderSummary`, install progress
 * from `deriveProviderInstallView`, and sign-in need from the model picker's
 * availability verdict.
 *
 * @module agentStatus
 */
import type {
  ExecutionEnvironmentPlatformOs,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderDetection,
} from "@threadlines/contracts";
import { serverProviderCanSignIn } from "@threadlines/shared/providerAuth";

import { getModelPickerProviderAvailability } from "../chat/modelPickerEmptyState";
import { deriveProviderInstallView, type ProviderInstallView } from "./providerInstall";
import { firstSentenceOf, getProviderSummary } from "./providerStatus";

export type AgentStatus =
  /**
   * Turned on, but the server is still looking, or has not yet seen the
   * switch flip. Never shown as ready or missing: provisional snapshots say
   * `installed: false` (Codex) or `true` (ACP) before anything was checked.
   */
  | { readonly kind: "checking" }
  | { readonly kind: "notInstalled"; readonly install: ProviderInstallView | null }
  | { readonly kind: "installing"; readonly install: ProviderInstallView }
  | { readonly kind: "needsSignIn"; readonly canSignIn: boolean }
  | { readonly kind: "ready" }
  | { readonly kind: "problem"; readonly headline: string; readonly detail: string | null }
  /** Turned off. `detection` is the server's file-only look, when it sent one. */
  | { readonly kind: "off"; readonly detection: ServerProviderDetection | null };

export function deriveAgentStatus(input: {
  /** The user's intent from settings; wins over a snapshot that lags behind. */
  readonly enabled: boolean;
  readonly driverKind: ProviderDriverKind;
  readonly snapshot: ServerProvider | undefined;
}): AgentStatus {
  const { snapshot } = input;
  if (!input.enabled) {
    return {
      kind: "off",
      detection: snapshot && !snapshot.enabled ? (snapshot.detection ?? null) : null,
    };
  }
  if (snapshot?.availability === "unavailable") {
    return { kind: "problem", headline: "Unavailable", detail: snapshot.unavailableReason ?? null };
  }
  if (!snapshot || !snapshot.enabled || snapshot.statusReason === "provider_probe_pending") {
    return { kind: "checking" };
  }

  const install = deriveProviderInstallView(snapshot);
  if (install?.status === "running") {
    return { kind: "installing", install };
  }
  if (!snapshot.installed) {
    return { kind: "notInstalled", install };
  }
  if (getModelPickerProviderAvailability(snapshot) === "notAuthenticated") {
    return {
      kind: "needsSignIn",
      canSignIn: serverProviderCanSignIn({
        driver: input.driverKind,
        community: snapshot.community,
      }),
    };
  }
  if (snapshot.status === "error") {
    const summary = getProviderSummary(snapshot);
    return {
      kind: "problem",
      headline: summary.headline,
      detail: firstSentenceOf(summary.detail),
    };
  }
  return { kind: "ready" };
}

/** True when the agent can take a turn right now. */
export function isAgentReady(status: AgentStatus): boolean {
  return status.kind === "ready";
}

/**
 * "this Mac", "this PC" or "this computer", for the environment the agents
 * run on. Concrete words read better than "the paired computer".
 */
export function thisComputerLabel(os: ExecutionEnvironmentPlatformOs | null | undefined): string {
  switch (os) {
    case "darwin":
      return "this Mac";
    case "windows":
      return "this PC";
    default:
      return "this computer";
  }
}

/**
 * The plain line under an agent's name for surfaces without account detail
 * (setup). Settings draws richer account lines for ready agents itself.
 */
export function agentStatusLine(input: {
  readonly status: AgentStatus;
  readonly needs: string;
  readonly snapshot: ServerProvider | undefined;
}): string {
  const { status, needs, snapshot } = input;
  switch (status.kind) {
    case "checking":
      return needs;
    case "notInstalled":
      return `Not installed · ${needs}`;
    case "installing":
      return needs;
    case "needsSignIn":
      return `Not signed in · ${needs}`;
    case "ready": {
      const authLabel = snapshot?.auth.label ?? snapshot?.auth.type ?? null;
      return authLabel ? `Signed in · ${authLabel}` : "Ready";
    }
    case "problem":
      return status.detail ? `${status.headline}. ${status.detail}` : status.headline;
    case "off":
      return status.detection?.status === "unknown" && status.detection.reason
        ? status.detection.reason
        : needs;
  }
}

/** What a turned-off agent's row says about this computer, before its button. */
export function agentDetectionLabel(
  detection: ServerProviderDetection | null,
  computer: string,
): string | null {
  if (!detection) return null;
  switch (detection.status) {
    case "found":
      return `Found on ${computer}`;
    case "notFound":
      return "Not installed";
    case "unknown":
      return null;
  }
}

/**
 * What a turned-off agent's row offers. "install": an Install button, which
 * turns it on and then installs it. "turnOn" (found, can't tell, never looked):
 * the row's switch, which only turns it on; the full check that follows says
 * what is still missing.
 */
export function offAgentAction(detection: ServerProviderDetection | null): "install" | "turnOn" {
  return detection?.status === "notFound" ? "install" : "turnOn";
}
