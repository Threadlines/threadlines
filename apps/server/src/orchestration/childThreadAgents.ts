/**
 * Which agents a child thread may run on (docs/design/child-threads.md).
 *
 * Any provider the user has ready can take a child, Codex and Claude or not,
 * with two exceptions the agent asking cannot see: a sign-in billed per use
 * (an API key), which an agent should never spend on its own, and a provider
 * that cannot work in plan mode when the asking thread is in it, since a
 * child never gets more access than its parent. `thread_agents` lists by
 * these rules, `thread_start` checks by them, and the user's approval is
 * re-checked by them before anything starts.
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@threadlines/contracts";

import { inviteBilling, inviteProviderName } from "./agentInvites.ts";

/**
 * Drivers known to honor plan mode: Codex (its plan collaboration mode),
 * Claude (permission mode `plan`), OpenCode (its plan agent) and Antigravity
 * (`/plan`). Cursor and fx plan only if their ACP agent happens to offer a
 * plan session mode, which is unknown until a session starts, so they are
 * left out while the asking thread plans.
 */
export const PLAN_MODE_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "opencode",
  "antigravity",
]);

/** The provider's name, as the agent and the approval card see it. */
export const childAgentProviderName = (provider: ServerProvider): string =>
  inviteProviderName(provider);

/**
 * Why a child cannot run on `provider` for a thread in `interactionMode`, as
 * the end of a sentence ("Claude is not available: <reason>"), or null.
 */
export function childAgentRefusal(
  provider: ServerProvider,
  interactionMode: ProviderInteractionMode,
): string | null {
  if (
    !provider.enabled ||
    !provider.installed ||
    !isProviderAvailable(provider) ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status !== "authenticated"
  ) {
    return "it is turned off, not installed or signed out";
  }
  if (inviteBilling(provider).perUse) {
    return "it is billed per use (an API key), and agents only start threads on plans";
  }
  if (interactionMode === "plan" && !PLAN_MODE_DRIVERS.has(provider.driver)) {
    return "it cannot work in plan mode, which this thread is in";
  }
  return null;
}

/**
 * Why a child cannot run on `selection`, or null: its provider must pass
 * childAgentRefusal and still offer the model. `knownModel: false` accepts a
 * model the provider does not list (the asking agent's own, which may be a
 * custom one).
 */
export function childModelRefusal(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly interactionMode: ProviderInteractionMode;
  readonly knownModel: boolean;
}): string | null {
  const provider = input.providers.find((entry) => entry.instanceId === input.selection.instanceId);
  if (provider === undefined) {
    return `No provider called "${input.selection.instanceId}" is set up. Pick one from thread_agents.`;
  }
  const refusal = childAgentRefusal(provider, input.interactionMode);
  if (refusal !== null) {
    return `${childAgentProviderName(provider)} can't take a thread: ${refusal}. Pick another from thread_agents.`;
  }
  if (input.knownModel && !provider.models.some((model) => model.slug === input.selection.model)) {
    return `${childAgentProviderName(provider)} has no model "${input.selection.model}". Pick one from thread_agents.`;
  }
  return null;
}
