import type {
  ProviderExtensionApp,
  ProviderExtensionMcpServer,
  ProviderExtensionPluginComponent,
  ProviderExtensionPluginComponentKind,
  ProviderExtensionPluginDetail,
  ProviderExtensionProviderInventory,
  ProviderExtensionSkill,
} from "@threadlines/contracts";

export type ExtensionItemKind = "plugin" | "skill" | "mcp" | "app";

export {
  extensionMcpNeedsAuthStatus,
  extensionMcpOAuthActionIntent,
  extensionMcpOAuthActionLabel,
  type ExtensionMcpAuthStatusInput,
  type ExtensionMcpOAuthActionIntent,
} from "../../mcpAuthStatus";

export function extensionProviderDriverSortRank(driverKind: string): number {
  if (driverKind === "codex") return 0;
  if (driverKind === "claudeAgent") return 1;
  return 2;
}

const EXTENSION_BROWSER_MAX_SINGLETON_GROUP_RATIO = 0.6;

export function formatExtensionGroupLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const spaced = trimmed.replace(/[-_]+/g, " ");
  if (spaced === spaced.toUpperCase()) return spaced;
  return spaced.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export interface ExtensionPluginGroupLabelInput {
  /** The provider's own category. Present on most catalog plugins for both providers. */
  readonly category?: string | undefined;
  readonly scope?: string | undefined;
  readonly marketplaceName?: string | undefined;
  readonly remoteMarketplaceName?: string | undefined;
  readonly installPolicy?: string | undefined;
  readonly availability?: string | undefined;
  readonly isOfficial: boolean;
  readonly isLocal: boolean;
}

export function deriveExtensionPluginGroupLabel({
  category,
  scope,
  marketplaceName,
  remoteMarketplaceName,
  installPolicy,
  availability,
  isOfficial,
  isLocal,
}: ExtensionPluginGroupLabelInput): string {
  // A real category beats a derived bucket: it is what makes 2,500 catalog entries navigable.
  if (category) return formatExtensionGroupLabel(category);
  if (scope) return formatExtensionGroupLabel(scope);
  if (isOfficial) return "Official catalog";
  if (isLocal) return "Local";
  const catalogName = marketplaceName ?? remoteMarketplaceName;
  if (catalogName) return formatExtensionGroupLabel(catalogName);
  if (installPolicy) return formatExtensionGroupLabel(installPolicy);
  if (availability) return formatExtensionGroupLabel(availability);
  return "Plugins";
}

/** Display order for a plugin's component inventory. Skills first: they are what users look for. */
const PLUGIN_COMPONENT_KIND_ORDER = [
  "skill",
  "agent",
  "mcpServer",
  "hook",
  "app",
  "appTemplate",
  "scheduledTask",
  "lspServer",
] as const satisfies ReadonlyArray<ProviderExtensionPluginComponentKind>;

const PLUGIN_COMPONENT_KIND_LABELS: Record<
  ProviderExtensionPluginComponentKind,
  { readonly one: string; readonly many: string }
> = {
  skill: { one: "Skill", many: "Skills" },
  agent: { one: "Agent", many: "Agents" },
  hook: { one: "Hook", many: "Hooks" },
  mcpServer: { one: "MCP server", many: "MCP servers" },
  app: { one: "App", many: "Apps" },
  appTemplate: { one: "App template", many: "App templates" },
  scheduledTask: { one: "Scheduled task", many: "Scheduled tasks" },
  lspServer: { one: "LSP server", many: "LSP servers" },
};

/**
 * Providers namespace a bundled skill as `<plugin>:<skill>`, which reads as duplication once the
 * row already says which plugin it came from. Same treatment MCP server names get.
 */
export function formatSkillDisplayName(name: string, bundleName: string | undefined): string {
  const trimmed = name.trim();
  const bundle = bundleName?.trim();
  if (!bundle || !trimmed.toLowerCase().startsWith(`${bundle.toLowerCase()}:`)) return trimmed;
  const remainder = trimmed.slice(bundle.length + 1).trim();
  return remainder.length > 0 ? remainder : trimmed;
}

