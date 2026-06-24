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
  readonly scope?: string | undefined;
  readonly marketplaceName?: string | undefined;
  readonly remoteMarketplaceName?: string | undefined;
  readonly installPolicy?: string | undefined;
  readonly availability?: string | undefined;
  readonly isOfficial: boolean;
  readonly isLocal: boolean;
}

export function deriveExtensionPluginGroupLabel({
  scope,
  marketplaceName,
  remoteMarketplaceName,
  installPolicy,
  availability,
  isOfficial,
  isLocal,
}: ExtensionPluginGroupLabelInput): string {
  if (scope) return formatExtensionGroupLabel(scope);
  if (isOfficial) return "Official catalog";
  if (isLocal) return "Local";
  const catalogName = marketplaceName ?? remoteMarketplaceName;
  if (catalogName) return formatExtensionGroupLabel(catalogName);
  if (installPolicy) return formatExtensionGroupLabel(installPolicy);
  if (availability) return formatExtensionGroupLabel(availability);
  return "Plugins";
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
