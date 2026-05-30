import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileTextIcon,
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
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type {
  ProviderExtensionApp,
  ProviderExtensionMcpServer,
  ProviderExtensionMcpTool,
  ProviderExtensionPlugin,
  ProviderExtensionProviderInventory,
  ProviderExtensionsInventoryResult,
  ProviderExtensionSkill,
} from "@t3tools/contracts";
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { openInPreferredEditor } from "../../editorPreferences";
import { ensureLocalApi } from "../../localApi";
import {
  deriveDetectedProviderThreadId,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  isLikelyLocalPath,
  type ExtensionItemKind,
} from "./ExtensionsSettings.logic";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useServerProviders } from "../../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { useUiStateStore } from "../../uiStateStore";
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
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { deriveSettingsProjectOptions } from "./settingsProjectOptions";

const COMPACT_LIST_PREVIEW_LIMIT = 8;
const EXTENSIONS_CODEX_DRIVER = ProviderDriverKind.make("codex");
const EXTENSIONS_CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

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

function CountPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-border/70 px-1.5 text-[11px] text-muted-foreground">
      <span className="font-mono tabular-nums text-foreground/80">{value}</span>
      {label}
    </span>
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

function filterExtensionItems(
  items: ReadonlyArray<ExtensionItem>,
  filterText: string,
): ReadonlyArray<ExtensionItem> {
  return items.filter((item) => extensionTextMatchesFilter(item.searchValues, filterText));
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

function commandArg(value: string): string {
  return /^[A-Za-z0-9._:/?=&,-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function codexMcpLoginCommand(serverName: string): string {
  return ["codex", "mcp", "login", serverName].map(commandArg).join(" ");
}

function isCodexProvider(provider: ProviderExtensionProviderInventory): boolean {
  return provider.driver === EXTENSIONS_CODEX_DRIVER;
}

function isClaudeProvider(provider: ProviderExtensionProviderInventory): boolean {
  return provider.driver === EXTENSIONS_CLAUDE_DRIVER;
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
        title: "Unable to open extension path",
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
          title: "Unable to open extension path",
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
}: {
  item: ExtensionItem | null;
  onClose: () => void;
  cwd: string;
  providerThreadId: string;
  onInventoryMutated: () => Promise<void>;
}) {
  const openPath = item ? extensionOpenPath(item) : null;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<ProviderExtensionMcpTool | null>(null);
  const [toolArguments, setToolArguments] = useState("{}");
  const pollRef = useRef(0);

  useEffect(() => {
    setBusyAction(null);
    setActionOutput(null);
    setSelectedTool(null);
    setToolArguments("{}");
    pollRef.current += 1;
  }, [item?.kind, item?.id]);

  const runDialogAction = useCallback(
    async (label: string, action: () => Promise<string | null | undefined>) => {
      setBusyAction(label);
      setActionOutput(null);
      try {
        const output = await action();
        if (output) setActionOutput(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "An error occurred.";
        setActionOutput(message);
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
    [],
  );

  const startMcpOAuth = useCallback(() => {
    if (!item || item.kind !== "mcp") return;
    void runDialogAction("OAuth", async () => {
      const api = ensureLocalApi();
      const result = await api.server.startProviderExtensionMcpOAuth({
        ...actionBaseInput(item, cwd),
        serverName: item.server.name,
        timeoutSecs: 300,
      });
      await api.shell.openExternal(result.authorizationUrl);
      const pollId = pollRef.current + 1;
      pollRef.current = pollId;
      setActionOutput(
        `Opened OAuth for ${item.server.name}.\n\nFallback:\n${result.terminalCommand}`,
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
          }
          return status.error
            ? `${status.message ?? status.status}\n\n${status.error}`
            : (status.message ?? status.status);
        }
      }
      return `OAuth timed out.\n\nFallback:\n${result.terminalCommand}`;
    });
  }, [cwd, item, onInventoryMutated, runDialogAction]);

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
        name: item.skill.name,
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

  const runSelectedTool = useCallback(() => {
    if (!item || item.kind !== "mcp" || !selectedTool) return;
    void runDialogAction("Run tool", async () => {
      const threadId = providerThreadId.trim();
      if (!threadId) {
        return "A provider thread id is required to run MCP tools.";
      }
      const result = await ensureLocalApi().server.callProviderExtensionMcpTool({
        ...actionBaseInput(item, cwd),
        serverName: item.server.name,
        toolName: selectedTool.name,
        providerThreadId: threadId,
        arguments: parseJsonInput(toolArguments),
      });
      return formatJson(result);
    });
  }, [cwd, item, providerThreadId, runDialogAction, selectedTool, toolArguments]);

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
                <ExtensionToolsList
                  tools={mcpTools}
                  onSelectTool={(tool) => {
                    setSelectedTool(tool);
                    setToolArguments("{}");
                  }}
                />
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
                    <Textarea
                      size="sm"
                      spellCheck={false}
                      value={toolArguments}
                      onChange={(event) => setToolArguments(event.currentTarget.value)}
                      className="font-mono text-xs"
                      aria-label="Tool arguments JSON"
                    />
                  </div>
                ) : null}
              </>
            ) : null}
            <ExtensionActionOutput value={actionOutput} />
          </DialogPanel>
          <DialogFooter>
            {codexActionsAvailable && item.kind === "mcp" ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={startMcpOAuth}
                >
                  {busyAction === "OAuth" ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <KeyRoundIcon className="size-3.5" />
                  )}
                  OAuth
                </Button>
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
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    copyText(codexMcpLoginCommand(item.server.name), "Terminal login command")
                  }
                >
                  <TerminalIcon className="size-3.5" />
                  Copy login
                </Button>
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-7 rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={() => copyText(extensionClipboardDetails(item), "Extension metadata")}
                    aria-label="Copy extension metadata"
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

