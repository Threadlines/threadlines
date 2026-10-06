import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  FxIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

/**
 * The built-in glyph of each driver. Draw a provider through `ProviderGlyph`
 * (or `ProviderInstanceIcon`), which also knows an instance's own icon; read
 * this table directly only where the UI lists driver kinds rather than
 * instances (the update prompt shows one mark per driver).
 */
export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("fx")]: FxIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

/** The longest registry icon the contract allows (`ServerProviderCommunity.iconSvg`). */
const PROVIDER_ICON_SVG_MAX_LENGTH = 32 * 1024;
/** An `<svg>` start tag with `xmlns="http://www.w3.org/2000/svg"` among its attributes. */
const SVG_ELEMENT_WITH_NAMESPACE =
  /<svg\s[^>]*?\bxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/i;

/**
 * A registry icon as a CSS `mask-image` value. The SVG text comes from a third
 * party, so it only ever reaches the page inside this data URL, where the
 * browser draws it as a static image: none of it is parsed as markup and no
 * script in it runs. Null for text that cannot be drawn (empty, over 32 KiB,
 * not an SVG document, or not encodable); the generic glyph stands in then.
 */
export function providerIconMaskImage(svg: string | null | undefined): string | null {
  if (!svg || svg.length > PROVIDER_ICON_SVG_MAX_LENGTH) {
    return null;
  }
  // A document whose `<svg>` element doesn't declare the SVG namespace does
  // not load as an image, and a mask that fails to load hides the glyph
  // entirely.
  if (!SVG_ELEMENT_WITH_NAMESPACE.test(svg)) {
    return null;
  }
  try {
    // encodeURIComponent leaves ' ( ) as they are, and each can end a CSS url().
    const encoded = encodeURIComponent(svg).replace(
      /['()]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `url("data:image/svg+xml;charset=utf-8,${encoded}")`;
  } catch {
    // A lone surrogate, which encodeURIComponent refuses.
    return null;
  }
}

/** What stands for a provider: its own registry icon, its driver's built-in glyph, or neither. */
export type ResolvedProviderGlyph =
  | { readonly kind: "driver"; readonly driver: ProviderDriverKind }
  | { readonly kind: "svg"; readonly svg: string }
  | { readonly kind: "generic" };

const GENERIC_PROVIDER_GLYPH: ResolvedProviderGlyph = { kind: "generic" };

/**
 * Which glyph stands for a provider instance. `providers` is every snapshot
 * the caller holds: an instance whose snapshot carries a drawable registry
 * icon (a community agent) gets that icon, a built-in provider its driver's
 * glyph, and anything else the generic one. `driver` may be a raw label off
 * the wire (the agents rail); when it names no built-in driver, the
 * instance's snapshot says which one it runs on.
 */
export function resolveProviderGlyph(input: {
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly driver?: string | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ResolvedProviderGlyph {
  // More than one when two computers run the same instance; any of them may
  // be the one that carries the icon.
  const snapshots = input.instanceId
    ? input.providers.filter((provider) => provider.instanceId === input.instanceId)
    : [];
  for (const snapshot of snapshots) {
    const svg = snapshot.community?.iconSvg;
    if (svg && providerIconMaskImage(svg) !== null) {
      return { kind: "svg", svg };
    }
  }
  for (const driver of [input.driver?.trim(), snapshots[0]?.driver]) {
    // An own-key check: the label is not ours, and "constructor" is not a driver.
    if (driver && Object.hasOwn(PROVIDER_ICON_BY_PROVIDER, driver)) {
      return { kind: "driver", driver: driver as ProviderDriverKind };
    }
  }
  return GENERIC_PROVIDER_GLYPH;
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

/**
 * The short name the model picker shows for a model: "Opus 5.5", "GPT-6
 * Astra". Rooms name their agents with it, so the picker, the timeline and
 * the inbox always agree.
 */
export function getPickerModelName(model: ModelEsque, driverKind: ProviderDriverKind): string {
  return getProviderScopedDisplayModelName(model, driverKind, { preferShortName: true });
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
