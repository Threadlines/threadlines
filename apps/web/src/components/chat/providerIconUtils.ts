import { ProviderDriverKind } from "@threadlines/contracts";
import { ClaudeAI, CursorIcon, FxIcon, Icon, OpenAI } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("fx")]: FxIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
};

/**
 * The provider glyph for a raw driver label off the wire. Surfaces that carry
 * a plain string (thread telemetry, the agents rail) go through this instead
 * of branding the value, so an unknown driver just draws no glyph.
 */
export function providerIconForDriverLabel(label: string | null | undefined): Icon | null {
  const trimmed = label?.trim();
  if (!trimmed) {
    return null;
  }
  return PROVIDER_ICON_BY_PROVIDER[trimmed as ProviderDriverKind] ?? null;
}

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
  /** Compact catalog metadata, e.g. "256K ctx · $0.25/M in · $2/M out". */
  metaLabel?: string | undefined;
  /** Promotional pricing chip from the provider's catalog, e.g. "Free". */
  promoLabel?: string | undefined;
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
