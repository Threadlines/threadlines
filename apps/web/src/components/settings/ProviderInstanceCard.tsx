"use client";

import {
  ChevronDownIcon,
  PipetteIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";

import {
  BROWSER_SIGN_IN_DRIVERS,
  BROWSER_SIGN_IN_LABEL,
  buildClaudeAuthLoginCommand,
  buildClaudeSetupTokenCommand,
  buildCodexLoginCommand,
  buildCursorLoginCommand,
  buildFxLoginCommand,
  buildOpenCodeLoginCommand,
  CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES,
  CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
  deriveClaudeLongLivedOAuthTokenState,
  sanitizeClaudeLongLivedOAuthTokenInput,
  upsertClaudeLongLivedOAuthTokenEnvironment,
} from "@threadlines/shared/providerAuthCommands";

import { LinkifiedText } from "../../lib/linkifiedText";
import { cn } from "../../lib/utils";
import {
  deriveProviderAccountUsagePresentationForProvider,
  headlineUsageMeter,
  type ProviderAccountUsagePresentation,
  usageMeterColor,
} from "../../lib/providerUsage";
import {
  formatProviderInstanceName,
  normalizeProviderAccentColor,
  PROVIDER_ACCENT_SWATCHES,
} from "../../providerInstances";
import { AddProviderAccountForm } from "./AddProviderAccountForm";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderConnectFlow } from "./ProviderConnectFlow";
import type { DriverOption } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  ProviderSettingsFields,
  readProviderConfigString,
  type ProviderSettingsFieldModel,
} from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderUsageDashboard } from "../ProviderUsageDashboard";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  firstSentenceOf,
  getProviderVersionAdvisoryPresentation,
  getProviderSummary,
  getProviderVersionLabel,
} from "./providerStatus";
import { deriveProviderInstallView } from "./providerInstall";
import { ProviderInstallAction, startProviderInstall } from "./ProviderInstallAction";
import { ProviderSignInAction } from "./ProviderSignInAction";
import { AgentRow, AgentUpdateTag, type AgentRowTone } from "./AgentRow";
import {
  agentDetectionLabel,
  agentStatusLine,
  deriveAgentStatus,
  offAgentAction,
} from "./agentStatus";
import { ProviderUpdatePopover } from "./ProviderUpdatePopover";
import type { ProviderUpdateControls } from "./useProviderUpdateRunner";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");
const RUNTIME_PROVIDER_CONFIG_FIELD_KEYS = new Set([
  "binaryPath",
  "launchArgs",
  "serverUrl",
  "serverPassword",
  "apiEndpoint",
]);

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

function nextConfigBlobWithOptionalStringArray(
  config: unknown,
  key: string,
  value: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  if (value.length > 0) {
    base[key] = [...value];
  } else {
    delete base[key];
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    (input.liveModels ?? [])
      .filter((model) => model.isCustom)
      .map((model) => [model.slug, model] as const),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

export function preferClaudeNormalSignInEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const credentialNames = new Set<string>([
    CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
    ...CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES,
  ]);
  const nextEnvironment = environment.filter((variable) => !credentialNames.has(variable.name));
  for (const name of credentialNames) {
    nextEnvironment.push({
      name,
      value: "",
      sensitive: false,
      valueRedacted: false,
    });
  }
  return nextEnvironment;
}

export function hasClaudeCredentialOverrideEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return environment.some(
    (variable) =>
      CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES.includes(
        variable.name as (typeof CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES)[number],
      ) &&
      (variable.valueRedacted === true || variable.value.trim().length > 0),
  );
}

export function preferClaudeLongLivedOAuthTokenEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const overrideNames = new Set<string>(CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES);
  const nextEnvironment = environment.filter((variable) => !overrideNames.has(variable.name));

  for (const name of CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES) {
    nextEnvironment.push({
      name,
      value: "",
      sensitive: false,
      valueRedacted: false,
    });
  }

  return nextEnvironment;
}

function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {props.separator ? <span aria-hidden>·</span> : null}
      {props.prefix ? <span className="text-muted-foreground/80">{props.prefix}</span> : null}
      <RedactedSensitiveText
        value={trimmed}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
      />
    </span>
  );
}

function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const draftColor = normalizeProviderAccentColor(draft);

  useEffect(() => {
    if (isEditing) return;
    setDraft(props.value ?? "");
  }, [isEditing, props.value]);

  const commitDraft = () => {
    setIsEditing(false);
    props.onCommit(draftColor ?? "");
  };

  const commitSwatch = (swatch: string) => {
    setIsEditing(false);
    setDraft(swatch);
    props.onCommit(swatch);
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="relative inline-flex size-7 shrink-0">
                <input
                  type="color"
                  value={draftColor ?? PROVIDER_ACCENT_SWATCHES[0]}
                  onFocus={() => setIsEditing(true)}
                  onInput={(event) => {
                    setIsEditing(true);
                    setDraft(event.currentTarget.value);
                  }}
                  onChange={(event) => {
                    setIsEditing(true);
                    setDraft(event.currentTarget.value);
                  }}
                  onBlur={commitDraft}
                  aria-label={`Pick custom accent color for ${props.displayName}`}
                  className="absolute inset-0 z-10 size-7 cursor-pointer rounded-full opacity-0"
                />
                <span
                  className={cn(
                    "pointer-events-none absolute inset-0 rounded-full border border-black/10 shadow-inner dark:border-white/20",
                    draftColor &&
                      !PROVIDER_ACCENT_SWATCHES.includes(
                        draftColor as (typeof PROVIDER_ACCENT_SWATCHES)[number],
                      ) &&
                      "ring-2 ring-ring ring-offset-1 ring-offset-background",
                  )}
                  style={{ backgroundColor: draftColor ?? PROVIDER_ACCENT_SWATCHES[0] }}
                  aria-hidden
                />
                <span className="pointer-events-none absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border border-background bg-background/95 text-foreground shadow-sm">
                  <PipetteIcon className="size-2.5" aria-hidden />
                </span>
              </span>
            }
          />
          <TooltipPopup side="top">Pick custom accent color</TooltipPopup>
        </Tooltip>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
            const selected = draftColor?.toLowerCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={cn(
                  "size-7 cursor-pointer rounded-full border transition",
                  selected
                    ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-black/10 hover:scale-105 dark:border-white/20",
                )}
                style={{ backgroundColor: swatch }}
                onClick={() => commitSwatch(swatch)}
                aria-label={`Use ${swatch} accent`}
              />
            );
          })}
        </div>
        {draftColor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setIsEditing(false);
              setDraft("");
              props.onCommit("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground">
        Used to distinguish this instance in picker rails and model lists.
      </span>
    </div>
  );
}

