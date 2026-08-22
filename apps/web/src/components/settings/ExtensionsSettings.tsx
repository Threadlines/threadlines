import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  CopyIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  KeyRoundIcon,
  LoaderIcon,
  MonitorIcon,
  PackageMinusIcon,
  PackagePlusIcon,
  PlugIcon,
  PowerIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type {
  EnvironmentApi,
  EnvironmentId,
  ProviderExtensionApp,
  ProviderExtensionMcpServer,
  ProviderExtensionMcpTool,
  ProviderExtensionPlugin,
  ProviderExtensionPluginComponent,
  ProviderExtensionPluginDetail,
  ProviderExtensionProviderInventory,
  ProviderExtensionsInventoryResult,
  ProviderExtensionSkill,
} from "@threadlines/contracts";
import { ProviderDriverKind, type ProviderInstanceId } from "@threadlines/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { openInPreferredEditor } from "../../editorPreferences";
import { providerIconForDriverLabel } from "../chat/providerIconUtils";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  resolveEnvironmentHttpUrl,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { readEnvironmentApi, useEnvironmentApiAvailable } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import {
  buildExtensionJsonSchemaFormArguments,
  createExtensionInventoryMemoryCache,
  deriveExtensionPluginGroupLabel,
  deriveDetectedProviderThreadId,
  deriveExtensionJsonSchemaFormFields,
  deriveExtensionScopeGroups,
  deriveExtensionSkillBundleKey,
  deriveExtensionSkillBundleLabel,
  extensionMcpNeedsAuthStatus,
  extensionMcpOAuthActionIntent,
  extensionMcpOAuthActionLabel,
  extensionScopeKey,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  formatSkillDisplayName,
  formatTokenCount,
  groupExtensionSkills,
  parseExtensionsSettingsTab,
  resolveExtensionsSettingsTab,
  type ExtensionsSettingsTab,
  rankPluginsAcrossProviders,
  resolveExtensionScope,
  selectCuratedPlugins,
  shouldCuratePluginBrowse,
  groupPluginComponents,
  isLikelyLocalPath,
  makeExtensionInventoryCacheKey,
  type ExtensionScopeGroup,
  type ExtensionScopeMachineInput,
  type ExtensionScopeSelection,
  type PluginComponentTarget,
  resolvePluginComponentTarget,
  summarizePluginDetail,
  makeExtensionJsonSchemaFormDefaults,
  shouldRenderExtensionBrowserGroups,
  type ExtensionItemKind,
} from "./ExtensionsSettings.logic";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useServerConfig, useServerProviders } from "../../rpc/serverState";
import {
  selectSidebarThreadsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  selectWorkspaceProjectsAcrossEnvironments,
  useStore,
} from "../../store";
import { providerMcpLoginCommand, type ExtensionMcpLoginProvider } from "../../mcpAuthStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { copyTextToClipboard } from "../../lib/clipboard";
import { cn } from "../../lib/utils";

const EXTENSION_SECTION_PREVIEW_LIMIT = 10;
const EXTENSION_BROWSER_PAGE_SIZE = 80;
const EXTENSION_INVENTORY_CACHE_MAX_ENTRIES = 5;
const EXTENSION_INVENTORY_CACHE_TTL_MS = 10 * 60 * 1_000;
const EXTENSIONS_CODEX_DRIVER = ProviderDriverKind.make("codex");
const EXTENSIONS_CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
type ExtensionSectionKey = "plugins" | "skills" | "mcpServers" | "apps";
type ExtensionBrowserFilter =
  | "all"
  | "enabled"
  | "disabled"
  | "installed"
  | "needs-auth"
  | "official"
  | "local";
type ExtensionBrowserSort = "recommended" | "popular" | "bundle" | "name" | "status" | "category";

type ExtensionItem =
  | {
      readonly kind: "plugin";
      readonly provider: ProviderExtensionProviderInventory;
      readonly id: string;
      readonly title: string;
      readonly detail?: string | undefined;
      readonly enabled?: boolean | undefined;
      readonly searchValues: ReadonlyArray<string | null | undefined>;
      readonly plugin: ProviderExtensionPlugin;
    }
  | {
      readonly kind: "skill";
      readonly provider: ProviderExtensionProviderInventory;
      readonly id: string;
      readonly title: string;
      readonly detail?: string | undefined;
      readonly enabled?: boolean | undefined;
      readonly searchValues: ReadonlyArray<string | null | undefined>;
      readonly skill: ProviderExtensionSkill;
    }
  | {
      readonly kind: "mcp";
      readonly provider: ProviderExtensionProviderInventory;
      readonly id: string;
      readonly title: string;
      readonly detail?: string | undefined;
      readonly enabled?: undefined;
      readonly searchValues: ReadonlyArray<string | null | undefined>;
      readonly server: ProviderExtensionMcpServer;
    }
  | {
      readonly kind: "app";
      readonly provider: ProviderExtensionProviderInventory;
      readonly id: string;
      readonly title: string;
      readonly detail?: string | undefined;
      readonly enabled?: boolean | undefined;
      readonly searchValues: ReadonlyArray<string | null | undefined>;
      readonly app: ProviderExtensionApp;
    };

interface ExtensionSectionConfig {
  readonly key: ExtensionSectionKey;
  readonly title: string;
  readonly label: string;
  readonly browseLabel: string;
  readonly icon: ReactNode;
  readonly items: ReadonlyArray<ExtensionItem>;
  /** Everything reachable from Browse. Defaults to `items`; plugins add the uninstalled catalog. */
  readonly browseItems?: ReadonlyArray<ExtensionItem> | undefined;
  /** The provider returned exactly our page size, so `totalCount` is a floor. */
  readonly isTruncated?: boolean | undefined;
  /** The section is skipped on the initial inventory read and fetched on demand. */
  readonly isDeferred?: boolean | undefined;
  readonly previewLimit?: number | undefined;
  readonly totalCount: number;
  readonly emptyLabel: string;
  readonly statusMessage?: string | undefined;
  readonly loadLabel?: string | undefined;
  readonly isLoading?: boolean | undefined;
  readonly onLoad?: (() => void) | undefined;
}

type ExtensionActionStatus = "running" | "success" | "error";

interface ExtensionActionHistoryEntry {
  readonly label: string;
  readonly status: ExtensionActionStatus;
  readonly startedAt: string;
  readonly durationMs?: number | undefined;
  readonly output?: string | undefined;
}

interface ExtensionsSettingsPanelMemoryState {
  scope?: ExtensionScopeSelection | undefined;
  /** Carries its machine: a filter picked on one machine means nothing on another. */
  providerFilter?:
    | { readonly environmentId: EnvironmentId; readonly instanceId: string }
    | undefined;
  manualThreadOverride?: { readonly scopeKey: string; readonly value: string } | undefined;
  showAdvancedContext?: boolean | undefined;
  /** Overridden by a `tab` search param, so a shared link still opens where it points. */
  tab?: ExtensionsSettingsTab | undefined;
}

type ExtensionProvidersApi = NonNullable<EnvironmentApi["providers"]>;

/** One provider filter chip: the instance, its label, and the driver behind it. */
interface ExtensionProviderChip {
  readonly value: string;
  readonly label: string;
  readonly driver: string;
}

const EMPTY_PROVIDER_CHIPS: ReadonlyArray<ExtensionProviderChip> = [];

interface ExtensionsScopeContextValue {
  readonly environmentId: EnvironmentId | null;
}

/**
 * The machine every plugin call in this panel goes to. The project picker spans
 * machines, so the API is resolved from the scope rather than from whichever
 * backend this client is paired with.
 */
const ExtensionsScopeContext = createContext<ExtensionsScopeContextValue | null>(null);

/** `null` when the scope's machine is disconnected, or runs a server predating this API. */
function readScopedProvidersApi(environmentId: EnvironmentId | null): ExtensionProvidersApi | null {
  if (!environmentId) return null;
  return readEnvironmentApi(environmentId)?.providers ?? null;
}

/**
 * Returns a getter rather than the API itself, for two reasons: a disconnected
 * machine must render a notice instead of throwing on the way to one, and the
 * connection behind an environment is rebuilt on reconnect, so the API has to be
 * resolved when the call is made rather than held from an earlier render.
 */
function useScopedProvidersApi(): () => ExtensionProvidersApi {
  const environmentId = useContext(ExtensionsScopeContext)?.environmentId ?? null;
  return useCallback(() => {
    const api = readScopedProvidersApi(environmentId);
    if (!api) {
      throw new Error("This machine is not connected.");
    }
    return api;
  }, [environmentId]);
}

const extensionInventoryCache =
  createExtensionInventoryMemoryCache<ProviderExtensionsInventoryResult>({
    maxEntries: EXTENSION_INVENTORY_CACHE_MAX_ENTRIES,
    ttlMs: EXTENSION_INVENTORY_CACHE_TTL_MS,
  });

const extensionsSettingsPanelMemoryState: ExtensionsSettingsPanelMemoryState = {};

const loadedPluginIconSrcs = new Set<string>();

/**
 * Plugin logos come either as a catalog URL or as a path inside the installed package. Local files
 * are served through the provider's HTTP route, which relay-paired environments cannot reach, so
 * every failure falls back to the kind glyph rather than a broken image.
 */
