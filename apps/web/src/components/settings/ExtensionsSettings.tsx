import { BotIcon, LoaderIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import type {
  ProviderExtensionProviderInventory,
  ProviderExtensionsInventoryResult,
} from "@t3tools/contracts";
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureLocalApi } from "../../localApi";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useServerProviders } from "../../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { deriveSettingsProjectOptions } from "./settingsProjectOptions";

const COMPACT_LIST_PREVIEW_LIMIT = 8;
const EXTENSIONS_CODEX_DRIVER = ProviderDriverKind.make("codex");
const EXTENSIONS_CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

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

function providerTitle(provider: ProviderExtensionProviderInventory): string {
  return provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : provider.driver);
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

function CompactList({
  items,
  totalCount,
}: {
  items: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly detail?: string | undefined;
    readonly enabled?: boolean | undefined;
  }>;
  totalCount: number;
}) {
  const hiddenCount = Math.max(0, totalCount - items.length);
  return (
    <div className="divide-y divide-border/50 rounded-md border border-border/60">
      {items.map((item) => (
        <div key={item.id} className="flex min-h-8 items-center gap-2 px-2.5 py-1.5">
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
        </div>
      ))}
      {hiddenCount > 0 ? (
        <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">{hiddenCount} more</div>
      ) : null}
    </div>
  );
}

function ProviderInventoryRow({ provider }: { provider: ProviderExtensionProviderInventory }) {
  const pluginItems = provider.plugins.slice(0, COMPACT_LIST_PREVIEW_LIMIT).map((plugin) => ({
    id: plugin.id,
    title: plugin.displayName ?? plugin.name,
    detail: plugin.description ?? plugin.scope ?? plugin.source,
    enabled: plugin.enabled,
  }));
  const skillItems = provider.skills.slice(0, COMPACT_LIST_PREVIEW_LIMIT).map((skill) => ({
    id: skill.path,
    title: skill.displayName ?? skill.name,
    detail: skill.shortDescription ?? skill.scope ?? skill.path,
    enabled: skill.enabled,
  }));
  const mcpItems = provider.mcpServers.slice(0, COMPACT_LIST_PREVIEW_LIMIT).map((server) => ({
    id: server.name,
    title: server.name,
    detail:
      [server.transport, server.status, server.detail].filter(Boolean).join(" - ") ||
      `${server.toolCount ?? 0} tools`,
  }));
  const appItems = provider.apps.slice(0, COMPACT_LIST_PREVIEW_LIMIT).map((app) => ({
    id: app.id,
    title: app.displayName ?? app.name,
    detail: app.description,
    enabled: app.enabled,
  }));

  return (
    <SettingsRow
      title={providerTitle(provider)}
      description={`${provider.instanceId} - ${provider.driver}`}
      status={provider.message}
      control={
        <Badge size="sm" variant={statusVariant(provider.status)}>
          {provider.status}
        </Badge>
      }
    >
      <div className="mt-3 space-y-3 border-t border-border/50 py-3">
        <div className="flex flex-wrap gap-1.5">
          <CountPill label="plugins" value={provider.plugins.length} />
          <CountPill label="skills" value={provider.skills.length} />
          <CountPill label="MCP" value={provider.mcpServers.length} />
          <CountPill label="apps" value={provider.apps.length} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
              Plugins
            </div>
            {pluginItems.length > 0 ? (
              <CompactList items={pluginItems} totalCount={provider.plugins.length} />
            ) : (
              <EmptyList label="No plugins reported." />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
              Skills
            </div>
            {skillItems.length > 0 ? (
              <CompactList items={skillItems} totalCount={provider.skills.length} />
            ) : (
              <EmptyList label="No skills reported." />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">
              MCP Servers
            </div>
            {mcpItems.length > 0 ? (
              <CompactList items={mcpItems} totalCount={provider.mcpServers.length} />
            ) : (
              <EmptyList label="No MCP servers reported." />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground/70">Apps</div>
            {appItems.length > 0 ? (
              <CompactList items={appItems} totalCount={provider.apps.length} />
            ) : (
              <EmptyList label="No apps reported." />
            )}
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

export function ExtensionsSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const serverProviders = useServerProviders();
  const projectOptions = useMemo(() => deriveSettingsProjectOptions(projects), [projects]);
  const providerOptions = useMemo(
    () =>
      sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders))
        .filter(
          (provider) =>
            provider.enabled &&
            provider.isAvailable &&
            (provider.driverKind === EXTENSIONS_CODEX_DRIVER ||
              provider.driverKind === EXTENSIONS_CLAUDE_DRIVER),
        )
        .map((provider) => ({
          value: String(provider.instanceId),
          label: provider.displayName,
        })),
    [serverProviders],
  );
  const [cwd, setCwd] = useState(() => projectOptions[0]?.value ?? "");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [inventory, setInventory] = useState<ProviderExtensionsInventoryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);

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
    if (!providerOptions.some((provider) => provider.value === providerInstanceId)) {
      setProviderInstanceId(providerOptions[0]!.value);
    }
  }, [providerInstanceId, providerOptions]);

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
  }, [cwd, providerInstanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection
        title="Extensions"
        icon={<PlugIcon className="size-3.5" />}
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isLoading}
                  onClick={() => void refresh()}
                  aria-label="Refresh extension inventory"
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh inventory</TooltipPopup>
          </Tooltip>
        }
      >
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
                  if (value) setCwd(value);
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
          description="Inventory is loaded for one supported provider instance."
          control={
            providerOptions.length > 0 ? (
              <Select
                value={providerInstanceId}
                onValueChange={(value) => {
                  if (value) setProviderInstanceId(value);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Provider">
                  <SelectValue>
                    {providerOptions.find((provider) => provider.value === providerInstanceId)
                      ?.label ?? "Provider"}
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
            ) : null
          }
        />
      </SettingsSection>

      <SettingsSection title="Providers" icon={<BotIcon className="size-3.5" />}>
        {inventory?.providers.length ? (
          inventory.providers.map((provider) => (
            <ProviderInventoryRow key={provider.instanceId} provider={provider} />
          ))
        ) : (
          <SettingsRow
            title={
              !cwd
                ? "No project selected"
                : isLoading
                  ? "Loading providers"
                  : "No supported providers"
            }
            description={
              !cwd
                ? "Choose a project to inspect extension surfaces."
                : isLoading
                  ? "Checking Codex and Claude extension surfaces."
                  : "Enable a Codex or Claude provider instance to inspect extensions."
            }
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