export function pluginComponentKindLabel(
  kind: ProviderExtensionPluginComponentKind,
  count: number,
): string {
  const labels = PLUGIN_COMPONENT_KIND_LABELS[kind];
  return count === 1 ? labels.one : labels.many;
}

export interface PluginComponentGroup {
  readonly kind: ProviderExtensionPluginComponentKind;
  readonly label: string;
  readonly components: ReadonlyArray<ProviderExtensionPluginComponent>;
}

export function groupPluginComponents(
  components: ReadonlyArray<ProviderExtensionPluginComponent>,
): ReadonlyArray<PluginComponentGroup> {
  return PLUGIN_COMPONENT_KIND_ORDER.flatMap((kind) => {
    const matching = components.filter((component) => component.kind === kind);
    if (matching.length === 0) return [];
    return [
      {
        kind,
        label: pluginComponentKindLabel(kind, matching.length),
        components: matching,
      },
    ];
  });
}

/** Compact token counts for dense UI: 298 -> "298", 4100 -> "4.1k", 1200000 -> "1.2m". */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens < 1000) return String(Math.round(tokens));
  const [value, suffix] = tokens < 1_000_000 ? [tokens / 1000, "k"] : [tokens / 1_000_000, "m"];
  const rounded = value.toFixed(1);
  return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}${suffix}`;
}

/**
 * A provider's plugin list is its entire catalog — Codex reports well over two thousand. Opening
 * Browse onto all of them is unusable, so an unsearched catalog shows a curated slice instead:
 * what you already have, what the provider promotes, then the most installed.
 */
const CURATED_PLUGIN_BROWSE_THRESHOLD = 60;
const CURATED_PLUGIN_BROWSE_LIMIT = 50;

export interface CuratedPluginCandidate {
  readonly featured?: boolean | undefined;
  readonly installed?: boolean | undefined;
  readonly installCount?: number | undefined;
}

export function shouldCuratePluginBrowse(totalItems: number, query: string): boolean {
  return query.trim().length === 0 && totalItems > CURATED_PLUGIN_BROWSE_THRESHOLD;
}

export function selectCuratedPlugins<T>(
  items: ReadonlyArray<T>,
  read: (item: T) => CuratedPluginCandidate,
): ReadonlyArray<T> {
  // What you already have is listed on the page above; spending discovery slots on it is what made
  // this view mostly a duplicate. Rank by what the provider promotes, then by what others install.
  const candidates = items.filter((item) => read(item).installed !== true);
  const featured = candidates.filter((item) => read(item).featured === true);
  const featuredSet = new Set(featured);
  const popular = candidates
    .filter((item) => !featuredSet.has(item))
    .toSorted((left, right) => (read(right).installCount ?? 0) - (read(left).installCount ?? 0));

  const curated = [...featured, ...popular].slice(0, CURATED_PLUGIN_BROWSE_LIMIT);
  // A catalog of only-installed plugins would otherwise curate down to nothing.
  return curated.length > 0 ? curated : items.slice(0, CURATED_PLUGIN_BROWSE_LIMIT);
}

/** Plain-text rendering of a plugin's contents, for surfaces that only have a text output slot. */
export function summarizePluginDetail(detail: ProviderExtensionPluginDetail): string {
  const heading = [detail.displayName ?? detail.name, detail.version].filter(Boolean).join(" ");
  const lines = [heading, ...(detail.description ? [detail.description] : [])];

  for (const group of groupPluginComponents(detail.components)) {
    const names = group.components.map((component) => component.name).join(", ");
    lines.push(`${group.label} (${group.components.length}): ${names}`);
  }

  const alwaysOn = detail.tokenCost?.alwaysOnTokens;
  if (alwaysOn !== undefined) {
    lines.push(`Always-on cost: ~${formatTokenCount(alwaysOn)} tok per session`);
  }

  return lines.join("\n");
}

export type PluginComponentTarget =
  | { readonly kind: "skill"; readonly skill: ProviderExtensionSkill }
  | { readonly kind: "mcp"; readonly server: ProviderExtensionMcpServer }
  | { readonly kind: "app"; readonly app: ProviderExtensionApp };

function lastNameSegment(value: string): string {
  const segments = value.split(":");
  return segments[segments.length - 1]?.trim() ?? value;
}

/**
 * Resolve a plugin component back to the inventory entry it refers to, so the detail dialog can
 * navigate to it. Returns null when the provider does not expose a matching entry.
 */
export function resolvePluginComponentTarget(
  component: ProviderExtensionPluginComponent,
  provider: Pick<ProviderExtensionProviderInventory, "skills" | "mcpServers" | "apps">,
): PluginComponentTarget | null {
  const name = component.name.trim().toLowerCase();
  if (name.length === 0) return null;

  if (component.kind === "skill") {
    const path = component.path?.trim();
    const skill =
      (path ? provider.skills.find((entry) => entry.path === path) : undefined) ??
      provider.skills.find((entry) => entry.name.trim().toLowerCase() === name);
    return skill ? { kind: "skill", skill } : null;
  }

  if (component.kind === "mcpServer") {
    const server =
      provider.mcpServers.find((entry) => entry.name.trim().toLowerCase() === name) ??
      provider.mcpServers.find(
        (entry) => lastNameSegment(entry.name).toLowerCase() === lastNameSegment(name),
      );
    return server ? { kind: "mcp", server } : null;
  }

  if (component.kind === "app") {
    const app = provider.apps.find(
      (entry) => entry.id.trim().toLowerCase() === name || entry.name.trim().toLowerCase() === name,
    );
    return app ? { kind: "app", app } : null;
  }

  return null;
}

export interface ExtensionSkillBundleLabelInput {
  readonly bundleId?: string | undefined;
  readonly bundleName?: string | undefined;
  readonly bundleDisplayName?: string | undefined;
  readonly scope?: string | undefined;
  readonly source?: string | undefined;
}

function marketplaceNameFromBundleId(bundleId: string | undefined): string | undefined {
  const marketplaceName = bundleId?.split("@").slice(1).join("@").trim();
  return marketplaceName && marketplaceName.length > 0 ? marketplaceName : undefined;
}

export function deriveExtensionSkillBundleLabel({
  bundleId,
  bundleName,
  bundleDisplayName,
  scope,
  source,
}: ExtensionSkillBundleLabelInput): string {
  const bundleTitle =
    bundleDisplayName?.trim() || bundleName?.trim() || bundleId?.split("@")[0]?.trim();
  if (bundleTitle) {
    const marketplaceName = marketplaceNameFromBundleId(bundleId);
    return marketplaceName
      ? `${formatExtensionGroupLabel(bundleTitle)} (${marketplaceName})`
      : formatExtensionGroupLabel(bundleTitle);
  }
  if (scope) return formatExtensionGroupLabel(scope);
  if (source) return formatExtensionGroupLabel(source);
  return "Skills";
}

export function deriveExtensionSkillBundleKey({
  bundleId,
  bundleName,
  scope,
  source,
}: ExtensionSkillBundleLabelInput): string {
  if (bundleId?.trim()) return `bundle:${bundleId.trim().toLowerCase()}`;
  if (bundleName?.trim()) return `bundle-name:${bundleName.trim().toLowerCase()}`;
  if (scope?.trim()) return `scope:${scope.trim().toLowerCase()}`;
  if (source?.trim()) return `source:${source.trim().toLowerCase()}`;
  return "skills";
}

export function shouldRenderExtensionBrowserGroups(
  groups: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>,
  sort: string,
): boolean {
  if (sort === "recommended" || groups.length <= 1) return false;
  const singletonGroupCount = groups.filter((group) => group.items.length === 1).length;
  const singletonGroupRatio = singletonGroupCount / groups.length;
  return (
    groups.some((group) => group.items.length > 1) &&
    singletonGroupRatio <= EXTENSION_BROWSER_MAX_SINGLETON_GROUP_RATIO
  );
}

export interface ExtensionProviderThreadProject {
  readonly environmentId: string;
  readonly id: string;
  readonly cwd: string;
}

export interface ExtensionProviderThreadCandidate {
  readonly key: string;
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly provider: string;
  readonly providerInstanceId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly sessionUpdatedAt?: string | undefined;
}

export interface ExtensionInventoryCacheKeyInput {
  readonly cwd: string;
  readonly providerInstanceId: string;
  readonly providerThreadId?: string | undefined;
}

export interface ExtensionInventoryMemoryCacheEntry<T> {
  readonly value: T;
  readonly cachedAtMs: number;
  readonly loadDurationMs: number | null;
}

export interface ExtensionInventoryMemoryCacheOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly nowMs?: () => number;
}

export function makeExtensionInventoryCacheKey({
  cwd,
  providerInstanceId,
  providerThreadId,
}: ExtensionInventoryCacheKeyInput): string | null {
  const cwdKey = normalizedCwdKey(cwd);
  const providerKey = providerInstanceId.trim();
  if (!cwdKey || !providerKey) return null;

  return JSON.stringify([cwdKey, providerKey, providerThreadId?.trim() ?? ""]);
}

export function createExtensionInventoryMemoryCache<T>({
  maxEntries,
  ttlMs,
  nowMs = () => Date.now(),
}: ExtensionInventoryMemoryCacheOptions) {
  const entries = new Map<string, ExtensionInventoryMemoryCacheEntry<T>>();
  const isFresh = (entry: ExtensionInventoryMemoryCacheEntry<T>) =>
    nowMs() - entry.cachedAtMs <= ttlMs;

  const peek = (key: string): ExtensionInventoryMemoryCacheEntry<T> | null => {
    const entry = entries.get(key);
    return entry && isFresh(entry) ? entry : null;
  };

  const get = (key: string): ExtensionInventoryMemoryCacheEntry<T> | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (!isFresh(entry)) {
      entries.delete(key);
      return null;
    }

    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };

  const set = (
    key: string,
    value: T,
    loadDurationMs: number | null,
  ): ExtensionInventoryMemoryCacheEntry<T> => {
    const entry = {
      value,
      cachedAtMs: nowMs(),
      loadDurationMs,
    };
    entries.delete(key);
    entries.set(key, entry);

    while (entries.size > Math.max(0, maxEntries)) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }

    return entry;
  };

  return {
    get,
    peek,
    set,
    delete: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}

export function extensionTextMatchesFilter(
  values: ReadonlyArray<string | null | undefined>,
  filterText: string,
): boolean {
  const normalizedFilter = filterText.trim().toLowerCase();
  if (normalizedFilter.length === 0) return true;

  return values.some((value) => value?.toLowerCase().includes(normalizedFilter) ?? false);
}

export function isLikelyLocalPath(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed);
}

export type ExtensionJsonSchemaFieldType = "string" | "number" | "boolean" | "json";

export interface ExtensionJsonSchemaFormField {
  readonly name: string;
  readonly type: ExtensionJsonSchemaFieldType;
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly defaultValue?: unknown;
  readonly enumValues?: ReadonlyArray<string> | undefined;
}

const MAX_SCHEMA_FORM_FIELDS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry !== "null");
  }
  return undefined;
}

function formFieldType(propertySchema: Record<string, unknown>): ExtensionJsonSchemaFieldType {
  const type = schemaType(propertySchema.type);
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "string") return "string";
  return "json";
}

function enumValues(propertySchema: Record<string, unknown>): ReadonlyArray<string> | undefined {
  if (!Array.isArray(propertySchema.enum)) return undefined;
  const values = propertySchema.enum.flatMap((value) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [String(value)]
      : [],
  );
  return values.length > 0 ? values : undefined;
}

export function deriveExtensionJsonSchemaFormFields(
  schema: unknown,
): ReadonlyArray<ExtensionJsonSchemaFormField> | null {
  if (!isRecord(schema)) return null;
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return null;

  const propertyEntries = Object.entries(properties).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );
  if (propertyEntries.length === 0 || propertyEntries.length > MAX_SCHEMA_FORM_FIELDS) {
    return null;
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return propertyEntries.map(([name, propertySchema]) => ({
    name,
    type: formFieldType(propertySchema),
    required: required.has(name),
    description:
      typeof propertySchema.description === "string" ? propertySchema.description : undefined,
    defaultValue:
      Object.hasOwn(propertySchema, "default") && propertySchema.default !== undefined
        ? propertySchema.default
        : undefined,
    enumValues: enumValues(propertySchema),
  }));
}

export function makeExtensionJsonSchemaFormDefaults(
  fields: ReadonlyArray<ExtensionJsonSchemaFormField>,
): Record<string, string | boolean> {
  return Object.fromEntries(
    fields.map((field) => {
      if (field.type === "boolean") {
        return [field.name, field.defaultValue === true] as const;
      }
      if (field.defaultValue === undefined) return [field.name, ""] as const;
      if (field.type === "json")
        return [field.name, JSON.stringify(field.defaultValue, null, 2)] as const;
      return [field.name, String(field.defaultValue)] as const;
    }),
  );
}

export function buildExtensionJsonSchemaFormArguments(
  fields: ReadonlyArray<ExtensionJsonSchemaFormField>,
  values: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const field of fields) {
    const value = values[field.name];
    if (field.type === "boolean") {
      output[field.name] = value === true;
      continue;
    }

    const text = typeof value === "string" ? value.trim() : "";
    if (text.length === 0 && !field.required) continue;
    if (field.type === "number") {
      const numberValue = Number(text);
      if (!Number.isFinite(numberValue)) {
        throw new Error(`${field.name} must be a number.`);
      }
      output[field.name] = numberValue;
      continue;
    }
    if (field.type === "json") {
      output[field.name] = text.length > 0 ? JSON.parse(text) : null;
      continue;
    }
    output[field.name] = text;
  }

  return output;
}

function normalizedCwdKey(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

function scopedLocalKey(environmentId: string, localId: string): string {
  return `${environmentId}:${localId}`;
}

function parsedTime(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function deriveDetectedProviderThreadId({
  cwd,
  providerDriver,
  providerInstanceId,
  projects,
  threads,
  threadLastVisitedAtById,
}: {
  readonly cwd: string;
  readonly providerDriver: string;
  readonly providerInstanceId: string;
  readonly projects: ReadonlyArray<ExtensionProviderThreadProject>;
  readonly threads: ReadonlyArray<ExtensionProviderThreadCandidate>;
  readonly threadLastVisitedAtById: Readonly<Record<string, string>>;
}): string {
  const cwdKey = normalizedCwdKey(cwd);
  const selectedProviderDriver = providerDriver.trim();
  const selectedProviderInstanceId = providerInstanceId.trim();
  if (!cwdKey || !selectedProviderDriver || !selectedProviderInstanceId) return "";

  const projectRefs = new Set(
    projects
      .filter((project) => normalizedCwdKey(project.cwd) === cwdKey)
      .map((project) => scopedLocalKey(project.environmentId, project.id)),
  );
  if (projectRefs.size === 0) return "";

  let best: {
    readonly providerThreadId: string;
    readonly instanceRank: number;
    readonly timestamp: number;
  } | null = null;

  for (const thread of threads) {
    if (!projectRefs.has(scopedLocalKey(thread.environmentId, thread.projectId))) continue;
    if (thread.provider !== selectedProviderDriver) continue;

    const providerThreadId = thread.providerThreadId?.trim();
    if (!providerThreadId) continue;

    const candidateInstanceId = thread.providerInstanceId?.trim();
    if (candidateInstanceId && candidateInstanceId !== selectedProviderInstanceId) continue;

    const instanceRank = candidateInstanceId === selectedProviderInstanceId ? 1 : 0;
    const timestamp = Math.max(
      parsedTime(threadLastVisitedAtById[thread.key]),
      parsedTime(thread.sessionUpdatedAt),
      parsedTime(thread.updatedAt),
      parsedTime(thread.createdAt),
    );

    if (
      !best ||
      instanceRank > best.instanceRank ||
      (instanceRank === best.instanceRank && timestamp > best.timestamp)
    ) {
      best = { providerThreadId, instanceRank, timestamp };
    }
  }

  return best?.providerThreadId ?? "";
}