function ExtensionListSection({
  title,
  items,
  totalCount,
  emptyLabel,
  filterText,
  expanded,
  onToggleExpanded,
  onSelect,
}: {
  title: string;
  items: ReadonlyArray<ExtensionItem>;
  totalCount: number;
  emptyLabel: string;
  filterText: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: (item: ExtensionItem) => void;
}) {
  const isFiltering = filterText.trim().length > 0;
  const visibleItems = isFiltering || expanded ? items : items.slice(0, COMPACT_LIST_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">{title}</div>
        {totalCount > 0 ? (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {items.length === totalCount ? totalCount : `${items.length}/${totalCount}`}
          </span>
        ) : null}
      </div>
      {visibleItems.length > 0 ? (
        <div className="divide-y divide-border/50 rounded-md border border-border/60">
          {visibleItems.map((item) => (
            <button
              key={`${item.kind}:${item.id}`}
              className="group flex min-h-9 w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(item)}
              type="button"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                {item.detail ? (
                  <div className="truncate text-[11px] text-muted-foreground/70">{item.detail}</div>
                ) : null}
              </div>
              {typeof item.enabled === "boolean" ? (
                <Badge size="sm" variant={item.enabled ? "success" : "outline"}>
                  {item.enabled ? "On" : "Off"}
                </Badge>
              ) : null}
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground" />
            </button>
          ))}
          {hiddenCount > 0 ? (
            <button
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onToggleExpanded}
              type="button"
            >
              Show {hiddenCount} more
            </button>
          ) : null}
          {!isFiltering && expanded && items.length > COMPACT_LIST_PREVIEW_LIMIT ? (
            <button
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onToggleExpanded}
              type="button"
            >
              Show less
            </button>
          ) : null}
        </div>
      ) : (
        <EmptyList label={isFiltering && totalCount > 0 ? "No matches." : emptyLabel} />
      )}
    </div>
  );
}

