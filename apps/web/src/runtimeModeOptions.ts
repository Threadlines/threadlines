import type {
  ProviderDriverKind,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";

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
  accentClassName?: string;
}

export const runtimeModeConfig: Record<RuntimeMode, RuntimeModePresentation> = {
  "approval-required": {
    label: "Supervised",
    description: "Asks before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    descriptionByDriver: {
      claudeAgent: "Edits run without asking; commands still ask.",
      codex: "Edits and workspace commands run; asks to go outside or online.",
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
    accentClassName: "text-amber-600 dark:text-amber-400",
  },
};

export interface RuntimeModeOption {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  accentClassName?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function deriveRuntimeModeOptions(input: {
  providers: ReadonlyArray<ServerProvider>;
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelName?: string;
}): RuntimeModeOption[] {
  const providerModes = getProviderSupportedRuntimeModes(input.providers, input.provider);
  const modelUnsupported = getModelUnsupportedRuntimeModes(
    input.models,
    input.model,
    input.provider,
  );
  return providerModes.map((mode) => {
    const presentation = runtimeModeConfig[mode];
    const disabled = modelUnsupported.includes(mode);
    return {
      mode,
      label: presentation.label,
      description: presentation.descriptionByDriver?.[input.provider] ?? presentation.description,
      icon: presentation.icon,
      ...(presentation.accentClassName ? { accentClassName: presentation.accentClassName } : {}),
      ...(disabled
        ? {
            disabled: true,
            disabledReason: `Not supported by ${input.modelName ?? "this model"}.`,
          }
        : {}),
    };
  });
}
