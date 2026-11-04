/**
 * Which models an agent may ask a settings card to pick
 * (docs/design/agent-settings-changes.md): ones this computer can run now,
 * from a provider whose sign-in we know is a plan. A card must not be able to
 * move someone's default onto per-use billing, however plain the card, so a
 * provider we can't tell about is the user's own to choose. The tool checks
 * when an agent asks and the computer again when the user accepts.
 */
import {
  isProviderAvailable,
  type ServerProvider,
  type ServerSettings,
} from "@threadlines/contracts";
import {
  type EditControl,
  type EditValue,
  modelEditValue,
  NO_MODEL,
  parseModelEditValue,
  placePathLabel,
} from "@threadlines/shared/appPlaces";
import type { CheckedEdit } from "@threadlines/shared/settingsEdits";

import { inviteBilling } from "../orchestration/agentInvites.ts";

/**
 * Providers whose sign-in type says how they're billed. Pi and OpenCode reach
 * many services with keys we can't see, fx bills through a gateway, and
 * community agents are ones we never tested.
 */
const SIGN_IN_SAYS_BILLING: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "antigravity",
]);

/** How many of a provider's models the guide lists, in the provider's own order. */
const MODELS_LISTED_PER_PROVIDER = 6;

const canRunNow = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status === "authenticated";

const onAPlan = (provider: ServerProvider): boolean =>
  SIGN_IN_SAYS_BILLING.has(provider.driver) &&
  provider.auth.type !== undefined &&
  !inviteBilling(provider).perUse;

const providerOf = (value: unknown, providers: ReadonlyArray<ServerProvider>) => {
  const parsed = parseModelEditValue(value);
  return providers.find(({ instanceId }) => instanceId === parsed?.instanceId);
};

const SEE_GUIDE = "Look the setting up with app_guide for the models it offers.";

/** Why this computer can't take a model, wherever it's for; null when it can. */
function modelProblem(value: EditValue, providers: ReadonlyArray<ServerProvider>): string | null {
  const parsed = parseModelEditValue(value);
  const provider = providerOf(value, providers);
  if (parsed === null || provider === undefined) {
    return `"${String(value)}" isn't a provider on this computer. ${SEE_GUIDE}`;
  }
  if (!canRunNow(provider)) {
    return `${parsed.instanceId} can't run on this computer right now. ${SEE_GUIDE}`;
  }
  if (!onAPlan(provider)) {
    return `${parsed.instanceId} may be billed per use, so only the user can make it a default. Give them the link.`;
  }
  const model = provider.models.find(({ slug }) => slug === parsed.model);
  if (model === undefined || model.isHidden === true) {
    return `${parsed.instanceId} has no model "${parsed.model}". ${SEE_GUIDE}`;
  }
  return null;
}

/** Why this one setting can't take its value, given the writing and backup models it would leave. */
function settingProblem(input: {
  readonly control: Extract<EditControl, { readonly kind: "model" }>;
  readonly value: EditValue;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly writing: EditValue;
  readonly backup: EditValue;
}): string | null {
  const { control, value, providers, writing, backup } = input;
  if (value === NO_MODEL) {
    // Off hands source control text to the writing model, whatever bills it.
    if (control.role !== "sourceControl") return null;
    const provider = providerOf(writing, providers);
    return provider !== undefined && onAPlan(provider)
      ? null
      : "Off would use the writing model, which may be billed per use, so only the user can pick it. Give them the link.";
  }
  const problem = modelProblem(value, providers);
  if (problem !== null) return problem;
  const writingProvider = providerOf(writing, providers);
  const backupProvider = providerOf(backup, providers);
  if (control.role === "backupWriting") {
    // A writing model that's off falls back to another; which one isn't this card's to say.
    if (writingProvider === undefined || !writingProvider.enabled) {
      return "The writing model isn't turned on, so a backup can't be checked against it. Change the writing model first.";
    }
    if (writingProvider.driver === providerOf(value, providers)?.driver) {
      return "The backup writing model has to be on a different provider than the writing model.";
    }
  }
  // Threadlines swaps a backup that's on the writing model's provider or turned
  // off when it reads settings, without saying so, maybe to a per-use one.
  if (control.role === "writing" && backup !== NO_MODEL) {
    if (backupProvider === undefined || !backupProvider.enabled) {
      return `The backup writing model isn't turned on, so it would be swapped for another. Ask to change ${placePathLabel("threads.backupWritingModel")} in the same request.`;
    }
    if (backupProvider.driver === providerOf(value, providers)?.driver) {
      return `That's the same provider as the backup writing model. Ask to change ${placePathLabel("threads.backupWritingModel")} in the same request.`;
    }
  }
  return null;
}

/**
 * The first model change that can't be made, said for the agent, or null.
 * `settings` is this computer's stored settings at the time.
 */
export function modelChangesProblem(
  edits: ReadonlyArray<CheckedEdit>,
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const asked = (place: string) => edits.find((edit) => edit.place === place)?.value;
  const writing =
    asked("threads.writingModel") ?? modelEditValue(settings.textGenerationModelSelection);
  const backup =
    asked("threads.backupWritingModel") ??
    modelEditValue(settings.textGenerationBackupModelSelection);
  for (const { edit, place, value } of edits) {
    if (edit.control.kind !== "model") continue;
    const problem = settingProblem({ control: edit.control, value, providers, writing, backup });
    if (problem !== null) return `${placePathLabel(place)}: ${problem}`;
  }
  return null;
}

/** The models the guide offers for a model setting, as their values with their names. */
export function offeredModels(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  return providers.flatMap((provider) =>
    canRunNow(provider) && onAPlan(provider)
      ? provider.models
          .filter((model) => model.isHidden !== true)
          .slice(0, MODELS_LISTED_PER_PROVIDER)
          .map((model) => ({
            value: `${provider.instanceId}/${model.slug}`,
            name: model.shortName ?? model.name,
          }))
      : [],
  );
}