function ProviderEnvironmentEditor(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly reservedNames?: ReadonlySet<string> | undefined;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const editableEnvironment = useMemo(
    () =>
      props.reservedNames
        ? props.environment.filter((variable) => !props.reservedNames?.has(variable.name))
        : props.environment,
    [props.environment, props.reservedNames],
  );
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    editableEnvironment.map(makeEnvironmentDraftRow),
  );

  useEffect(() => {
    setRows(editableEnvironment.map(makeEnvironmentDraftRow));
  }, [editableEnvironment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    const reserved = props.reservedNames
      ? props.environment.filter((variable) => props.reservedNames?.has(variable.name))
      : [];
    props.onChange([...reserved, ...published]);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  const addVariable = () =>
    setRows([
      ...rows,
      {
        id: nextEnvironmentVariableDraftId(),
        name: "",
        value: "",
        sensitive: true,
      },
    ]);

  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-semibold text-foreground">Environment variables</p>
          <p className="text-xs text-muted-foreground">
            Process environment for provider-specific tokens, gateways, and debugging.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={addVariable}
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No environment variables configured.</p>
      ) : (
        <div className="grid gap-2">
          {rows.map((variable, index) => (
            <div
              key={variable.id}
              className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] sm:items-center"
            >
              <DraftInput
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <DraftInput
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted ? "Stored secret - enter a new value to replace" : "Value"
                }
                spellCheck={false}
                aria-label={`Environment variable value ${index + 1}`}
              />
              <label className="inline-flex h-8 items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={variable.sensitive}
                  onChange={(event) => {
                    const sensitive = event.currentTarget.checked;
                    updateVariable(variable.id, {
                      sensitive,
                      ...(sensitive && variable.valueRedacted === undefined
                        ? {}
                        : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                    });
                  }}
                />
                Sensitive
              </label>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-8 justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClaudeLongLivedAuthSection(props: {
  readonly idPrefix: string;
  readonly instanceId: ProviderInstanceId;
  readonly setupCommand: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const tokenState = deriveClaudeLongLivedOAuthTokenState(props.environment);
  const tokenInputId = `${props.idPrefix}-claude-oauth-token`;
  const [tokenDraft, setTokenDraft] = useState("");
  const [isExpanded, setIsExpanded] = useState(tokenState.configured);
  const sanitizedTokenDraft = sanitizeClaudeLongLivedOAuthTokenInput(tokenDraft);
  const tokenDraftHasValue = tokenDraft.trim().length > 0;
  const tokenDraftWillBeSanitized = tokenDraftHasValue && sanitizedTokenDraft !== tokenDraft.trim();
  const saveToken = () => {
    if (sanitizedTokenDraft.length === 0) {
      toastManager.add({
        type: "error",
        title: "Paste a Claude OAuth token first",
        description: "Run the setup command, copy the printed token, then save it here.",
      });
      return;
    }
    props.onChange(
      upsertClaudeLongLivedOAuthTokenEnvironment(props.environment, sanitizedTokenDraft),
    );
    setTokenDraft("");
    toastManager.add({
      type: "success",
      title: "Claude long-lived token saved",
      description: tokenDraftWillBeSanitized
        ? "Whitespace was removed from the pasted token before saving."
        : "Threadlines will pass it to Claude as CLAUDE_CODE_OAUTH_TOKEN.",
    });
  };

  return (
    <details
      className="group border-t border-border/50 pt-4"
      // React alone drives `open`: the summary click below prevents the
      // native toggle. Letting the browser toggle first creates a race where a
      // render committed before the onToggle state update re-applies the stale
      // `open` and snaps the section shut (a CI-only flake on loaded runners).
      open={isExpanded}
    >
      <summary
        className="cursor-pointer list-none text-xs font-semibold text-foreground marker:hidden"
        onClick={(event) => {
          event.preventDefault();
          setIsExpanded((expanded) => !expanded);
        }}
      >
        <span className="inline-flex items-center gap-1.5">
          <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
          Advanced: headless chat token
          {tokenState.configured ? (
            <Badge variant="secondary" size="sm">
              Active
            </Badge>
          ) : null}
        </span>
      </summary>
      <div className="mt-3 grid gap-3">
        <p className="text-xs text-muted-foreground">
          Optional for remote or headless chat. Usage still requires normal Claude sign-in.
        </p>
        <ProviderConnectFlow
          instanceId={props.instanceId}
          flow="claude-setup-token"
          displayName="Claude"
          actionLabel={tokenState.configured ? "Generate new token" : "Generate token"}
          command={props.setupCommand}
          buttonVariant={tokenState.configured ? "outline" : "default"}
          description="Threadlines saves the token for you when it appears."
        />
        <label className="block" htmlFor={tokenInputId}>
          <span className="text-xs font-medium text-foreground">Paste a token instead</span>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
            <Input
              id={tokenInputId}
              className="min-w-64 flex-1"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveToken();
                }
              }}
              type="password"
              autoComplete="off"
              placeholder={
                tokenState.configured
                  ? "Stored secret - enter a new value to replace"
                  : "Paste token"
              }
              spellCheck={false}
            />
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8 px-2 text-xs sm:h-7.5"
              disabled={sanitizedTokenDraft.length === 0}
              onClick={saveToken}
            >
              Save token
            </Button>
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            This writes <code className="text-foreground">{CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV}</code>{" "}
            as a sensitive environment variable.
          </span>
          {tokenDraftWillBeSanitized ? (
            <span className="mt-1 block text-xs text-warning">
              Whitespace will be removed before saving.
            </span>
          ) : null}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={tokenState.configured ? "success" : "secondary"} size="sm">
            {tokenState.configured ? "Configured" : "Not configured"}
          </Badge>
          {tokenState.configured ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => props.onChange(preferClaudeNormalSignInEnvironment(props.environment))}
            >
              Use normal Claude sign-in
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}

export function providerAuthBadge(input: ServerProvider["auth"] | undefined): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary";
} {
  const chatStatus = input?.capabilities?.chat?.status;
  if (chatStatus === "verified") {
    return { label: "Authenticated", variant: "success" };
  }
  if (chatStatus === "configured") {
    return { label: "Credential configured", variant: "secondary" };
  }
  if (chatStatus === "unavailable") {
    return { label: "Needs sign in", variant: "warning" };
  }
  switch (input?.status) {
    case "authenticated":
      return { label: "Authenticated", variant: "success" };
    case "unauthenticated":
      return { label: "Needs sign in", variant: "warning" };
    default:
      return { label: "Checking", variant: "secondary" };
  }
}

export function claudeAuthCapabilityBadge(
  capability: NonNullable<ServerProvider["auth"]["capabilities"]>["chat"] | undefined,
  kind: "chat" | "usage",
): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary";
} | null {
  if (!capability) return null;
  const prefix = kind === "chat" ? "Chat" : "Usage";
  switch (capability.status) {
    case "verified":
      return { label: `${prefix} verified`, variant: "success" };
    case "configured":
      return { label: `${prefix} configured`, variant: "secondary" };
    case "unavailable":
      return { label: `${prefix} unavailable`, variant: "warning" };
    case "unknown":
      return { label: `${prefix} checking`, variant: "secondary" };
  }
}

function ProviderAccountSignInSection(props: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | null;
  readonly displayName: string;
  readonly liveProvider: ServerProvider | undefined;
  readonly terminalLoginCommand: string;
  readonly idPrefix: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onEnvironmentChange: (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => void;
  readonly claudeSetupTokenCommand?: string | undefined;
  readonly signInHandoffActive?: boolean;
}) {
  const authBadge = providerAuthBadge(props.liveProvider?.auth);
  const needsSignIn = authBadge.variant === "warning";
  const isClaude = props.driverKind === CLAUDE_DRIVER_KIND;
  // OpenCode's sign-in opens on a menu of providers to connect, in the
  // terminal itself, so the terminal shows from the start.
  const signInStartsInTerminal = props.driverKind === OPENCODE_DRIVER_KIND;
  // Antigravity signs in through a Google page, inside the agent: no
  // terminal, and it can sign out.
  const browserSignIn =
    props.driverKind !== null && BROWSER_SIGN_IN_DRIVERS.has(String(props.driverKind));
  const hasClaudeCredentialOverride =
    isClaude && hasClaudeCredentialOverrideEnvironment(props.environment);
  const claudeLongLivedTokenConfigured =
    isClaude && deriveClaudeLongLivedOAuthTokenState(props.environment).configured;
  const claudeCapabilityBadges = isClaude
    ? (["chat", "usage"] as const).flatMap((kind) => {
        const capability = props.liveProvider?.auth.capabilities?.[kind];
        if (!capability) return [];
        const presentation = claudeAuthCapabilityBadge(capability, kind);
        return presentation ? [{ kind, capability, presentation }] : [];
      })
    : [];

  return (
    <ProviderConfigurationSection
      title="Account & Sign-in"
      description="Shows whether this provider is ready and signs it back in without leaving settings."
    >
      <div className="grid gap-4">
        {props.liveProvider?.enabled === false ? (
          // Turned off: the server has not looked at it, so there is no
          // sign-in state to show or run yet.
          <p className="text-xs text-muted-foreground">Turn {props.displayName} on to sign in.</p>
        ) : props.liveProvider?.installed === false ? (
          // Nothing to sign in to yet: the row's Install comes first.
          <p className="text-xs text-muted-foreground">
            Install {props.displayName} first, then sign in here.
          </p>
        ) : (
          <ProviderConnectFlow
            instanceId={props.instanceId}
            flow="login"
            displayName={props.displayName}
            actionLabel={needsSignIn ? "Sign in" : "Sign in again"}
            command={props.terminalLoginCommand}
            autoShowTerminal={(props.signInHandoffActive ?? false) || signInStartsInTerminal}
            surface={browserSignIn ? "browser" : "terminal"}
            runningHint={
              signInStartsInTerminal
                ? "Pick a provider in the terminal below, then finish any step it opens in your browser."
                : browserSignIn
                  ? "Finish signing in on Google's page in your browser."
                  : undefined
            }
            buttonVariant={needsSignIn ? "default" : "ghost"}
            description={
              isClaude
                ? "Signing in covers both chat and usage."
                : signInStartsInTerminal
                  ? "Connects a model provider, such as an OpenCode Go plan or your ChatGPT account, to OpenCode."
                  : browserSignIn
                    ? "Signs in with your Google account."
                    : undefined
            }
            statusRow={
              <>
                <Badge variant={authBadge.variant} size="sm">
                  {authBadge.label}
                </Badge>
                {claudeCapabilityBadges.map(({ kind, capability, presentation }) => (
                  <Badge
                    key={kind}
                    variant={presentation.variant}
                    size="sm"
                    title={capability.detail}
                  >
                    {presentation.label}
                  </Badge>
                ))}
              </>
            }
          />
        )}

        {browserSignIn && props.liveProvider?.auth.status === "authenticated" ? (
          <ProviderConnectFlow
            instanceId={props.instanceId}
            flow="logout"
            displayName={props.displayName}
            actionLabel="Sign out"
            command="Sign out of Google"
            surface="browser"
            buttonVariant="ghost"
            runningHint="Signing out…"
            description="Ends this Google sign-in for Antigravity on this computer."
          />
        ) : null}

        {hasClaudeCredentialOverride ? (
          <div className="rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs leading-5 text-warning">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">Environment override active</p>
                <p className="mt-0.5 text-warning/85">
                  `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is set for this provider. Claude
                  uses those before the long-lived OAuth token.
                </p>
                {claudeLongLivedTokenConfigured ? (
                  <p className="mt-1 text-warning/85">
                    Use the long-lived token to clear these provider overrides and mask inherited
                    Anthropic env vars.
                  </p>
                ) : (
                  <p className="mt-1 text-warning/85">
                    Add a long-lived token before switching this provider to OAuth token auth.
                  </p>
                )}
              </div>
              {claudeLongLivedTokenConfigured ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-warning/40 bg-warning/10 px-2 text-xs text-warning hover:bg-warning/15"
                  onClick={() =>
                    props.onEnvironmentChange(
                      preferClaudeLongLivedOAuthTokenEnvironment(props.environment),
                    )
                  }
                >
                  Use long-lived token
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {isClaude && props.claudeSetupTokenCommand ? (
          <ClaudeLongLivedAuthSection
            idPrefix={props.idPrefix}
            instanceId={props.instanceId}
            setupCommand={props.claudeSetupTokenCommand}
            environment={props.environment}
            onChange={props.onEnvironmentChange}
          />
        ) : null}
      </div>
    </ProviderConfigurationSection>
  );
}

type ProviderDetailsSection = "account" | "usage" | "models" | "configuration";

const PROVIDER_DETAILS_SECTION_LABELS: Record<ProviderDetailsSection, string> = {
  account: "Account",
  usage: "Usage",
  models: "Models",
  configuration: "Configuration",
};

function splitProviderSettingsFields(fields: ReadonlyArray<ProviderSettingsFieldModel>): {
  readonly runtimeFields: ReadonlyArray<ProviderSettingsFieldModel>;
  readonly advancedFields: ReadonlyArray<ProviderSettingsFieldModel>;
} {
  const runtimeFields: ProviderSettingsFieldModel[] = [];
  const advancedFields: ProviderSettingsFieldModel[] = [];
  for (const field of fields) {
    if (RUNTIME_PROVIDER_CONFIG_FIELD_KEYS.has(field.key)) {
      runtimeFields.push(field);
    } else {
      advancedFields.push(field);
    }
  }
  return { runtimeFields, advancedFields };
}

function ProviderDetailsNav(props: {
  readonly sections: ReadonlyArray<ProviderDetailsSection>;
  readonly activeSection: ProviderDetailsSection;
  readonly onSectionChange: (section: ProviderDetailsSection) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-4 border-b border-border/60">
      {props.sections.map((section) => (
        <button
          key={section}
          type="button"
          className={cn(
            "relative h-8 shrink-0 cursor-pointer text-xs transition-colors",
            props.activeSection === section
              ? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:bg-primary-readable"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => props.onSectionChange(section)}
          aria-pressed={props.activeSection === section}
        >
          {PROVIDER_DETAILS_SECTION_LABELS[section]}
        </button>
      ))}
    </div>
  );
}

/**
 * The row's compact usage: the tightest limit window as one small meter, plus
 * a reset-credit button when the account has credits. The full view (every
 * window, history, external resets) lives in the opened row's Usage tab.
 */
function ProviderUsageMeter(props: {
  readonly usage: ProviderAccountUsagePresentation;
  readonly displayName: string;
  readonly onResetAccountUsage?: (() => void) | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
}) {
  const meter = headlineUsageMeter(props.usage);
  const resetCount = props.usage.resetCredits?.availableCount ?? 0;
  const canReset = props.onResetAccountUsage !== undefined && resetCount > 0;
  if (!meter && !canReset) return null;
  const meterColor = meter ? usageMeterColor(meter.usedPercent, meter.warning) : undefined;

  return (
    <span className="flex min-w-0 items-center gap-2.5 text-[11.5px] text-muted-foreground">
      {canReset ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-[11.5px] font-normal text-muted-foreground hover:text-foreground"
          disabled={props.accountUsageResetInFlight === true}
          onClick={props.onResetAccountUsage}
          aria-label={`Choose a reset credit for ${props.displayName} usage`}
        >
          {props.accountUsageResetInFlight
            ? "Using reset"
            : `${resetCount} ${resetCount === 1 ? "reset" : "resets"}`}
        </Button>
      ) : null}
      {meter ? (
        <span className="flex items-center gap-1.5">
          <span>{meter.label}</span>
          <span
            role="meter"
            aria-label={`${props.usage.label} ${meter.label} ${meter.usedPercent}% used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={meter.usedPercent}
            className="h-1 w-13 overflow-hidden rounded-full bg-muted/80"
          >
            <span
              className={cn("block h-full rounded-full", !meterColor && "bg-primary-graph")}
              style={{ width: `${meter.usedPercent}%`, backgroundColor: meterColor }}
            />
          </span>
          <span className="min-w-7 text-right font-mono text-[11px] text-foreground tabular-nums">
            {meter.usedPercent}%
          </span>
        </span>
      ) : null}
    </span>
  );
}

function ProviderConfigurationSection(props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-xs font-semibold text-foreground">{props.title}</h4>
          {props.description ? (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        {props.action ? <div className="shrink-0">{props.action}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

function ProviderAdvancedConfigurationSection(props: {
  readonly fields: ReadonlyArray<ProviderSettingsFieldModel>;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly reservedEnvironmentNames?: ReadonlySet<string> | undefined;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
  readonly onEnvironmentChange: (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const editableEnvironmentCount = props.reservedEnvironmentNames
    ? props.environment.filter((variable) => !props.reservedEnvironmentNames?.has(variable.name))
        .length
    : props.environment.length;
  if (props.fields.length === 0 && editableEnvironmentCount === 0) return null;

  return (
    <section className="border-t border-border/60 px-4 py-3 sm:px-5">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between gap-3 py-1 text-left"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
        >
          <span className="min-w-0 space-y-0.5">
            <span className="block text-xs font-semibold text-foreground">Advanced</span>
            <span className="block text-xs text-muted-foreground">
              Home paths, environment variables, and low-level provider overrides.
            </span>
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <CollapsibleContent>
          <div className="grid gap-4 pt-3">
            {props.fields.length > 0 ? (
              <div className="grid gap-1">
                <ProviderSettingsFields
                  fields={props.fields}
                  value={props.value}
                  idPrefix={props.idPrefix}
                  variant="group"
                  onChange={props.onChange}
                />
              </div>
            ) : null}
            <ProviderEnvironmentEditor
              environment={props.environment}
              reservedNames={props.reservedEnvironmentNames}
              onChange={props.onEnvironmentChange}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly isExpanded: boolean;
  /**
   * True when the user arrived via a sign-in hand-off (`?instance=`): the
   * login flow's terminal opens as soon as it is active instead of waiting
   * out the stall threshold a second time.
   */
  readonly signInHandoffActive?: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Turns the agent on or off through the shared enablement path. Resolves
   * once the server stored it, so "Install" on a turned-off agent can wait
   * for the server to offer the install.
   */
  readonly onEnabledChange: (enabled: boolean) => Promise<void>;
  /**
   * Pass `undefined` to hide Delete. Built-in default instance slots use
   * `undefined`: they can't be deleted without losing the slot. Explicit
   * `| undefined` accommodates `exactOptionalPropertyTypes: true`.
   */
  readonly onDelete?: (() => void) | undefined;
  /** Restores a built-in slot's settings; absent when nothing differs from defaults. */
  readonly onResetDefaults?: (() => void) | undefined;
  /** "this Mac", "this PC" or "this computer", for detection copy. */
  readonly computerLabel: string;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly updateControls: ProviderUpdateControls;
  readonly onResetAccountUsage?: (() => void) | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
  /**
   * For agents that can hold extra accounts: the footer offers "Add another
   * … account", which opens the form inside this row.
   */
  readonly addAccount?: ProviderAddAccountControls | undefined;
  /** Removes this extra account (the caller confirms first). Shown instead of Delete. */
  readonly onRemoveAccount?: (() => void) | undefined;
  /** A just-added account: start its sign-in as soon as the row offers it. */
  readonly autoSignIn?: boolean | undefined;
  /** The auto sign-in started, or there was nothing to start. */
  readonly onAutoSignInSettled?: ((instanceId: ProviderInstanceId) => void) | undefined;
}

export interface ProviderAddAccountControls {
  /** The agent's own name, e.g. "Claude". */
  readonly agentName: string;
  readonly existingNames: ReadonlyArray<string>;
  readonly existingColors: ReadonlyArray<string | undefined>;
  readonly onAdded: (instanceId: ProviderInstanceId, startSignIn: boolean) => void;
  /** Changes when the header's "+" menu asks this row to show the form. */
  readonly openRequest: number;
}

/** How long a one-click Install on a turned-off agent waits for the server to offer it. */
const PENDING_INSTALL_TIMEOUT_MS = 30_000;
/** How long a just-added account waits for its row to offer sign-in. */
const AUTO_SIGN_IN_TIMEOUT_MS = 45_000;

/**
 * One configured provider instance on the Providers settings page, drawn as
 * a flat agent row that opens in place. Used for every row: built-in default
 * slots (no Delete) and user-authored custom instances.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no match
 *     is available yet the row still renders and reads "Checking…".
 *   - Turned-off rows say what the agent needs and what the server's file-only
 *     look found, with one button: "Turn on", or "Install" (turn on, then
 *     install once the server offers it).
 *   - Unknown drivers (`driverOption === undefined`) get a read-only notice
 *     instead of editable fields, so fork instances round-trip without
 *     destroying their config.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isExpanded,
  signInHandoffActive = false,
  onExpandedChange,
  onUpdate,
  onEnabledChange,
  onDelete,
  onResetDefaults,
  computerLabel,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  updateControls,
  onResetAccountUsage,
  accountUsageResetInFlight,
  addAccount,
  onRemoveAccount,
  autoSignIn = false,
  onAutoSignInSettled,
}: ProviderInstanceCardProps) {
  const enabled = instance.enabled ?? true;
  const summary = getProviderSummary(liveProvider);
  const authEmail = liveProvider?.auth.email;
  const usageEmail = liveProvider?.auth.usageEmail;
  const usageEmailForDisplay =
    usageEmail?.trim() && usageEmail !== authEmail ? usageEmail : undefined;
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const providerInstallView = deriveProviderInstallView(liveProvider);
  const usagePresentation = deriveProviderAccountUsagePresentationForProvider(liveProvider);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const [detailsSection, setDetailsSection] = useState<ProviderDetailsSection>("account");
  const [pendingInstall, setPendingInstall] = useState(false);
  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  const FallbackIconComponent = driverOption?.icon;
  const agentName =
    driverOption?.label ||
    (driverKind ? PROVIDER_DISPLAY_NAMES[driverKind] : undefined) ||
    String(instance.driver);
  const displayName = formatProviderInstanceName({
    agentName,
    displayName: instance.displayName,
    isDefault: String(instanceId) === String(instance.driver),
  });
  const [addingAccount, setAddingAccount] = useState(false);
  const [seenAddAccountRequest, setSeenAddAccountRequest] = useState(addAccount?.openRequest ?? 0);
  if (addAccount && addAccount.openRequest !== seenAddAccountRequest) {
    // Adjusting state while rendering: the header's "+" asked for the form.
    setSeenAddAccountRequest(addAccount.openRequest);
    setAddingAccount(true);
  }
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const agentStatus = deriveAgentStatus({
    enabled,
    driverKind: instance.driver,
    snapshot: liveProvider,
  });

  const customModels = readConfigStringArray(instance.config, "customModels");
  const fallbackModels = readConfigStringArray(instance.config, "fallbackModel");
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });
  const providerSettingsFields = useMemo(
    () => (driverOption ? deriveProviderSettingsFields(driverOption) : []),
    [driverOption],
  );
  const providerSettingsFieldGroups = useMemo(
    () => splitProviderSettingsFields(providerSettingsFields),
    [providerSettingsFields],
  );
  const claudeSetupTokenCommand = useMemo(
    () =>
      buildClaudeSetupTokenCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
        homePath: readProviderConfigString(instance.config, "homePath"),
        accountFolder: readProviderConfigString(instance.config, "accountFolder"),
      }),
    [instance.config],
  );
  const terminalLoginCommand = useMemo(() => {
    if (driverKind === CODEX_DRIVER_KIND) {
      return buildCodexLoginCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
        homePath: readProviderConfigString(instance.config, "homePath"),
        shadowHomePath: readProviderConfigString(instance.config, "shadowHomePath"),
      });
    }
    if (driverKind === CLAUDE_DRIVER_KIND) {
      return buildClaudeAuthLoginCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
        homePath: readProviderConfigString(instance.config, "homePath"),
        accountFolder: readProviderConfigString(instance.config, "accountFolder"),
      });
    }
    if (driverKind === CURSOR_DRIVER_KIND) {
      return buildCursorLoginCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
      });
    }
    if (driverKind === FX_DRIVER_KIND) {
      return buildFxLoginCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
      });
    }
    if (driverKind === OPENCODE_DRIVER_KIND) {
      return buildOpenCodeLoginCommand({
        binaryPath: readProviderConfigString(instance.config, "binaryPath"),
        accountFolder: readProviderConfigString(instance.config, "accountFolder"),
      });
    }
    if (driverKind !== null && BROWSER_SIGN_IN_DRIVERS.has(String(driverKind))) {
      return BROWSER_SIGN_IN_LABEL;
    }
    return null;
  }, [driverKind, instance.config]);
  // Installed but signed out: the next step belongs on the row, like Install.
  const showRowSignIn =
    enabled &&
    liveProvider?.installed === true &&
    liveProvider.auth.status === "unauthenticated" &&
    terminalLoginCommand !== null;
  const reservedEnvironmentNames = useMemo(
    () =>
      driverKind === CLAUDE_DRIVER_KIND
        ? new Set<string>([CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV])
        : undefined,
    [driverKind],
  );

  // A one-click Install on a turned-off agent: the agent is turned on first,
  // and the install starts as soon as the server's snapshot offers it. The
  // row only says so while the server is still catching up; once it reports
  // anything else (installing, already there, nothing to install) the row
  // shows that instead, and a bounded timeout ends the wait.
  const installStartedRef = useRef(false);
  const showPendingInstall =
    pendingInstall && (agentStatus.kind === "checking" || agentStatus.kind === "off");
  useEffect(() => {
    if (!pendingInstall || installStartedRef.current) return;
    // Any install the server offers and isn't already running: a previous
    // failed attempt shows as "failed", and the user just asked again.
    if (!providerInstallView || providerInstallView.status === "running" || driverKind === null) {
      return;
    }
    installStartedRef.current = true;
    void startProviderInstall({ instanceId, driverKind, displayName }).finally(() => {
      installStartedRef.current = false;
      setPendingInstall(false);
    });
  }, [displayName, driverKind, instanceId, pendingInstall, providerInstallView]);
  useEffect(() => {
    if (!pendingInstall) return;
    const timeout = window.setTimeout(() => setPendingInstall(false), PENDING_INSTALL_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [pendingInstall]);
  // A just-added account that turns out to be signed in already (a folder
  // that held a login) has nothing to start; neither does one that never
  // gets as far as offering sign-in.
  const autoSignInMoot = autoSignIn && agentStatus.kind === "ready";
  useEffect(() => {
    if (!autoSignIn) return;
    if (autoSignInMoot) {
      onAutoSignInSettled?.(instanceId);
      return;
    }
    const timeout = window.setTimeout(
      () => onAutoSignInSettled?.(instanceId),
      AUTO_SIGN_IN_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [autoSignIn, autoSignInMoot, instanceId, onAutoSignInSettled]);

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomModels = (next: ReadonlyArray<string>) => {
    const nextConfig = nextConfigBlobWithValue(instance.config, "customModels", [...next]);
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  const updateFallbackModels = (next: ReadonlyArray<string>) => {
    const nextConfig = nextConfigBlobWithOptionalStringArray(
      instance.config,
      "fallbackModel",
      next,
    );
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const iconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
  ) : null;

  const tone: AgentRowTone =
    agentStatus.kind === "problem"
      ? "error"
      : agentStatus.kind === "needsSignIn" || agentStatus.kind === "notInstalled"
        ? "warning"
        : "none";
  const needs = driverOption?.needs ?? "";
  // Healthy rows say who is signed in and nothing more; a broken one keeps the
  // first sentence of the server's diagnosis.
  // Without an Install button the full guide (with its link) is the only way
  // forward, so it stays whole.
  const showFullGuide = agentStatus.kind === "notInstalled" && !providerInstallView;
  const diagnosis =
    tone === "none"
      ? null
      : showFullGuide
        ? (summary.detail ?? null)
        : firstSentenceOf(summary.detail);
  // A signed-out row with a Sign in button says what the agent needs, the same
  // words setup uses; the server's terminal instructions would only compete
  // with the button next to them.
  const statusNode: ReactNode =
    agentStatus.kind === "off" ||
    agentStatus.kind === "installing" ||
    (agentStatus.kind === "needsSignIn" && showRowSignIn) ? (
      agentStatusLine({ status: agentStatus, needs, snapshot: liveProvider })
    ) : agentStatus.kind === "checking" ? (
      "Checking…"
    ) : hasAuthenticatedEmail ? (
      <span className="inline-flex min-w-0 items-center gap-x-1">
        <ProviderAuthEmail email={authEmail} />
        {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
        <ProviderAuthEmail email={usageEmailForDisplay} separator prefix="Usage" />
      </span>
    ) : showFullGuide ? (
      <span>
        {summary.headline}
        {diagnosis ? (
          <>
            {" · "}
            <LinkifiedText text={diagnosis} />
          </>
        ) : null}
      </span>
    ) : (
      <span className="inline-flex min-w-0 items-center gap-x-1">
        <span className="shrink-0">{summary.headline}</span>
        {diagnosis ? (
          <span className="min-w-0 truncate">
            · <LinkifiedText text={diagnosis} />
          </span>
        ) : null}
      </span>
    );

  const detectionLabel =
    agentStatus.kind === "off" ? agentDetectionLabel(agentStatus.detection, computerLabel) : null;
  const actionsNode: ReactNode =
    agentStatus.kind === "off" ? (
      <>
        {detectionLabel ? (
          <span className="text-xs text-muted-foreground/62">{detectionLabel}</span>
        ) : null}
        {showPendingInstall ? (
          <span className="text-xs text-muted-foreground">Starting install…</span>
        ) : offAgentAction(agentStatus.detection) === "install" ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Install ${displayName}`}
            onClick={() => {
              setPendingInstall(true);
              void onEnabledChange(true).catch(() => setPendingInstall(false));
            }}
          >
            Install
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Turn on ${displayName}`}
            onClick={() => void onEnabledChange(true)}
          >
            Turn on
          </Button>
        )}
      </>
    ) : providerInstallView && driverKind ? (
      <ProviderInstallAction
        instanceId={instanceId}
        driverKind={driverKind}
        displayName={displayName}
        view={providerInstallView}
        statusClassName="max-w-64"
      />
    ) : showRowSignIn ? (
      <ProviderSignInAction
        instanceId={instanceId}
        displayName={displayName}
        autoStart={autoSignIn}
        onStarted={() => {
          setDetailsSection("account");
          onExpandedChange(true);
          if (autoSignIn) onAutoSignInSettled?.(instanceId);
        }}
      />
    ) : showPendingInstall ? (
      <span className="text-xs text-muted-foreground">Starting install…</span>
    ) : usagePresentation && agentStatus.kind === "ready" ? (
      <ProviderUsageMeter
        usage={usagePresentation}
        displayName={displayName}
        onResetAccountUsage={onResetAccountUsage}
        accountUsageResetInFlight={accountUsageResetInFlight}
      />
    ) : null;

  const versionExtraNode = (
    <>
      {String(instanceId) !== String(instance.driver) && !instance.displayName?.trim() ? (
        <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {enabled && versionAdvisory && updateControls.candidate ? (
        <ProviderUpdatePopover
          liveProvider={liveProvider}
          displayName={displayName}
          controls={updateControls}
          trigger={
            <AgentUpdateTag
              version={updateControls.candidate.versionAdvisory.latestVersion}
              aria-label={`Update ${displayName} to ${updateControls.candidate.versionAdvisory.latestVersion}`}
            />
          }
        />
      ) : null}
    </>
  );

  const availableDetailsSections: ReadonlyArray<ProviderDetailsSection> = [
    ...(terminalLoginCommand ? (["account"] as const) : []),
    ...(usagePresentation ? (["usage"] as const) : []),
    ...(driverOption !== undefined ? (["models"] as const) : []),
    "configuration",
  ];
  const activeDetailsSection = availableDetailsSections.includes(detailsSection)
    ? detailsSection
    : (availableDetailsSections[0] ?? "configuration");

  return (
    <AgentRow
      data-testid="provider-instance-row"
      data-provider-instance-id={String(instanceId)}
      data-agent-status={agentStatus.kind}
      icon={iconNode}
      name={displayName}
      version={enabled ? versionLabel : null}
      versionExtra={versionExtraNode}
      status={statusNode}
      wrapStatus={showFullGuide}
      tone={enabled ? tone : "none"}
      actions={actionsNode}
      expanded={isExpanded}
      onToggle={() => onExpandedChange(!isExpanded)}
      trailing={
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground data-[pressed]:bg-transparent"
          onClick={() => onExpandedChange(!isExpanded)}
          aria-label={`Toggle ${displayName} details`}
          aria-expanded={isExpanded}
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
          />
        </Button>
      }
    >
      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="px-4 sm:px-5">
            <ProviderDetailsNav
              sections={availableDetailsSections}
              activeSection={activeDetailsSection}
              onSectionChange={setDetailsSection}
            />
          </div>

          {activeDetailsSection === "usage" && usagePresentation ? (
            <div className="px-4 py-4 sm:px-5">
              <ProviderUsageDashboard
                usage={usagePresentation}
                displayName={displayName}
                onResetAccountUsage={onResetAccountUsage}
                accountUsageResetInFlight={accountUsageResetInFlight}
              />
              {usagePresentation.tokenUsage?.scope === "local" ? (
                <div className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  This history is from the paired computer.{" "}
                  <Link className="text-foreground hover:text-primary-readable" to="/usage">
                    View all machines
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeDetailsSection === "account" && terminalLoginCommand ? (
            <div className="space-y-0">
              <ProviderAccountSignInSection
                instanceId={instanceId}
                driverKind={driverKind}
                displayName={displayName}
                liveProvider={liveProvider}
                terminalLoginCommand={terminalLoginCommand}
                idPrefix={`provider-instance-${instanceId}`}
                environment={instance.environment ?? []}
                onEnvironmentChange={updateEnvironment}
                signInHandoffActive={signInHandoffActive}
                {...(driverKind === CLAUDE_DRIVER_KIND ? { claudeSetupTokenCommand } : {})}
              />
            </div>
          ) : null}

          {activeDetailsSection === "models" && driverOption !== undefined ? (
            <ProviderModelsSection
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              fallbackModels={fallbackModels}
              modelOrder={modelOrder}
              onChange={updateCustomModels}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onFallbackModelsChange={
                driverKind === "claudeAgent" ? updateFallbackModels : undefined
              }
              onModelOrderChange={onModelOrderChange}
            />
          ) : null}

          {activeDetailsSection === "configuration" ? (
            <div className="space-y-0">
              <ProviderConfigurationSection
                title="Appearance"
                description="Names and colors used to distinguish provider instances in Threadlines."
              >
                <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                  <span className="text-xs font-medium text-foreground">Display name</span>
                  <DraftInput
                    id={`provider-instance-${instanceId}-display-name`}
                    className="mt-1.5"
                    value={instance.displayName ?? ""}
                    onCommit={updateDisplayName}
                    placeholder={driverOption?.label ?? "Instance label"}
                    spellCheck={false}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Optional label shown in the provider list.
                  </span>
                </label>

                <div className="mt-4">
                  <ProviderAccentColorPicker
                    displayName={displayName}
                    value={accentColor}
                    onCommit={updateAccentColor}
                  />
                </div>
              </ProviderConfigurationSection>

              {providerSettingsFieldGroups.runtimeFields.length > 0 ? (
                <ProviderConfigurationSection
                  title="Command & Launch"
                  description="Executable and launch arguments used when this provider starts a session."
                >
                  <ProviderSettingsFields
                    fields={providerSettingsFieldGroups.runtimeFields}
                    value={instance.config}
                    idPrefix={`provider-instance-${instanceId}`}
                    variant="group"
                    onChange={updateConfig}
                  />
                </ProviderConfigurationSection>
              ) : null}

              {driverOption ? (
                <ProviderAdvancedConfigurationSection
                  fields={providerSettingsFieldGroups.advancedFields}
                  value={instance.config}
                  idPrefix={`provider-instance-${instanceId}`}
                  environment={instance.environment ?? []}
                  reservedEnvironmentNames={reservedEnvironmentNames}
                  onChange={updateConfig}
                  onEnvironmentChange={updateEnvironment}
                />
              ) : (
                <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                  <p className="text-xs text-muted-foreground">
                    This instance uses a driver (
                    <code className="text-foreground">{String(instance.driver)}</code>) that is not
                    shipped with the current build. Configuration values are preserved but cannot be
                    edited from this surface.
                  </p>
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/60 px-3 py-2">
            {onResetDefaults ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={onResetDefaults}
              >
                <RotateCcwIcon className="size-3" />
                Reset to defaults
              </Button>
            ) : null}
            {addAccount && !addingAccount ? (
              <Button
                size="xs"
                variant="ghost"
                className="mr-auto text-muted-foreground hover:text-foreground"
                onClick={() => setAddingAccount(true)}
              >
                <PlusIcon className="size-3" />
                Add another {addAccount.agentName} account
              </Button>
            ) : null}
            {onRemoveAccount ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={onRemoveAccount}
              >
                <Trash2Icon className="size-3" />
                Remove account
              </Button>
            ) : onDelete ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={onDelete}
                aria-label={`Delete provider instance ${instanceId}`}
              >
                <Trash2Icon className="size-3" />
                Delete
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void onEnabledChange(!enabled)}
            >
              {enabled ? `Turn off ${displayName}` : `Turn on ${displayName}`}
            </Button>
          </div>
          {addAccount && addingAccount && driverKind ? (
            <AddProviderAccountForm
              driverKind={driverKind}
              agentName={addAccount.agentName}
              existingNames={addAccount.existingNames}
              existingColors={addAccount.existingColors}
              onCancel={() => setAddingAccount(false)}
              onAdded={(newInstanceId, startSignIn) => {
                setAddingAccount(false);
                addAccount.onAdded(newInstanceId, startSignIn);
              }}
            />
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </AgentRow>
  );
}
