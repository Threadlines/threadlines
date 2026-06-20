"use client";

import {
  ArrowUpCircleIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  LoaderIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderDriverKind,
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  ProviderSettingsFields,
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

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
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
          aria-label={`Accent color for ${props.displayName}`}
          className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
        />
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
            const selected = draftColor?.toLowerCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={cn(
                  "size-6 cursor-pointer rounded-full border transition",
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

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

  useEffect(() => {
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

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
    props.onChange(published);
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
    <ProviderConfigurationSection
      title="Environment"
      description="Variables passed to this provider instance. Sensitive values stay stored separately."
      action={
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
      }
    >
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
    </ProviderConfigurationSection>
  );
}

type ProviderDetailsSection = "usage" | "models" | "configuration";

const PROVIDER_DETAILS_SECTION_LABELS: Record<ProviderDetailsSection, string> = {
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
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  if (props.fields.length === 0) return null;

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
              Home paths and low-level provider process settings.
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
          <div className="pt-3">
            <ProviderSettingsFields
              fields={props.fields}
              value={props.value}
              idPrefix={props.idPrefix}
              variant="group"
              onChange={props.onChange}
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
  readonly onResetAccountUsage?:
    | ((request: ProviderRateLimitResetCreditRequest) => void)
    | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
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
  onResetAccountUsage,
  accountUsageResetInFlight,
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
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const summary = rawSummary;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const usagePresentation = deriveProviderAccountUsagePresentationForProvider(liveProvider);
  const hasTokenUsageDetails = usagePresentation?.tokenUsage !== undefined;
  const [detailsSection, setDetailsSection] = useState<ProviderDetailsSection>("usage");
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
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
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
                      {onRunUpdate ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          className="w-full"
                          disabled={isUpdating}
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
                title="Identity"
                description="Controls how this provider appears in pickers and settings."
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
                  title="Runtime"
                  description="Process launch settings used when this provider starts a session."
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

              <ProviderEnvironmentSection
                environment={instance.environment ?? []}
                onChange={updateEnvironment}
              />

              {driverOption ? (
                <ProviderAdvancedConfigurationSection
                  fields={providerSettingsFieldGroups.advancedFields}
                  value={instance.config}
                  idPrefix={`provider-instance-${instanceId}`}
                  onChange={updateConfig}
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
