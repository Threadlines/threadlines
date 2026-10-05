/**
 * Agent invites on the server (docs/design/rooms-agent-invites.md): which
 * providers an agent may invite, how each is paid for, and the checks the
 * user's answer passes before it reaches the decider.
 *
 * The decider rules on the thread (the invite is still waiting, Stop, voice,
 * a side answer running). What it cannot see lives here: the setting, and
 * whether the invited agent's provider is still signed in, paid for the way
 * the user was shown when the agent asked, and offering the reasoning level
 * the invite named.
 */
import {
  type AgentInvitesMode,
  isProviderAvailable,
  type OrchestrationThread,
  type RoomAgentInviteBilling,
  type RoomAgentInviteChoice,
  type RoomAgentRequestId,
  type ServerProvider,
} from "@threadlines/contracts";
import { offersSelectedReasoning } from "@threadlines/shared/model";

/**
 * Drivers an agent can invite: only Codex and Claude run the locked-down
 * review runtime an invited reviewer uses.
 */
export const INVITABLE_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Sign-ins billed per use rather than by a plan's limits (lowercased). */
const PER_USE_AUTH_TYPES: ReadonlySet<string> = new Set(["apikey", "amazonbedrock"]);

const DRIVER_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
};

/** A provider an agent may invite from: on, installed, signed in, able to review. */
export function isInvitableProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status === "authenticated" &&
    INVITABLE_DRIVERS.has(provider.driver)
  );
}

/** The provider's name, as the invite card shows it. */
export const inviteProviderName = (provider: ServerProvider): string =>
  provider.displayName ?? DRIVER_NAMES[provider.driver] ?? provider.driver;

/** Who pays for an invited agent: "Codex · ChatGPT Pro Subscription", per use or not. */
export function inviteBilling(provider: ServerProvider): RoomAgentInviteBilling {
  const name = inviteProviderName(provider);
  return {
    instanceId: provider.instanceId,
    label: provider.auth.label !== undefined ? `${name} · ${provider.auth.label}` : name,
    perUse: PER_USE_AUTH_TYPES.has(provider.auth.type?.toLowerCase() ?? ""),
  };
}

/**
 * Why the user's answer to an invite cannot be applied as they were shown
 * it, or null. Declining always goes through.
 */
export function inviteAnswerRefusal(input: {
  readonly thread: Pick<OrchestrationThread, "agentRequests" | "messages" | "participants">;
  readonly requestId: RoomAgentRequestId;
  readonly choice: RoomAgentInviteChoice;
  readonly mode: AgentInvitesMode;
  readonly providers: ReadonlyArray<ServerProvider>;
}): string | null {
  if (input.choice === "decline") {
    return null;
  }
  if (input.mode === "off") {
    return "Bringing in other agents is turned off in Settings.";
  }
  const request = input.thread.agentRequests.open.find(
    (entry) => entry.requestId === input.requestId,
  );
  if (request === undefined || request.kind !== "invite") {
    // The decider says why.
    return null;
  }
  const shown = input.thread.messages.find((message) => message.id === request.requestMessageId)
    ?.invite?.billing;
  const guest = input.thread.participants.find(
    (participant) => participant.id === request.to.participantId,
  );
  if (shown === undefined || guest === undefined) {
    return null;
  }
  const provider = input.providers.find(
    (entry) => entry.instanceId === guest.modelSelection.instanceId,
  );
  if (provider === undefined || !isInvitableProvider(provider)) {
    return `${guest.handle} is not available right now: its provider is off or signed out.`;
  }
  const model = provider.models.find((entry) => entry.slug === guest.modelSelection.model);
  if (model === undefined) {
    return `${guest.handle} is no longer offered by its provider.`;
  }
  if (!offersSelectedReasoning(model.capabilities, guest.modelSelection.options)) {
    return `${guest.handle} no longer offers the reasoning level the agent asked for. Ask it to invite again.`;
  }
  const now = inviteBilling(provider);
  if (now.label !== shown.label || now.perUse !== shown.perUse) {
    return `${inviteProviderName(provider)}'s sign-in changed since the agent asked. Ask it to invite again.`;
  }
  return null;
}
