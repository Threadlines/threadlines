import { ProviderDriverKind } from "@threadlines/contracts";
import { ClaudeAI, Icon, OpenAI } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  description?: string | undefined;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isDefault?: boolean | undefined;
};

const CLAUDE_AGENT_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function stripClaudeModelPrefix(name: string): string {
  const strippedName = name.replace(/^Claude\s+/u, "").trim();
  return strippedName.length > 0 ? strippedName : name;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  if (options?.preferShortName && model.shortName) {
    return model.shortName;
  }
  return model.name;
}

export function getProviderScopedDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind,
  options?: { preferShortName?: boolean },
): string {
  const displayName = getDisplayModelName(model, options);
  if (driverKind === CLAUDE_AGENT_DRIVER_KIND) {
    return stripClaudeModelPrefix(displayName);
  }
  return displayName;
}

export function getProviderScopedDisplayModelLabel(
  model: ModelEsque,
  driverKind: ProviderDriverKind,
  options?: { preferShortName?: boolean },
): string {
  const title = getProviderScopedDisplayModelName(model, driverKind, options);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const title = getTriggerDisplayModelName(model);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}
