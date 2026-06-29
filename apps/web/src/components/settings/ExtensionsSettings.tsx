import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HistoryIcon,
  KeyRoundIcon,
  LoaderIcon,
  PackageMinusIcon,
  PackagePlusIcon,
  PlugIcon,
  PowerIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type {
  ProviderExtensionApp,
  ProviderExtensionMcpServer,
  ProviderExtensionMcpTool,
  ProviderExtensionPlugin,
  ProviderExtensionProviderInventory,
  ProviderExtensionsInventoryResult,
  ProviderExtensionSkill,
} from "@threadlines/contracts";
import { ProviderDriverKind, type ProviderInstanceId } from "@threadlines/contracts";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { openInPreferredEditor } from "../../editorPreferences";
import { ensureLocalApi } from "../../localApi";
import {
  buildExtensionJsonSchemaFormArguments,
  createExtensionInventoryMemoryCache,
  deriveExtensionPluginGroupLabel,
  deriveDetectedProviderThreadId,
  deriveExtensionJsonSchemaFormFields,
  deriveExtensionSkillBundleKey,
  deriveExtensionSkillBundleLabel,
  extensionMcpNeedsAuthStatus,
  extensionMcpOAuthActionIntent,
  extensionMcpOAuthActionLabel,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  isLikelyLocalPath,
  makeExtensionInventoryCacheKey,
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
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { useUiStateStore } from "../../uiStateStore";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { deriveSettingsProjectOptions } from "./settingsProjectOptions";
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
type ExtensionBrowserSort = "recommended" | "bundle" | "name" | "status" | "category";

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
  cwd?: string | undefined;
  providerInstanceId?: string | undefined;
  manualProviderThreadId?: string | undefined;
  showAdvancedContext?: boolean | undefined;
}

const extensionInventoryCache =
  createExtensionInventoryMemoryCache<ProviderExtensionsInventoryResult>({
    maxEntries: EXTENSION_INVENTORY_CACHE_MAX_ENTRIES,
    ttlMs: EXTENSION_INVENTORY_CACHE_TTL_MS,
  });

const extensionsSettingsPanelMemoryState: ExtensionsSettingsPanelMemoryState = {};

function extensionItemActionKey(item: ExtensionItem): string {
  return `${item.provider.instanceId}:${item.kind}:${item.id}`;
}

function statusVariant(status: ProviderExtensionProviderInventory["status"]) {
  switch (status) {
    case "ready":
      return "success";
    case "partial":
      return "warning";
    case "error":
      return "error";
    case "disabled":
    case "unsupported":
      return "outline";
  }
}

function providerStatusLabel(status: ProviderExtensionProviderInventory["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "partial":
      return "Loaded with issues";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    case "unsupported":
      return "Unsupported";
  }
}

function providerTitle(provider: ProviderExtensionProviderInventory): string {
  return provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : provider.driver);
}

function inventoryHasLoadedMcpServers(inventory: ProviderExtensionsInventoryResult): boolean {
  return inventory.providers.some(
    (provider) => provider.mcpServersStatus === "ready" || provider.mcpServers.length > 0,
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
  const detail = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
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
  active,
  icon,
  panelId,
  onClick,
}: {
  label: string;
  value: number;
  totalValue: number;
  active: boolean;
  icon: ReactNode;
  panelId: string;
  onClick: () => void;
}) {
  const countLabel = value === totalValue ? String(totalValue) : `${value}/${totalValue}`;

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
    ],
    plugin,
  };
}