function PluginIcon({
  environmentId,
  iconUrl,
  iconPath,
  fallback,
  sizeClassName = "size-4",
}: {
  environmentId: EnvironmentId | null;
  iconUrl?: string | undefined;
  iconPath?: string | undefined;
  fallback: ReactNode;
  sizeClassName?: string;
}) {
  const src = (() => {
    if (iconUrl) return iconUrl;
    if (!iconPath || !environmentId) return null;
    try {
      return resolveEnvironmentHttpUrl({
        environmentId,
        pathname: "/api/plugin-icon",
        searchParams: { path: iconPath },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedPluginIconSrcs.has(src) ? "loaded" : "loading",
  );

  if (!src || status === "error") return <>{fallback}</>;

  return (
    <>
      {status !== "loaded" ? fallback : null}
      <img
        src={src}
        alt=""
        className={`${sizeClassName} shrink-0 rounded-md object-contain ${status === "loaded" ? "" : "hidden"}`}
        onLoad={() => {
          loadedPluginIconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}

function extensionItemActionKey(item: ExtensionItem): string {
  return `${item.provider.instanceId}:${item.kind}:${item.id}`;
}

function providerTitle(provider: ProviderExtensionProviderInventory): string {
  return provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : provider.driver);
}

function inventoryHasLoadedMcpServers(inventory: ProviderExtensionsInventoryResult): boolean {
  return inventory.providers.some(
    (provider) => provider.mcpServersStatus === "ready" || provider.mcpServers.length > 0,
  );
}

function inventoryHasLoadedApps(inventory: ProviderExtensionsInventoryResult): boolean {
  return inventory.providers.some(
    (provider) => provider.appsStatus === "ready" || provider.apps.length > 0,
  );
}

function extensionKindLabel(kind: ExtensionItemKind): string {
  switch (kind) {
    case "plugin":
      return "Plugin";
    case "skill":
      return "Skill";
    case "mcp":
      return "MCP server";
    case "app":
      return "App";
  }
}

function optionalDetail(parts: ReadonlyArray<string | null | undefined>): string | undefined {
  // Providers often repeat the same phrase across status fields ("Needs authentication" as both the
  // auth status and the status), so de-duplicate rather than rendering it twice.
  const seen = new Set<string>();
  const detail = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" - ");
  return detail.length > 0 ? detail : undefined;
}

function formatBoolean(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? "Yes" : "No";
}

function SectionTabButton({
  label,
  value,
  totalValue,
  isTruncated,
  isDeferred,
  active,
  icon,
  panelId,
  onClick,
}: {
  label: string;
  value: number;
  totalValue: number;
  isTruncated?: boolean | undefined;
  /** The section has not been fetched yet, so 0 would be a lie; show a placeholder instead. */
  isDeferred?: boolean | undefined;
  active: boolean;
  icon: ReactNode;
  panelId: string;
  onClick: () => void;
}) {
  const total = formatSectionTotal(totalValue, isTruncated);
  const countLabel = isDeferred ? "–" : value === totalValue ? total : `${value}/${total}`;

  return (
    <Button
      size="xs"
      variant={active ? "outline" : "ghost"}
      className={cn(
        "h-7 justify-start rounded-sm px-2 text-[11px]",
        active
          ? "border-primary/35 bg-accent/70 text-foreground shadow-none"
          : "text-muted-foreground hover:text-foreground",
      )}
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      data-pressed={active ? "" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      <span className="ml-1 font-mono tabular-nums text-foreground/80">{countLabel}</span>
    </Button>
  );
}

function EmptyList({ label }: { label: string }) {
  return <p className="py-1 text-xs text-muted-foreground/70">{label}</p>;
}

function pluginExtensionItem(
  provider: ProviderExtensionProviderInventory,
  plugin: ProviderExtensionPlugin,
): ExtensionItem {
  const title = plugin.displayName ?? plugin.name;
  return {
    kind: "plugin",
    provider,
    id: plugin.id,
    title,
    detail: plugin.description ?? plugin.scope ?? plugin.source,
    enabled: plugin.enabled,
    searchValues: [
      plugin.id,
      plugin.name,
      plugin.displayName,
      plugin.description,
      plugin.scope,
      plugin.source,
      plugin.version,
      plugin.installPath,
      plugin.projectPath,
      plugin.authPolicy,
      plugin.installPolicy,
      plugin.availability,
      plugin.marketplaceName,
      plugin.marketplacePath,
      plugin.remoteMarketplaceName,
      ...(plugin.keywords ?? []),
    ],
    plugin,
  };
}

function skillExtensionItem(
  provider: ProviderExtensionProviderInventory,
  skill: ProviderExtensionSkill,
): ExtensionItem {
  const title = skill.displayName ?? formatSkillDisplayName(skill.name, skill.bundleName);
  return {
    kind: "skill",
    provider,
    id: skill.path,
    title,
    detail: skill.shortDescription ?? skill.scope ?? skill.path,
    enabled: skill.enabled,
    searchValues: [
      skill.name,
      skill.displayName,
      skill.description,
      skill.shortDescription,
      skill.scope,
      skill.source,
      skill.bundleId,
      skill.bundleName,
      skill.bundleDisplayName,
      skill.path,
    ],
    skill,
  };
}

function mcpExtensionItem(
  provider: ProviderExtensionProviderInventory,
  server: ProviderExtensionMcpServer,
): ExtensionItem {
  return {
    kind: "mcp",
    provider,
    id: server.name,
    title: server.name,
    detail:
      optionalDetail([server.transport, server.status, server.detail]) ??
      `${server.toolCount ?? 0} tools`,
    searchValues: [
      server.name,
      server.authStatus,
      server.status,
      server.transport,
      server.detail,
      ...(server.tools ?? []),
      ...(server.toolDefinitions ?? []).flatMap((tool) => [
        tool.name,
        tool.title,
        tool.description,
      ]),
      ...(server.resources ?? []).flatMap((resource) => [
        resource.name,
        resource.title,
        resource.description,
        resource.uri,
      ]),
      ...(server.resourceTemplates ?? []).flatMap((resource) => [
        resource.name,
        resource.title,
        resource.description,
        resource.uriTemplate,
      ]),
    ],
    server,
  };
}

function appExtensionItem(
  provider: ProviderExtensionProviderInventory,
  app: ProviderExtensionApp,
): ExtensionItem {
  const title = app.displayName ?? app.name;
  return {
    kind: "app",
    provider,
    id: app.id,
    title,
    detail: app.description,
    // Codex reports every directory app as enabled unless it is banned in config.toml, so an
    // On badge only means something for apps that are actually connected to the account.
    ...(app.accessible === true ? { enabled: app.enabled } : {}),
    searchValues: [app.id, app.name, app.displayName, app.description],
    app,
  };
}

function skillBundlePlugin(item: ExtensionItem): ProviderExtensionPlugin | null {
  if (item.kind !== "skill") return null;
  const bundleId = item.skill.bundleId?.trim();
  if (!bundleId) return null;
  return item.provider.plugins.find((plugin) => plugin.id === bundleId) ?? null;
}

function skillBundleLabel(skill: ProviderExtensionSkill): string {
  return deriveExtensionSkillBundleLabel({
    bundleId: skill.bundleId,
    bundleName: skill.bundleName,
    bundleDisplayName: skill.bundleDisplayName,
    scope: skill.scope,
    source: skill.source,
  });
}

function skillBundleKey(skill: ProviderExtensionSkill): string {
  return deriveExtensionSkillBundleKey({
    bundleId: skill.bundleId,
    bundleName: skill.bundleName,
    scope: skill.scope,
    source: skill.source,
  });
}

/** `<root>/<name>/SKILL.md` -> `<root>/<name>`: the folder a delete removes. */
function skillFolderPath(skillPath: string): string {
  const separatorIndex = skillPath.replaceAll("\\", "/").lastIndexOf("/");
  return separatorIndex > 0 ? skillPath.slice(0, separatorIndex) : skillPath;
}

function findRefreshedExtensionItem(
  current: ExtensionItem,
  inventory: ProviderExtensionsInventoryResult,
): ExtensionItem | null {
  const provider =
    inventory.providers.find((entry) => entry.instanceId === current.provider.instanceId) ?? null;
  if (!provider) return null;

  switch (current.kind) {
    case "plugin": {
      const plugin = provider.plugins.find((entry) => entry.id === current.plugin.id);
      return plugin ? pluginExtensionItem(provider, plugin) : null;
    }
    case "skill": {
      const skill = provider.skills.find((entry) => entry.path === current.skill.path);
      return skill ? skillExtensionItem(provider, skill) : null;
    }
    case "mcp": {
      const server = provider.mcpServers.find((entry) => entry.name === current.server.name);
      return server ? mcpExtensionItem(provider, server) : null;
    }
    case "app": {
      const app = provider.apps.find((entry) => entry.id === current.app.id);
      return app ? appExtensionItem(provider, app) : null;
    }
  }
}

function filterExtensionItems(
  items: ReadonlyArray<ExtensionItem>,
  filterText: string,
): ReadonlyArray<ExtensionItem> {
  return items.filter((item) => extensionTextMatchesFilter(item.searchValues, filterText));
}

function compareExtensionItemsByTitle(left: ExtensionItem, right: ExtensionItem): number {
  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function extensionItemInstalled(item: ExtensionItem): boolean {
  if (item.kind === "plugin") return item.plugin.installed === true;
  if (item.kind === "skill") return skillBundlePlugin(item)?.installed === true;
  if (item.kind === "app") return item.app.accessible === true;
  return false;
}

function extensionItemNeedsAuth(item: ExtensionItem): boolean {
  if (item.kind === "mcp") {
    return extensionMcpNeedsAuthStatus(item.server);
  }

  if (item.kind === "plugin") {
    const authPolicy = item.plugin.authPolicy?.toLowerCase() ?? "";
    const availability = item.plugin.availability?.toLowerCase() ?? "";
    return [authPolicy, availability].some(
      (value) =>
        value.includes("unauth") ||
        value.includes("not authenticated") ||
        value.includes("needs auth") ||
        value.includes("login required") ||
        value.includes("expired"),
    );
  }

  return false;
}

function extensionItemIsLocal(item: ExtensionItem): boolean {
  if (extensionOpenPath(item)) return true;
  if (item.kind === "plugin") {
    return [item.plugin.source, item.plugin.projectPath, item.plugin.marketplacePath].some(
      isLikelyLocalPath,
    );
  }
  if (item.kind === "skill") {
    return isLikelyLocalPath(item.skill.path) || isLikelyLocalPath(item.skill.source);
  }
  return false;
}

function extensionItemIsOfficial(item: ExtensionItem): boolean {
  const values =
    item.kind === "plugin"
      ? [
          item.plugin.source,
          item.plugin.installPath,
          item.plugin.marketplaceName,
          item.plugin.marketplacePath,
          item.plugin.remoteMarketplaceName,
        ]
      : item.kind === "skill"
        ? [item.skill.source, item.skill.path]
        : [item.provider.displayName, item.provider.driver];

  return values.some((value) => {
    const normalized = value?.toLowerCase() ?? "";
    return (
      normalized.includes("official") ||
      normalized.includes("openai-curated") ||
      normalized.includes("claude-plugins-official")
    );
  });
}

function extensionItemPriorityRank(item: ExtensionItem): number {
  if (extensionItemNeedsAuth(item)) return 0;
  if (item.enabled === true) return 1;
  if (extensionItemInstalled(item)) return 2;
  if (extensionItemIsLocal(item)) return 3;
  return 4;
}

function extensionItemStatusRank(item: ExtensionItem): number {
  if (extensionItemNeedsAuth(item)) return 0;
  if (item.enabled === true) return 1;
  if (extensionItemInstalled(item)) return 2;
  if (item.enabled === false) return 3;
  return 4;
}

function extensionItemGroupLabel(item: ExtensionItem): string {
  if (item.kind === "mcp") {
    return item.server.status ?? item.server.authStatus ?? item.server.transport ?? "MCP servers";
  }

  if (item.kind === "plugin") {
    return deriveExtensionPluginGroupLabel({
      category: item.plugin.category,
      scope: item.plugin.scope,
      marketplaceName: item.plugin.marketplaceName,
      remoteMarketplaceName: item.plugin.remoteMarketplaceName,
      installPolicy: item.plugin.installPolicy,
      availability: item.plugin.availability,
      isOfficial: extensionItemIsOfficial(item),
      isLocal: extensionItemIsLocal(item),
    });
  }

  if (item.kind === "skill") {
    return skillBundleLabel(item.skill);
  }

  if (item.kind === "app") {
    if (item.app.enabled === false) return "Disabled";
    if (item.app.accessible === false) return "Unavailable";
    return "Apps";
  }

  return "Other";
}

function extensionItemGroupKey(item: ExtensionItem, sort: ExtensionBrowserSort): string {
  if (sort === "name") {
    const firstLetter = item.title.trim().charAt(0).toUpperCase();
    return /^[A-Z0-9]$/.test(firstLetter) ? firstLetter : "#";
  }
  if (sort === "status") {
    if (extensionItemNeedsAuth(item)) return "Needs auth";
    if (item.enabled === true) return "Enabled";
    if (extensionItemInstalled(item)) return "Installed";
    if (item.enabled === false) return "Disabled";
    return "Available";
  }
  if (sort === "bundle" && item.kind === "skill") {
    return skillBundleKey(item.skill);
  }
  return extensionItemGroupLabel(item);
}

function sortExtensionItems(
  items: ReadonlyArray<ExtensionItem>,
  sort: ExtensionBrowserSort,
): ReadonlyArray<ExtensionItem> {
  return items.toSorted((left, right) => {
    if (sort === "name") return compareExtensionItemsByTitle(left, right);
    if (sort === "status") {
      const statusRank = extensionItemStatusRank(left) - extensionItemStatusRank(right);
      return statusRank || compareExtensionItemsByTitle(left, right);
    }
    if (sort === "category") {
      const categoryRank = extensionItemGroupLabel(left).localeCompare(
        extensionItemGroupLabel(right),
        undefined,
        { sensitivity: "base" },
      );
      return categoryRank || compareExtensionItemsByTitle(left, right);
    }
    if (sort === "bundle") {
      const bundleRank = extensionItemGroupLabel(left).localeCompare(
        extensionItemGroupLabel(right),
        undefined,
        { sensitivity: "base" },
      );
      return bundleRank || compareExtensionItemsByTitle(left, right);
    }
    const priorityRank = extensionItemPriorityRank(left) - extensionItemPriorityRank(right);
    return priorityRank || compareExtensionItemsByTitle(left, right);
  });
}

function extensionItemMatchesBrowserFilter(
  item: ExtensionItem,
  filter: ExtensionBrowserFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "enabled":
      return item.enabled === true;
    case "disabled":
      return item.enabled === false;
    case "installed":
      return extensionItemInstalled(item);
    case "needs-auth":
      return extensionItemNeedsAuth(item);
    case "official":
      return extensionItemIsOfficial(item);
    case "local":
      return extensionItemIsLocal(item);
  }
}

function mcpOAuthActionIntent(item: ExtensionItem) {
  if (item.kind !== "mcp") return null;
  return extensionMcpOAuthActionIntent(item.server);
}

function mcpLoginProviderForItem(item: ExtensionItem): ExtensionMcpLoginProvider {
  return item.provider.driver === EXTENSIONS_CLAUDE_DRIVER ? "claudeAgent" : "codex";
}

function ExtensionItemBadges({
  item,
  showProvider = false,
}: {
  item: ExtensionItem;
  showProvider?: boolean;
}) {
  const ProviderGlyph = showProvider
    ? providerIconForDriverLabel(String(item.provider.driver))
    : null;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      {/* Both providers ship a "figma"; without this the rows are indistinguishable. */}
      {showProvider ? (
        <Badge size="sm" variant="outline">
          {ProviderGlyph ? <ProviderGlyph className="size-2.5" /> : null}
          {providerTitle(item.provider)}
        </Badge>
      ) : null}
      {extensionItemNeedsAuth(item) ? (
        <Badge size="sm" variant="warning">
          Auth
        </Badge>
      ) : null}
      {typeof item.enabled === "boolean" ? (
        <Badge size="sm" variant={item.enabled ? "success" : "outline"}>
          {item.enabled ? "On" : "Off"}
        </Badge>
      ) : null}
      {extensionItemInstalled(item) ? (
        <Badge size="sm" variant="outline">
          Installed
        </Badge>
      ) : null}
      {extensionItemIsOfficial(item) ? (
        <Badge size="sm" variant="outline">
          Official
        </Badge>
      ) : null}
      {extensionItemIsLocal(item) ? (
        <Badge size="sm" variant="outline">
          Local
        </Badge>
      ) : null}
    </div>
  );
}

function extensionAuthIssueDetail(item: ExtensionItem): string {
  if (item.kind === "mcp") {
    return (
      optionalDetail([item.server.authStatus, item.server.status, item.server.detail]) ??
      "MCP authentication needs attention."
    );
  }

  if (item.kind === "plugin") {
    return (
      optionalDetail([item.plugin.authPolicy, item.plugin.availability]) ??
      "Plugin authentication needs attention."
    );
  }

  return `${extensionKindLabel(item.kind)} authentication needs attention.`;
}

function extensionOpenPath(item: ExtensionItem): string | null {
  if (item.kind === "skill") return item.skill.path;
  if (item.kind === "plugin" && isLikelyLocalPath(item.plugin.installPath)) {
    return item.plugin.installPath ?? null;
  }
  if (item.kind === "plugin" && isLikelyLocalPath(item.plugin.source)) {
    return item.plugin.source ?? null;
  }
  return null;
}

function extensionClipboardDetails(item: ExtensionItem): string {
  switch (item.kind) {
    case "plugin":
      return JSON.stringify(
        {
          kind: item.kind,
          id: item.plugin.id,
          name: item.plugin.name,
          displayName: item.plugin.displayName,
          description: item.plugin.description,
          installed: item.plugin.installed,
          enabled: item.plugin.enabled,
          source: item.plugin.source,
          version: item.plugin.version,
          installPath: item.plugin.installPath,
          installedAt: item.plugin.installedAt,
          lastUpdated: item.plugin.lastUpdated,
          installCount: item.plugin.installCount,
          projectPath: item.plugin.projectPath,
          scope: item.plugin.scope,
          authPolicy: item.plugin.authPolicy,
          installPolicy: item.plugin.installPolicy,
          availability: item.plugin.availability,
          marketplaceName: item.plugin.marketplaceName,
          marketplacePath: item.plugin.marketplacePath,
          remoteMarketplaceName: item.plugin.remoteMarketplaceName,
          provider: providerTitle(item.provider),
        },
        null,
        2,
      );
    case "skill":
      return JSON.stringify(
        {
          kind: item.kind,
          name: item.skill.name,
          displayName: item.skill.displayName,
          description: item.skill.description,
          shortDescription: item.skill.shortDescription,
          enabled: item.skill.enabled,
          scope: item.skill.scope,
          source: item.skill.source,
          bundleId: item.skill.bundleId,
          bundleName: item.skill.bundleName,
          bundleDisplayName: item.skill.bundleDisplayName,
          path: item.skill.path,
          provider: providerTitle(item.provider),
        },
        null,
        2,
      );
    case "mcp":
      return JSON.stringify(
        {
          kind: item.kind,
          name: item.server.name,
          authStatus: item.server.authStatus,
          status: item.server.status,
          transport: item.server.transport,
          tools: item.server.tools,
          toolDefinitions: item.server.toolDefinitions,
          resources: item.server.resources,
          resourceTemplates: item.server.resourceTemplates,
          toolCount: item.server.toolCount,
          resourceCount: item.server.resourceCount,
          detail: item.server.detail,
          provider: providerTitle(item.provider),
        },
        null,
        2,
      );
    case "app":
      return JSON.stringify(
        {
          kind: item.kind,
          id: item.app.id,
          name: item.app.name,
          displayName: item.app.displayName,
          description: item.app.description,
          enabled: item.app.enabled,
          accessible: item.app.accessible,
          provider: providerTitle(item.provider),
        },
        null,
        2,
      );
  }
}

function copyText(value: string, label: string) {
  void copyTextToClipboard(value).then(
    () => {
      const preview = value.length > 180 ? `${value.slice(0, 177).trimEnd()}...` : value;
      toastManager.add({
        type: "success",
        title: `${label} copied`,
        description: preview,
      });
    },
    (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${label.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonInput(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  return JSON.parse(trimmed);
}

function actionBaseInput(item: ExtensionItem, cwd: string) {
  const trimmedCwd = cwd.trim();
  return {
    ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
    providerInstanceId: item.provider.instanceId as ProviderInstanceId,
  };
}

function pluginSelectorInput(plugin: ProviderExtensionPlugin) {
  return {
    pluginName: plugin.name,
    ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : {}),
    ...(plugin.remoteMarketplaceName
      ? { remoteMarketplaceName: plugin.remoteMarketplaceName }
      : {}),
    ...(plugin.scope ? { scope: plugin.scope } : {}),
  };
}

function isCodexProvider(provider: ProviderExtensionProviderInventory): boolean {
  return provider.driver === EXTENSIONS_CODEX_DRIVER;
}

function isClaudeProvider(provider: ProviderExtensionProviderInventory): boolean {
  return provider.driver === EXTENSIONS_CLAUDE_DRIVER;
}

function findManagedClaudePluginForMcp(item: ExtensionItem | null): ProviderExtensionPlugin | null {
  if (!item || item.kind !== "mcp" || !isClaudeProvider(item.provider)) return null;
  const serverName = item.server.name.toLowerCase();
  const serverPluginName = serverName.split(":")[0] ?? serverName;
  return (
    item.provider.plugins.find((plugin) => {
      const pluginName = plugin.name.toLowerCase();
      const pluginIdName = plugin.id.split("@")[0]?.toLowerCase();
      return (
        pluginName === serverName ||
        pluginName === serverPluginName ||
        pluginIdName === serverName ||
        pluginIdName === serverPluginName
      );
    }) ?? null
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function openPathInEditor(targetPath: string) {
  let api: ReturnType<typeof ensureLocalApi>;
  try {
    api = ensureLocalApi();
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open plugin path",
        description: error instanceof Error ? error.message : "Local API unavailable.",
      }),
    );
    return;
  }

  void openInPreferredEditor(api, targetPath).then(
    () => {
      toastManager.add({
        type: "success",
        title: "Opened in editor",
        description: targetPath,
      });
    },
    (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open plugin path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  );
}

function DetailRow({
  label,
  value,
  copyValue,
}: {
  label: string;
  value: ReactNode;
  copyValue?: string | undefined;
}) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return null;
  }

  return (
    <div className="grid gap-1.5 border-t border-border/50 py-2.5 first:border-t-0 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-start">
      <dt className="text-[11px] font-semibold uppercase text-muted-foreground/70">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-xs text-foreground">{value}</dd>
      {copyValue ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-6 rounded-sm text-muted-foreground hover:text-foreground max-sm:hidden"
                onClick={() => copyText(copyValue, label)}
                aria-label={`Copy ${label}`}
              >
                <CopyIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">Copy {label.toLowerCase()}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function ExtensionActionOutput({ value }: { value: string | null }) {
  if (!value) return null;

  return (
    <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-background p-3 text-[11px] leading-relaxed text-muted-foreground">
      {value}
    </pre>
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function actionOutputPreview(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 320 ? `${trimmed.slice(0, 317).trimEnd()}...` : trimmed;
}

function ExtensionActionSummary({ entry }: { entry?: ExtensionActionHistoryEntry | undefined }) {
  if (!entry) return null;
  const variant =
    entry.status === "success" ? "success" : entry.status === "error" ? "error" : "outline";

  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="text-[11px] font-semibold uppercase text-muted-foreground/70">
          Last action
        </span>
        <Badge size="sm" variant={variant}>
          {entry.status === "running" ? "Running" : entry.status === "success" ? "Done" : "Failed"}
        </Badge>
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">
          {entry.label}
          {entry.durationMs !== undefined ? ` (${formatDuration(entry.durationMs)})` : ""}
        </span>
      </div>
      {entry.output ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground/70">{entry.output}</div>
      ) : null}
    </div>
  );
}

function ExtensionToolsList({
  tools,
  onSelectTool,
}: {
  tools: ReadonlyArray<ProviderExtensionMcpTool>;
  onSelectTool: (tool: ProviderExtensionMcpTool) => void;
}) {
  if (tools.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-border/50 pt-3">
      <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">Tools</div>
      <div className="divide-y divide-border/50 rounded-md border border-border/60 bg-background">
        {tools.map((tool) => (
          <div key={tool.name} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-foreground/90">{tool.name}</div>
              {tool.description || tool.title ? (
                <div className="truncate text-[11px] text-muted-foreground/70">
                  {tool.description ?? tool.title}
                </div>
              ) : null}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() => copyText(formatJson(tool.inputSchema ?? {}), "Tool schema")}
                    aria-label={`Copy ${tool.name} schema`}
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Copy schema</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() => onSelectTool(tool)}
                    aria-label={`Prepare ${tool.name}`}
                  >
                    <PlayIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Use tool</TooltipPopup>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExtensionResourcesList({
  server,
  onReadResource,
}: {
  server: ProviderExtensionMcpServer;
  onReadResource: (uri: string) => void;
}) {
  const resources = server.resources ?? [];
  const templates = server.resourceTemplates ?? [];
  if (resources.length === 0 && templates.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-border/50 pt-3">
      <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">Resources</div>
      <div className="divide-y divide-border/50 rounded-md border border-border/60 bg-background">
        {resources.map((resource) => (
          <div key={resource.uri} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-foreground/90">
                {resource.name}
              </div>
              <div className="truncate text-[11px] text-muted-foreground/70">{resource.uri}</div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() => onReadResource(resource.uri)}
                    aria-label={`Read ${resource.name}`}
                  >
                    <DatabaseIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Read resource</TooltipPopup>
            </Tooltip>
          </div>
        ))}
        {templates.map((template) => (
          <div key={template.uriTemplate} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-foreground/90">
                {template.name}
              </div>
              <div className="truncate text-[11px] text-muted-foreground/70">
                {template.uriTemplate}
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() => copyText(template.uriTemplate, "Resource template")}
                    aria-label={`Copy ${template.name}`}
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Copy template</TooltipPopup>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

type SkillContentsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly contents: string; readonly truncated: boolean }
  | { readonly status: "error"; readonly message: string };

type PluginDetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly detail: ProviderExtensionPluginDetail }
  | { readonly status: "error"; readonly message: string };

/** Dot-separated meta line. Skips blanks so a sparse plugin does not render stray separators. */
function PluginMetaLine({ parts }: { parts: ReadonlyArray<string | undefined> }) {
  const present = parts.filter((part): part is string => Boolean(part?.trim()));
  if (present.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground/70">
      {present.map((part, index) => (
        <span key={part} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </div>
  );
}

function PluginTokenCost({ detail }: { detail: ProviderExtensionPluginDetail }) {
  const alwaysOn = detail.tokenCost?.alwaysOnTokens;
  if (alwaysOn === undefined) return null;

  return (
    <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
      <span className="font-mono text-foreground">{formatTokenCount(alwaysOn)} tok</span>
      <span>added to every session</span>
    </div>
  );
}

function PluginComponentRow({
  component,
  onInvoke,
}: {
  component: ProviderExtensionPluginComponent;
  onInvoke: (() => void) | null;
}) {
  const body = (
    <>
      <span className="min-w-0 truncate text-xs text-foreground">{component.name}</span>
      {component.detail ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {component.detail}
        </span>
      ) : null}
      {component.enabled === false ? (
        <Badge size="sm" variant="outline">
          Off
        </Badge>
      ) : null}
    </>
  );

  if (!onInvoke) {
    return (
      <div className="flex min-w-0 items-center gap-2 border-t border-border/40 py-1.5 first:border-t-0">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group flex min-w-0 items-center gap-2 border-t border-border/40 py-1.5 text-left transition-colors first:border-t-0 hover:text-foreground focus-ring"
      onClick={onInvoke}
    >
      {body}
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function PluginComponents({
  state,
  provider,
  onSelectTarget,
  onRetry,
}: {
  state: PluginDetailState;
  provider: ProviderExtensionProviderInventory;
  onSelectTarget: (target: PluginComponentTarget) => void;
  onRetry: () => void;
}) {
  const groups = useMemo(
    () => (state.status === "ready" ? groupPluginComponents(state.detail.components) : []),
    [state],
  );

  if (state.status === "idle") return null;

  return (
    <section className="space-y-2 border-t border-border/50 pt-3">
      <h3 className="text-[11px] font-semibold uppercase text-muted-foreground/70">What it adds</h3>
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          Reading plugin contents
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 text-xs text-muted-foreground">{state.message}</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {state.status === "ready" && groups.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          This plugin does not contribute any components.
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.kind} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="pt-1.5 text-[11px] font-semibold uppercase text-muted-foreground/70">
            {group.label}
            <span className="ml-1 font-mono font-normal text-muted-foreground/50">
              {group.components.length}
            </span>
          </div>
          <div className="min-w-0">
            {group.components.map((component) => {
              const target = resolvePluginComponentTarget(component, provider);
              return (
                <PluginComponentRow
                  key={`${component.kind}:${component.name}`}
                  component={component}
                  onInvoke={target ? () => onSelectTarget(target) : null}
                />
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function ExtensionDetailDialog({
  item,
  onClose,
  onSelectItem,
  environmentId,
  cwd,
  machineLabel,
  providerThreadId,
  onInventoryMutated,
  lastAction,
  onActionHistoryChange,
}: {
  item: ExtensionItem | null;
  onClose: () => void;
  onSelectItem: (item: ExtensionItem) => void;
  environmentId: EnvironmentId | null;
  cwd: string;
  /** Named in the delete confirmation so it is clear which machine loses the folder. */
  machineLabel: string;
  providerThreadId: string;
  onInventoryMutated: () => Promise<void>;
  lastAction?: ExtensionActionHistoryEntry | undefined;
  onActionHistoryChange: (itemKey: string, entry: ExtensionActionHistoryEntry) => void;
}) {
  const providersApi = useScopedProvidersApi();
  const openPath = item ? extensionOpenPath(item) : null;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<ProviderExtensionMcpTool | null>(null);
  const [toolArguments, setToolArguments] = useState("{}");
  const [toolArgumentMode, setToolArgumentMode] = useState<"form" | "json">("json");
  const [toolFormValues, setToolFormValues] = useState<Record<string, string | boolean>>({});
  const [pluginDetail, setPluginDetail] = useState<PluginDetailState>({ status: "idle" });
  const [pluginDetailAttempt, setPluginDetailAttempt] = useState(0);
  const [skillContents, setSkillContents] = useState<SkillContentsState>({ status: "idle" });
  const pollRef = useRef(0);
  const managedClaudePlugin = useMemo(() => findManagedClaudePluginForMcp(item), [item]);

  useEffect(() => {
    setBusyAction(null);
    setActionOutput(null);
    setSelectedTool(null);
    setToolArguments("{}");
    setToolArgumentMode("json");
    setToolFormValues({});
    setPluginDetail({ status: "idle" });
    setPluginDetailAttempt(0);
    setSkillContents({ status: "idle" });
    pollRef.current += 1;
  }, [item?.kind, item?.id]);

  // A plugin's component inventory needs a provider round trip, so it loads with the dialog rather
  // than behind a button: "what does this add" is the question the dialog exists to answer.
  useEffect(() => {
    if (!item || item.kind !== "plugin" || item.plugin.installed !== true) return;

    let cancelled = false;
    setPluginDetail({ status: "loading" });
    void (async () => {
      try {
        const result = await providersApi().readExtensionPlugin({
          ...actionBaseInput(item, cwd),
          ...pluginSelectorInput(item.plugin),
        });
        if (!cancelled) setPluginDetail({ status: "ready", detail: result.plugin });
      } catch (error) {
        if (cancelled) return;
        setPluginDetail({
          status: "error",
          message: error instanceof Error ? error.message : "Could not read plugin contents.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cwd, item, pluginDetailAttempt, providersApi]);

  useEffect(() => {
    if (!item || item.kind !== "skill") return;

    let cancelled = false;
    setSkillContents({ status: "loading" });
    void (async () => {
      try {
        const result = await providersApi().readExtensionSkill({
          ...actionBaseInput(item, cwd),
          path: item.skill.path,
        });
        if (!cancelled) {
          setSkillContents({
            status: "ready",
            contents: result.contents,
            truncated: result.truncated === true,
          });
        }
      } catch (error) {
        if (cancelled) return;
        setSkillContents({
          status: "error",
          message: error instanceof Error ? error.message : "Could not read this skill.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cwd, item, providersApi]);

  const pluginDetailValue = pluginDetail.status === "ready" ? pluginDetail.detail : null;
  const pluginDescription =
    item?.kind === "plugin"
      ? (pluginDetailValue?.description ?? item.plugin.description)
      : undefined;
  const pluginVersion =
    item?.kind === "plugin" ? (item.plugin.version ?? pluginDetailValue?.version) : undefined;
  // Many plugins name their developer after the plugin, which would just echo the dialog title.
  const pluginDeveloperName =
    item?.kind === "plugin" &&
    item.plugin.developerName &&
    item.plugin.developerName.trim().toLowerCase() !== item.title.trim().toLowerCase()
      ? item.plugin.developerName
      : undefined;

  const selectComponentTarget = useCallback(
    (target: PluginComponentTarget) => {
      if (!item) return;
      if (target.kind === "skill") {
        onSelectItem(skillExtensionItem(item.provider, target.skill));
        return;
      }
      if (target.kind === "mcp") {
        onSelectItem(mcpExtensionItem(item.provider, target.server));
        return;
      }
      onSelectItem(appExtensionItem(item.provider, target.app));
    },
    [item, onSelectItem],
  );

  const runDialogAction = useCallback(
    async (label: string, action: () => Promise<string | null | undefined>) => {
      const itemKey = item ? extensionItemActionKey(item) : null;
      const startedAt = new Date().toISOString();
      const startedMs = performance.now();
      setBusyAction(label);
      setActionOutput(null);
      if (itemKey) {
        onActionHistoryChange(itemKey, {
          label,
          status: "running",
          startedAt,
        });
      }
      try {
        const output = await action();
        if (output) setActionOutput(output);
        if (itemKey) {
          onActionHistoryChange(itemKey, {
            label,
            status: "success",
            startedAt,
            durationMs: performance.now() - startedMs,
            ...(actionOutputPreview(output) ? { output: actionOutputPreview(output) } : {}),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "An error occurred.";
        setActionOutput(message);
        if (itemKey) {
          onActionHistoryChange(itemKey, {
            label,
            status: "error",
            startedAt,
            durationMs: performance.now() - startedMs,
            ...(actionOutputPreview(message) ? { output: actionOutputPreview(message) } : {}),
          });
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${label} failed`,
            description: message,
          }),
        );
      } finally {
        setBusyAction((current) => (current === label ? null : current));
      }
    },
    [item, onActionHistoryChange],
  );

  const mcpOAuthIntent = item ? mcpOAuthActionIntent(item) : null;
  const mcpOAuthActionLabel = extensionMcpOAuthActionLabel(mcpOAuthIntent);
  const mcpOAuthActionAvailable = mcpOAuthIntent !== null;

  const startMcpOAuth = useCallback(() => {
    if (!item || item.kind !== "mcp") return;
    void runDialogAction(mcpOAuthActionLabel, async () => {
      const providers = providersApi();
      const result = await providers.startExtensionMcpOAuth({
        ...actionBaseInput(item, cwd),
        serverName: item.server.configuredName ?? item.server.name,
        timeoutSecs: 300,
      });
      // The browser prompt opens where the user is sitting, not on the machine
      // running the provider, so this stays a local-shell call.
      if (result.authorizationUrl) {
        await ensureLocalApi().shell.openExternal(result.authorizationUrl);
      }
      const pollId = pollRef.current + 1;
      pollRef.current = pollId;
      setActionOutput(
        result.authorizationUrl
          ? `Opened OAuth for ${item.server.name}.\n\nFallback:\n${result.terminalCommand}`
          : `Started login for ${item.server.name}. Complete the browser prompt if Claude opens one.\n\nFallback:\n${result.terminalCommand}`,
      );

      const expiresAt = Date.parse(result.expiresAt);
      while (pollRef.current === pollId && Date.now() < expiresAt + 15_000) {
        await wait(1_500);
        if (pollRef.current !== pollId) return null;
        const status = await providers.getExtensionOperationStatus({
          operationId: result.operationId,
        });
        setActionOutput(
          `${status.message ?? status.status}\n\nFallback:\n${result.terminalCommand}`,
        );
        if (status.status !== "running") {
          if (status.status === "completed") {
            toastManager.add({
              type: "success",
              title: "OAuth completed",
              description: item.server.name,
            });
            await onInventoryMutated();
            return status.message ?? status.status;
          }
          const message = status.error
            ? `${status.message ?? status.status}\n\n${status.error}`
            : (status.message ?? status.status);
          throw new Error(message);
        }
      }
      throw new Error(`OAuth timed out.\n\nFallback:\n${result.terminalCommand}`);
    });
  }, [cwd, item, mcpOAuthActionLabel, onInventoryMutated, providersApi, runDialogAction]);

  const reloadMcp = useCallback(() => {
    if (!item) return;
    void runDialogAction("Reload MCP", async () => {
      await providersApi().reloadExtensionMcpServers(actionBaseInput(item, cwd));
      await onInventoryMutated();
      return "MCP servers reloaded.";
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const toggleSkill = useCallback(() => {
    if (!item || item.kind !== "skill") return;
    const nextEnabled = !(item.skill.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable skill" : "Disable skill", async () => {
      const result = await providersApi().setExtensionSkillEnabled({
        ...actionBaseInput(item, cwd),
        path: item.skill.path,
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Skill ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const deleteSkill = useCallback(() => {
    if (!item || item.kind !== "skill") return;
    const folder = skillFolderPath(item.skill.path);
    void runDialogAction("Delete skill", async () => {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Delete ${item.title}? Deletes the folder ${folder} on ${machineLabel}.`,
      );
      if (!confirmed) return "Delete cancelled.";
      await providersApi().deleteExtensionSkill({
        ...actionBaseInput(item, cwd),
        path: item.skill.path,
      });
      await onInventoryMutated();
      // The item this dialog is bound to no longer exists, so there is nothing left to show.
      onClose();
      return "Skill deleted.";
    });
  }, [cwd, item, machineLabel, onClose, onInventoryMutated, providersApi, runDialogAction]);

  const installPlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Install plugin", async () => {
      const result = await providersApi().installExtensionPlugin({
        ...actionBaseInput(item, cwd),
        ...pluginSelectorInput(item.plugin),
      });
      await onInventoryMutated();
      return formatJson(result);
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const uninstallPlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Uninstall plugin", async () => {
      const confirmed = await ensureLocalApi().dialogs.confirm(`Uninstall ${item.plugin.name}?`);
      if (!confirmed) return "Uninstall cancelled.";
      await providersApi().uninstallExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin uninstalled.";
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const togglePlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    const nextEnabled = !(item.plugin.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable plugin" : "Disable plugin", async () => {
      const result = await providersApi().setExtensionPluginEnabled({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Plugin ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const updatePlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Update plugin", async () => {
      await providersApi().updateExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin updated. Restart active Claude sessions to apply the new plugin bundle.";
    });
  }, [cwd, item, onInventoryMutated, providersApi, runDialogAction]);

  const readManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    void runDialogAction("Plugin details", async () => {
      const result = await providersApi().readExtensionPlugin({
        ...actionBaseInput(item, cwd),
        ...pluginSelectorInput(managedClaudePlugin),
      });
      return summarizePluginDetail(result.plugin);
    });
  }, [cwd, item, managedClaudePlugin, providersApi, runDialogAction]);

  const toggleManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    const nextEnabled = !(managedClaudePlugin.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable plugin" : "Disable plugin", async () => {
      const result = await providersApi().setExtensionPluginEnabled({
        ...actionBaseInput(item, cwd),
        pluginId: managedClaudePlugin.id,
        ...(managedClaudePlugin.scope ? { scope: managedClaudePlugin.scope } : {}),
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Plugin ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, managedClaudePlugin, onInventoryMutated, providersApi, runDialogAction]);

  const uninstallManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    void runDialogAction("Uninstall plugin", async () => {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Uninstall ${managedClaudePlugin.name}?`,
      );
      if (!confirmed) return "Uninstall cancelled.";
      await providersApi().uninstallExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: managedClaudePlugin.id,
        ...(managedClaudePlugin.scope ? { scope: managedClaudePlugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin uninstalled.";
    });
  }, [cwd, item, managedClaudePlugin, onInventoryMutated, providersApi, runDialogAction]);

  const selectedToolFormFields = useMemo(
    () => deriveExtensionJsonSchemaFormFields(selectedTool?.inputSchema),
    [selectedTool],
  );

  const runSelectedTool = useCallback(() => {
    if (!item || item.kind !== "mcp" || !selectedTool) return;
    void runDialogAction("Run tool", async () => {
      const threadId = providerThreadId.trim();
      if (!threadId) {
        return "A provider thread id is required to run MCP tools.";
      }
      const argumentsValue =
        toolArgumentMode === "form" && selectedToolFormFields
          ? buildExtensionJsonSchemaFormArguments(selectedToolFormFields, toolFormValues)
          : parseJsonInput(toolArguments);
      const result = await providersApi().callExtensionMcpTool({
        ...actionBaseInput(item, cwd),
        serverName: item.server.configuredName ?? item.server.name,
        toolName: selectedTool.name,
        providerThreadId: threadId,
        arguments: argumentsValue,
      });
      return formatJson(result);
    });
  }, [
    cwd,
    item,
    providersApi,
    providerThreadId,
    runDialogAction,
    selectedTool,
    selectedToolFormFields,
    toolArgumentMode,
    toolArguments,
    toolFormValues,
  ]);

  const readResource = useCallback(
    (uri: string) => {
      if (!item || item.kind !== "mcp") return;
      void runDialogAction("Read resource", async () => {
        const threadId = providerThreadId.trim();
        const result = await providersApi().readExtensionMcpResource({
          ...actionBaseInput(item, cwd),
          serverName: item.server.configuredName ?? item.server.name,
          uri,
          ...(threadId ? { providerThreadId: threadId } : {}),
        });
        return formatJson(result);
      });
    },
    [cwd, item, providersApi, providerThreadId, runDialogAction],
  );

  const codexActionsAvailable = item ? isCodexProvider(item.provider) : false;
  const claudeActionsAvailable = item ? isClaudeProvider(item.provider) : false;
  const mcpTools =
    item?.kind === "mcp"
      ? (item.server.toolDefinitions ??
        (item.server.tools ?? []).map(
          (tool) => ({ name: tool }) satisfies ProviderExtensionMcpTool,
        ))
      : [];
  const selectTool = useCallback((tool: ProviderExtensionMcpTool) => {
    const formFields = deriveExtensionJsonSchemaFormFields(tool.inputSchema);
    setSelectedTool(tool);
    setToolArguments("{}");
    setToolArgumentMode(formFields ? "form" : "json");
    setToolFormValues(formFields ? makeExtensionJsonSchemaFormDefaults(formFields) : {});
  }, []);

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <DialogPopup className="max-w-2xl overflow-hidden">
          <DialogHeader className="border-b border-border/70 bg-background">
            <div className="flex min-w-0 items-start gap-3 pr-8">
              <span className="mt-0.5 shrink-0">
                <ExtensionItemGlyph
                  item={item}
                  environmentId={environmentId}
                  sizeClassName="size-8"
                  containerClassName="inline-flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground"
                />
              </span>
              <div className="min-w-0 space-y-1">
                <DialogTitle className="truncate text-base">{item.title}</DialogTitle>
                <DialogDescription>
                  {extensionKindLabel(item.kind)} from {providerTitle(item.provider)} (
                  {item.provider.instanceId})
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogPanel className="space-y-4 border-b border-border/70 bg-muted/15 px-6 py-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge size="sm" variant="outline">
                {extensionKindLabel(item.kind)}
              </Badge>
              {typeof item.enabled === "boolean" ? (
                <Badge size="sm" variant={item.enabled ? "success" : "outline"}>
                  {item.enabled ? "On" : "Off"}
                </Badge>
              ) : null}
            </div>
            {item.kind === "plugin" ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  {pluginDescription ? (
                    // Some descriptions are whole prompt paragraphs; keep the identity block
                    // scannable and let the title attribute carry the rest.
                    <p
                      className="line-clamp-3 text-xs leading-relaxed text-foreground/90"
                      title={pluginDescription}
                    >
                      {pluginDescription}
                    </p>
                  ) : null}
                  <PluginMetaLine
                    parts={[
                      pluginDeveloperName,
                      pluginVersion ? `v${pluginVersion}` : undefined,
                      item.plugin.availableVersion
                        ? `v${item.plugin.availableVersion} available`
                        : undefined,
                      item.plugin.category,
                      item.plugin.marketplaceName,
                    ]}
                  />
                  {pluginDetail.status === "ready" ? (
                    <PluginTokenCost detail={pluginDetail.detail} />
                  ) : null}
                </div>
                <PluginComponents
                  state={pluginDetail}
                  provider={item.provider}
                  onSelectTarget={selectComponentTarget}
                  onRetry={() => setPluginDetailAttempt((attempt) => attempt + 1)}
                />
                <details className="group border-t border-border/50 pt-3">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
                    Provenance
                  </summary>
                  <dl className="mt-1">
                    <DetailRow label="ID" value={item.plugin.id} copyValue={item.plugin.id} />
                    <DetailRow label="Name" value={item.plugin.name} copyValue={item.plugin.name} />
                    <DetailRow label="Display" value={item.plugin.displayName} />
                    <DetailRow
                      label="Website"
                      value={item.plugin.websiteUrl}
                      copyValue={item.plugin.websiteUrl}
                    />
                    <DetailRow
                      label="Repository"
                      value={pluginDetailValue?.repositoryUrl}
                      copyValue={pluginDetailValue?.repositoryUrl}
                    />
                    <DetailRow label="License" value={pluginDetailValue?.license} />
                    <DetailRow
                      label="Share URL"
                      value={pluginDetailValue?.shareUrl}
                      copyValue={pluginDetailValue?.shareUrl}
                    />
                    <DetailRow label="Installed" value={formatBoolean(item.plugin.installed)} />
                    <DetailRow label="Enabled" value={formatBoolean(item.plugin.enabled)} />
                    <DetailRow label="Auth Policy" value={item.plugin.authPolicy} />
                    <DetailRow label="Install Policy" value={item.plugin.installPolicy} />
                    <DetailRow label="Availability" value={item.plugin.availability} />
                    <DetailRow label="Marketplace" value={item.plugin.marketplaceName} />
                    <DetailRow
                      label="Install Path"
                      value={item.plugin.installPath}
                      copyValue={item.plugin.installPath}
                    />
                    <DetailRow label="Installed At" value={item.plugin.installedAt} />
                    <DetailRow label="Last Updated" value={item.plugin.lastUpdated} />
                    <DetailRow
                      label="Install Count"
                      value={
                        item.plugin.installCount !== undefined
                          ? String(item.plugin.installCount)
                          : undefined
                      }
                    />
                    <DetailRow
                      label="Project Path"
                      value={item.plugin.projectPath}
                      copyValue={item.plugin.projectPath}
                    />
                    <DetailRow
                      label="Market Path"
                      value={item.plugin.marketplacePath}
                      copyValue={item.plugin.marketplacePath}
                    />
                    <DetailRow label="Scope" value={item.plugin.scope} />
                    <DetailRow
                      label="Source"
                      value={item.plugin.source}
                      copyValue={item.plugin.source}
                    />
                  </dl>
                </details>
              </div>
            ) : null}
            {item.kind !== "plugin" ? (
              <dl className="rounded-md border border-border/60 bg-background px-3">
                {item.kind === "skill" ? (
                  <>
                    <DetailRow label="Name" value={item.skill.name} copyValue={item.skill.name} />
                    <DetailRow label="Display" value={item.skill.displayName} />
                    <DetailRow label="Summary" value={item.skill.shortDescription} />
                    <DetailRow label="Description" value={item.skill.description} />
                    <DetailRow label="Enabled" value={formatBoolean(item.skill.enabled)} />
                    <DetailRow
                      label="Bundle"
                      value={item.skill.bundleId ? skillBundleLabel(item.skill) : undefined}
                    />
                    <DetailRow
                      label="Bundle ID"
                      value={item.skill.bundleId}
                      copyValue={item.skill.bundleId}
                    />
                    <DetailRow label="Scope" value={item.skill.scope} />
                    <DetailRow label="Source" value={item.skill.source} />
                    <DetailRow label="Path" value={item.skill.path} copyValue={item.skill.path} />
                  </>
                ) : null}
                {item.kind === "mcp" ? (
                  <>
                    <DetailRow label="Name" value={item.server.name} copyValue={item.server.name} />
                    <DetailRow label="Status" value={item.server.status} />
                    <DetailRow label="Auth" value={item.server.authStatus} />
                    <DetailRow label="Transport" value={item.server.transport} />
                    <DetailRow label="Tool Count" value={String(item.server.toolCount ?? 0)} />
                    <DetailRow label="Resources" value={String(item.server.resourceCount ?? 0)} />
                    <DetailRow label="Detail" value={item.server.detail} />
                    <DetailRow
                      label="Managed By"
                      value={managedClaudePlugin ? `${managedClaudePlugin.name} plugin` : undefined}
                      copyValue={managedClaudePlugin?.id}
                    />
                  </>
                ) : null}
                {item.kind === "app" ? (
                  <>
                    <DetailRow label="ID" value={item.app.id} copyValue={item.app.id} />
                    <DetailRow label="Name" value={item.app.name} copyValue={item.app.name} />
                    <DetailRow label="Display" value={item.app.displayName} />
                    <DetailRow label="Description" value={item.app.description} />
                    <DetailRow label="Enabled" value={formatBoolean(item.app.enabled)} />
                    <DetailRow label="Accessible" value={formatBoolean(item.app.accessible)} />
                  </>
                ) : null}
              </dl>
            ) : null}
            {item.kind === "skill" ? (
              <section className="space-y-2 border-t border-border/50 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                    Contents
                  </h3>
                  {skillContents.status === "ready" ? (
                    <div className="flex items-center gap-1.5">
                      {skillContents.truncated ? (
                        <Badge size="sm" variant="outline">
                          Truncated
                        </Badge>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => copyText(skillContents.contents, "Skill")}
                      >
                        <CopyIcon className="size-3" />
                        Copy
                      </Button>
                    </div>
                  ) : null}
                </div>
                {skillContents.status === "loading" ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderIcon className="size-3.5 animate-spin" />
                    Reading skill
                  </div>
                ) : null}
                {skillContents.status === "error" ? (
                  <div className="text-xs text-muted-foreground">{skillContents.message}</div>
                ) : null}
                {skillContents.status === "ready" ? (
                  <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-background p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {skillContents.contents}
                  </pre>
                ) : null}
              </section>
            ) : null}
            {item.kind === "mcp" ? (
              <>
                <ExtensionToolsList tools={mcpTools} onSelectTool={selectTool} />
                <ExtensionResourcesList server={item.server} onReadResource={readResource} />
                {selectedTool ? (
                  <div className="space-y-2 border-t border-border/50 pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                          Tool call
                        </div>
                        <div className="truncate font-mono text-[11px] text-foreground/80">
                          {selectedTool.name}
                        </div>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busyAction !== null || !providerThreadId.trim()}
                        onClick={runSelectedTool}
                      >
                        {busyAction === "Run tool" ? (
                          <LoaderIcon className="size-3.5 animate-spin" />
                        ) : (
                          <PlayIcon className="size-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                    {selectedToolFormFields ? (
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          variant={toolArgumentMode === "form" ? "default" : "outline"}
                          onClick={() => setToolArgumentMode("form")}
                        >
                          Form
                        </Button>
                        <Button
                          size="xs"
                          variant={toolArgumentMode === "json" ? "default" : "outline"}
                          onClick={() => setToolArgumentMode("json")}
                        >
                          JSON
                        </Button>
                      </div>
                    ) : null}
                    {toolArgumentMode === "form" && selectedToolFormFields ? (
                      <div className="grid gap-2 rounded-md border border-border/60 bg-background p-3">
                        {selectedToolFormFields.map((field) => {
                          const value = toolFormValues[field.name];
                          return (
                            <label key={field.name} className="grid gap-1.5">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-mono text-[11px] font-medium text-foreground/90">
                                  {field.name}
                                </span>
                                {field.required ? (
                                  <Badge size="sm" variant="outline">
                                    required
                                  </Badge>
                                ) : null}
                              </span>
                              {field.description ? (
                                <span className="text-[11px] text-muted-foreground/70">
                                  {field.description}
                                </span>
                              ) : null}
                              {field.type === "boolean" ? (
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={value === true}
                                    onCheckedChange={(checked) =>
                                      setToolFormValues((current) => ({
                                        ...current,
                                        [field.name]: Boolean(checked),
                                      }))
                                    }
                                    aria-label={field.name}
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    {value === true ? "True" : "False"}
                                  </span>
                                </div>
                              ) : field.type === "json" ? (
                                <Textarea
                                  size="sm"
                                  spellCheck={false}
                                  value={typeof value === "string" ? value : ""}
                                  onChange={(event) =>
                                    setToolFormValues((current) => ({
                                      ...current,
                                      [field.name]: event.currentTarget.value,
                                    }))
                                  }
                                  className="font-mono text-xs"
                                  aria-label={`${field.name} JSON`}
                                />
                              ) : field.enumValues ? (
                                <Select
                                  value={typeof value === "string" ? value : ""}
                                  onValueChange={(nextValue) =>
                                    setToolFormValues((current) => ({
                                      ...current,
                                      [field.name]: nextValue ?? "",
                                    }))
                                  }
                                >
                                  <SelectTrigger className="w-full" aria-label={field.name}>
                                    <SelectValue>
                                      {typeof value === "string" && value
                                        ? value
                                        : `Select ${field.name}`}
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectPopup align="start" alignItemWithTrigger={false}>
                                    {field.enumValues.map((enumValue) => (
                                      <SelectItem key={enumValue} value={enumValue}>
                                        {enumValue}
                                      </SelectItem>
                                    ))}
                                  </SelectPopup>
                                </Select>
                              ) : (
                                <Input
                                  nativeInput
                                  type={field.type === "number" ? "number" : "text"}
                                  value={typeof value === "string" ? value : ""}
                                  onChange={(event) =>
                                    setToolFormValues((current) => ({
                                      ...current,
                                      [field.name]: event.currentTarget.value,
                                    }))
                                  }
                                  aria-label={field.name}
                                />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <Textarea
                        size="sm"
                        spellCheck={false}
                        value={toolArguments}
                        onChange={(event) => setToolArguments(event.currentTarget.value)}
                        className="font-mono text-xs"
                        aria-label="Tool arguments JSON"
                      />
                    )}
                  </div>
                ) : null}
              </>
            ) : null}
            <ExtensionActionSummary entry={lastAction} />
            <ExtensionActionOutput value={actionOutput} />
          </DialogPanel>
          <DialogFooter>
            {(codexActionsAvailable || claudeActionsAvailable) && item.kind === "mcp" ? (
              <>
                {mcpOAuthActionAvailable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={startMcpOAuth}
                  >
                    {busyAction === mcpOAuthActionLabel ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <KeyRoundIcon className="size-3.5" />
                    )}
                    {mcpOAuthActionLabel}
                  </Button>
                ) : null}
                {codexActionsAvailable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={reloadMcp}
                  >
                    {busyAction === "Reload MCP" ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3.5" />
                    )}
                    Reload MCP
                  </Button>
                ) : null}
                {mcpOAuthActionAvailable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      copyText(
                        providerMcpLoginCommand(mcpLoginProviderForItem(item), item.server.name),
                        "Terminal login command",
                      )
                    }
                  >
                    <TerminalIcon className="size-3.5" />
                    Copy login
                  </Button>
                ) : null}
              </>
            ) : null}
            {item.kind === "skill" && item.skill.canToggle === true ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={toggleSkill}
              >
                {busyAction === "Enable skill" || busyAction === "Disable skill" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <PowerIcon className="size-3.5" />
                )}
                {item.skill.enabled === false ? "Enable" : "Disable"}
              </Button>
            ) : null}
            {item.kind === "skill" && item.skill.canDelete === true ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={deleteSkill}
              >
                {busyAction === "Delete skill" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                Delete
              </Button>
            ) : null}
            {codexActionsAvailable && item.kind === "plugin" ? (
              <>
                {item.plugin.installed === true ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={togglePlugin}
                    >
                      {busyAction === "Enable plugin" || busyAction === "Disable plugin" ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <PowerIcon className="size-3.5" />
                      )}
                      {item.plugin.enabled === false ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={uninstallPlugin}
                    >
                      {busyAction === "Uninstall plugin" ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <PackageMinusIcon className="size-3.5" />
                      )}
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={installPlugin}
                  >
                    {busyAction === "Install plugin" ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <PackagePlusIcon className="size-3.5" />
                    )}
                    Install
                  </Button>
                )}
              </>
            ) : null}
            {claudeActionsAvailable && item.kind === "plugin" ? (
              <>
                {item.plugin.installed === true ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={togglePlugin}
                    >
                      {busyAction === "Enable plugin" || busyAction === "Disable plugin" ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <PowerIcon className="size-3.5" />
                      )}
                      {item.plugin.enabled === false ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={updatePlugin}
                    >
                      {busyAction === "Update plugin" ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCwIcon className="size-3.5" />
                      )}
                      Update
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={uninstallPlugin}
                    >
                      {busyAction === "Uninstall plugin" ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <PackageMinusIcon className="size-3.5" />
                      )}
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={installPlugin}
                  >
                    {busyAction === "Install plugin" ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <PackagePlusIcon className="size-3.5" />
                    )}
                    Install
                  </Button>
                )}
              </>
            ) : null}
            {claudeActionsAvailable && item.kind === "mcp" && managedClaudePlugin ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={readManagedClaudePlugin}
                >
                  {busyAction === "Plugin details" ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <WrenchIcon className="size-3.5" />
                  )}
                  Plugin details
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={toggleManagedClaudePlugin}
                >
                  {busyAction === "Enable plugin" || busyAction === "Disable plugin" ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PowerIcon className="size-3.5" />
                  )}
                  {managedClaudePlugin.enabled === false ? "Enable plugin" : "Disable plugin"}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={uninstallManagedClaudePlugin}
                >
                  {busyAction === "Uninstall plugin" ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PackageMinusIcon className="size-3.5" />
                  )}
                  Uninstall plugin
                </Button>
              </>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-7 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      copyText(
                        extensionClipboardDetails(item),
                        `${extensionKindLabel(item.kind)} metadata`,
                      )
                    }
                    aria-label={`Copy ${extensionKindLabel(item.kind).toLowerCase()} metadata`}
                  >
                    <CopyIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Copy metadata</TooltipPopup>
            </Tooltip>
            {openPath ? (
              <Button size="xs" onClick={() => openPathInEditor(openPath)}>
                <ExternalLinkIcon className="size-3.5" />
                Open path
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

/** A count the provider capped at our page size is a floor, not a total. */
function formatSectionTotal(total: number, isTruncated: boolean | undefined): string {
  return isTruncated ? `${total}+` : String(total);
}

function ExtensionPreviewSection({
  title,
  environmentId,
  isTruncated,
  previewLimit,
  items,
  totalCount,
  emptyLabel,
  statusMessage,
  loadLabel,
  isLoading,
  onLoad,
  filterText,
  onSelect,
  panelId,
  browseLabel,
  browseAvailable,
  onBrowse,
}: {
  title: string;
  environmentId: EnvironmentId | null;
  isTruncated?: boolean | undefined;
  previewLimit?: number | undefined;
  items: ReadonlyArray<ExtensionItem>;
  totalCount: number;
  emptyLabel: string;
  statusMessage?: string | undefined;
  loadLabel?: string | undefined;
  isLoading?: boolean | undefined;
  onLoad?: (() => void) | undefined;
  filterText: string;
  onSelect: (item: ExtensionItem) => void;
  panelId: string;
  browseLabel: string;
  /** The Browse dialog has content beyond the visible items (e.g. an uninstalled catalog). */
  browseAvailable?: boolean | undefined;
  onBrowse: () => void;
}) {
  const isFiltering = filterText.trim().length > 0;
  const visibleItems = items.slice(0, previewLimit ?? EXTENSION_SECTION_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div
      id={panelId}
      role="tabpanel"
      className="min-w-0 rounded-md border border-border/60 bg-background/35"
    >
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
            {title}
          </div>
          {totalCount > 0 ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground/65">
              {isFiltering
                ? `${items.length} matching ${formatSectionTotal(totalCount, isTruncated)} total`
                : `${formatSectionTotal(totalCount, isTruncated)} total`}
            </div>
          ) : null}
        </div>
        {isLoading ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
            <LoaderIcon className="size-3 animate-spin" />
            Loading
          </span>
        ) : totalCount > 0 ? (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {visibleItems.length === items.length
              ? `${items.length}`
              : `${visibleItems.length}/${items.length}`}
          </span>
        ) : null}
      </div>
      {visibleItems.length > 0 ? (
        <>
          {/* Two columns: skills and apps are short-titled and numerous, so a single column is
              mostly empty space and twice the scrolling. */}
          <div className="grid lg:grid-cols-2">
            {visibleItems.map((item) => (
              <button
                key={`${item.kind}:${item.id}`}
                className="group flex min-h-10 w-full items-center gap-2 border-t border-border/40 px-3 py-2 text-left transition-colors first:border-t-0 hover:bg-accent/55 focus-ring sm:[&:nth-child(2)]:border-t-0"
                onClick={() => onSelect(item)}
                type="button"
              >
                <ExtensionItemGlyph item={item} environmentId={environmentId} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                  {item.detail ? (
                    <div className="truncate text-[11px] text-muted-foreground/70">
                      {item.detail}
                    </div>
                  ) : null}
                </div>
                <ExtensionItemBadges item={item} />
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
              </button>
            ))}
          </div>
          {items.length > 0 ? (
            <button
              className="w-full border-t border-border/50 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-ring"
              onClick={onBrowse}
              type="button"
            >
              {hiddenCount > 0 ? `${browseLabel} (${hiddenCount} more)` : browseLabel}
            </button>
          ) : null}
        </>
      ) : (
        <div className="px-3 py-2">
          <EmptyList label={isFiltering && totalCount > 0 ? "No matches." : emptyLabel} />
          {statusMessage && !isFiltering ? (
            <div className="mt-1 text-[11px] text-muted-foreground/70">{statusMessage}</div>
          ) : null}
          {loadLabel && !isFiltering ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              disabled={isLoading}
              onClick={onLoad}
            >
              {isLoading ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              {loadLabel}
            </Button>
          ) : null}
          {totalCount > 0 || browseAvailable ? (
            <Button size="xs" variant="outline" className="mt-2" onClick={onBrowse}>
              {browseLabel}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const EXTENSION_BROWSER_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: ExtensionBrowserFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "installed", label: "Installed" },
  { value: "needs-auth", label: "Needs auth" },
  { value: "official", label: "Official" },
  { value: "local", label: "Local" },
];

const EXTENSION_BROWSER_SORT_OPTIONS: ReadonlyArray<{
  readonly value: ExtensionBrowserSort;
  readonly label: string;
}> = [
  { value: "recommended", label: "Recommended" },
  { value: "bundle", label: "Bundle" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "category", label: "Category" },
];

function defaultExtensionBrowserSort(section: ExtensionSectionConfig | null): ExtensionBrowserSort {
  return section?.key === "skills" ? "bundle" : "recommended";
}

function groupExtensionItems(
  items: ReadonlyArray<ExtensionItem>,
  sort: ExtensionBrowserSort,
): ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<ExtensionItem>;
}> {
  const groups = new Map<string, ExtensionItem[]>();
  for (const item of items) {
    const key = extensionItemGroupKey(item, sort);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    label: groupItems[0] ? extensionItemGroupLabel(groupItems[0]) : key,
    items: groupItems,
  }));
}

interface ExtensionSkillBundleControl {
  readonly kind: "plugin" | "skills";
  readonly provider: ProviderExtensionProviderInventory;
  readonly plugin: ProviderExtensionPlugin;
  readonly label: string;
  readonly skillCount: number;
  readonly busyKey: string;
  readonly badgeLabel: string;
  readonly badgeVariant: "outline" | "success";
  readonly actionLabel: string;
  readonly nextEnabled: boolean;
  readonly skills?: ReadonlyArray<ProviderExtensionSkill> | undefined;
}

function skillBundleControlForGroup(
  items: ReadonlyArray<ExtensionItem>,
  filter: ExtensionBrowserFilter,
): ExtensionSkillBundleControl | null {
  const skillItems = items.filter(
    (item): item is Extract<ExtensionItem, { kind: "skill" }> => item.kind === "skill",
  );
  if (skillItems.length !== items.length || skillItems.length === 0) return null;

  const first = skillItems[0]!;
  const bundleId = first.skill.bundleId?.trim();
  if (!bundleId) return null;
  if (skillItems.some((item) => item.skill.bundleId !== bundleId)) return null;

  const plugin = skillBundlePlugin(first);
  if (!plugin || plugin.installed !== true) return null;
  const visibleDisabledCount = skillItems.filter((item) => item.skill.enabled === false).length;
  const visibleEnabledCount = skillItems.filter((item) => item.skill.enabled !== false).length;
  const label = skillBundleLabel(first.skill);

  if (filter === "disabled" && visibleDisabledCount > 0) {
    return {
      kind: "skills",
      provider: first.provider,
      plugin,
      label,
      skillCount: visibleDisabledCount,
      busyKey: `${plugin.id}:visible-disabled`,
      badgeLabel: "Off",
      badgeVariant: "outline",
      actionLabel: "Enable",
      nextEnabled: true,
      skills: skillItems.map((item) => item.skill),
    };
  }

  if (filter === "enabled" && visibleEnabledCount > 0) {
    return {
      kind: "skills",
      provider: first.provider,
      plugin,
      label,
      skillCount: visibleEnabledCount,
      busyKey: `${plugin.id}:visible-enabled`,
      badgeLabel: "On",
      badgeVariant: "success",
      actionLabel: "Disable",
      nextEnabled: false,
      skills: skillItems.map((item) => item.skill),
    };
  }

  const pluginEnabled = plugin.enabled !== false;

  return {
    kind: "plugin",
    provider: first.provider,
    plugin,
    label,
    skillCount: skillItems.length,
    busyKey: plugin.id,
    badgeLabel: pluginEnabled ? "On" : "Off",
    badgeVariant: pluginEnabled ? "success" : "outline",
    actionLabel: pluginEnabled ? "Disable" : "Enable",
    nextEnabled: !pluginEnabled,
  };
}

function ExtensionItemGlyph({
  item,
  environmentId,
  sizeClassName = "size-4",
  containerClassName,
}: {
  item: ExtensionItem;
  environmentId: EnvironmentId | null;
  sizeClassName?: string;
  /** Wraps the kind glyph only. Real plugin artwork brings its own tile. */
  containerClassName?: string | undefined;
}) {
  const glyphClassName = containerClassName
    ? "size-4 shrink-0 text-muted-foreground/45"
    : `${sizeClassName} shrink-0 text-muted-foreground/45`;
  const fallbackClassName = glyphClassName;
  const fallback =
    item.kind === "skill" ? (
      <FileTextIcon className={fallbackClassName} />
    ) : item.kind === "mcp" ? (
      <DatabaseIcon className={fallbackClassName} />
    ) : item.kind === "app" ? (
      <BotIcon className={fallbackClassName} />
    ) : (
      <PlugIcon className={fallbackClassName} />
    );

  const wrappedFallback = containerClassName ? (
    <span className={containerClassName}>{fallback}</span>
  ) : (
    fallback
  );

  if (item.kind !== "plugin") return wrappedFallback;
  return (
    <PluginIcon
      environmentId={environmentId}
      iconUrl={item.plugin.iconUrl}
      iconPath={item.plugin.iconPath}
      fallback={wrappedFallback}
      sizeClassName={sizeClassName}
    />
  );
}

/**
 * Everything installed, as logos. A dozen icons in one line answers "what do I have" faster than a
 * dozen text rows, and it is the one place a plugin's identity is worth more than its metadata.
 */
function InstalledStrip({
  items,
  environmentId,
  onSelect,
}: {
  items: ReadonlyArray<ExtensionItem>;
  environmentId: EnvironmentId | null;
  onSelect: (item: ExtensionItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Tooltip key={`${item.provider.instanceId}:${item.id}`}>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-md transition-opacity hover:opacity-80 focus-ring"
                onClick={() => onSelect(item)}
                aria-label={item.title}
              >
                {/* Plugin artwork already ships its own tile and background, so wrapping it in
                    another square just shrinks it and fights whatever the icon draws. Only the
                    fallback needs a container of ours. */}
                <PluginIcon
                  environmentId={environmentId}
                  iconUrl={item.kind === "plugin" ? item.plugin.iconUrl : undefined}
                  iconPath={item.kind === "plugin" ? item.plugin.iconPath : undefined}
                  sizeClassName="size-9"
                  fallback={
                    <span className="inline-flex size-9 items-center justify-center rounded-md border border-border/60 bg-muted/40">
                      <PlugIcon className="size-4 shrink-0 text-muted-foreground/45" />
                    </span>
                  }
                />
              </button>
            }
          />
          <TooltipPopup side="bottom">{item.title}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function InstalledStripSkeleton() {
  return (
    <div className="flex flex-wrap gap-1.5" aria-hidden="true">
      {["first", "second", "third", "fourth", "fifth", "sixth"].map((key) => (
        <Skeleton key={key} className="size-9 rounded-md" />
      ))}
    </div>
  );
}

function SkillListSkeleton() {
  return (
    <div aria-hidden="true" data-testid="extensions-skills-skeleton">
      {["first-skill", "second-skill", "third-skill", "fourth-skill"].map((rowKey) => (
        <div
          key={rowKey}
          className="flex min-h-11 items-center gap-2.5 border-t border-border/40 px-4 py-2.5 first:border-t-0 sm:px-5"
        >
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28 max-w-full rounded-full" />
            <Skeleton className="h-2.5 w-48 max-w-full rounded-full" />
          </div>
          <Skeleton className="h-4 w-8 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function ConnectionsTableSkeleton() {
  return (
    <div aria-hidden="true" data-testid="extensions-connections-skeleton">
      <div className="grid grid-cols-[minmax(0,1fr)_9rem_8rem] gap-3 border-b border-border/50 pb-1.5">
        <Skeleton className="h-2.5 w-20 max-w-full rounded-full" />
        <Skeleton className="h-2.5 w-10 max-w-full rounded-full" />
        <Skeleton className="h-2.5 w-12 max-w-full rounded-full" />
      </div>
      {["first-connection", "second-connection"].map((rowKey) => (
        <div
          key={rowKey}
          className="grid min-h-11 grid-cols-[minmax(0,1fr)_9rem_8rem] items-center gap-3 border-t border-border/40 py-2 first:border-t-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Skeleton className="size-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-3 w-32 max-w-full rounded-full" />
          </span>
          <Skeleton className="h-3 w-20 max-w-full rounded-full" />
          <Skeleton className="h-3 w-16 max-w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

interface ExtensionAttentionEntry {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly item?: ExtensionItem | undefined;
}

/** Things that are broken or half-configured, above the fold instead of inside a collapsed panel. */
function NeedsAttention({
  entries,
  onSelect,
}: {
  entries: ReadonlyArray<ExtensionAttentionEntry>;
  onSelect: (item: ExtensionItem) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-semibold uppercase text-muted-foreground/70">
        Needs attention
      </h3>
      <div>
        {entries.map((entry) => {
          const body = (
            <>
              <KeyRoundIcon className="size-3.5 shrink-0 text-warning-foreground/80" />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.title}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                {entry.detail}
              </span>
            </>
          );
          return entry.item ? (
            <button
              key={entry.key}
              type="button"
              className="flex w-full min-w-0 items-center gap-2 border-t border-border/40 py-2 text-left transition-colors first:border-t-0 hover:bg-accent/40 focus-ring"
              onClick={() => entry.item && onSelect(entry.item)}
            >
              {body}
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
            </button>
          ) : (
            <div
              key={entry.key}
              className="flex min-w-0 items-center gap-2 border-t border-border/40 py-2 first:border-t-0"
            >
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * One table over every provider's MCP servers. The origin column is the point: a connection that
 * arrived with a plugin should say so and lead back to it, rather than looking hand-configured.
 */
function ConnectionsTable({
  items,
  environmentId,
  isLoading,
  onSelect,
}: {
  items: ReadonlyArray<ExtensionItem>;
  environmentId: EnvironmentId | null;
  isLoading: boolean;
  onSelect: (item: ExtensionItem) => void;
}) {
  if (items.length === 0) {
    // Do not assert emptiness while the inventory is still arriving.
    return isLoading ? (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <LoaderIcon className="size-3.5 animate-spin" />
        Reading connections
      </div>
    ) : (
      <div className="py-2 text-xs text-muted-foreground">No connections configured.</div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_9rem_8rem] gap-3 border-b border-border/50 pb-1.5 text-[11px] font-semibold uppercase text-muted-foreground/70">
        <span>Connection</span>
        <span>Type</span>
        <span>Status</span>
      </div>
      {items.map((item) => {
        if (item.kind !== "mcp") return null;
        const origin = item.server.origin;
        const needsAuth = extensionItemNeedsAuth(item);
        return (
          <button
            key={`${item.provider.instanceId}:${item.id}`}
            type="button"
            className="grid w-full grid-cols-[minmax(0,1fr)_9rem_8rem] items-center gap-3 border-t border-border/40 py-2 text-left transition-colors first:border-t-0 hover:bg-accent/40 focus-ring"
            onClick={() => onSelect(item)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ExtensionItemGlyph item={item} environmentId={environmentId} />
              <span className="min-w-0">
                <span className="block truncate text-xs text-foreground">{item.title}</span>
                {origin?.kind === "plugin" ? (
                  <span className="block truncate text-[11px] text-muted-foreground/70">
                    Provided by the {origin.pluginName ?? origin.pluginId} plugin
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs text-foreground/90">
                {providerTitle(item.provider)}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                {item.server.transport ? (
                  <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                    {item.server.transport}
                  </span>
                ) : null}
                {origin?.kind === "plugin" ? (
                  <Badge size="sm" variant="outline">
                    Plugin
                  </Badge>
                ) : null}
              </span>
            </span>
            <span className="min-w-0">
              {needsAuth ? (
                <Badge size="sm" variant="warning">
                  Needs auth
                </Badge>
              ) : (
                <span className="truncate text-[11px] text-muted-foreground/70">
                  {item.server.status ?? "Ready"}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Marketplaces sit between installed plugins and the catalog, because they are what turns one into
 * the other. Provider-managed catalogs are shown but not removable.
 */
function MarketplacesBlock({
  provider,
  cwd,
  onMutated,
}: {
  provider: ProviderExtensionProviderInventory;
  cwd: string;
  onMutated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const providersApi = useScopedProvidersApi();
  const [isAdding, setIsAdding] = useState(false);
  const [source, setSource] = useState("");

  const run = useCallback(
    async (label: string, action: () => Promise<string | undefined>) => {
      setBusy(label);
      try {
        const message = await action();
        toastManager.add({
          type: "success",
          title: label,
          description: message ?? "Done.",
        });
        await onMutated();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${label} failed`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setBusy(null);
      }
    },
    [onMutated],
  );

  const baseInput = {
    ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
    providerInstanceId: provider.instanceId,
  };

  return (
    <section className="space-y-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase text-muted-foreground/70">
          {providerTitle(provider)}
        </h3>
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void run("Update marketplaces", async () => {
                const result = await providersApi().refreshExtensionPluginMarketplaces(baseInput);
                return result.errors?.length
                  ? result.errors.join(" ")
                  : (result.refreshedMarketplaces?.join(", ") ?? result.output);
              })
            }
          >
            {busy === "Update marketplaces" ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Update all
          </Button>
          <Button size="xs" variant="outline" onClick={() => setIsAdding((value) => !value)}>
            <PackagePlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
      </div>
      {isAdding ? (
        <div className="flex gap-2">
          <Input
            nativeInput
            value={source}
            placeholder="Git URL, owner/repo, or local path"
            aria-label="Marketplace source"
            onChange={(event) => setSource(event.currentTarget.value)}
          />
          <Button
            size="xs"
            disabled={busy !== null || source.trim().length === 0}
            onClick={() =>
              void run("Add marketplace", async () => {
                const result = await providersApi().addExtensionMarketplace({
                  ...baseInput,
                  source: source.trim(),
                });
                setSource("");
                setIsAdding(false);
                return result.message ?? `Added ${result.name ?? source.trim()}.`;
              })
            }
          >
            Add
          </Button>
        </div>
      ) : null}
      {provider.marketplaces.length === 0 ? (
        <div className="text-xs text-muted-foreground">No marketplaces configured.</div>
      ) : (
        <div>
          {provider.marketplaces.map((marketplace) => (
            <div
              key={marketplace.name}
              className="flex min-w-0 items-center gap-3 border-t border-border/40 py-2 first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground">
                  {marketplace.displayName ?? marketplace.name}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground/70">
                  {[
                    marketplace.remote ? "remote catalog" : marketplace.source,
                    marketplace.pluginCount !== undefined
                      ? `${marketplace.pluginCount} plugins`
                      : undefined,
                    marketplace.installedPluginCount
                      ? `${marketplace.installedPluginCount} installed`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {marketplace.loadError ? (
                  <div className="truncate text-[11px] text-destructive">
                    {marketplace.loadError}
                  </div>
                ) : null}
              </div>
              {marketplace.removable ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`Remove ${marketplace.name}`, async () => {
                      const confirmed = await ensureLocalApi().dialogs.confirm(
                        `Remove ${marketplace.name}?`,
                      );
                      if (!confirmed) return "Cancelled.";
                      await providersApi().removeExtensionMarketplace({
                        ...baseInput,
                        name: marketplace.name,
                      });
                      return `Removed ${marketplace.name}.`;
                    })
                  }
                >
                  <PackageMinusIcon className="size-3.5" />
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ExtensionBrowserItemRow({
  item,
  groupLabel,
  environmentId,
  showProvider,
  onSelect,
}: {
  item: ExtensionItem;
  groupLabel?: string | undefined;
  environmentId: EnvironmentId | null;
  showProvider: boolean;
  onSelect: (item: ExtensionItem) => void;
}) {
  return (
    <button
      type="button"
      className="group grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/45 focus-ring"
      onClick={() => onSelect(item)}
    >
      {/* Catalog rows are two lines tall, so the artwork carries the row rather than
          sitting in it as an afterthought. */}
      <ExtensionItemGlyph
        item={item}
        environmentId={environmentId}
        sizeClassName="size-8"
        containerClassName="inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-muted/40"
      />
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
          {groupLabel ? (
            <span className="hidden max-w-44 shrink-0 truncate rounded-sm bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/75 sm:inline-block">
              {groupLabel}
            </span>
          ) : null}
        </div>
        {item.detail ? (
          <div className="truncate text-[11px] text-muted-foreground/70">{item.detail}</div>
        ) : null}
      </div>
      <ExtensionItemBadges item={item} showProvider={showProvider} />
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function ExtensionBrowserDialog({
  section,
  providerLabel,
  initialQuery,
  environmentId,
  onClose,
  onSelect,
  onToggleSkillBundle,
}: {
  section: ExtensionSectionConfig | null;
  providerLabel: string;
  initialQuery: string;
  environmentId: EnvironmentId | null;
  onClose: () => void;
  onSelect: (item: ExtensionItem) => void;
  onToggleSkillBundle: (bundle: ExtensionSkillBundleControl) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExtensionBrowserFilter>("all");
  const [sort, setSort] = useState<ExtensionBrowserSort>("recommended");
  const [visibleLimit, setVisibleLimit] = useState(EXTENSION_BROWSER_PAGE_SIZE);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [busyBundleId, setBusyBundleId] = useState<string | null>(null);
  const [showEntireCatalog, setShowEntireCatalog] = useState(false);
  const sortOptions = useMemo(
    () =>
      EXTENSION_BROWSER_SORT_OPTIONS.filter(
        (option) => option.value !== "bundle" || section?.key === "skills",
      ),
    [section?.key],
  );

  useEffect(() => {
    setQuery(initialQuery);
    setFilter("all");
    setSort(defaultExtensionBrowserSort(section));
    setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
    setCollapsedGroups({});
    setBusyBundleId(null);
    setShowEntireCatalog(false);
  }, [initialQuery, section?.key]);

  const browseSourceItems = section?.browseItems ?? section?.items ?? [];
  const spansProviders =
    new Set(browseSourceItems.map((item) => String(item.provider.instanceId))).size > 1;
  const matchingItems = useMemo(
    () => filterExtensionItems(browseSourceItems, query),
    [browseSourceItems, query],
  );
  // Curation is only the opening view. Any explicit refinement — a search or a filter — means the
  // user asked for something specific, and answering it from a 50-item slice would be a lie.
  const isCurated =
    section?.key === "plugins" &&
    !showEntireCatalog &&
    filter === "all" &&
    shouldCuratePluginBrowse(browseSourceItems.length, query);
  const searchedItems = useMemo(
    () =>
      isCurated
        ? selectCuratedPlugins(matchingItems, (item) => ({
            providerId: String(item.provider.instanceId),
            ...(item.kind === "plugin"
              ? {
                  featured: item.plugin.featured,
                  installed: item.plugin.installed,
                  installCount: item.plugin.installCount,
                }
              : {}),
          }))
        : matchingItems,
    [isCurated, matchingItems],
  );
  // Counts describe the whole catalog, not the slice on screen: "Installed 0" while you have 18
  // installed reads as a fact about your machine rather than about this list.
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        EXTENSION_BROWSER_FILTER_OPTIONS.map((option) => [
          option.value,
          matchingItems.filter((item) => extensionItemMatchesBrowserFilter(item, option.value))
            .length,
        ]),
      ) as Record<ExtensionBrowserFilter, number>,
    [matchingItems],
  );
  const browserItems = useMemo(() => {
    const filtered = searchedItems.filter((item) =>
      extensionItemMatchesBrowserFilter(item, filter),
    );
    // "Recommended" over plugins means the same cross-provider ranking whether you are looking at
    // the opening slice or the whole catalog. Other sections have no popularity signal, so they
    // keep the triage order that puts problems first.
    if (sort !== "recommended") return sortExtensionItems(filtered, sort);
    if (section?.key !== "plugins") return sortExtensionItems(filtered, sort);
    return isCurated
      ? filtered
      : rankPluginsAcrossProviders(filtered, (item) => ({
          providerId: String(item.provider.instanceId),
          ...(item.kind === "plugin"
            ? {
                featured: item.plugin.featured,
                installed: item.plugin.installed,
                installCount: item.plugin.installCount,
              }
            : {}),
        }));
  }, [filter, isCurated, searchedItems, section?.key, sort]);
  const visibleItems = browserItems.slice(0, visibleLimit);
  const groups = useMemo(() => groupExtensionItems(visibleItems, sort), [sort, visibleItems]);
  const renderGroups =
    section?.key === "skills" && sort === "bundle"
      ? groups.length > 0
      : shouldRenderExtensionBrowserGroups(groups, sort);
  const hiddenCount = Math.max(0, browserItems.length - visibleItems.length);
  const nextVisibleCount = Math.min(EXTENSION_BROWSER_PAGE_SIZE, hiddenCount);
  const hasActiveRefinement =
    query.trim().length > 0 || filter !== "all" || sort !== defaultExtensionBrowserSort(section);

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  }, []);

  const toggleSkillBundle = useCallback(
    async (bundle: ExtensionSkillBundleControl) => {
      setBusyBundleId(bundle.busyKey);
      try {
        await onToggleSkillBundle(bundle);
        toastManager.add({
          type: "success",
          title:
            bundle.kind === "skills"
              ? bundle.nextEnabled
                ? "Skills enabled"
                : "Skills disabled"
              : bundle.nextEnabled
                ? "Bundle enabled"
                : "Bundle disabled",
          description:
            bundle.kind === "skills"
              ? `${bundle.label}: ${bundle.skillCount} visible skills updated.`
              : `${bundle.label} controls ${bundle.skillCount} skills.`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Bundle toggle failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setBusyBundleId((current) => (current === bundle.busyKey ? null : current));
      }
    },
    [onToggleSkillBundle],
  );

  return (
    <Dialog
      open={section !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {section ? (
        <DialogPopup className="max-h-[min(86vh,54rem)] max-w-5xl overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border/70 bg-background">
            <div className="flex min-w-0 items-start gap-3 pr-8">
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
                {section.icon}
              </span>
              <div className="min-w-0 space-y-1">
                <DialogTitle className="truncate text-base">
                  Browse {section.key === "plugins" ? "plugins" : section.title.toLowerCase()}
                </DialogTitle>
                <DialogDescription>
                  {isCurated
                    ? `${providerLabel} - featured and most installed. Search to reach all ${browseSourceItems.length}.`
                    : `${providerLabel} - ${browserItems.length} visible from ${browseSourceItems.length} total`}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="shrink-0 space-y-3 border-b border-border/70 bg-muted/15 px-6 py-4">
            <div className="grid gap-2 lg:grid-cols-[minmax(14rem,1fr)_12rem]">
              <div className="relative min-w-0">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  nativeInput
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
                  }}
                  placeholder={`Search ${section.title.toLowerCase()}`}
                  className="w-full [&_[data-slot=input]]:pl-8"
                  aria-label={`Search ${section.title.toLowerCase()}`}
                />
              </div>
              <Select
                value={sort}
                onValueChange={(value) => {
                  setSort(value as ExtensionBrowserSort);
                  setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Sort plugins">
                  <SelectValue>
                    {sortOptions.find((option) => option.value === sort)?.label ?? "Recommended"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {sortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXTENSION_BROWSER_FILTER_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  size="xs"
                  variant={filter === option.value ? "outline" : "ghost"}
                  className={cn(
                    "h-7 rounded-sm px-2 text-[11px]",
                    filter === option.value
                      ? "border-primary/35 bg-accent/70 text-foreground shadow-none"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  data-pressed={filter === option.value ? "" : undefined}
                  onClick={() => {
                    setFilter(option.value);
                    setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
                  }}
                >
                  {isCurated && option.value === "all" ? "Featured" : option.label}
                  <span className="font-mono tabular-nums text-foreground/80">
                    {isCurated && option.value === "all"
                      ? searchedItems.length
                      : filterCounts[option.value]}
                  </span>
                </Button>
              ))}
              {hasActiveRefinement ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                    setSort(defaultExtensionBrowserSort(section));
                    setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
                    setCollapsedGroups({});
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
          {isCurated ? (
            <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border/60 bg-muted/10 px-6 py-2 text-[11px] text-muted-foreground">
              <span>
                Showing {searchedItems.length} featured and most-installed plugins. Search, or
              </span>
              <button
                type="button"
                className="font-medium text-foreground underline-offset-2 hover:underline focus-ring"
                onClick={() => {
                  setShowEntireCatalog(true);
                  setSort("category");
                  setVisibleLimit(EXTENSION_BROWSER_PAGE_SIZE);
                }}
              >
                browse all {browseSourceItems.length} by category
              </button>
            </div>
          ) : null}
          <div className="min-h-0 p-0">
            {visibleItems.length > 0 ? (
              <div className="max-h-[min(58vh,36rem)] overflow-y-auto overscroll-contain">
                {renderGroups ? (
                  <div className="divide-y divide-border/45">
                    {groups.map((group) => {
                      const collapsed = collapsedGroups[group.key] === true;
                      const bundleControl =
                        section.key === "skills"
                          ? skillBundleControlForGroup(group.items, filter)
                          : null;
                      const bundleBusy =
                        bundleControl !== null && busyBundleId === bundleControl.busyKey;
                      return (
                        <section key={group.key}>
                          <div className="sticky top-0 z-10 flex min-h-8 w-full items-center justify-between gap-3 border-b border-border/35 bg-popover/95 px-4 py-1.5 backdrop-blur">
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground focus-ring"
                              onClick={() => toggleGroup(group.key)}
                              aria-expanded={!collapsed}
                            >
                              <span className="min-w-0 truncate text-[11px] font-semibold uppercase text-muted-foreground/70">
                                {group.label}
                              </span>
                              {bundleControl ? (
                                <Badge
                                  size="sm"
                                  variant={bundleControl.badgeVariant}
                                  className="shrink-0"
                                >
                                  {bundleControl.badgeLabel}
                                </Badge>
                              ) : null}
                            </button>
                            <span className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
                              <span className="font-mono tabular-nums">{group.items.length}</span>
                              {bundleControl ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="h-6 rounded-sm px-2 text-[10px]"
                                  disabled={bundleBusy}
                                  onClick={() => void toggleSkillBundle(bundleControl)}
                                >
                                  {bundleBusy ? (
                                    <LoaderIcon className="size-3 animate-spin" />
                                  ) : (
                                    <PowerIcon className="size-3" />
                                  )}
                                  {bundleControl.actionLabel}
                                </Button>
                              ) : null}
                              <button
                                type="button"
                                className="rounded-sm p-0.5 transition-colors hover:text-foreground focus-ring"
                                onClick={() => toggleGroup(group.key)}
                                aria-label={collapsed ? "Expand bundle" : "Collapse bundle"}
                              >
                                <ChevronDownIcon
                                  className={cn(
                                    "size-3 transition-transform",
                                    collapsed ? "-rotate-90" : "",
                                  )}
                                />
                              </button>
                            </span>
                          </div>
                          {!collapsed ? (
                            <div className="divide-y divide-border/35">
                              {group.items.map((item) => (
                                <ExtensionBrowserItemRow
                                  key={`${item.kind}:${item.id}`}
                                  item={item}
                                  environmentId={environmentId}
                                  showProvider={spansProviders}
                                  onSelect={onSelect}
                                />
                              ))}
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
                ) : (
                  <div className="divide-y divide-border/35">
                    {visibleItems.map((item) => (
                      <ExtensionBrowserItemRow
                        key={`${item.kind}:${item.id}`}
                        item={item}
                        groupLabel={
                          sort === "recommended" ? undefined : extensionItemGroupLabel(item)
                        }
                        environmentId={environmentId}
                        showProvider={spansProviders}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )}
                {hiddenCount > 0 ? (
                  <button
                    className="w-full border-t border-border/50 px-4 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-ring"
                    onClick={() =>
                      setVisibleLimit((current) =>
                        Math.min(browserItems.length, current + EXTENSION_BROWSER_PAGE_SIZE),
                      )
                    }
                    type="button"
                  >
                    Load {nextVisibleCount} more
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="px-6 py-5">
                <EmptyList
                  label={`No ${section.title.toLowerCase()} match the current browser filters.`}
                />
              </div>
            )}
          </div>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

/**
 * One skill, as a row. The control on the right is whatever the server says this skill supports:
 * a switch when it can be toggled, otherwise a status badge. Bundled skills follow their plugin,
 * so they read as status rather than offering a control that would not apply.
 */
function SkillListRow({
  item,
  environmentId,
  isBusy,
  onSelect,
  onToggle,
}: {
  item: Extract<ExtensionItem, { kind: "skill" }>;
  environmentId: EnvironmentId | null;
  isBusy: boolean;
  onSelect: (item: ExtensionItem) => void;
  onToggle: (item: Extract<ExtensionItem, { kind: "skill" }>, nextEnabled: boolean) => void;
}) {
  const ProviderGlyph = providerIconForDriverLabel(String(item.provider.driver));
  const enabled = item.skill.enabled !== false;
  const description = item.skill.shortDescription ?? item.skill.description ?? item.skill.path;

  return (
    <div className="group flex min-h-11 items-center gap-2.5 border-t border-border/40 px-4 first:border-t-0 sm:px-5">
      <button
        className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-1 py-2.5 text-left transition-colors hover:text-foreground focus-ring"
        onClick={() => onSelect(item)}
        type="button"
      >
        {ProviderGlyph ? (
          <ProviderGlyph className="size-3.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <ExtensionItemGlyph item={item} environmentId={environmentId} sizeClassName="size-3.5" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground/70">{description}</span>
        </span>
      </button>
      {item.skill.canToggle === true ? (
        <Switch
          checked={enabled}
          disabled={isBusy}
          aria-label={`${enabled ? "Disable" : "Enable"} ${item.title}`}
          onCheckedChange={(checked) => onToggle(item, Boolean(checked))}
        />
      ) : (
        <Badge size="sm" variant={enabled ? "success" : "outline"}>
          {enabled ? "On" : "Off"}
        </Badge>
      )}
    </div>
  );
}

function NewSkillDialog({
  open,
  providers,
  cwd,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Providers in scope that can hold a new skill. The picker is hidden when there is only one. */
  providers: ReadonlyArray<ProviderExtensionProviderInventory>;
  cwd: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const providersApi = useScopedProvidersApi();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setError(null);
    setIsSaving(false);
    setProviderInstanceId(String(providers[0]?.instanceId ?? ""));
  }, [open, providers]);

  const trimmedName = name.trim();
  const nameIsValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedName) && trimmedName.length <= 64;
  const canSave = nameIsValid && providerInstanceId.length > 0 && !isSaving;

  const save = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await providersApi().createExtensionSkill({
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        providerInstanceId: providerInstanceId as ProviderInstanceId,
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      await onCreated();
      toastManager.add({
        type: "success",
        title: "Skill created",
        description: result.path,
      });
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The skill was not created.");
    } finally {
      setIsSaving(false);
    }
  }, [
    canSave,
    cwd,
    description,
    onClose,
    onCreated,
    providerInstanceId,
    providersApi,
    trimmedName,
  ]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-md">
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>New skill</DialogTitle>
            <DialogDescription>
              Writes a SKILL.md into your personal skills folder. Open it afterwards to fill in the
              instructions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {providers.length > 1 ? (
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                  Provider
                </span>
                <Select
                  value={providerInstanceId}
                  onValueChange={(value) => setProviderInstanceId(String(value))}
                >
                  <SelectTrigger className="w-full" aria-label="Provider">
                    <SelectValue>
                      {providerTitle(
                        providers.find(
                          (provider) => String(provider.instanceId) === providerInstanceId,
                        ) ?? providers[0]!,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {providers.map((provider) => (
                      <SelectItem key={provider.instanceId} value={String(provider.instanceId)}>
                        {providerTitle(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                Name
              </span>
              <Input
                nativeInput
                autoFocus
                value={name}
                placeholder="review-checklist"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <span className="block text-[11px] text-muted-foreground/70">
                Lower-case letters, digits, and single hyphens. This is the folder name too.
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                Description
              </span>
              <Textarea
                value={description}
                rows={3}
                placeholder="When the agent should reach for this skill."
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
            {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button size="xs" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="xs" disabled={!canSave} onClick={() => void save()}>
              {isSaving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              Create skill
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MachineGlyph({ isPrimary }: { isPrimary: boolean }) {
  return isPrimary ? (
    <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
  ) : (
    <CloudIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
  );
}

/**
 * Which machine, and optionally which project on it, the inventory is read for.
 * Built from the same pieces as the sidebar's picker so the two read alike, but
 * kept local: the sidebar's version carries drafts, renames, and grouping menus
 * that have nothing to do with plugins.
 *
 * With one machine known there is no machine to name, so the groups collapse to
 * a flat "All projects" plus projects, exactly as the sidebar drops its machine
 * filter when there is nowhere else the work could be.
 */
function ExtensionScopePicker({
  groups,
  scope,
  onScopeChange,
}: {
  groups: ReadonlyArray<ExtensionScopeGroup>;
  scope: ExtensionScopeSelection | null;
  onScopeChange: (next: ExtensionScopeSelection) => void;
}) {
  const showMachineGroups = groups.length > 1;
  const soleGroup = groups.length === 1 ? groups[0] : undefined;
  const selectedKey = scope ? extensionScopeKey(scope) : "";
  const selectedGroup =
    groups.find((group) => group.environmentId === scope?.environmentId) ?? null;
  const selectedProject =
    selectedGroup?.projects.find((project) => project.key === selectedKey) ?? null;
  const triggerLabel = selectedProject
    ? selectedProject.label
    : showMachineGroups && selectedGroup
      ? `All projects · ${selectedGroup.label}`
      : "All projects";

  const machineRow = (group: ExtensionScopeGroup) => (
    <MenuItem
      data-testid={`extension-scope-machine-${group.environmentId}`}
      className={cn(
        MENU_PICK_ITEM_CLASS_NAME,
        selectedKey === group.machineKey && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
      )}
      onClick={() => onScopeChange({ environmentId: group.environmentId, cwd: null })}
    >
      {showMachineGroups ? (
        <MachineGlyph isPrimary={group.isPrimary} />
      ) : (
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
      )}
      <span className="min-w-0 flex-1 truncate">All projects</span>
    </MenuItem>
  );

  const projectRows = (group: ExtensionScopeGroup) =>
    group.projects.map((project) => (
      <MenuItem
        key={project.key}
        data-testid={`extension-scope-${project.key}`}
        className={cn(
          MENU_PICK_ITEM_CLASS_NAME,
          selectedKey === project.key && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
        )}
        onClick={() => onScopeChange({ environmentId: project.environmentId, cwd: project.cwd })}
      >
        <ProjectFavicon
          cwd={project.cwd}
          environmentId={project.environmentId}
          name={project.label}
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate">{project.label}</span>
      </MenuItem>
    ));

  return (
    <Menu>
      <MenuTrigger
        data-testid="extension-scope-trigger"
        aria-label="Plugin scope"
        // Sized to sit level with the xs provider chips beside it; capped so a
        // long project or machine name truncates instead of wrapping the row.
        className="flex h-7 min-w-32 max-w-64 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-1.5 text-xs text-muted-foreground/80 transition-colors select-none hover:bg-accent/60 hover:text-foreground focus-ring sm:h-6 dark:bg-input/32"
      >
        {selectedProject ? (
          <ProjectFavicon
            cwd={selectedProject.cwd}
            environmentId={selectedProject.environmentId}
            name={selectedProject.label}
            className="size-3.5 shrink-0"
          />
        ) : showMachineGroups && selectedGroup ? (
          <MachineGlyph isPrimary={selectedGroup.isPrimary} />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
        <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground/60" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-56">
        {showMachineGroups ? (
          groups.map((group, index) => (
            <MenuGroup key={group.environmentId}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroupLabel>{group.label}</MenuGroupLabel>
              {machineRow(group)}
              {projectRows(group)}
            </MenuGroup>
          ))
        ) : soleGroup ? (
          <>
            {machineRow(soleGroup)}
            {soleGroup.projects.length > 0 ? <MenuSeparator /> : null}
            {projectRows(soleGroup)}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function ExtensionsSettingsPanel() {
  const projects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const serverConfig = useServerConfig();
  const serverProviders = useServerProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  // Every machine this client knows about, this device first. Same source and
  // ordering the sidebar's picker uses, so the two lists never disagree.
  const machineOptions = useMemo<ExtensionScopeMachineInput[]>(() => {
    const resolveLabel = (environmentId: EnvironmentId, isPrimary: boolean) =>
      resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId,
        runtimeLabel: savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ?? null,
        savedLabel: savedEnvironmentRegistry[environmentId]?.label ?? null,
      });
    const savedOptions = Object.values(savedEnvironmentRegistry)
      .filter((record) => record.environmentId !== primaryEnvironmentId)
      .map((record) => ({
        environmentId: record.environmentId,
        label: resolveLabel(record.environmentId, false),
        isPrimary: false,
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
    return primaryEnvironmentId === null
      ? savedOptions
      : [
          {
            environmentId: primaryEnvironmentId,
            label: resolveLabel(primaryEnvironmentId, true),
            isPrimary: true,
          },
          ...savedOptions,
        ];
  }, [primaryEnvironmentId, savedEnvironmentRegistry, savedEnvironmentRuntimeById]);
  const scopeGroups = useMemo(
    () => deriveExtensionScopeGroups(projects, sidebarThreads, machineOptions),
    [machineOptions, projects, sidebarThreads],
  );
  const [rememberedScope, setRememberedScope] = useState<ExtensionScopeSelection | null>(
    () => extensionsSettingsPanelMemoryState.scope ?? null,
  );
  const scope = useMemo(
    () => resolveExtensionScope(scopeGroups, rememberedScope),
    [rememberedScope, scopeGroups],
  );
  const scopeEnvironmentId = scope?.environmentId ?? null;
  const scopeCwd = scope?.cwd ?? null;
  // Downstream inputs omit an empty cwd, which is exactly what a machine scope means.
  const cwd = scopeCwd ?? "";
  const isPrimaryScope = scopeEnvironmentId !== null && scopeEnvironmentId === primaryEnvironmentId;
  const scopeKey = scope ? extensionScopeKey(scope) : "";
  const environmentApiAvailable = useEnvironmentApiAvailable(scopeEnvironmentId);
  const scopeContextValue = useMemo<ExtensionsScopeContextValue>(
    () => ({ environmentId: scopeEnvironmentId }),
    [scopeEnvironmentId],
  );
  const scopeMachineLabel =
    scopeGroups.find((group) => group.environmentId === scopeEnvironmentId)?.label ??
    "This machine";
  // Recomputed whenever the connection registry moves, so reconnecting a machine
  // takes the notice down and starts the load without any other nudge.
  const scopeIsReachable = useMemo(
    () => environmentApiAvailable && readScopedProvidersApi(scopeEnvironmentId) !== null,
    [environmentApiAvailable, scopeEnvironmentId],
  );
  const localProviderEntries = useMemo(
    () =>
      sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders))
        .filter(
          (provider) =>
            provider.enabled &&
            provider.isAvailable &&
            (provider.driverKind === EXTENSIONS_CODEX_DRIVER ||
              provider.driverKind === EXTENSIONS_CLAUDE_DRIVER),
        )
        .toSorted(
          (left, right) =>
            extensionProviderDriverSortRank(String(left.driverKind)) -
            extensionProviderDriverSortRank(String(right.driverKind)),
        ),
    [serverProviders],
  );
  const localProviderOptions = useMemo(
    () =>
      localProviderEntries.map((provider) => ({
        value: String(provider.instanceId),
        label: provider.displayName,
        driver: String(provider.driverKind),
      })),
    [localProviderEntries],
  );
  // A remote machine's provider instances are its own, and this client's server
  // config says nothing about them. Its chips come from the inventory it returned,
  // tagged with the machine that answered so they cannot outlive a scope hop.
  const [remoteProviders, setRemoteProviders] = useState<{
    readonly environmentId: EnvironmentId;
    readonly options: ReadonlyArray<ExtensionProviderChip>;
  } | null>(null);
  const providerOptions = isPrimaryScope
    ? localProviderOptions
    : remoteProviders?.environmentId === scopeEnvironmentId
      ? remoteProviders.options
      : EMPTY_PROVIDER_CHIPS;
  const [providerFilter, setProviderFilter] = useState(
    () => extensionsSettingsPanelMemoryState.providerFilter ?? null,
  );
  // Derived, not reset by an effect: a filter must stop applying on the render
  // the scope changes, or one request goes out naming another machine's provider.
  const providerInstanceId =
    providerFilter && providerFilter.environmentId === scopeEnvironmentId
      ? providerFilter.instanceId
      : "";
  const [manualThreadOverride, setManualThreadOverride] = useState(
    () => extensionsSettingsPanelMemoryState.manualThreadOverride ?? null,
  );
  const manualProviderThreadId =
    manualThreadOverride && manualThreadOverride.scopeKey === scopeKey
      ? manualThreadOverride.value
      : "";
  const [showAdvancedContext, setShowAdvancedContext] = useState(
    () => extensionsSettingsPanelMemoryState.showAdvancedContext ?? false,
  );
  // Read loosely: the panel is also mounted outside its own route in tests, and a strict
  // subscription would fail there rather than fall back to the remembered tab.
  const searchTab = useSearch({
    strict: false,
    select: (search) => parseExtensionsSettingsTab((search as { readonly tab?: unknown }).tab),
  });
  const navigate = useNavigate();
  const [rememberedTab, setRememberedTab] = useState(() => extensionsSettingsPanelMemoryState.tab);
  const tab = resolveExtensionsSettingsTab(searchTab, rememberedTab);
  const selectTab = useCallback(
    (next: ExtensionsSettingsTab) => {
      setRememberedTab(next);
      void navigate({
        to: "/settings/plugins",
        replace: true,
        search: (previous) => ({ ...previous, tab: next }),
      });
    },
    [navigate],
  );
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);
  const [busySkillPath, setBusySkillPath] = useState<string | null>(null);
  const [pageQuery, setPageQuery] = useState("");
  const deferredPageQuery = useDeferredValue(pageQuery);
  const refreshRequestRef = useRef(0);
  const inventoryRequestKeyRef = useRef("");
  const selectedProviderOption = useMemo(
    () => providerOptions.find((provider) => provider.value === providerInstanceId),
    [providerInstanceId, providerOptions],
  );
  // MCP tool calls need a Codex thread. With no provider filter there is still exactly one Codex
  // instance to scope against, so keep detecting it rather than losing the capability.
  const threadScopeProvider =
    selectedProviderOption ??
    providerOptions.find((provider) => provider.driver === EXTENSIONS_CODEX_DRIVER) ??
    providerOptions[0];
  // Plugin icon files are served by whichever machine owns the scope.
  const selectedEnvironmentId = scopeEnvironmentId;
  const detectedProviderThreadId = useMemo(
    () =>
      deriveDetectedProviderThreadId({
        cwd,
        providerDriver: threadScopeProvider?.driver ?? "",
        providerInstanceId: threadScopeProvider?.value ?? "",
        projects: projects.map((project) => ({
          environmentId: project.environmentId,
          id: project.id,
          cwd: project.cwd,
        })),
        threads: threads.map((thread) => ({
          key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          environmentId: thread.environmentId,
          id: thread.id,
          projectId: thread.projectId,
          provider: thread.session ? String(thread.session.provider) : "",
          providerInstanceId: thread.session?.providerInstanceId
            ? String(thread.session.providerInstanceId)
            : undefined,
          providerThreadId: thread.session?.providerThreadId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          sessionUpdatedAt: thread.session?.updatedAt,
          lastSeenAt: thread.lastSeenAt,
        })),
      }),
    [cwd, projects, threadScopeProvider, threads],
  );
  const effectiveProviderThreadId = manualProviderThreadId.trim() || detectedProviderThreadId;
  const providerThreadContextSource = manualProviderThreadId.trim()
    ? "manual"
    : detectedProviderThreadId
      ? "auto"
      : "none";
  const providerThreadContextDescription =
    providerThreadContextSource === "manual"
      ? "Using a manual Codex thread context for MCP tool calls and thread-scoped inventory."
      : providerThreadContextSource === "auto"
        ? "Using the active Codex session for MCP tool calls and thread-scoped inventory."
        : "OAuth, reload, plugins, and skills work without this. Running MCP tools needs an active Codex thread.";
  const inventoryRequestKey = useMemo(
    () =>
      makeExtensionInventoryCacheKey({
        environmentId: scopeEnvironmentId ?? "",
        cwd: scopeCwd,
        providerInstanceId: providerInstanceId || "all",
        providerThreadId: effectiveProviderThreadId,
      }) ?? "",
    [effectiveProviderThreadId, providerInstanceId, scopeCwd, scopeEnvironmentId],
  );
  inventoryRequestKeyRef.current = inventoryRequestKey;
  const initialCachedInventory = inventoryRequestKey
    ? extensionInventoryCache.peek(inventoryRequestKey)
    : null;
  const initialMcpInventoryRequested = initialCachedInventory
    ? inventoryHasLoadedMcpServers(initialCachedInventory.value)
    : false;
  const initialAppsInventoryRequested = initialCachedInventory
    ? inventoryHasLoadedApps(initialCachedInventory.value)
    : false;
  const [inventory, setInventory] = useState<ProviderExtensionsInventoryResult | null>(
    () => initialCachedInventory?.value ?? null,
  );
  const [selectedItem, setSelectedItem] = useState<ExtensionItem | null>(null);
  const [isBrowsingCatalog, setIsBrowsingCatalog] = useState(false);
  const [actionHistoryByItem, setActionHistoryByItem] = useState<
    Record<string, ExtensionActionHistoryEntry>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [mcpLoadingProviderId, setMcpLoadingProviderId] = useState<string | null>(null);
  const [appsLoadingProviderId, setAppsLoadingProviderId] = useState<string | null>(null);
  const [lastInventoryLoadMs, setLastInventoryLoadMs] = useState<number | null>(
    () => initialCachedInventory?.loadDurationMs ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const mcpInventoryRequestedRef = useRef(initialMcpInventoryRequested);
  const appsInventoryRequestedRef = useRef(initialAppsInventoryRequested);

  const clearInventory = useCallback((options?: { readonly loading?: boolean }) => {
    refreshRequestRef.current += 1;
    mcpInventoryRequestedRef.current = false;
    appsInventoryRequestedRef.current = false;
    setInventory(null);
    setLastInventoryLoadMs(null);
    setError(null);
    setSelectedItem(null);
    setMcpLoadingProviderId(null);
    setAppsLoadingProviderId(null);
    setIsLoading(options?.loading ?? false);
  }, []);

  const invalidateInventoryRefresh = useCallback(() => {
    refreshRequestRef.current += 1;
    setError(null);
    setSelectedItem(null);
    setMcpLoadingProviderId(null);
    setAppsLoadingProviderId(null);
  }, []);

  // The resolved scope is what gets remembered, so a pick that lapsed does not
  // come back on the next visit.
  useEffect(() => {
    extensionsSettingsPanelMemoryState.scope = scope ?? undefined;
  }, [scope]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.providerFilter = providerFilter ?? undefined;
  }, [providerFilter]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.manualThreadOverride = manualThreadOverride ?? undefined;
  }, [manualThreadOverride]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.showAdvancedContext = showAdvancedContext;
  }, [showAdvancedContext]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.tab = tab;
  }, [tab]);

  // Only this device's provider list is authoritative about this device. A remote
  // scope's chips come from its own inventory, so nothing here may clear them.
  useEffect(() => {
    if (!isPrimaryScope || !providerFilter) return;
    if (localProviderOptions.length === 0) {
      if (serverConfig) {
        setProviderFilter(null);
        clearInventory();
      }
      return;
    }
    if (!localProviderOptions.some((provider) => provider.value === providerFilter.instanceId)) {
      setProviderFilter(null);
      clearInventory();
    }
  }, [clearInventory, isPrimaryScope, localProviderOptions, providerFilter, serverConfig]);

  useEffect(() => {
    setSelectedItem(null);
  }, [providerInstanceId, scopeKey]);

  useEffect(() => {
    mcpInventoryRequestedRef.current = false;
    appsInventoryRequestedRef.current = false;
    setMcpLoadingProviderId(null);
    setAppsLoadingProviderId(null);
    invalidateInventoryRefresh();
  }, [effectiveProviderThreadId, invalidateInventoryRefresh]);

  useEffect(() => {
    if (!inventoryRequestKey) {
      clearInventory();
      return;
    }

    const cachedInventory = extensionInventoryCache.get(inventoryRequestKey);
    if (!cachedInventory) return;

    setInventory(cachedInventory.value);
    mcpInventoryRequestedRef.current = inventoryHasLoadedMcpServers(cachedInventory.value);
    appsInventoryRequestedRef.current = inventoryHasLoadedApps(cachedInventory.value);
    setLastInventoryLoadMs(cachedInventory.loadDurationMs);
    setError(null);
  }, [clearInventory, inventoryRequestKey]);

  const refresh = useCallback(
    async (options?: {
      readonly invalidateCache?: boolean;
      readonly includeMcpServers?: boolean;
      readonly includeApps?: boolean;
    }) => {
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      const requestKey = inventoryRequestKey;
      const requestCwd = scopeCwd?.trim() ?? "";
      const requestEnvironmentId = scopeEnvironmentId;
      const includeMcpServers = options?.includeMcpServers ?? mcpInventoryRequestedRef.current;
      const includeApps = options?.includeApps ?? appsInventoryRequestedRef.current;
      // A machine scope has no cwd and is still a request; nothing to ask means no
      // scope resolved yet, or a machine this client cannot currently reach.
      const providersApi = readScopedProvidersApi(requestEnvironmentId);
      if (!providersApi) {
        setInventory(null);
        setLastInventoryLoadMs(null);
        setError(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      if (includeMcpServers) {
        mcpInventoryRequestedRef.current = true;
      }
      if (includeApps) {
        appsInventoryRequestedRef.current = true;
      }
      if (options?.invalidateCache && requestKey) {
        extensionInventoryCache.delete(requestKey);
      }
      const startedMs = performance.now();
      try {
        const result = await providersApi.getExtensions({
          // No cwd is the machine-wide request: the server answers with the
          // user-level inventory rather than any one project's.
          ...(requestCwd ? { cwd: requestCwd } : {}),
          // An empty filter means "every configured provider"; the server already fans out when
          // no instance id is supplied.
          ...(providerInstanceId
            ? { providerInstanceId: providerInstanceId as ProviderInstanceId }
            : {}),
          ...(effectiveProviderThreadId ? { providerThreadId: effectiveProviderThreadId } : {}),
          includeMcpServers,
          includeApps,
        });
        if (
          refreshRequestRef.current === requestId &&
          inventoryRequestKeyRef.current === requestKey
        ) {
          const loadDurationMs = performance.now() - startedMs;
          if (requestKey) {
            extensionInventoryCache.set(requestKey, result, loadDurationMs);
          }
          // An unfiltered load is the only one that sees every provider, so it is
          // the only one allowed to redraw a remote machine's chips.
          if (!providerInstanceId && requestEnvironmentId) {
            setRemoteProviders({
              environmentId: requestEnvironmentId,
              options: result.providers.map((provider) => ({
                value: String(provider.instanceId),
                label: provider.displayName ?? String(provider.driver),
                driver: String(provider.driver),
              })),
            });
          }
          setInventory(result);
          setSelectedItem((current) =>
            current ? findRefreshedExtensionItem(current, result) : current,
          );
          setLastInventoryLoadMs(loadDurationMs);
        }
      } catch (refreshError) {
        if (
          refreshRequestRef.current === requestId &&
          inventoryRequestKeyRef.current === requestKey
        ) {
          setError(
            refreshError instanceof Error ? refreshError.message : "Plugin inventory failed.",
          );
          setLastInventoryLoadMs(null);
        }
      } finally {
        if (
          refreshRequestRef.current === requestId &&
          inventoryRequestKeyRef.current === requestKey
        ) {
          setIsLoading(false);
        }
      }
    },
    [
      effectiveProviderThreadId,
      inventoryRequestKey,
      providerInstanceId,
      scopeCwd,
      scopeEnvironmentId,
      // Not read here: it is what makes a reconnect retry the load.
      scopeIsReachable,
    ],
  );

  useEffect(() => {
    const loadDelayMs = manualProviderThreadId.trim().length > 0 ? 350 : 0;
    const timeoutId = window.setTimeout(() => void refresh(), loadDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [manualProviderThreadId, refresh]);

  const hasInventory = inventory !== null;
  const isInitialInventoryLoading = scopeIsReachable && !hasInventory && error === null;
  const selectedItemActionKey = selectedItem ? extensionItemActionKey(selectedItem) : null;
  const selectedItemLastAction = selectedItemActionKey
    ? actionHistoryByItem[selectedItemActionKey]
    : undefined;
  const recordItemActionHistory = useCallback(
    (itemKey: string, entry: ExtensionActionHistoryEntry) => {
      setActionHistoryByItem((current) => ({ ...current, [itemKey]: entry }));
    },
    [],
  );
  const refreshAfterMutation = useCallback(() => refresh({ invalidateCache: true }), [refresh]);
  const loadMcpServers = useCallback(
    async (provider: ProviderExtensionProviderInventory) => {
      const providerId = String(provider.instanceId);
      if (mcpLoadingProviderId === providerId) return;
      setMcpLoadingProviderId(providerId);
      mcpInventoryRequestedRef.current = true;
      try {
        await refresh({ includeMcpServers: true, invalidateCache: true });
      } finally {
        setMcpLoadingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [mcpLoadingProviderId, refresh],
  );
  const loadApps = useCallback(
    async (provider: ProviderExtensionProviderInventory) => {
      const providerId = String(provider.instanceId);
      if (appsLoadingProviderId === providerId) return;
      setAppsLoadingProviderId(providerId);
      appsInventoryRequestedRef.current = true;
      try {
        await refresh({ includeApps: true, invalidateCache: true });
      } finally {
        setAppsLoadingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [appsLoadingProviderId, refresh],
  );

  const providerScopedInventory = useMemo(
    () =>
      (inventory?.providers ?? []).filter(
        (provider) => !providerInstanceId || String(provider.instanceId) === providerInstanceId,
      ),
    [inventory, providerInstanceId],
  );
  const allPluginItems = useMemo(
    () =>
      providerScopedInventory.flatMap((provider) =>
        provider.plugins.map((plugin) => pluginExtensionItem(provider, plugin)),
      ),
    [providerScopedInventory],
  );
  const allMcpItems = useMemo(
    () =>
      providerScopedInventory.flatMap((provider) =>
        provider.mcpServers.map((server) => mcpExtensionItem(provider, server)),
      ),
    [providerScopedInventory],
  );
  // Both tabs read the same single inventory load; nothing here refetches per tab.
  const allSkillItems = useMemo(
    () =>
      providerScopedInventory.flatMap((provider) =>
        provider.skills.map((skill) => skillExtensionItem(provider, skill)),
      ),
    [providerScopedInventory],
  );
  const skillGroups = useMemo(
    () =>
      groupExtensionSkills(
        filterExtensionItems(allSkillItems, deferredPageQuery).filter(
          (item): item is Extract<ExtensionItem, { kind: "skill" }> => item.kind === "skill",
        ),
        (item) => ({
          scope: item.skill.scope,
          bundleId: item.skill.bundleId,
          sortKey: item.title.toLowerCase(),
        }),
      ),
    [allSkillItems, deferredPageQuery],
  );
  const matchingSkillCount = skillGroups.reduce((total, group) => total + group.items.length, 0);
  const skillCreateProviders = useMemo(
    () =>
      providerScopedInventory.filter(
        (provider) => isCodexProvider(provider) || isClaudeProvider(provider),
      ),
    [providerScopedInventory],
  );
  const toggleSkillRow = useCallback(
    async (item: Extract<ExtensionItem, { kind: "skill" }>, nextEnabled: boolean) => {
      const providersApi = readScopedProvidersApi(scopeEnvironmentId);
      if (!providersApi) return;
      setBusySkillPath(item.skill.path);
      try {
        await providersApi.setExtensionSkillEnabled({
          ...actionBaseInput(item, cwd),
          path: item.skill.path,
          enabled: nextEnabled,
        });
        await refresh({ invalidateCache: true });
      } catch (toggleError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${nextEnabled ? "Enable" : "Disable"} skill failed`,
            description: toggleError instanceof Error ? toggleError.message : "An error occurred.",
          }),
        );
      } finally {
        setBusySkillPath((current) => (current === item.skill.path ? null : current));
      }
    },
    [cwd, refresh, scopeEnvironmentId],
  );

  // Apps are a Codex concept; the Claude driver always reports an empty list.
  const codexProviders = useMemo(
    () => providerScopedInventory.filter(isCodexProvider),
    [providerScopedInventory],
  );
  const allAppItems = useMemo(
    () =>
      codexProviders.flatMap((provider) =>
        provider.apps.map((app) => appExtensionItem(provider, app)),
      ),
    [codexProviders],
  );
  const appsDeferredProvider = codexProviders.find(
    (provider) => provider.appsStatus === "deferred" || provider.appsStatus === "error",
  );
  const appsSection = useMemo((): ExtensionSectionConfig => {
    // Codex answers app/list with the whole ChatGPT app directory; only accessible apps are
    // actually connected to the account. The section shows those, the catalog lives behind Browse.
    const connected = allAppItems.filter(extensionItemInstalled);
    const catalogCount = allAppItems.length - connected.length;
    const truncated = codexProviders.some((provider) => provider.appsTruncated);
    const failed = codexProviders.some((provider) => provider.appsStatus === "error");
    const deferred = codexProviders.every((provider) => provider.appsStatus === "deferred");
    return {
      key: "apps",
      title: "Apps",
      label: "Apps",
      browseLabel:
        catalogCount > 0 ? `Browse ${catalogCount}${truncated ? "+" : ""} more` : "Browse all apps",
      icon: <BotIcon className="size-3.5" />,
      items: sortExtensionItems(filterExtensionItems(connected, deferredPageQuery), "recommended"),
      browseItems: sortExtensionItems(
        filterExtensionItems(allAppItems, deferredPageQuery),
        "recommended",
      ),
      totalCount: connected.length,
      isDeferred: deferred,
      emptyLabel: deferred
        ? "Apps not loaded."
        : failed
          ? "Apps failed to load."
          : "No connected apps.",
      statusMessage: codexProviders.find((provider) => provider.appsMessage)?.appsMessage,
      loadLabel: deferred ? "Load apps" : failed ? "Retry apps" : undefined,
      isLoading: appsLoadingProviderId !== null,
      ...(appsDeferredProvider ? { onLoad: () => void loadApps(appsDeferredProvider) } : {}),
    };
  }, [
    allAppItems,
    appsDeferredProvider,
    appsLoadingProviderId,
    codexProviders,
    deferredPageQuery,
    loadApps,
  ]);
  const [isBrowsingApps, setIsBrowsingApps] = useState(false);

  const searchedInstalledPlugins = useMemo(
    () =>
      sortExtensionItems(
        filterExtensionItems(allPluginItems.filter(extensionItemInstalled), deferredPageQuery),
        "recommended",
      ),
    [allPluginItems, deferredPageQuery],
  );
  const searchedConnections = useMemo(
    () => sortExtensionItems(filterExtensionItems(allMcpItems, deferredPageQuery), "recommended"),
    [allMcpItems, deferredPageQuery],
  );
  // MCP status is fetched lazily, so the one action that reveals connection auth belongs with the
  // connections, not buried under skills. Refresh is global, so one provider drives them all.
  const mcpAuthCheckProvider = providerScopedInventory.find(
    (provider) => provider.mcpServersStatus === "deferred" || provider.mcpServersStatus === "error",
  );
  const mcpAuthCheckFailed = providerScopedInventory.some(
    (provider) => provider.mcpServersStatus === "error",
  );

  const catalogSection = useMemo((): ExtensionSectionConfig => {
    const installed = searchedInstalledPlugins;
    const browseItems = sortExtensionItems(
      filterExtensionItems(allPluginItems, deferredPageQuery),
      "recommended",
    );
    return {
      key: "plugins",
      title: "Plugins",
      label: "Plugins",
      browseLabel: "Browse catalog",
      icon: <PlugIcon className="size-3.5" />,
      items: installed,
      browseItems,
      totalCount: installed.length,
      emptyLabel: "No plugins installed.",
    };
  }, [allPluginItems, deferredPageQuery, searchedInstalledPlugins]);

  const attentionEntries = useMemo((): ReadonlyArray<ExtensionAttentionEntry> => {
    const connectionIssues = allMcpItems.filter(extensionItemNeedsAuth).map((item) => ({
      key: `mcp:${item.provider.instanceId}:${item.id}`,
      title: item.title,
      detail: extensionAuthIssueDetail(item),
      item,
    }));
    const providerIssues = providerScopedInventory.flatMap((provider) =>
      provider.status === "error" || provider.status === "partial"
        ? [
            {
              key: `provider:${provider.instanceId}`,
              title: providerTitle(provider),
              detail: provider.message ?? "Inventory partially loaded.",
            },
          ]
        : [],
    );
    const marketplaceIssues = providerScopedInventory.flatMap((provider) =>
      provider.marketplaces.flatMap((marketplace) =>
        marketplace.loadError
          ? [
              {
                key: `marketplace:${provider.instanceId}:${marketplace.name}`,
                title: marketplace.displayName ?? marketplace.name,
                detail: marketplace.loadError,
              },
            ]
          : [],
      ),
    );
    return [...connectionIssues, ...providerIssues, ...marketplaceIssues];
  }, [allMcpItems, providerScopedInventory]);

  return (
    <ExtensionsScopeContext.Provider value={scopeContextValue}>
      <SettingsPageContainer className="max-w-5xl">
        {isInitialInventoryLoading ? (
          <span className="sr-only" role="status">
            Loading plugins and connections
          </span>
        ) : null}
        <SettingsSection
          title="Plugins"
          icon={<PlugIcon className="size-3.5" />}
          headerAction={
            isLoading ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <LoaderIcon className="size-3 animate-spin" />
                Loading
              </span>
            ) : null
          }
        >
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <p className="text-xs text-muted-foreground">
              {scopeCwd === null
                ? "Plugins and connections available to Codex and Claude on this machine."
                : "Plugins and connections available to Codex and Claude in this project."}
              {inventory?.generatedAt
                ? ` Loaded ${new Date(inventory.generatedAt).toLocaleTimeString()}${
                    lastInventoryLoadMs !== null ? ` in ${formatDuration(lastInventoryLoadMs)}` : ""
                  }.`
                : ""}
            </p>
            {scope !== null && !scopeIsReachable ? (
              <p className="text-xs text-muted-foreground">{scopeMachineLabel} is not connected.</p>
            ) : null}
            <Input
              nativeInput
              value={pageQuery}
              placeholder="Search plugins and connections"
              aria-label="Search plugins and connections"
              onChange={(event) => setPageQuery(event.currentTarget.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                variant={providerInstanceId ? "outline" : "default"}
                onClick={() => setProviderFilter(null)}
              >
                All providers
              </Button>
              {providerOptions.map((provider) => {
                const ProviderGlyph = providerIconForDriverLabel(provider.driver);
                return (
                  <Button
                    key={provider.value}
                    size="xs"
                    variant={providerInstanceId === provider.value ? "default" : "outline"}
                    onClick={() => {
                      if (!scopeEnvironmentId) return;
                      setProviderFilter({
                        environmentId: scopeEnvironmentId,
                        instanceId: provider.value,
                      });
                    }}
                  >
                    {ProviderGlyph ? <ProviderGlyph className="size-3 shrink-0" /> : null}
                    {provider.label}
                  </Button>
                );
              })}
              {scopeGroups.length > 0 ? (
                <ExtensionScopePicker
                  groups={scopeGroups}
                  scope={scope}
                  onScopeChange={(next) => {
                    setRememberedScope(next);
                    setShowAdvancedContext(false);
                    clearInventory({ loading: true });
                  }}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Plugins and skills">
              <SectionTabButton
                label="Plugins"
                value={searchedInstalledPlugins.length}
                totalValue={allPluginItems.filter(extensionItemInstalled).length}
                active={tab === "plugins"}
                icon={<PlugIcon className="size-3.5" />}
                panelId="extensions-tab-plugins"
                onClick={() => selectTab("plugins")}
              />
              <SectionTabButton
                label="Skills"
                value={matchingSkillCount}
                totalValue={allSkillItems.length}
                active={tab === "skills"}
                icon={<FileTextIcon className="size-3.5" />}
                panelId="extensions-tab-skills"
                onClick={() => selectTab("skills")}
              />
            </div>
          </div>
        </SettingsSection>

        {tab === "plugins" ? (
          <>
            <SettingsSection
              title="Installed plugins"
              icon={<PlugIcon className="size-3.5" />}
              headerAction={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={allPluginItems.length === 0}
                  onClick={() => setIsBrowsingCatalog(true)}
                >
                  <SearchIcon className="size-3.5" />
                  Browse catalog
                </Button>
              }
            >
              <div
                className="space-y-4 px-4 py-4 sm:px-5"
                id="extensions-tab-plugins"
                role="tabpanel"
              >
                {isInitialInventoryLoading ? (
                  <InstalledStripSkeleton />
                ) : (
                  <InstalledStrip
                    items={searchedInstalledPlugins}
                    environmentId={selectedEnvironmentId}
                    onSelect={setSelectedItem}
                  />
                )}
                <NeedsAttention entries={attentionEntries} onSelect={setSelectedItem} />
              </div>
            </SettingsSection>

            {codexProviders.length > 0 ? (
              <SettingsSection title="Apps" icon={<BotIcon className="size-3.5" />}>
                <div className="px-4 py-3.5 sm:px-5">
                  <ExtensionPreviewSection
                    environmentId={selectedEnvironmentId}
                    title={appsSection.title}
                    items={appsSection.items}
                    totalCount={appsSection.totalCount}
                    isTruncated={appsSection.isTruncated}
                    emptyLabel={appsSection.emptyLabel}
                    statusMessage={appsSection.statusMessage}
                    loadLabel={appsSection.loadLabel}
                    isLoading={appsSection.isLoading}
                    onLoad={appsSection.onLoad}
                    filterText={deferredPageQuery}
                    onSelect={setSelectedItem}
                    panelId="extensions-apps"
                    browseLabel={appsSection.browseLabel}
                    browseAvailable={(appsSection.browseItems ?? appsSection.items).length > 0}
                    onBrowse={() => setIsBrowsingApps(true)}
                  />
                </div>
              </SettingsSection>
            ) : null}
          </>
        ) : (
          <SettingsSection
            title="Skills"
            icon={<FileTextIcon className="size-3.5" />}
            headerAction={
              <div className="flex items-center gap-2">
                {hasInventory && isLoading ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <LoaderIcon className="size-3 animate-spin" />
                    Refreshing
                  </span>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={skillCreateProviders.length === 0}
                  onClick={() => setIsCreatingSkill(true)}
                >
                  <PackagePlusIcon className="size-3.5" />
                  New skill
                </Button>
              </div>
            }
          >
            <div id="extensions-tab-skills" role="tabpanel">
              {isInitialInventoryLoading ? (
                <SkillListSkeleton />
              ) : skillGroups.length > 0 ? (
                skillGroups.map((group) => (
                  <div key={group.key}>
                    <div className="border-t border-border/50 bg-muted/15 px-4 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground/70 first:border-t-0 sm:px-5">
                      {group.label}
                    </div>
                    {group.items.map((item) => (
                      <SkillListRow
                        key={item.skill.path}
                        item={item}
                        environmentId={selectedEnvironmentId}
                        isBusy={busySkillPath === item.skill.path}
                        onSelect={setSelectedItem}
                        onToggle={(target, nextEnabled) => void toggleSkillRow(target, nextEnabled)}
                      />
                    ))}
                  </div>
                ))
              ) : (
                <SettingsRow
                  title={
                    !scopeIsReachable ? (
                      scope === null ? (
                        "No machine available"
                      ) : (
                        `${scopeMachineLabel} is not connected`
                      )
                    ) : isLoading ? (
                      <span className="inline-flex items-center gap-2">
                        <LoaderIcon className="size-3.5 animate-spin" />
                        Loading skills
                      </span>
                    ) : error ? (
                      "Inventory failed to load"
                    ) : allSkillItems.length > 0 ? (
                      "No matching skills"
                    ) : (
                      "No skills reported"
                    )
                  }
                  description={
                    !scopeIsReachable
                      ? scope === null
                        ? "Add a computer or a project to inspect skills."
                        : "Reconnect this machine to inspect its skills."
                      : isLoading
                        ? "Reading skills from Codex and Claude."
                        : error
                          ? "The inventory could not be loaded. Details are shown above."
                          : allSkillItems.length > 0
                            ? "No skill matches the search above."
                            : scopeCwd === null
                              ? "Neither provider reported skills on this machine."
                              : "Neither provider reported skills for this project."
                  }
                />
              )}
            </div>
          </SettingsSection>
        )}

        {tab === "plugins" ? (
          <>
            <SettingsSection
              title="Connections"
              icon={<DatabaseIcon className="size-3.5" />}
              headerAction={
                mcpAuthCheckProvider ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={mcpLoadingProviderId !== null}
                    onClick={() => void loadMcpServers(mcpAuthCheckProvider)}
                  >
                    {mcpLoadingProviderId !== null ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <KeyRoundIcon className="size-3.5" />
                    )}
                    {mcpAuthCheckFailed ? "Retry MCP auth" : "Check MCP auth"}
                  </Button>
                ) : null
              }
            >
              <div className="px-4 py-3.5 sm:px-5">
                {isInitialInventoryLoading ? (
                  <ConnectionsTableSkeleton />
                ) : (
                  <ConnectionsTable
                    items={searchedConnections}
                    environmentId={selectedEnvironmentId}
                    isLoading={isLoading}
                    onSelect={setSelectedItem}
                  />
                )}
              </div>
            </SettingsSection>

            {providerScopedInventory.some((provider) => provider.marketplaces.length > 0) ? (
              <SettingsSection title="Marketplaces" icon={<PackagePlusIcon className="size-3.5" />}>
                <div className="space-y-3 px-4 py-3.5 sm:px-5">
                  {providerScopedInventory.map((provider) => (
                    <MarketplacesBlock
                      key={provider.instanceId}
                      provider={provider}
                      cwd={cwd}
                      onMutated={refreshAfterMutation}
                    />
                  ))}
                </div>
              </SettingsSection>
            ) : null}

            <SettingsSection title="Advanced" icon={<PlugIcon className="size-3.5" />}>
              <SettingsRow
                title="MCP context"
                description={providerThreadContextDescription}
                control={
                  <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
                    <Badge
                      size="sm"
                      variant={providerThreadContextSource === "none" ? "outline" : "success"}
                    >
                      {providerThreadContextSource === "manual"
                        ? "Manual"
                        : providerThreadContextSource === "auto"
                          ? "Auto"
                          : "No context"}
                    </Badge>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setShowAdvancedContext((open) => !open)}
                      aria-expanded={showAdvancedContext}
                    >
                      <ChevronDownIcon
                        className={`size-3.5 transition-transform ${showAdvancedContext ? "" : "-rotate-90"}`}
                      />
                      Advanced
                    </Button>
                  </div>
                }
              >
                {showAdvancedContext ? (
                  <div className="mt-3 grid gap-3 border-t border-border/50 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] sm:items-start">
                    <div className="min-w-0 space-y-1">
                      <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
                        Detected context
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-foreground/80"
                        title={detectedProviderThreadId || undefined}
                      >
                        {detectedProviderThreadId || "No active Codex thread detected"}
                      </div>
                      <p className="text-[11px] text-muted-foreground/70">
                        Leave the override empty to use the detected active session.
                      </p>
                    </div>
                    <Input
                      nativeInput
                      value={manualProviderThreadId}
                      onChange={(event) => {
                        setManualThreadOverride({ scopeKey, value: event.currentTarget.value });
                        invalidateInventoryRefresh();
                      }}
                      placeholder="override provider thread id"
                      className="w-full"
                      aria-label="Override provider thread id"
                    />
                  </div>
                ) : null}
              </SettingsRow>
            </SettingsSection>
          </>
        ) : null}

        <ExtensionBrowserDialog
          environmentId={selectedEnvironmentId}
          section={isBrowsingCatalog ? catalogSection : null}
          providerLabel={
            providerInstanceId ? (selectedProviderOption?.label ?? "") : "All providers"
          }
          initialQuery={pageQuery}
          onClose={() => setIsBrowsingCatalog(false)}
          onSelect={(item) => {
            setIsBrowsingCatalog(false);
            setSelectedItem(item);
          }}
          onToggleSkillBundle={async () => {}}
        />
        <ExtensionBrowserDialog
          environmentId={selectedEnvironmentId}
          section={isBrowsingApps ? appsSection : null}
          providerLabel={
            providerInstanceId ? (selectedProviderOption?.label ?? "") : "All providers"
          }
          initialQuery={pageQuery}
          onClose={() => setIsBrowsingApps(false)}
          onSelect={(item) => {
            setIsBrowsingApps(false);
            setSelectedItem(item);
          }}
          onToggleSkillBundle={async () => {}}
        />
        <NewSkillDialog
          open={isCreatingSkill}
          providers={skillCreateProviders}
          cwd={cwd}
          onClose={() => setIsCreatingSkill(false)}
          onCreated={refreshAfterMutation}
        />
        <ExtensionDetailDialog
          item={selectedItem}
          environmentId={selectedEnvironmentId}
          cwd={cwd}
          machineLabel={scopeMachineLabel}
          providerThreadId={effectiveProviderThreadId}
          onClose={() => setSelectedItem(null)}
          onSelectItem={setSelectedItem}
          onInventoryMutated={refreshAfterMutation}
          lastAction={selectedItemLastAction}
          onActionHistoryChange={recordItemActionHistory}
        />
      </SettingsPageContainer>
    </ExtensionsScopeContext.Provider>
  );
}
