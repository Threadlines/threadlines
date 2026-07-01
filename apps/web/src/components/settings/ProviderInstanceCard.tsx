"use client";

import {
  ArrowUpCircleIcon,
  AlertCircleIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  LoaderIcon,
  PipetteIcon,
  PlusIcon,
  RotateCcwIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
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

import { cn } from "../../lib/utils";
import {
  deriveProviderAccountUsagePresentationForProvider,
  type ProviderAccountUsagePresentation,
} from "../../lib/providerUsage";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import type { ProviderRateLimitResetCreditRequest } from "../ProviderRateLimitResetCredit";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const PROVIDER_ACCENT_SWATCHES = ["#00347D", "#16a34a", "#ea580c", "#dc2626", "#7c3aed"] as const;
const PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS = 700;

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const RUNTIME_PROVIDER_CONFIG_FIELD_KEYS = new Set([
  "binaryPath",
  "launchArgs",
  "serverUrl",
  "serverPassword",
  "apiEndpoint",
]);

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

export interface ProviderAccountTerminalCommandRequest {
  readonly title: string;
  readonly command: string;
  readonly terminalId: string;
}

function providerAccountTerminalId(driverKind: ProviderDriverKind | null): string {
  const driverKey = driverKind ? String(driverKind).replace(/[^A-Za-z0-9_-]/g, "-") : "provider";
  return `auth-${driverKey}`;
}

function truncateProviderUpdateOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS).trimEnd()}...`;
}

function isProviderUpdateProcessLockMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("claude") &&
    normalized.includes("windows") &&
    normalized.includes("replace") &&
    normalized.includes("executable")
  );
}

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

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./~:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildClaudeSetupTokenCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  const homePath = input.homePath.trim();
  const command = `${shellWord(binaryPath)} setup-token`;
  return homePath ? `HOME=${shellWord(homePath)} ${command}` : command;
}

export function buildClaudeAuthLoginCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  const homePath = input.homePath.trim();
  const command = `${shellWord(binaryPath)} auth login`;
  return homePath ? `HOME=${shellWord(homePath)} ${command}` : command;
}

export function buildCodexLoginCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "codex";
  const authHomePath = input.shadowHomePath.trim() || input.homePath.trim();
  const command = `${shellWord(binaryPath)} login`;
  return authHomePath ? `CODEX_HOME=${shellWord(authHomePath)} ${command}` : command;
}

export interface ClaudeLongLivedOAuthTokenState {
  readonly configured: boolean;
  readonly redacted: boolean;
  readonly value: string;
}

export function deriveClaudeLongLivedOAuthTokenState(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ClaudeLongLivedOAuthTokenState {
  const variable = environment.find((entry) => entry.name === CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV);
  if (!variable) {
    return { configured: false, redacted: false, value: "" };
  }
  const redacted = variable.valueRedacted === true;
  const value = redacted ? "" : variable.value;
  return {
    configured: redacted || value.trim().length > 0,
    redacted,
    value,
  };
}

export function sanitizeClaudeLongLivedOAuthTokenInput(value: string): string {
  const trimmed = value.trim();
  const assignmentMatch = trimmed.match(/(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+)$/u);
  const token = assignmentMatch?.[1]?.trim() ?? trimmed;
  return token
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\[nr]/g, "")
    .replace(/\s+/g, "");
}

export function upsertClaudeLongLivedOAuthTokenEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  token: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = sanitizeClaudeLongLivedOAuthTokenInput(token);
  const nextEnvironment: ProviderInstanceEnvironmentVariable[] = [];
  let inserted = false;

  for (const variable of environment) {
    if (variable.name !== CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV) {
      nextEnvironment.push(variable);
      continue;
    }
    if (trimmed.length === 0 || inserted) {
      continue;
    }
    nextEnvironment.push({
      name: CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
      value: trimmed,
      sensitive: true,
      valueRedacted: false,
    });
    inserted = true;
  }

  if (trimmed.length > 0 && !inserted) {
    nextEnvironment.push({
      name: CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
      value: trimmed,
      sensitive: true,
      valueRedacted: false,
    });
  }

  return nextEnvironment;
}

export function removeClaudeLongLivedOAuthTokenEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return environment.filter((variable) => variable.name !== CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV);
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
  readonly setupCommand: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  readonly onRunTerminalCommand?:
    | ((request: ProviderAccountTerminalCommandRequest) => Promise<void> | void)
    | undefined;
  readonly terminalCommandRequest?: ProviderAccountTerminalCommandRequest | undefined;
}) {
  const tokenState = deriveClaudeLongLivedOAuthTokenState(props.environment);
  const tokenInputId = `${props.idPrefix}-claude-oauth-token`;
  const [tokenDraft, setTokenDraft] = useState("");
  const [isRunningSetupCommand, setIsRunningSetupCommand] = useState(false);
  const sanitizedTokenDraft = sanitizeClaudeLongLivedOAuthTokenInput(tokenDraft);
  const tokenDraftHasValue = tokenDraft.trim().length > 0;
  const tokenDraftWillBeSanitized = tokenDraftHasValue && sanitizedTokenDraft !== tokenDraft.trim();
  const { copyToClipboard, isCopied } = useCopyToClipboard<"setup-token-command">({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Claude token setup command copied",
        description: "Run it in a terminal, then paste the generated token here.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy Claude token setup command",
          description: error.message,
        }),
      );
    },
  });
  const canRunSetupCommand =
    props.onRunTerminalCommand !== undefined && props.terminalCommandRequest !== undefined;
  const runSetupCommand = async () => {
    if (!props.onRunTerminalCommand || !props.terminalCommandRequest) {
      return;
    }
    setIsRunningSetupCommand(true);
    try {
      await props.onRunTerminalCommand(props.terminalCommandRequest);
    } finally {
      setIsRunningSetupCommand(false);
    }
  };
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
    <div className="grid gap-3 border-t border-border/50 pt-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-semibold text-foreground">Long-lived token</p>
        <p className="text-xs text-muted-foreground">
          Keeps Claude sessions signed in. Usage still comes from Claude's normal sign-in.
        </p>
      </div>
      <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Setup command</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {canRunSetupCommand ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={isRunningSetupCommand}
                onClick={() => void runSetupCommand()}
              >
                {isRunningSetupCommand ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <TerminalIcon className="size-3" />
                )}
                {isRunningSetupCommand ? "Opening" : "Run"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => copyToClipboard(props.setupCommand, "setup-token-command")}
            >
              <CopyIcon className="size-3" />
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <code className="block overflow-x-auto whitespace-nowrap rounded border border-border/60 bg-background/80 px-2 py-1.5 font-mono text-[11px] text-foreground/85">
          {props.setupCommand}
        </code>
        <p className="text-xs text-muted-foreground">
          Run this in a terminal, finish the browser authorization, then paste the generated token
          below.
        </p>
      </div>
      <label className="block" htmlFor={tokenInputId}>
        <span className="text-xs font-medium text-foreground">OAuth token</span>
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
              tokenState.configured ? "Stored secret - enter a new value to replace" : "Paste token"
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
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant={tokenState.configured ? "success" : "secondary"} size="sm">
          {tokenState.configured ? "Configured" : "Not configured"}
        </Badge>
        {tokenState.configured ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() =>
              props.onChange(removeClaudeLongLivedOAuthTokenEnvironment(props.environment))
            }
          >
            Clear token
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CopyableProviderCommand(props: {
  readonly title: string;
  readonly command: string;
  readonly description: string;
  readonly copiedTitle: string;
  readonly errorTitle: string;
  readonly runLabel?: string | undefined;
  readonly onRunTerminalCommand?:
    | ((request: ProviderAccountTerminalCommandRequest) => Promise<void> | void)
    | undefined;
  readonly terminalCommandRequest?: ProviderAccountTerminalCommandRequest | undefined;
}) {
  const [isRunningCommand, setIsRunningCommand] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<"command">({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: props.copiedTitle,
        description: "Run it in a terminal when you need to refresh this account.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: props.errorTitle,
          description: error.message,
        }),
      );
    },
  });
  const canRunCommand =
    props.onRunTerminalCommand !== undefined && props.terminalCommandRequest !== undefined;
  const runCommand = async () => {
    if (!props.onRunTerminalCommand || !props.terminalCommandRequest) {
      return;
    }
    setIsRunningCommand(true);
    try {
      await props.onRunTerminalCommand(props.terminalCommandRequest);
    } finally {
      setIsRunningCommand(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{props.title}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {canRunCommand ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={isRunningCommand}
              onClick={() => void runCommand()}
            >
              {isRunningCommand ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <TerminalIcon className="size-3" />
              )}
              {isRunningCommand ? "Opening" : (props.runLabel ?? "Run")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copyToClipboard(props.command, "command")}
          >
            <CopyIcon className="size-3" />
            {isCopied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      <code className="block overflow-x-auto whitespace-nowrap rounded border border-border/60 bg-background/80 px-2 py-1.5 font-mono text-[11px] text-foreground/85">
        {props.command}
      </code>
      <p className="text-xs text-muted-foreground">{props.description}</p>
    </div>
  );
}

function providerAuthBadge(input: ServerProvider["auth"] | undefined): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary";
} {
  switch (input?.status) {
    case "authenticated":
      return { label: "Authenticated", variant: "success" };
    case "unauthenticated":
      return { label: "Needs sign in", variant: "warning" };
    default:
      return { label: "Checking", variant: "secondary" };
  }
}

function ProviderAccountSignInSection(props: {
  readonly driverKind: ProviderDriverKind | null;
  readonly displayName: string;
  readonly liveProvider: ServerProvider | undefined;
  readonly authEmail: string | undefined;
  readonly terminalLoginCommand: string;
  readonly idPrefix: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onEnvironmentChange: (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => void;
  readonly claudeSetupTokenCommand?: string | undefined;
  readonly onRunTerminalCommand?:
    | ((request: ProviderAccountTerminalCommandRequest) => Promise<void> | void)
    | undefined;
}) {
  const authBadge = providerAuthBadge(props.liveProvider?.auth);
  const authLabel = props.liveProvider?.auth.label ?? props.liveProvider?.auth.type ?? null;
  const usageEmail = props.liveProvider?.auth.usageEmail;
  const usageEmailForDisplay =
    usageEmail?.trim() && usageEmail !== props.authEmail ? usageEmail : undefined;
  const isClaude = props.driverKind === CLAUDE_DRIVER_KIND;
  const hasClaudeCredentialOverride =
    isClaude && hasClaudeCredentialOverrideEnvironment(props.environment);
  const claudeLongLivedTokenConfigured =
    isClaude && deriveClaudeLongLivedOAuthTokenState(props.environment).configured;

  return (
    <ProviderConfigurationSection
      title="Account & Sign-in"
      description="Shows whether this provider is ready and gives the right terminal command to refresh it."
    >
      <div className="grid gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={authBadge.variant} size="sm">
            {authBadge.label}
          </Badge>
          <ProviderAuthEmail email={props.authEmail} prefix="Account" />
          {authLabel ? <span className="text-xs text-muted-foreground">· {authLabel}</span> : null}
          <ProviderAuthEmail email={usageEmailForDisplay} separator prefix="Usage" />
        </div>

        <CopyableProviderCommand
          title="Terminal sign-in"
          command={props.terminalLoginCommand}
          description={
            isClaude && claudeLongLivedTokenConfigured
              ? "Refreshes Claude's normal sign-in so usage reporting can work."
              : `Run this when ${props.displayName} reports that the account is signed out.`
          }
          copiedTitle={`${props.displayName} sign-in command copied`}
          errorTitle={`Could not copy ${props.displayName} sign-in command`}
          runLabel="Sign in"
          onRunTerminalCommand={props.onRunTerminalCommand}
          terminalCommandRequest={{
            title: `${props.displayName} sign-in`,
            command: props.terminalLoginCommand,
            terminalId: providerAccountTerminalId(props.driverKind),
          }}
        />

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
            setupCommand={props.claudeSetupTokenCommand}
            environment={props.environment}
            onChange={props.onEnvironmentChange}
            onRunTerminalCommand={props.onRunTerminalCommand}
            terminalCommandRequest={{
              title: "Claude token setup",
              command: props.claudeSetupTokenCommand,
              terminalId: providerAccountTerminalId(props.driverKind),
            }}
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

const PROVIDER_CARD_TOGGLE_IGNORE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='switch']",
  "[data-provider-card-toggle-ignore]",
].join(",");

function shouldIgnoreProviderCardToggle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PROVIDER_CARD_TOGGLE_IGNORE_SELECTOR) !== null;
}

function formatResetCreditAvailability(availableCount: number): string {
  if (availableCount <= 0) return "None available";
  return availableCount === 1 ? "1 available" : `${availableCount} available`;
}

function formatResetCreditDetail(detail: string): string {
  return detail === "usable for 30 days after grant" ? "30-day grant window" : detail;
}

function ProviderUsageSummaryBar(props: {
  readonly usageLabel: string;
  readonly label: string;
  readonly detail: string;
  readonly usedPercent: number;
  readonly reachedLimit: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className="min-w-10 font-medium text-foreground">{props.label}</span>
        <span className="text-muted-foreground">
          {props.usedPercent}% used{props.detail ? ` - ${props.detail}` : ""}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${props.usageLabel} ${props.label} ${props.usedPercent}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.usedPercent}
        className="h-1.5 overflow-hidden rounded-full bg-muted/70"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            props.reachedLimit || props.usedPercent >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${props.usedPercent}%` }}
        />
      </div>
    </div>
  );
}