function skillExtensionItem(
  provider: ProviderExtensionProviderInventory,
  skill: ProviderExtensionSkill,
): ExtensionItem {
  const title = skill.displayName ?? skill.name;
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
    enabled: app.enabled,
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

function ExtensionItemBadges({ item }: { item: ExtensionItem }) {
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
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

function ExtensionAuthenticationIssues({
  provider,
  items,
  isLoadingMcpServers,
  onLoadMcpServers,
  onSelect,
}: {
  provider: ProviderExtensionProviderInventory;
  items: ReadonlyArray<ExtensionItem>;
  isLoadingMcpServers: boolean;
  onLoadMcpServers: (provider: ProviderExtensionProviderInventory) => Promise<void>;
  onSelect: (item: ExtensionItem) => void;
}) {
  const mcpStatus = provider.mcpServersStatus;
  const canCheckMcpAuth = mcpStatus === "deferred" || mcpStatus === "error";
  const hasAuthIssue = items.length > 0 || mcpStatus === "error";
  if (items.length === 0 && !canCheckMcpAuth) return null;

  return (
    <div
      className={cn(
        "rounded-md border",
        hasAuthIssue ? "border-warning/25 bg-warning/5" : "border-border/60 bg-background/35",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-start justify-between gap-3 border-b px-3 py-2",
          hasAuthIssue ? "border-warning/15" : "border-border/50",
        )}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <KeyRoundIcon
              className={cn(
                "size-3.5 shrink-0",
                hasAuthIssue ? "text-warning" : "text-muted-foreground/70",
              )}
            />
            <div className="text-[11px] font-semibold uppercase text-foreground/85">
              Authentication
            </div>
            {items.length > 0 ? (
              <Badge size="sm" variant="warning">
                {items.length}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/75">
            Extension sign-in issues are shown here unless they directly block a chat turn.
          </p>
        </div>
        {canCheckMcpAuth ? (
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={isLoadingMcpServers}
            onClick={() => void onLoadMcpServers(provider)}
          >
            {isLoadingMcpServers ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            {mcpStatus === "error" ? "Retry MCP auth" : "Check MCP auth"}
          </Button>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div className="divide-y divide-warning/15">
          {items.map((item) => (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              className="group flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(item)}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-warning/10 text-warning">
                <KeyRoundIcon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                <div className="truncate text-[11px] text-muted-foreground/75">
                  {extensionAuthIssueDetail(item)}
                </div>
              </div>
              <ExtensionItemBadges item={item} />
              <span className="hidden shrink-0 text-[11px] font-medium text-muted-foreground/70 transition-colors group-hover:text-foreground sm:inline">
                Review auth
              </span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2">
          <EmptyList
            label={
              mcpStatus === "error"
                ? "MCP authentication status could not be checked."
                : "MCP authentication status has not been checked."
            }
          />
          {provider.mcpServersMessage ? (
            <div className="mt-1 text-[11px] text-muted-foreground/70">
              {provider.mcpServersMessage}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
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
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Failed to copy ${label.toLowerCase()}`,
        description: "Clipboard API unavailable.",
      }),
    );
    return;
  }

  void navigator.clipboard.writeText(value).then(
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

function ExtensionDetailDialog({
  item,
  onClose,
  cwd,
  providerThreadId,
  onInventoryMutated,
  lastAction,
  onActionHistoryChange,
}: {
  item: ExtensionItem | null;
  onClose: () => void;
  cwd: string;
  providerThreadId: string;
  onInventoryMutated: () => Promise<void>;
  lastAction?: ExtensionActionHistoryEntry | undefined;
  onActionHistoryChange: (itemKey: string, entry: ExtensionActionHistoryEntry) => void;
}) {
  const openPath = item ? extensionOpenPath(item) : null;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<ProviderExtensionMcpTool | null>(null);
  const [toolArguments, setToolArguments] = useState("{}");
  const [toolArgumentMode, setToolArgumentMode] = useState<"form" | "json">("json");
  const [toolFormValues, setToolFormValues] = useState<Record<string, string | boolean>>({});
  const pollRef = useRef(0);
  const managedClaudePlugin = useMemo(() => findManagedClaudePluginForMcp(item), [item]);

  useEffect(() => {
    setBusyAction(null);
    setActionOutput(null);
    setSelectedTool(null);
    setToolArguments("{}");
    setToolArgumentMode("json");
    setToolFormValues({});
    pollRef.current += 1;
  }, [item?.kind, item?.id]);

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
      const api = ensureLocalApi();
      const result = await api.server.startProviderExtensionMcpOAuth({
        ...actionBaseInput(item, cwd),
        serverName: item.server.name,
        timeoutSecs: 300,
      });
      if (result.authorizationUrl) {
        await api.shell.openExternal(result.authorizationUrl);
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
        const status = await api.server.getProviderExtensionOperationStatus({
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
  }, [cwd, item, mcpOAuthActionLabel, onInventoryMutated, runDialogAction]);

  const reloadMcp = useCallback(() => {
    if (!item) return;
    void runDialogAction("Reload MCP", async () => {
      await ensureLocalApi().server.reloadProviderExtensionMcpServers(actionBaseInput(item, cwd));
      await onInventoryMutated();
      return "MCP servers reloaded.";
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const toggleSkill = useCallback(() => {
    if (!item || item.kind !== "skill") return;
    const nextEnabled = !(item.skill.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable skill" : "Disable skill", async () => {
      const result = await ensureLocalApi().server.setProviderExtensionSkillEnabled({
        ...actionBaseInput(item, cwd),
        path: item.skill.path,
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Skill ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const readPlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Read plugin", async () => {
      const result = await ensureLocalApi().server.readProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        ...pluginSelectorInput(item.plugin),
      });
      return formatJson(result.plugin);
    });
  }, [cwd, item, runDialogAction]);

  const installPlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Install plugin", async () => {
      const result = await ensureLocalApi().server.installProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        ...pluginSelectorInput(item.plugin),
      });
      await onInventoryMutated();
      return formatJson(result);
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const uninstallPlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Uninstall plugin", async () => {
      const api = ensureLocalApi();
      const confirmed = await api.dialogs.confirm(`Uninstall ${item.plugin.name}?`);
      if (!confirmed) return "Uninstall cancelled.";
      await api.server.uninstallProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin uninstalled.";
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const togglePlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    const nextEnabled = !(item.plugin.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable plugin" : "Disable plugin", async () => {
      const result = await ensureLocalApi().server.setProviderExtensionPluginEnabled({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Plugin ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const updatePlugin = useCallback(() => {
    if (!item || item.kind !== "plugin") return;
    void runDialogAction("Update plugin", async () => {
      await ensureLocalApi().server.updateProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: item.plugin.id,
        ...(item.plugin.scope ? { scope: item.plugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin updated. Restart active Claude sessions to apply the new plugin bundle.";
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

  const readManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    void runDialogAction("Plugin details", async () => {
      const result = await ensureLocalApi().server.readProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        ...pluginSelectorInput(managedClaudePlugin),
      });
      return formatJson(result.plugin);
    });
  }, [cwd, item, managedClaudePlugin, runDialogAction]);

  const toggleManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    const nextEnabled = !(managedClaudePlugin.enabled ?? true);
    void runDialogAction(nextEnabled ? "Enable plugin" : "Disable plugin", async () => {
      const result = await ensureLocalApi().server.setProviderExtensionPluginEnabled({
        ...actionBaseInput(item, cwd),
        pluginId: managedClaudePlugin.id,
        ...(managedClaudePlugin.scope ? { scope: managedClaudePlugin.scope } : {}),
        enabled: nextEnabled,
      });
      await onInventoryMutated();
      return `Plugin ${result.effectiveEnabled ? "enabled" : "disabled"}.`;
    });
  }, [cwd, item, managedClaudePlugin, onInventoryMutated, runDialogAction]);

  const uninstallManagedClaudePlugin = useCallback(() => {
    if (!item || !managedClaudePlugin) return;
    void runDialogAction("Uninstall plugin", async () => {
      const api = ensureLocalApi();
      const confirmed = await api.dialogs.confirm(`Uninstall ${managedClaudePlugin.name}?`);
      if (!confirmed) return "Uninstall cancelled.";
      await api.server.uninstallProviderExtensionPlugin({
        ...actionBaseInput(item, cwd),
        pluginId: managedClaudePlugin.id,
        ...(managedClaudePlugin.scope ? { scope: managedClaudePlugin.scope } : {}),
      });
      await onInventoryMutated();
      return "Plugin uninstalled.";
    });
  }, [cwd, item, managedClaudePlugin, onInventoryMutated, runDialogAction]);

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
      const result = await ensureLocalApi().server.callProviderExtensionMcpTool({
        ...actionBaseInput(item, cwd),
        serverName: item.server.name,
        toolName: selectedTool.name,
        providerThreadId: threadId,
        arguments: argumentsValue,
      });
      return formatJson(result);
    });
  }, [
    cwd,
    item,
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
        const result = await ensureLocalApi().server.readProviderExtensionMcpResource({
          ...actionBaseInput(item, cwd),
          serverName: item.server.name,
          uri,
          ...(threadId ? { providerThreadId: threadId } : {}),
        });
        return formatJson(result);
      });
    },
    [cwd, item, providerThreadId, runDialogAction],
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
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
                {item.kind === "skill" ? (
                  <FileTextIcon className="size-4" />
                ) : (
                  <PlugIcon className="size-4" />
                )}
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
            <dl className="rounded-md border border-border/60 bg-background px-3">
              {item.kind === "plugin" ? (
                <>
                  <DetailRow label="ID" value={item.plugin.id} copyValue={item.plugin.id} />
                  <DetailRow label="Name" value={item.plugin.name} copyValue={item.plugin.name} />
                  <DetailRow label="Display" value={item.plugin.displayName} />
                  <DetailRow label="Description" value={item.plugin.description} />
                  <DetailRow label="Version" value={item.plugin.version} />
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
                </>
              ) : null}
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
                                      <SelectItem key={enumValue} hideIndicator value={enumValue}>
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
            {codexActionsAvailable && item.kind === "skill" ? (
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
            {codexActionsAvailable && item.kind === "plugin" ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={readPlugin}
                >
                  {busyAction === "Read plugin" ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <WrenchIcon className="size-3.5" />
                  )}
                  Details
                </Button>
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
                {item.plugin.installed === true && item.plugin.enabled !== false ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={readPlugin}
                  >
                    {busyAction === "Read plugin" ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <WrenchIcon className="size-3.5" />
                    )}
                    Details
                  </Button>
                ) : null}
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

function ExtensionPreviewSection({
  title,
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
  onBrowse,
}: {
  title: string;
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
  onBrowse: () => void;
}) {
  const isFiltering = filterText.trim().length > 0;
  const visibleItems = items.slice(0, EXTENSION_SECTION_PREVIEW_LIMIT);
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
              {isFiltering ? `${items.length} matching ${totalCount} total` : `${totalCount} total`}
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
          <div className="divide-y divide-border/50">
            {visibleItems.map((item) => (
              <button
                key={`${item.kind}:${item.id}`}
                className="group flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(item)}
                type="button"
              >
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
              className="w-full border-t border-border/50 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          {totalCount > 0 ? (
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

function ExtensionBrowserItemRow({
  item,
  groupLabel,
  onSelect,
}: {
  item: ExtensionItem;
  groupLabel?: string | undefined;
  onSelect: (item: ExtensionItem) => void;
}) {
  return (
    <button
      type="button"
      className="group grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onSelect(item)}
    >
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
      <ExtensionItemBadges item={item} />
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function ExtensionBrowserDialog({
  section,
  providerLabel,
  initialQuery,
  onClose,
  onSelect,
  onToggleSkillBundle,
}: {
  section: ExtensionSectionConfig | null;
  providerLabel: string;
  initialQuery: string;
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
  }, [initialQuery, section?.key]);

  const searchedItems = useMemo(
    () => filterExtensionItems(section?.items ?? [], query),
    [query, section?.items],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        EXTENSION_BROWSER_FILTER_OPTIONS.map((option) => [
          option.value,
          searchedItems.filter((item) => extensionItemMatchesBrowserFilter(item, option.value))
            .length,
        ]),
      ) as Record<ExtensionBrowserFilter, number>,
    [searchedItems],
  );
  const browserItems = useMemo(
    () =>
      sortExtensionItems(
        searchedItems.filter((item) => extensionItemMatchesBrowserFilter(item, filter)),
        sort,
      ),
    [filter, searchedItems, sort],
  );
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
                  Browse {section.title.toLowerCase()}
                </DialogTitle>
                <DialogDescription>
                  {providerLabel} - {browserItems.length} visible from {section.totalCount} total
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
                    <SelectItem key={option.value} hideIndicator value={option.value}>
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
                  {option.label}
                  <span className="font-mono tabular-nums text-foreground/80">
                    {filterCounts[option.value]}
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
                              className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                className="rounded-sm p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )}
                {hiddenCount > 0 ? (
                  <button
                    className="w-full border-t border-border/50 px-4 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function ProviderInventoryRow({
  provider,
  cwd,
  onSelectItem,
  onInventoryMutated,
  onLoadMcpServers,
  isLoadingMcpServers,
}: {
  provider: ProviderExtensionProviderInventory;
  cwd: string;
  onSelectItem: (item: ExtensionItem) => void;
  onInventoryMutated: () => Promise<void>;
  onLoadMcpServers: (provider: ProviderExtensionProviderInventory) => Promise<void>;
  isLoadingMcpServers: boolean;
}) {
  const [activeSection, setActiveSection] = useState<ExtensionSectionKey>("plugins");
  const [browseSection, setBrowseSection] = useState<ExtensionSectionKey | null>(null);
  const [providerFilterText, setProviderFilterText] = useState("");
  const deferredProviderFilterText = useDeferredValue(providerFilterText);

  const allItems = useMemo(
    () => ({
      plugins: provider.plugins.map((plugin) => pluginExtensionItem(provider, plugin)),
      skills: provider.skills.map((skill) => skillExtensionItem(provider, skill)),
      mcpServers: provider.mcpServers.map((server) => mcpExtensionItem(provider, server)),
      apps: provider.apps.map((app) => appExtensionItem(provider, app)),
    }),
    [provider],
  );
  const filterProviderItems = useCallback(
    (items: ReadonlyArray<ExtensionItem>) =>
      filterExtensionItems(items, deferredProviderFilterText),
    [deferredProviderFilterText],
  );
  const filteredItems = useMemo(
    () => ({
      plugins: sortExtensionItems(filterProviderItems(allItems.plugins), "recommended"),
      skills: sortExtensionItems(filterProviderItems(allItems.skills), "recommended"),
      mcpServers: sortExtensionItems(filterProviderItems(allItems.mcpServers), "recommended"),
      apps: sortExtensionItems(filterProviderItems(allItems.apps), "recommended"),
    }),
    [allItems, filterProviderItems],
  );
  const authenticationIssueItems = useMemo(
    () =>
      sortExtensionItems(
        [...allItems.plugins, ...allItems.mcpServers].filter(extensionItemNeedsAuth),
        "recommended",
      ),
    [allItems],
  );
  const panelIdBase = useMemo(
    () => `extensions-${String(provider.instanceId).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    [provider.instanceId],
  );
  const initialSection =
    provider.plugins.length > 0
      ? "plugins"
      : provider.skills.length > 0
        ? "skills"
        : provider.mcpServers.length > 0
          ? "mcpServers"
          : provider.apps.length > 0
            ? "apps"
            : "plugins";
  const sections: ReadonlyArray<ExtensionSectionConfig> = [
    {
      key: "plugins" as const,
      title: "Plugins",
      label: "Plugins",
      browseLabel: "Browse all plugins",
      icon: <PlugIcon className="size-3.5" />,
      items: filteredItems.plugins,
      totalCount: provider.plugins.length,
      emptyLabel: "No plugins reported.",
    },
    {
      key: "skills" as const,
      title: "Skills",
      label: "Skills",
      browseLabel: "Browse all skills",
      icon: <FileTextIcon className="size-3.5" />,
      items: filteredItems.skills,
      totalCount: provider.skills.length,
      emptyLabel: "No skills reported.",
    },
    {
      key: "mcpServers" as const,
      title: "MCP Servers",
      label: "MCP",
      browseLabel: "Browse MCP servers",
      icon: <DatabaseIcon className="size-3.5" />,
      items: filteredItems.mcpServers,
      totalCount: provider.mcpServers.length,
      emptyLabel:
        provider.mcpServersStatus === "deferred"
          ? "MCP servers not loaded."
          : provider.mcpServersStatus === "error"
            ? "MCP servers failed to load."
            : "No MCP servers reported.",
      statusMessage: provider.mcpServersMessage,
      loadLabel:
        provider.mcpServersStatus === "deferred"
          ? "Load MCP servers"
          : provider.mcpServersStatus === "error"
            ? "Retry MCP servers"
            : undefined,
      isLoading: isLoadingMcpServers,
      onLoad: () => void onLoadMcpServers(provider),
    },
    {
      key: "apps" as const,
      title: "Apps",
      label: "Apps",
      browseLabel: "Browse apps",
      icon: <BotIcon className="size-3.5" />,
      items: filteredItems.apps,
      totalCount: provider.apps.length,
      emptyLabel: "No apps reported.",
    },
  ];
  const activeSectionConfig =
    sections.find((section) => section.key === activeSection) ?? sections[0];
  const browseSectionConfig = sections.find((section) => section.key === browseSection) ?? null;
  const firstFilteredSection =
    sections.find((section) => section.items.length > 0)?.key ?? initialSection;
  const activeSectionItemCount = filteredItems[activeSection]?.length ?? 0;

  useEffect(() => {
    setActiveSection(initialSection);
    setBrowseSection(null);
    setProviderFilterText("");
  }, [initialSection, provider.instanceId]);

  useEffect(() => {
    if (activeSection === "mcpServers") return;
    if (activeSectionItemCount === 0 && firstFilteredSection !== activeSection) {
      setActiveSection(firstFilteredSection);
    }
  }, [activeSection, activeSectionItemCount, firstFilteredSection]);

  useEffect(() => {
    if (
      activeSection === "mcpServers" &&
      provider.mcpServersStatus === "deferred" &&
      !isLoadingMcpServers
    ) {
      void onLoadMcpServers(provider);
    }
  }, [activeSection, isLoadingMcpServers, onLoadMcpServers, provider]);

  const toggleSkillBundle = useCallback(
    async (bundle: ExtensionSkillBundleControl) => {
      if (bundle.kind === "skills") {
        const skills = bundle.skills ?? [];
        for (const skill of skills) {
          await ensureLocalApi().server.setProviderExtensionSkillEnabled({
            ...actionBaseInput(skillExtensionItem(bundle.provider, skill), cwd),
            path: skill.path,
            enabled: bundle.nextEnabled,
          });
        }
        await onInventoryMutated();
        return;
      }

      const pluginItem = pluginExtensionItem(bundle.provider, bundle.plugin);
      await ensureLocalApi().server.setProviderExtensionPluginEnabled({
        ...actionBaseInput(pluginItem, cwd),
        pluginId: bundle.plugin.id,
        ...(bundle.plugin.scope ? { scope: bundle.plugin.scope } : {}),
        enabled: bundle.nextEnabled,
      });
      await onInventoryMutated();
    },
    [cwd, onInventoryMutated],
  );

  return (
    <SettingsRow
      title={providerTitle(provider)}
      description={`${provider.instanceId} - ${provider.driver}`}
      status={provider.message}
      control={
        <Badge size="sm" variant={statusVariant(provider.status)}>
          {providerStatusLabel(provider.status)}
        </Badge>
      }
    >
      <div className="mt-3 space-y-3 border-t border-border/50 py-3">
        <ExtensionAuthenticationIssues
          provider={provider}
          items={authenticationIssueItems}
          isLoadingMcpServers={isLoadingMcpServers}
          onLoadMcpServers={onLoadMcpServers}
          onSelect={onSelectItem}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              nativeInput
              type="search"
              value={providerFilterText}
              onChange={(event) => setProviderFilterText(event.currentTarget.value)}
              placeholder={`Search ${providerTitle(provider)} plugins`}
              className="w-full [&_[data-slot=input]]:pl-8"
              aria-label={`Search ${providerTitle(provider)} plugins`}
            />
          </div>
          {providerFilterText.trim().length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start sm:self-auto"
              onClick={() => setProviderFilterText("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Plugin section">
          {sections.map((section) => (
            <SectionTabButton
              key={section.key}
              label={section.label}
              value={section.items.length}
              totalValue={section.totalCount}
              active={activeSection === section.key}
              icon={section.icon}
              panelId={`${panelIdBase}-${section.key}`}
              onClick={() => setActiveSection(section.key)}
            />
          ))}
        </div>
        {activeSectionConfig ? (
          <ExtensionPreviewSection
            title={activeSectionConfig.title}
            items={activeSectionConfig.items}
            totalCount={activeSectionConfig.totalCount}
            emptyLabel={activeSectionConfig.emptyLabel}
            statusMessage={activeSectionConfig.statusMessage}
            loadLabel={activeSectionConfig.loadLabel}
            isLoading={activeSectionConfig.isLoading}
            onLoad={activeSectionConfig.onLoad}
            filterText={deferredProviderFilterText}
            onSelect={onSelectItem}
            panelId={`${panelIdBase}-${activeSectionConfig.key}`}
            browseLabel={activeSectionConfig.browseLabel}
            onBrowse={() => setBrowseSection(activeSectionConfig.key)}
          />
        ) : null}
      </div>
      <ExtensionBrowserDialog
        section={browseSectionConfig}
        providerLabel={providerTitle(provider)}
        initialQuery={providerFilterText}
        onClose={() => setBrowseSection(null)}
        onSelect={onSelectItem}
        onToggleSkillBundle={toggleSkillBundle}
      />
    </SettingsRow>
  );
}

export function ExtensionsSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const serverConfig = useServerConfig();
  const serverProviders = useServerProviders();
  const projectOptions = useMemo(() => deriveSettingsProjectOptions(projects), [projects]);
  const providerEntries = useMemo(
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
  const providerOptions = useMemo(
    () =>
      providerEntries.map((provider) => ({
        value: String(provider.instanceId),
        label: provider.displayName,
      })),
    [providerEntries],
  );
  const [cwd, setCwd] = useState(
    () => extensionsSettingsPanelMemoryState.cwd ?? projectOptions[0]?.value ?? "",
  );
  const [providerInstanceId, setProviderInstanceId] = useState(
    () => extensionsSettingsPanelMemoryState.providerInstanceId ?? "",
  );
  const [manualProviderThreadId, setManualProviderThreadId] = useState(
    () => extensionsSettingsPanelMemoryState.manualProviderThreadId ?? "",
  );
  const [showAdvancedContext, setShowAdvancedContext] = useState(
    () => extensionsSettingsPanelMemoryState.showAdvancedContext ?? false,
  );
  const refreshRequestRef = useRef(0);
  const inventoryRequestKeyRef = useRef("");
  const selectedProviderEntry = useMemo(
    () => providerEntries.find((provider) => String(provider.instanceId) === providerInstanceId),
    [providerEntries, providerInstanceId],
  );
  const detectedProviderThreadId = useMemo(
    () =>
      deriveDetectedProviderThreadId({
        cwd,
        providerDriver: selectedProviderEntry ? String(selectedProviderEntry.driverKind) : "",
        providerInstanceId,
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
        })),
        threadLastVisitedAtById,
      }),
    [cwd, projects, providerInstanceId, selectedProviderEntry, threadLastVisitedAtById, threads],
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
        cwd,
        providerInstanceId,
        providerThreadId: effectiveProviderThreadId,
      }) ?? "",
    [cwd, effectiveProviderThreadId, providerInstanceId],
  );
  inventoryRequestKeyRef.current = inventoryRequestKey;
  const initialCachedInventory = inventoryRequestKey
    ? extensionInventoryCache.peek(inventoryRequestKey)
    : null;
  const initialMcpInventoryRequested = initialCachedInventory
    ? inventoryHasLoadedMcpServers(initialCachedInventory.value)
    : false;
  const [inventory, setInventory] = useState<ProviderExtensionsInventoryResult | null>(
    () => initialCachedInventory?.value ?? null,
  );
  const [selectedItem, setSelectedItem] = useState<ExtensionItem | null>(null);
  const [actionHistoryByItem, setActionHistoryByItem] = useState<
    Record<string, ExtensionActionHistoryEntry>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [mcpLoadingProviderId, setMcpLoadingProviderId] = useState<string | null>(null);
  const [isRefreshingMarketplaces, setIsRefreshingMarketplaces] = useState(false);
  const [lastInventoryLoadMs, setLastInventoryLoadMs] = useState<number | null>(
    () => initialCachedInventory?.loadDurationMs ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const projectProviderRef = useRef({ cwd, providerInstanceId });
  const mcpInventoryRequestedRef = useRef(initialMcpInventoryRequested);

  const clearInventory = useCallback((options?: { readonly loading?: boolean }) => {
    refreshRequestRef.current += 1;
    mcpInventoryRequestedRef.current = false;
    setInventory(null);
    setLastInventoryLoadMs(null);
    setError(null);
    setSelectedItem(null);
    setMcpLoadingProviderId(null);
    setIsLoading(options?.loading ?? false);
  }, []);

  const invalidateInventoryRefresh = useCallback(() => {
    refreshRequestRef.current += 1;
    setError(null);
    setSelectedItem(null);
    setMcpLoadingProviderId(null);
  }, []);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.cwd = cwd;
  }, [cwd]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.providerInstanceId = providerInstanceId;
  }, [providerInstanceId]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.manualProviderThreadId = manualProviderThreadId;
  }, [manualProviderThreadId]);

  useEffect(() => {
    extensionsSettingsPanelMemoryState.showAdvancedContext = showAdvancedContext;
  }, [showAdvancedContext]);

  useEffect(() => {
    if (!cwd && projectOptions[0]?.value) {
      setCwd(projectOptions[0].value);
    }
  }, [cwd, projectOptions]);

  useEffect(() => {
    if (providerOptions.length === 0) {
      if (serverConfig && providerInstanceId) {
        setProviderInstanceId("");
        clearInventory();
      }
      return;
    }
    if (
      providerInstanceId &&
      !providerOptions.some((provider) => provider.value === providerInstanceId)
    ) {
      setProviderInstanceId("");
      clearInventory();
    }
  }, [clearInventory, providerInstanceId, providerOptions, serverConfig]);

  useEffect(() => {
    setSelectedItem(null);
  }, [cwd, providerInstanceId]);

  useEffect(() => {
    const previous = projectProviderRef.current;
    projectProviderRef.current = { cwd, providerInstanceId };
    if (previous.cwd === cwd && previous.providerInstanceId === providerInstanceId) {
      return;
    }

    setManualProviderThreadId("");
    setShowAdvancedContext(false);
  }, [cwd, providerInstanceId]);

  useEffect(() => {
    mcpInventoryRequestedRef.current = false;
    setMcpLoadingProviderId(null);
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
    setLastInventoryLoadMs(cachedInventory.loadDurationMs);
    setError(null);
  }, [clearInventory, inventoryRequestKey]);

  const refresh = useCallback(
    async (options?: {
      readonly invalidateCache?: boolean;
      readonly includeMcpServers?: boolean;
    }) => {
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      const requestKey = inventoryRequestKey;
      const requestCwd = cwd.trim();
      const includeMcpServers = options?.includeMcpServers ?? mcpInventoryRequestedRef.current;
      if (!requestCwd || !providerInstanceId) {
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
      if (options?.invalidateCache && requestKey) {
        extensionInventoryCache.delete(requestKey);
      }
      const startedMs = performance.now();
      try {
        const result = await ensureLocalApi().server.getProviderExtensions({
          cwd: requestCwd,
          providerInstanceId: providerInstanceId as ProviderInstanceId,
          ...(effectiveProviderThreadId ? { providerThreadId: effectiveProviderThreadId } : {}),
          includeMcpServers,
        });
        if (
          refreshRequestRef.current === requestId &&
          inventoryRequestKeyRef.current === requestKey
        ) {
          const loadDurationMs = performance.now() - startedMs;
          if (requestKey) {
            extensionInventoryCache.set(requestKey, result, loadDurationMs);
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
    [cwd, effectiveProviderThreadId, inventoryRequestKey, providerInstanceId],
  );

  useEffect(() => {
    const loadDelayMs = manualProviderThreadId.trim().length > 0 ? 350 : 0;
    const timeoutId = window.setTimeout(() => void refresh(), loadDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [manualProviderThreadId, refresh]);

  const canReadInventory = cwd.trim().length > 0 && providerInstanceId.length > 0;
  const hasInventory = inventory !== null;
  const canRefreshCodexMarketplaces =
    canReadInventory && selectedProviderEntry?.driverKind === EXTENSIONS_CODEX_DRIVER;
  const refreshCodexMarketplaces = useCallback(async () => {
    const requestCwd = cwd.trim();
    if (!requestCwd || !providerInstanceId) return;

    setIsRefreshingMarketplaces(true);
    try {
      const result = await ensureLocalApi().server.refreshProviderExtensionPluginMarketplaces({
        cwd: requestCwd,
        providerInstanceId: providerInstanceId as ProviderInstanceId,
      });
      toastManager.add({
        type: "success",
        title: "Marketplace refreshed",
        description: result.output ?? "Codex plugin marketplace metadata is up to date.",
      });
      await refresh({ invalidateCache: true });
    } catch (refreshError) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Marketplace refresh failed",
          description: refreshError instanceof Error ? refreshError.message : "An error occurred.",
        }),
      );
    } finally {
      setIsRefreshingMarketplaces(false);
    }
  }, [cwd, providerInstanceId, refresh]);
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

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection title="Plugins" icon={<PlugIcon className="size-3.5" />}>
        <SettingsRow
          title="Project"
          description={
            inventory?.generatedAt
              ? `Inventory generated ${new Date(inventory.generatedAt).toLocaleString()}${
                  lastInventoryLoadMs !== null ? ` in ${formatDuration(lastInventoryLoadMs)}` : ""
                }.`
              : "Pick the project context used for project plugins, skills, and MCP status."
          }
          control={
            projectOptions.length > 0 ? (
              <Select
                value={cwd}
                onValueChange={(value) => {
                  if (!value) return;
                  setCwd(value);
                  clearInventory({ loading: providerInstanceId.length > 0 });
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Project">
                  <SelectValue>
                    {projectOptions.find((project) => project.value === cwd)?.label ?? "Project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.value} hideIndicator value={project.value}>
                      {project.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null
          }
        />
        <SettingsRow
          title="Provider"
          description="Choose a supported provider to load plugins, skills, MCP servers, and apps."
          status={error}
          control={
            providerOptions.length > 0 ? (
              <div className="flex w-full items-center gap-1.5 sm:w-auto">
                {canRefreshCodexMarketplaces ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          className="size-7 shrink-0 rounded-sm"
                          size="icon-xs"
                          variant="outline"
                          disabled={isLoading || isRefreshingMarketplaces}
                          onClick={() => void refreshCodexMarketplaces()}
                          aria-label="Refresh Codex plugin marketplace"
                        >
                          {isRefreshingMarketplaces ? (
                            <LoaderIcon className="size-3.5 animate-spin" />
                          ) : (
                            <PackagePlusIcon className="size-3.5" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Refresh Codex marketplace</TooltipPopup>
                  </Tooltip>
                ) : null}
                <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                  <Select
                    value={providerInstanceId}
                    onValueChange={(value) => {
                      if (!value) return;
                      setProviderInstanceId(value);
                      clearInventory({ loading: cwd.trim().length > 0 });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-56" aria-label="Provider">
                      <SelectValue>
                        {providerOptions.find((provider) => provider.value === providerInstanceId)
                          ?.label ?? "Select provider"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {providerOptions.map((provider) => (
                        <SelectItem key={provider.value} hideIndicator value={provider.value}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null
          }
        />
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
                  setManualProviderThreadId(event.currentTarget.value);
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

      <SettingsSection
        title="Providers"
        icon={<BotIcon className="size-3.5" />}
        headerAction={
          hasInventory && isLoading ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderIcon className="size-3 animate-spin" />
              Refreshing
            </span>
          ) : null
        }
      >
        {inventory?.providers.length ? (
          inventory.providers.map((provider) => (
            <ProviderInventoryRow
              key={provider.instanceId}
              provider={provider}
              cwd={cwd}
              onSelectItem={setSelectedItem}
              onInventoryMutated={refreshAfterMutation}
              onLoadMcpServers={loadMcpServers}
              isLoadingMcpServers={mcpLoadingProviderId === String(provider.instanceId)}
            />
          ))
        ) : (
          <SettingsRow
            title={
              !cwd ? (
                "No project selected"
              ) : !providerInstanceId ? (
                "No provider selected"
              ) : isLoading ? (
                <span className="inline-flex items-center gap-2">
                  <LoaderIcon className="size-3.5 animate-spin" />
                  Loading plugins
                </span>
              ) : error ? (
                "Inventory failed to load"
              ) : hasInventory ? (
                "No plugin providers found"
              ) : (
                "No plugin inventory"
              )
            }
            description={
              !cwd
                ? "Choose a project to inspect plugin surfaces."
                : !providerInstanceId
                  ? "Choose Codex or Claude to load plugins, skills, MCP servers, and apps."
                  : isLoading
                    ? "Loading plugins, skills, MCP servers, and apps for the selected provider."
                    : error
                      ? "The selected provider inventory could not be loaded. Details are shown above."
                      : hasInventory
                        ? "The selected provider returned no plugin records."
                        : "Choose a provider to load its plugin inventory."
            }
          />
        )}
      </SettingsSection>
      <ExtensionDetailDialog
        item={selectedItem}
        cwd={cwd}
        providerThreadId={effectiveProviderThreadId}
        onClose={() => setSelectedItem(null)}
        onInventoryMutated={refreshAfterMutation}
        lastAction={selectedItemLastAction}
        onActionHistoryChange={recordItemActionHistory}
      />
    </SettingsPageContainer>
  );
}
