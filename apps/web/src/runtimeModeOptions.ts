import {
  LEGACY_RUNTIME_MODES,
  type ProviderDriverKind,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";

import { effectiveRuntimeMode } from "@threadlines/shared/runtimeMode";

import {
  getModelUnsupportedRuntimeModes,
  getProviderSupportedRuntimeModes,
} from "./providerModels";

interface RuntimeModePresentation {
  label: string;
  description: string;
  // Provider-specific copy: the same tier has a different blast radius per
  // driver (e.g. Codex workspace-write auto-runs commands, Claude acceptEdits
  // does not), so the menu describes what the active driver will actually do.
  descriptionByDriver?: Partial<Record<string, string>>;
  icon: LucideIcon;
}

export const runtimeModeConfig: Record<RuntimeMode, RuntimeModePresentation> = {
  "approval-required": {
    label: "Supervised",
    description: "Asks before commands and file changes.",
    // Muse's strictest profile (Ask me) lets edits inside the project through.
    descriptionByDriver: {
      muse: "Edits in the project run; asks before commands and outside access.",
    },
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    descriptionByDriver: {
      claudeAgent: "Edits run without asking; commands still ask.",
      codex: "Edits and workspace commands run; asks to go outside or online.",
      muse: "Same as Supervised: Muse never asks for edits in the project.",
    },
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "No routine prompts; a safety model reviews risky actions.",
    descriptionByDriver: {
      claudeAgent: "No routine prompts; a classifier blocks risky actions.",
      codex: "Runs in the workspace; a reviewer agent rules on escalations.",
    },
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: "Full access",
    description: "No prompts or sandbox. Trusted repos only.",
    icon: LockOpenIcon,
  },
};

export interface RuntimeModeOption {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
}

export function deriveRuntimeModeOptions(input: {
  providers: ReadonlyArray<ServerProvider>;
  provider: ProviderDriverKind;
  /** The selected instance's own snapshot, when known: a custom instance or a
   *  community agent is not its driver's default instance. */
  snapshot?: ServerProvider | null;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelName?: string;
}): RuntimeModeOption[] {
  const providerModes = input.snapshot
    ? (input.snapshot.supportedRuntimeModes ?? LEGACY_RUNTIME_MODES)
    : getProviderSupportedRuntimeModes(input.providers, input.provider);
  const modelUnsupported = getModelUnsupportedRuntimeModes(
    input.models,
    input.model,
    input.provider,
  );
  return providerModes.map((mode) => {
    const presentation = runtimeModeConfig[mode];
    const disabled = modelUnsupported.includes(mode);
    const option: RuntimeModeOption = {
      mode,
      label: presentation.label,
      description: presentation.descriptionByDriver?.[input.provider] ?? presentation.description,
      icon: presentation.icon,
    };
    if (disabled) {
      option.disabled = true;
      option.disabledReason = `Not supported by ${input.modelName ?? "this model"}.`;
    }
    return option;
  });
}

/**
 * The access level the composer shows: the one the chat runs at. That is the
 * chosen level when the agent and model offer it, else the next safer one they
 * do (`effectiveRuntimeMode`, the rule every driver applies). Until the
 * server's agent list arrives nothing is known, so the choice shows as is.
 */
export function shownRuntimeMode(input: {
  providers: ReadonlyArray<ServerProvider>;
  mode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
}): RuntimeMode {
  if (input.providers.length === 0) {
    return input.mode;
  }
  const offered = input.options
    .filter((option) => option.disabled !== true)
    .map((option) => option.mode);
  return effectiveRuntimeMode(input.mode, offered);
}

/** The composer's access-level controls for one agent and model. */
export function deriveAccessLevel(input: {
  providers: ReadonlyArray<ServerProvider>;
  provider: ProviderDriverKind;
  snapshot: ServerProvider | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  /** The level the thread's user chose. */
  mode: RuntimeMode;
}): { options: RuntimeModeOption[]; shown: RuntimeMode } {
  const modelName = input.models.find((candidate) => candidate.slug === input.model)?.name;
  const options = deriveRuntimeModeOptions({
    providers: input.providers,
    provider: input.provider,
    snapshot: input.snapshot ?? null,
    models: input.models,
    model: input.model,
    ...(modelName ? { modelName } : {}),
  });
  return {
    options,
    shown: shownRuntimeMode({ providers: input.providers, mode: input.mode, options }),
  };
}