function ProviderUsageSummary(props: {
  readonly usage: ProviderAccountUsagePresentation;
  readonly displayName: string;
  readonly instanceId: ProviderInstanceId;
  readonly onResetAccountUsage?:
    | ((request: ProviderRateLimitResetCreditRequest) => void)
    | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
}) {
  const hasLimitSummary =
    props.usage.windows.length > 0 ||
    props.usage.spendControl !== undefined ||
    props.usage.resetCredits !== undefined;
  if (!hasLimitSummary) return null;

  const canReset =
    props.onResetAccountUsage !== undefined && (props.usage.resetCredits?.availableCount ?? 0) > 0;

  return (
    <div className="mt-2 max-w-md space-y-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">{props.usage.label}</span>
      </div>
      <div className="space-y-1.5 pl-5">
        {props.usage.resetCredits ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="min-w-10 font-medium text-foreground">Resets</span>
            <span>{formatResetCreditAvailability(props.usage.resetCredits.availableCount)}</span>
            <span aria-hidden>·</span>
            <span>{formatResetCreditDetail(props.usage.resetCredits.detail)}</span>
            {canReset ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="ml-1 h-5 gap-1 rounded px-1.5 text-[10px] leading-none [&_svg]:size-2.5"
                disabled={props.accountUsageResetInFlight === true}
                onClick={() =>
                  props.onResetAccountUsage?.({
                    instanceId: props.instanceId,
                    availableCount: props.usage.resetCredits?.availableCount ?? 0,
                  })
                }
                aria-label={`Use one reset credit for ${props.displayName} usage`}
              >
                <RotateCcwIcon className="size-3" />
                {props.accountUsageResetInFlight ? "Using" : "Use reset"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {props.usage.spendControl ? (
          <ProviderUsageSummaryBar
            usageLabel={props.usage.label}
            label={props.usage.spendControl.label}
            detail={props.usage.spendControl.detail}
            usedPercent={props.usage.spendControl.usedPercent}
            reachedLimit={props.usage.spendControl.reachedLimit}
          />
        ) : null}
        {props.usage.windows.map((window) => (
          <ProviderUsageSummaryBar
            key={window.key}
            usageLabel={props.usage.label}
            label={window.label}
            detail={window.detail}
            usedPercent={window.usedPercent}
            reachedLimit={window.reachedLimit}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderDetailsNav(props: {
  readonly sections: ReadonlyArray<ProviderDetailsSection>;
  readonly activeSection: ProviderDetailsSection;
  readonly onSectionChange: (section: ProviderDetailsSection) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border/70 bg-muted/20 p-0.5">
      {props.sections.map((section) => (
        <button
          key={section}
          type="button"
          className={cn(
            "h-7 cursor-pointer rounded px-2.5 text-xs transition-colors",
            props.activeSection === section
              ? "bg-background text-foreground shadow-xs"
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
  readonly onExpandedChange: (open: boolean) => void;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete button entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
  readonly onResolveUpdateBlockers?: (() => void) | undefined;
  readonly isResolvingUpdateBlockers?: boolean | undefined;
  readonly onResetAccountUsage?:
    | ((request: ProviderRateLimitResetCreditRequest) => void)
    | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
  readonly onRunTerminalCommand?:
    | ((request: ProviderAccountTerminalCommandRequest) => Promise<void> | void)
    | undefined;
}

/**
 * A single configured provider-instance row in the Providers settings
 * section. Used for every row — both the built-in default instance for a
 * driver (rendered with `onDelete` omitted) and user-authored custom
 * instances (`onDelete` supplied). The only UI difference between the two
 * is whether the trash button is visible; every other field (display
 * name, config fields, models) behaves identically.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field; the server's registry consults this at `entry.enabled ?? true`
 *     before materializing the instance, and the probe also checks its
 *     driver-specific `config.enabled`. We treat the envelope flag as the
 *     single source of truth from the UI — built-in cards used to write
 *     the inner flag, but on the promotion-to-instance path every edit
 *     flows through the envelope.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isExpanded,
  onExpandedChange,
  onUpdate,
  onDelete,
  headerAction,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
  onResolveUpdateBlockers,
  isResolvingUpdateBlockers = false,
  onResetAccountUsage,
  accountUsageResetInFlight,
  onRunTerminalCommand,
}: ProviderInstanceCardProps) {
  const enabled = instance.enabled ?? true;
  // The server-reported status wins when present; otherwise fall back to
  // "disabled"/"warning" based on the local `enabled` flag so the dot
  // reflects the persisted intent even before the first probe completes.
  const statusKey: ProviderStatusKey =
    (liveProvider?.status as ProviderStatusKey | undefined) ?? (enabled ? "warning" : "disabled");
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const rawSummary = getProviderSummary(liveProvider);
  const authEmail = liveProvider?.auth.email;
  const usageEmail = liveProvider?.auth.usageEmail;
  const usageEmailForDisplay =
    usageEmail?.trim() && usageEmail !== authEmail ? usageEmail : undefined;
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const summary = rawSummary;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const providerUpdateState = liveProvider?.updateState ?? null;
  const providerUpdateMessage = providerUpdateState?.message?.trim() ?? "";
  const providerUpdateOutput = providerUpdateState?.output?.trim() ?? "";
  const providerUpdateIsProcessLock =
    providerUpdateState?.status === "failed" &&
    isProviderUpdateProcessLockMessage(providerUpdateMessage);
  const providerUpdatePanelMessage = providerUpdateIsProcessLock
    ? "Claude is running in the background, so Windows cannot replace claude.exe. Stop those Claude processes, then run the update again."
    : providerUpdateMessage;
  const canResolveProviderUpdateBlockers =
    providerUpdateIsProcessLock && onResolveUpdateBlockers !== undefined;
  const usagePresentation = deriveProviderAccountUsagePresentationForProvider(liveProvider);
  const hasTokenUsageDetails = usagePresentation?.tokenUsage !== undefined;
  const [detailsSection, setDetailsSection] = useState<ProviderDetailsSection>("account");
  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() ||
    driverOption?.label ||
    (driverKind ? PROVIDER_DISPLAY_NAMES[driverKind] : undefined) ||
    String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
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
      });
    }
    return null;
  }, [driverKind, instance.config]);
  const reservedEnvironmentNames = useMemo(
    () =>
      driverKind === CLAUDE_DRIVER_KIND
        ? new Set<string>([CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV])
        : undefined,
    [driverKind],
  );

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    onUpdate({ ...instance, enabled: value });
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

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      statusDotClassName={statusStyle.dot}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          statusStyle.dot,
        )}
        aria-hidden
      />
    </span>
  ) : (
    <span className={cn("size-2 shrink-0 rounded-full", statusStyle.dot)} />
  );

  const titleHeadNode = (
    <>
      {titleIconNode}
      <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
        {displayName}
      </h3>
      {String(instanceId) !== String(instance.driver) ? (
        <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
    </>
  );

  const titleTailNode = (
    <>
      {headerAction ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {headerAction}
        </span>
      ) : null}
      {onDelete ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label={`Delete provider instance ${instanceId}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete instance</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </>
  );

  const availableDetailsSections: ReadonlyArray<ProviderDetailsSection> = [
    ...(terminalLoginCommand ? (["account"] as const) : []),
    ...(hasTokenUsageDetails ? (["usage"] as const) : []),
    ...(driverOption !== undefined ? (["models"] as const) : []),
    "configuration",
  ];
  const activeDetailsSection = availableDetailsSections.includes(detailsSection)
    ? detailsSection
    : (availableDetailsSections[0] ?? "configuration");

  const authRowNode = (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground/80">
      {hasAuthenticatedEmail ? (
        <>
          <span>Authenticated as</span>
          <ProviderAuthEmail email={authEmail} />
          {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
          <ProviderAuthEmail email={usageEmailForDisplay} separator prefix="Usage" />
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
          <ProviderAuthEmail email={usageEmailForDisplay} separator prefix="Usage" />
        </>
      )}
      {summary.detail ? <span>- {summary.detail}</span> : null}
    </p>
  );

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;
  const toggleDetails = () => onExpandedChange(!isExpanded);
  const handleSummaryClick = (event: MouseEvent<HTMLDivElement>) => {
    if (shouldIgnoreProviderCardToggle(event.target)) return;
    toggleDetails();
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/75 bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
      <div
        className="cursor-pointer px-4 py-3.5 transition-colors hover:bg-muted/10 sm:px-5"
        onClick={handleSummaryClick}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {titleHeadNode}
              {versionCodeNode}
              {versionAdvisory ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className={cn(
                          "size-5 rounded-sm p-0",
                          versionAdvisory.emphasis === "strong"
                            ? "text-warning hover:text-warning"
                            : "text-primary-readable hover:text-primary-readable",
                        )}
                        aria-label="Update available — view details"
                      >
                        <ArrowUpCircleIcon className="size-3.5 [animation:bounce_2.4s_ease-in-out_infinite] motion-reduce:animate-none" />
                      </Button>
                    }
                  />
                  <PopoverPopup
                    side="bottom"
                    align="start"
                    className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
                  >
                    <div className="grid min-w-0 gap-3">
                      <div className="grid gap-0.5">
                        <p className="text-[13px] font-semibold leading-tight text-foreground">
                          Update available
                        </p>
                        <p
                          className={cn(
                            "text-xs leading-snug",
                            versionAdvisory.emphasis === "strong"
                              ? "text-warning"
                              : "text-muted-foreground",
                          )}
                        >
                          {versionAdvisory.detail}
                        </p>
                      </div>
                      {providerUpdateMessage ? (
                        <div
                          className={cn(
                            "grid gap-2 rounded-md border px-2.5 py-2 text-xs leading-snug",
                            providerUpdateIsProcessLock
                              ? "border-warning/35 bg-warning/8 text-warning"
                              : providerUpdateState?.status === "failed"
                                ? "border-destructive/35 bg-destructive/8 text-destructive"
                                : providerUpdateState?.status === "unchanged"
                                  ? "border-warning/35 bg-warning/8 text-warning"
                                  : "border-border/70 bg-muted/40 text-muted-foreground",
                          )}
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            <p className="min-w-0">{providerUpdatePanelMessage}</p>
                          </div>
                          {providerUpdateState?.status === "failed" &&
                          providerUpdateOutput &&
                          !providerUpdateIsProcessLock ? (
                            <ScrollArea scrollFade className="max-h-24 min-w-0 rounded-sm">
                              <code className="block whitespace-pre-wrap break-words rounded-sm bg-background/55 p-2 font-mono text-[10px] leading-snug text-foreground/80">
                                {truncateProviderUpdateOutput(providerUpdateOutput)}
                              </code>
                            </ScrollArea>
                          ) : null}
                          {canResolveProviderUpdateBlockers ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              className="w-full border-warning/35 bg-background/45 text-warning hover:bg-warning/10 hover:text-warning"
                              disabled={isResolvingUpdateBlockers || isUpdating}
                              onClick={onResolveUpdateBlockers}
                            >
                              {isResolvingUpdateBlockers ? (
                                <LoaderIcon className="animate-spin" />
                              ) : (
                                <XIcon />
                              )}
                              {isResolvingUpdateBlockers
                                ? "Stopping Claude"
                                : "Stop Claude processes"}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {onRunUpdate ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          className="w-full"
                          disabled={isUpdating || isResolvingUpdateBlockers}
                          onClick={onRunUpdate}
                        >
                          {isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
                          {isUpdating ? "Updating" : "Update now"}
                        </Button>
                      ) : null}
                      {onRunUpdate && updateCommand ? (
                        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          <span aria-hidden className="h-px flex-1 bg-border" />
                          or, update manually using
                          <span aria-hidden className="h-px flex-1 bg-border" />
                        </div>
                      ) : null}
                      {updateCommand ? (
                        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                          <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                            <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                              {updateCommand}
                            </code>
                          </ScrollArea>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    copyToClipboard(updateCommand, {
                                      providerName: displayName,
                                    })
                                  }
                                  aria-label="Copy update command"
                                >
                                  <CopyIcon className="size-3" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Copy command</TooltipPopup>
                          </Tooltip>
                        </div>
                      ) : null}
                    </div>
                  </PopoverPopup>
                </Popover>
              ) : null}
              {titleTailNode}
            </div>
            {authRowNode}
            {usagePresentation ? (
              <ProviderUsageSummary
                usage={usagePresentation}
                displayName={displayName}
                instanceId={instanceId}
                onResetAccountUsage={onResetAccountUsage}
                accountUsageResetInFlight={accountUsageResetInFlight}
              />
            ) : null}
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground data-[pressed]:bg-transparent"
              onClick={toggleDetails}
              aria-label={`Toggle ${displayName} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
              aria-label={`Enable ${displayName}`}
            />
          </div>
        </div>
      </div>

      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
            <ProviderDetailsNav
              sections={availableDetailsSections}
              activeSection={activeDetailsSection}
              onSectionChange={setDetailsSection}
            />
          </div>

          {activeDetailsSection === "usage" && usagePresentation ? (
            <div className="border-t border-border/60 px-4 py-4 sm:px-5">
              <ProviderUsageDashboard
                usage={usagePresentation}
                displayName={displayName}
                instanceId={instanceId}
                showLimits={false}
                onResetAccountUsage={onResetAccountUsage}
                accountUsageResetInFlight={accountUsageResetInFlight}
              />
            </div>
          ) : null}

          {activeDetailsSection === "account" && terminalLoginCommand ? (
            <div className="space-y-0">
              <ProviderAccountSignInSection
                driverKind={driverKind}
                displayName={displayName}
                liveProvider={liveProvider}
                authEmail={authEmail}
                terminalLoginCommand={terminalLoginCommand}
                idPrefix={`provider-instance-${instanceId}`}
                environment={instance.environment ?? []}
                onEnvironmentChange={updateEnvironment}
                onRunTerminalCommand={onRunTerminalCommand}
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
