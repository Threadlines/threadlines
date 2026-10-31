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
 *
 * A child's reasoning is settled when it is asked for (settleChildReasoning)
 * and saved in its launch: a level the agent names, else the level the user
 * set for an agent in the asking thread on the same model, so an agent that
 * picks a model already in the room doesn't drop to the provider's default.
 */
import {
  isProviderAvailable,
  type ModelCapabilities,
  type ModelSelection,
  type PeerModelReasoning,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@threadlines/contracts";
import {
  findReasoningOptionDescriptor,
  findReasoningSelection,
  getPromotedChoiceReplacement,
} from "@threadlines/shared/model";

import { inviteBilling, inviteProviderName } from "./agentInvites.ts";

/**
 * Drivers known to honor plan mode: Codex (its plan collaboration mode),
 * Claude (permission mode `plan`), OpenCode (its plan agent), Antigravity
 * (`/plan`), Muse Code (a read-only host) and Grok (its `plan` session mode). Cursor and fx
 * plan only if their ACP agent happens to offer a
 * plan session mode, which is unknown until a session starts, so they are
 * left out while the asking thread plans.
 */
export const PLAN_MODE_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "opencode",
  "antigravity",
  "grok",
  // A read-only host whose answer is the plan.
  "muse",
  // The Threadlines extension declines every change while planning.
  "pi",
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
 * custom one). `listTool` is the tool the caller picks agents from.
 */
