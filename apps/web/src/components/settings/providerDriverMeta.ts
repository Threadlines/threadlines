import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  FxSettings,
  OpenCodeSettings,
  AntigravitySettings,
  ProviderDriverKind,
} from "@threadlines/contracts";
import type * as Schema from "effect/Schema";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  FxIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  /**
   * What someone needs before this agent works, in a few plain words
   * ("ChatGPT plan or API key"). Setup tiles and Settings rows for agents
   * that aren't set up yet show it, so the choice is informed before any
   * install or sign-in starts.
   */
  readonly needs: string;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    settingsSchema: CodexSettings,
    needs: "ChatGPT plan or API key",
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
    needs: "Claude plan or API key",
  },
  {
    value: ProviderDriverKind.make("fx"),
    label: "fx",
    icon: FxIcon,
    settingsSchema: FxSettings,
    needs: "Vercel AI Gateway account",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
    settingsSchema: CursorSettings,
    needs: "Cursor account, free plan works",
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
    needs: "Free models, no account needed",
  },
  {
    value: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    icon: AntigravityIcon,
    settingsSchema: AntigravitySettings,
    needs: "Google account",
  },
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