function ProviderInventoryRow({
  provider,
  filterText,
  onSelectItem,
}: {
  provider: ProviderExtensionProviderInventory;
  filterText: string;
  onSelectItem: (item: ExtensionItem) => void;
}) {
  const [expandedSections, setExpandedSections] = useState<Record<ExtensionItemKind, boolean>>({
    plugin: false,
    skill: false,
    mcp: false,
    app: false,
  });

  const toggleExpanded = useCallback((kind: ExtensionItemKind) => {
    setExpandedSections((current) => ({ ...current, [kind]: !current[kind] }));
  }, []);

  const pluginItems = filterExtensionItems(
    provider.plugins.map((plugin) => pluginExtensionItem(provider, plugin)),
    filterText,
  );
  const skillItems = filterExtensionItems(
    provider.skills.map((skill) => skillExtensionItem(provider, skill)),
    filterText,
  );
  const mcpItems = filterExtensionItems(
    provider.mcpServers.map((server) => mcpExtensionItem(provider, server)),
    filterText,
  );
  const appItems = filterExtensionItems(
    provider.apps.map((app) => appExtensionItem(provider, app)),
    filterText,
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
        <div className="flex flex-wrap gap-1.5">
          <CountPill label="plugins" value={pluginItems.length} />
          <CountPill label="skills" value={skillItems.length} />
          <CountPill label="MCP" value={mcpItems.length} />
          <CountPill label="apps" value={appItems.length} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <ExtensionListSection
            title="Plugins"
            items={pluginItems}
            totalCount={provider.plugins.length}
            emptyLabel="No plugins reported."
            filterText={filterText}
            expanded={expandedSections.plugin}
            onToggleExpanded={() => toggleExpanded("plugin")}
            onSelect={onSelectItem}
          />
          <ExtensionListSection
            title="Skills"
            items={skillItems}
            totalCount={provider.skills.length}
            emptyLabel="No skills reported."
            filterText={filterText}
            expanded={expandedSections.skill}
            onToggleExpanded={() => toggleExpanded("skill")}
            onSelect={onSelectItem}
          />
          <ExtensionListSection
            title="MCP Servers"
            items={mcpItems}
            totalCount={provider.mcpServers.length}
            emptyLabel="No MCP servers reported."
            filterText={filterText}
            expanded={expandedSections.mcp}
            onToggleExpanded={() => toggleExpanded("mcp")}
            onSelect={onSelectItem}
          />
          <ExtensionListSection
            title="Apps"
            items={appItems}
            totalCount={provider.apps.length}
            emptyLabel="No apps reported."
            filterText={filterText}
            expanded={expandedSections.app}
            onToggleExpanded={() => toggleExpanded("app")}
            onSelect={onSelectItem}
          />
        </div>
      </div>
    </SettingsRow>
  );
}

function countProviderExtensions(provider: ProviderExtensionProviderInventory): number {
  return (
    provider.plugins.length +
    provider.skills.length +
    provider.mcpServers.length +
    provider.apps.length
  );
}

function countProviderMatches(
  provider: ProviderExtensionProviderInventory,
  filterText: string,
): number {
  if (filterText.trim().length === 0) return countProviderExtensions(provider);
  return (
    filterExtensionItems(
      provider.plugins.map((plugin) => pluginExtensionItem(provider, plugin)),
      filterText,
    ).length +
    filterExtensionItems(
      provider.skills.map((skill) => skillExtensionItem(provider, skill)),
      filterText,
    ).length +
    filterExtensionItems(
      provider.mcpServers.map((server) => mcpExtensionItem(provider, server)),
      filterText,
    ).length +
    filterExtensionItems(
      provider.apps.map((app) => appExtensionItem(provider, app)),
      filterText,
    ).length
  );
}