export function childModelRefusal(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly interactionMode: ProviderInteractionMode;
  readonly knownModel: boolean;
  readonly listTool?: string;
}): string | null {
  const listTool = input.listTool ?? "thread_agents";
  const provider = input.providers.find((entry) => entry.instanceId === input.selection.instanceId);
  if (provider === undefined) {
    return `No provider called "${input.selection.instanceId}" is set up. Pick one from ${listTool}.`;
  }
  const refusal = childAgentRefusal(provider, input.interactionMode);
  if (refusal !== null) {
    return `${childAgentProviderName(provider)} can't take a thread: ${refusal}. Pick another from ${listTool}.`;
  }
  if (input.knownModel && !provider.models.some((model) => model.slug === input.selection.model)) {
    return `${childAgentProviderName(provider)} has no model "${input.selection.model}". Pick one from ${listTool}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/**
 * A model's reasoning levels, as thread_agents lists them and a linked
 * computer's peer.describe shares them. Null when it has none to choose.
 */
export function modelReasoningSetting(
  caps: ModelCapabilities | null | undefined,
): PeerModelReasoning | null {
  const descriptor = findReasoningOptionDescriptor(caps?.optionDescriptors ?? []);
  return descriptor === undefined || descriptor.options.length === 0
    ? null
    : {
        option: descriptor.id,
        levels: descriptor.options.map((level) => ({ id: level.id, label: level.label })),
      };
}

/** The reasoning setting of a provider's model; undefined when the provider doesn't list it. */
export function providerModelReasoning(
  provider: ServerProvider | undefined,
  model: string,
): PeerModelReasoning | null | undefined {
  const listed = provider?.models.find((entry) => entry.slug === model);
  return listed === undefined ? undefined : modelReasoningSetting(listed.capabilities);
}

const normalizeLevel = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A level a call names, by id ("xhigh") or as the model picker shows it ("Extra High"). */
export function matchReasoningLevel(
  setting: PeerModelReasoning,
  input: string,
): PeerModelReasoning["levels"][number] | undefined {
  const wanted = normalizeLevel(input);
  return wanted.length === 0
    ? undefined
    : setting.levels.find((level) =>
        [level.id, level.label].some((name) => normalizeLevel(name) === wanted),
      );
}

/** Someone a child's reasoning can follow: an agent in the asking thread, or the user's default. */
export interface ReasoningSource {
  /** Its provider kind; undefined when its provider is gone. */
  readonly driver: string | undefined;
  readonly selection: ModelSelection;
}

/** `selection` with its reasoning level replaced, or taken out for the provider to pick. */
const withReasoning = (
  selection: ModelSelection,
  level: ProviderOptionSelection | undefined,
): ModelSelection => {
  const reasoning = findReasoningSelection(selection.options);
  const rest = (selection.options ?? []).filter((option) => option !== reasoning);
  const options = level === undefined ? rest : [...rest, level];
  const { options: _options, ...base } = selection;
  return options.length > 0 ? { ...base, options } : base;
};

/** A retired level as the one it stands for now: Claude's old "ultracode" effort is Extra High. */
const currentLevel = (level: ProviderOptionSelection): ProviderOptionSelection => {
  const replacement =
    typeof level.value === "string"
      ? getPromotedChoiceReplacement(level.id, level.value)
      : undefined;
  return replacement !== undefined ? { id: level.id, value: replacement } : level;
};

/** Whether `setting` offers `level`, a retired level counting as the one it stands for. */
const offers = (setting: PeerModelReasoning, level: ProviderOptionSelection) =>
  setting.option === level.id &&
  setting.levels.some(
    (entry) => entry.id === level.value || entry.id === currentLevel(level).value,
  );

const levelList = (setting: PeerModelReasoning) =>
  `${setting.levels.map((level) => level.id).join(", ")}, or "default" for the provider's own`;

/**
 * The selection a child runs on, its reasoning settled. In order: a level
 * the call names in `reasoning` ("default" for the provider's own); a
 * reasoning option it passed in `options`; the level of the first source on
 * the same kind of agent and model, as the user set it there (the asking
 * agent, the room's other agents, the user's default for new threads). That
 * source decides: one naming no level leaves it to the provider, and a level
 * the model doesn't offer is refused rather than quietly dropped. `setting`
 * is what the model offers: null for nothing to choose, undefined when
 * unknown (a model a linked computer didn't list), where a followed level
 * passes as it is and the computer that runs it checks it.
 */
export function settleChildReasoning(input: {
  readonly selection: ModelSelection;
  readonly reasoning: string | undefined;
  readonly driver: string | undefined;
  readonly setting: PeerModelReasoning | null | undefined;
  readonly sources: ReadonlyArray<ReasoningSource>;
  /** The model's name, for refusals. */
  readonly name: string;
}): ModelSelection | { readonly refused: string } {
  const { selection, setting, name } = input;
  const named = input.reasoning?.trim() ?? "";
  if (named.length > 0) {
    const level = setting ? matchReasoningLevel(setting, named) : undefined;
    if (level !== undefined) {
      return withReasoning(selection, { id: setting!.option, value: level.id });
    }
    if (normalizeLevel(named) === "default") {
      return withReasoning(selection, undefined);
    }
    return {
      refused:
        setting === null
          ? `${name} has no reasoning levels to choose from. Leave \`reasoning\` out.`
          : setting === undefined
            ? `Threadlines can't tell which reasoning levels ${name} has. Leave \`reasoning\` out.`
            : `${name} has no reasoning level "${named}". Its levels: ${levelList(setting)}.`,
    };
  }
  const passed = findReasoningSelection(selection.options);
  if (passed !== undefined) {
    if (setting === undefined || (setting !== null && offers(setting, passed))) {
      return selection;
    }
    return {
      refused:
        setting === null
          ? `${name} has no reasoning levels to choose from. Leave the reasoning option out.`
          : `${name} has no reasoning level "${String(passed.value)}". Name one of its levels in \`reasoning\`: ${levelList(setting)}.`,
    };
  }
  const source =
    input.driver === undefined
      ? undefined
      : input.sources.find(
          (entry) => entry.driver === input.driver && entry.selection.model === selection.model,
        );
  const followed = source && findReasoningSelection(source.selection.options);
  if (followed === undefined || setting === null) {
    return selection;
  }
  // Only the level follows: a retired level brings no switch it implied.
  const level = currentLevel(followed);
  if (setting === undefined || offers(setting, level)) {
    return withReasoning(selection, level);
  }
  return {
    refused: `${name} doesn't offer "${String(level.value)}", the reasoning the user set for this model here. Name one of its levels in \`reasoning\`: ${levelList(setting)}.`,
  };
}

/**
 * Why a saved launch's reasoning can't run on `provider` now, or null: the
 * computer running it checks again, since a level chosen when the agent
 * asked may be gone by the time it starts. Never followed anew.
 */
export function childReasoningRefusal(
  provider: ServerProvider,
  selection: ModelSelection,
  ownLabel: string,
): string | null {
  const level = findReasoningSelection(selection.options);
  if (level === undefined) return null;
  const setting = providerModelReasoning(provider, selection.model);
  if (setting === undefined || (setting !== null && offers(setting, level))) return null;
  const listed = provider.models.find((entry) => entry.slug === selection.model);
  const model = listed?.shortName ?? listed?.name ?? selection.model;
  return `${ownLabel}'s ${model} doesn't offer reasoning "${String(level.value)}".`;
}

/** The reasoning level a selection names, as thread tools report it. */
export const reasoningLevel = (selection: ModelSelection): string | undefined => {
  const level = findReasoningSelection(selection.options)?.value;
  return typeof level === "string" ? level : undefined;
};