export function ExtensionsSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
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
  const [cwd, setCwd] = useState(() => projectOptions[0]?.value ?? "");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [manualProviderThreadId, setManualProviderThreadId] = useState("");
  const [showAdvancedContext, setShowAdvancedContext] = useState(false);
  const [inventory, setInventory] = useState<ProviderExtensionsInventoryResult | null>(null);
  const [filterText, setFilterText] = useState("");
  const [selectedItem, setSelectedItem] = useState<ExtensionItem | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
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

  const extensionTotals = useMemo(() => {
    if (!inventory) return { total: 0, matching: 0 };
    return inventory.providers.reduce(
      (acc, provider) => ({
        total: acc.total + countProviderExtensions(provider),
        matching: acc.matching + countProviderMatches(provider, filterText),
      }),
      { total: 0, matching: 0 },
    );
  }, [filterText, inventory]);

  useEffect(() => {
    if (!cwd && projectOptions[0]?.value) {
      setCwd(projectOptions[0].value);
    }
  }, [cwd, projectOptions]);

  useEffect(() => {
    if (providerOptions.length === 0) {
      if (providerInstanceId) setProviderInstanceId("");
      return;
    }
    if (
      providerInstanceId &&
      !providerOptions.some((provider) => provider.value === providerInstanceId)
    ) {
      setProviderInstanceId("");
      setInventory(null);
      setError(null);
      setSelectedItem(null);
    }
  }, [providerInstanceId, providerOptions]);

  useEffect(() => {
    setSelectedItem(null);
  }, [cwd, providerInstanceId]);

  useEffect(() => {
    setManualProviderThreadId("");
    setShowAdvancedContext(false);
  }, [cwd, providerInstanceId]);

  useEffect(() => {
    setInventory(null);
    setError(null);
    setSelectedItem(null);
  }, [effectiveProviderThreadId]);

  const refresh = useCallback(async () => {
    const requestCwd = cwd.trim();
    if (!requestCwd || !providerInstanceId) {
      setInventory(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setIsLoading(true);
    setError(null);
    try {
      const result = await ensureLocalApi().server.getProviderExtensions({
        cwd: requestCwd,
        providerInstanceId: providerInstanceId as ProviderInstanceId,
        ...(effectiveProviderThreadId ? { providerThreadId: effectiveProviderThreadId } : {}),
      });
      if (refreshRequestRef.current === requestId) {
        setInventory(result);
      }
    } catch (refreshError) {
      if (refreshRequestRef.current === requestId) {
        setError(
          refreshError instanceof Error ? refreshError.message : "Extension inventory failed.",
        );
      }
    } finally {
      if (refreshRequestRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [cwd, effectiveProviderThreadId, providerInstanceId]);

  const canLoadInventory = cwd.trim().length > 0 && providerInstanceId.length > 0;
  const hasInventory = inventory !== null;

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection title="Extensions" icon={<PlugIcon className="size-3.5" />}>
        <SettingsRow
          title="Project"
          description={
            inventory?.generatedAt
              ? `Inventory generated ${new Date(inventory.generatedAt).toLocaleString()}.`
              : "Pick the project context used for project skills and MCP status."
          }
          status={error}
          control={
            projectOptions.length > 0 ? (
              <Select
                value={cwd}
                onValueChange={(value) => {
                  if (!value) return;
                  setCwd(value);
                  setInventory(null);
                  setError(null);
                  setSelectedItem(null);
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
          description="Choose a supported provider, then load its extension inventory when needed."
          control={
            providerOptions.length > 0 ? (
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
                <Button
                  className="order-2 w-full sm:order-1 sm:w-auto"
                  size="xs"
                  variant={hasInventory ? "outline" : "default"}
                  disabled={!canLoadInventory || isLoading}
                  onClick={() => void refresh()}
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                  {hasInventory ? "Reload" : "Load"}
                </Button>
                <div className="order-1 min-w-0 sm:order-2">
                  <Select
                    value={providerInstanceId}
                    onValueChange={(value) => {
                      if (!value) return;
                      setProviderInstanceId(value);
                      setInventory(null);
                      setError(null);
                      setSelectedItem(null);
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
          title="Filter"
          description={
            inventory
              ? filterText.trim().length > 0
                ? `Showing ${extensionTotals.matching} of ${extensionTotals.total} extension records.`
                : "Search plugins, skills, MCP servers, apps, paths, and tool names."
              : "Load an extension inventory to filter it."
          }
          control={
            <div className="relative w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                nativeInput
                type="search"
                value={filterText}
                onChange={(event) => setFilterText(event.currentTarget.value)}
                placeholder="Search extensions"
                className="w-full [&_[data-slot=input]]:pl-8"
                disabled={!inventory}
                aria-label="Search extensions"
              />
            </div>
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
                  setInventory(null);
                  setError(null);
                  setSelectedItem(null);
                }}
                placeholder="override provider thread id"
                className="w-full"
                aria-label="Override provider thread id"
              />
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Providers" icon={<BotIcon className="size-3.5" />}>
        {inventory?.providers.length ? (
          inventory.providers.map((provider) => (
            <ProviderInventoryRow
              key={provider.instanceId}
              provider={provider}
              filterText={filterText}
              onSelectItem={setSelectedItem}
            />
          ))
        ) : (
          <SettingsRow
            title={
              !cwd
                ? "No project selected"
                : !providerInstanceId
                  ? "No provider selected"
                  : isLoading
                    ? "Loading inventory"
                    : "Inventory not loaded"
            }
            description={
              !cwd
                ? "Choose a project to inspect extension surfaces."
                : !providerInstanceId
                  ? "Choose Codex or Claude before loading extensions."
                  : isLoading
                    ? "Checking the selected provider extension surfaces."
                    : "Click Load after choosing a provider."
            }
          />
        )}
      </SettingsSection>
      <ExtensionDetailDialog
        item={selectedItem}
        cwd={cwd}
        providerThreadId={effectiveProviderThreadId}
        onClose={() => setSelectedItem(null)}
        onInventoryMutated={refresh}
      />
    </SettingsPageContainer>
  );
}
