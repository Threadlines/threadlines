import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type {
  EnvironmentApi,
  ProviderExtensionMcpServer,
  ProviderExtensionMcpServerAuthProviderType,
  ProviderExtensionMcpServerMode,
  ProviderExtensionProviderInventory,
  ProviderInstanceId,
} from "@threadlines/contracts";
import { useCallback, useEffect, useState } from "react";

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
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

type ExtensionProvidersApi = NonNullable<EnvironmentApi["providers"]>;

interface KeyValueDraft {
  readonly id: number;
  readonly key: string;
  readonly value: string;
  readonly saved?: boolean;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function providerLabel(provider: ProviderExtensionProviderInventory): string {
  return provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : provider.driver);
}

function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function KeyValueListEditor({
  label,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
}: {
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: ReadonlyArray<KeyValueDraft>;
  onChange: (next: Array<KeyValueDraft>) => void;
}) {
  const addRow = () => {
    const nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    onChange([...rows, { id: nextId, key: "", value: "" }]);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
        <Button type="button" size="xs" variant="ghost" onClick={addRow}>
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-1.5"
            >
              <Input
                nativeInput
                size="sm"
                value={row.key}
                placeholder={keyPlaceholder}
                aria-label={`${label} name`}
                onChange={(event) => {
                  const nextKey = event.currentTarget.value;
                  onChange(
                    rows.map((entry) =>
                      entry.id === row.id ? { ...entry, key: nextKey, saved: false } : entry,
                    ),
                  );
                }}
              />
              <Input
                nativeInput
                size="sm"
                type="password"
                value={row.value}
                placeholder={row.saved ? "Saved (leave blank to keep)" : valuePlaceholder}
                aria-label={`${label} value`}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  onChange(
                    rows.map((entry) =>
                      entry.id === row.id ? { ...entry, value: nextValue } : entry,
                    ),
                  );
                }}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${row.key || label}`}
                onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function McpServerDialog({
  open,
  editing,
  providers,
  cwd,
  providersApi,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: {
    readonly provider: ProviderExtensionProviderInventory;
    readonly server: ProviderExtensionMcpServer;
  } | null;
  providers: ReadonlyArray<ProviderExtensionProviderInventory>;
  cwd: string;
  providersApi: () => ExtensionProvidersApi;
  onClose: () => void;
  onSaved: (saved: {
    readonly providerInstanceId: string;
    readonly serverName: string;
    readonly isOAuth: boolean;
  }) => Promise<void>;
}) {
  const isEditing = editing !== null;
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [mode, setMode] = useState<ProviderExtensionMcpServerMode>("oauth");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [serverCwd, setServerCwd] = useState("");
  const [authProviderType, setAuthProviderType] = useState<
    "none" | ProviderExtensionMcpServerAuthProviderType
  >("none");
  const [headerRows, setHeaderRows] = useState<Array<KeyValueDraft>>([]);
  const [envRows, setEnvRows] = useState<Array<KeyValueDraft>>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIsSaving(false);
    if (editing) {
      const cfg = editing.server.config;
      setProviderInstanceId(String(editing.provider.instanceId));
      setMode(cfg?.mode ?? "http");
      setName(editing.server.name);
      setUrl(cfg?.url ?? "");
      setCommand(cfg?.command ?? "");
      setArgsText((cfg?.args ?? []).join("\n"));
      setServerCwd(cfg?.cwd ?? "");
      setAuthProviderType(cfg?.authProviderType ?? "none");
      setHeaderRows(
        (cfg?.headerKeys ?? []).map((key, index) => ({
          id: index + 1,
          key,
          value: "",
          saved: true,
        })),
      );
      setEnvRows(
        (cfg?.envKeys ?? []).map((key, index) => ({
          id: index + 1,
          key,
          value: "",
          saved: true,
        })),
      );
    } else {
      setProviderInstanceId(String(providers[0]?.instanceId ?? ""));
      setMode("oauth");
      setName("");
      setUrl("");
      setCommand("");
      setArgsText("");
      setServerCwd("");
      setAuthProviderType("none");
      setHeaderRows([]);
      setEnvRows([]);
    }
  }, [editing, open, providers]);

  const trimmedName = name.trim();
  const nameValid = SERVER_NAME_PATTERN.test(trimmedName);
  const transportValid = mode === "stdio" ? command.trim().length > 0 : isValidHttpUrl(url);
  const canSave = nameValid && transportValid && providerInstanceId.length > 0 && !isSaving;

  const save = useCallback(async () => {
    if (!canSave) return;
    const api = providersApi();
    if (!api.saveExtensionMcpServer) {
      setError("This server does not support managing MCP connections from Settings.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      const keepHeaderKeys: Array<string> = [];
      for (const row of headerRows) {
        const key = row.key.trim();
        if (!key) continue;
        if (row.saved && row.value.length === 0) {
          keepHeaderKeys.push(key);
        } else if (row.value.length > 0) {
          headers[key] = row.value;
        }
      }

      const env: Record<string, string> = {};
      const keepEnvKeys: Array<string> = [];
      for (const row of envRows) {
        const key = row.key.trim();
        if (!key) continue;
        if (row.saved && row.value.length === 0) {
          keepEnvKeys.push(key);
        } else if (row.value.length > 0) {
          env[key] = row.value;
        }
      }

      const args = argsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      await api.saveExtensionMcpServer({
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        providerInstanceId: providerInstanceId as ProviderInstanceId,
        name: trimmedName,
        ...(editing ? { previousName: editing.server.name } : {}),
        mode,
        ...(mode === "stdio"
          ? {
              command: command.trim(),
              ...(args.length > 0 ? { args } : {}),
              ...(serverCwd.trim() ? { serverCwd: serverCwd.trim() } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
              ...(keepEnvKeys.length > 0 ? { keepEnvKeys } : {}),
            }
          : {
              url: url.trim(),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              ...(keepHeaderKeys.length > 0 ? { keepHeaderKeys } : {}),
              ...(mode === "http" && authProviderType !== "none" ? { authProviderType } : {}),
            }),
        ...(editing?.server.enabled !== undefined ? { enabled: editing.server.enabled } : {}),
      });

      toastManager.add({
        type: "success",
        title: isEditing ? "Connection updated" : "Connection added",
        description:
          mode === "oauth" && !isEditing
            ? `${trimmedName} saved. Click Authorize to sign in.`
            : `${trimmedName} saved to this Antigravity profile.`,
      });
      await onSaved({
        providerInstanceId,
        serverName: trimmedName,
        isOAuth: mode === "oauth",
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the connection.");
    } finally {
      setIsSaving(false);
    }
  }, [
    argsText,
    authProviderType,
    canSave,
    command,
    cwd,
    editing,
    envRows,
    headerRows,
    isEditing,
    mode,
    onClose,
    onSaved,
    providerInstanceId,
    providersApi,
    serverCwd,
    trimmedName,
    url,
  ]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? `Edit ${editing.server.name}` : "Add connection"}</DialogTitle>
          <DialogDescription>
            Saved inside this Antigravity profile only, separate from ~/.gemini/config.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {!isEditing && providers.length > 1 ? (
              <label className="block space-y-1">
                <span className="text-[11.5px] font-medium text-muted-foreground">Account</span>
                <Select
                  value={providerInstanceId}
                  onValueChange={(value) => setProviderInstanceId(String(value))}
                >
                  <SelectTrigger className="w-full" aria-label="Account">
                    <SelectValue>
                      {providerLabel(
                        providers.find(
                          (provider) => String(provider.instanceId) === providerInstanceId,
                        ) ?? providers[0]!,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {providers.map((provider) => (
                      <SelectItem key={provider.instanceId} value={String(provider.instanceId)}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}

            <div className="space-y-1">
              <span className="block text-[11.5px] font-medium text-muted-foreground">
                Transport
              </span>
              <SegmentedControl
                value={mode}
                onValueChange={(next) => {
                  if (next === "oauth" || next === "http" || next === "stdio") {
                    setMode(next);
                  }
                }}
                aria-label="MCP transport"
              >
                <SegmentedControlItem value="oauth">Remote OAuth</SegmentedControlItem>
                <SegmentedControlItem value="http">Streamable HTTP</SegmentedControlItem>
                <SegmentedControlItem value="stdio">Local stdio</SegmentedControlItem>
              </SegmentedControl>
            </div>

            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-muted-foreground">Name</span>
              <Input
                nativeInput
                autoFocus={!isEditing}
                value={name}
                placeholder={
                  mode === "oauth" ? "posthog" : mode === "http" ? "internal-api" : "sqlite"
                }
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <span className="block text-[11px] text-muted-foreground">
                Letters, digits, dots, underscores, or hyphens.
              </span>
            </label>

            {mode === "oauth" || mode === "http" ? (
              <>
                <label className="block space-y-1">
                  <span className="text-[11.5px] font-medium text-muted-foreground">
                    Server URL
                  </span>
                  <Input
                    nativeInput
                    value={url}
                    placeholder={
                      mode === "oauth"
                        ? "https://mcp.posthog.com/mcp"
                        : "https://api.example.com/mcp"
                    }
                    onChange={(event) => setUrl(event.currentTarget.value)}
                  />
                  {mode === "oauth" ? (
                    <span className="block text-[11px] text-muted-foreground">
                      Uses mcp-remote with OAuth tokens kept inside this Antigravity profile.
                    </span>
                  ) : null}
                </label>

                {mode === "http" ? (
                  <label className="block space-y-1">
                    <span className="text-[11.5px] font-medium text-muted-foreground">
                      Authentication
                    </span>
                    <Select
                      value={authProviderType}
                      onValueChange={(value) =>
                        setAuthProviderType(
                          value === "google_credentials" ? "google_credentials" : "none",
                        )
                      }
                    >
                      <SelectTrigger className="w-full" aria-label="Authentication">
                        <SelectValue>
                          {authProviderType === "google_credentials"
                            ? "Google ADC (google_credentials)"
                            : "None or custom headers"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        <SelectItem value="none">None or custom headers</SelectItem>
                        <SelectItem value="google_credentials">
                          Google ADC (google_credentials)
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  </label>
                ) : null}

                <KeyValueListEditor
                  label="HTTP headers"
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer ..."
                  rows={headerRows}
                  onChange={setHeaderRows}
                />
              </>
            ) : (
              <>
                <label className="block space-y-1">
                  <span className="text-[11.5px] font-medium text-muted-foreground">Command</span>
                  <Input
                    nativeInput
                    value={command}
                    placeholder="npx"
                    onChange={(event) => setCommand(event.currentTarget.value)}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11.5px] font-medium text-muted-foreground">
                    Arguments (one per line)
                  </span>
                  <Textarea
                    value={argsText}
                    rows={3}
                    className="font-mono text-xs"
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                    onChange={(event) => setArgsText(event.currentTarget.value)}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11.5px] font-medium text-muted-foreground">
                    Working directory (optional)
                  </span>
                  <Input
                    nativeInput
                    value={serverCwd}
                    placeholder="/path/to/workspace"
                    onChange={(event) => setServerCwd(event.currentTarget.value)}
                  />
                </label>
                <KeyValueListEditor
                  label="Environment variables"
                  keyPlaceholder="API_KEY"
                  valuePlaceholder="value"
                  rows={envRows}
                  onChange={setEnvRows}
                />
              </>
            )}

            {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" disabled={!canSave} onClick={() => void save()}>
            {isSaving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {isEditing ? "Save changes" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function InstallPluginSourceDialog({
  open,
  providers,
  cwd,
  providersApi,
  onClose,
  onInstalled,
}: {
  open: boolean;
  providers: ReadonlyArray<ProviderExtensionProviderInventory>;
  cwd: string;
  providersApi: () => ExtensionProvidersApi;
  onClose: () => void;
  onInstalled: (providerInstanceId: string) => Promise<void>;
}) {
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [source, setSource] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setError(null);
    setIsInstalling(false);
    setProviderInstanceId(String(providers[0]?.instanceId ?? ""));
  }, [open, providers]);

  const trimmedSource = source.trim();
  const canInstall = trimmedSource.length > 0 && providerInstanceId.length > 0 && !isInstalling;

  const install = useCallback(async () => {
    if (!canInstall) return;
    setIsInstalling(true);
    setError(null);
    try {
      await providersApi().installExtensionPlugin({
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        providerInstanceId: providerInstanceId as ProviderInstanceId,
        pluginName: trimmedSource,
        source: trimmedSource,
      });
      toastManager.add({
        type: "success",
        title: "Plugin installed",
        description: trimmedSource,
      });
      await onInstalled(providerInstanceId);
      onClose();
    } catch (installError) {
      setError(
        installError instanceof Error ? installError.message : "Could not install the plugin.",
      );
    } finally {
      setIsInstalling(false);
    }
  }, [canInstall, cwd, onClose, onInstalled, providerInstanceId, providersApi, trimmedSource]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install plugin from source</DialogTitle>
          <DialogDescription>
            Installs a GitHub repository or local plugin folder into this Antigravity profile.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {providers.length > 1 ? (
              <label className="block space-y-1">
                <span className="text-[11.5px] font-medium text-muted-foreground">Account</span>
                <Select
                  value={providerInstanceId}
                  onValueChange={(value) => setProviderInstanceId(String(value))}
                >
                  <SelectTrigger className="w-full" aria-label="Account">
                    <SelectValue>
                      {providerLabel(
                        providers.find(
                          (provider) => String(provider.instanceId) === providerInstanceId,
                        ) ?? providers[0]!,
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {providers.map((provider) => (
                      <SelectItem key={provider.instanceId} value={String(provider.instanceId)}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-muted-foreground">
                GitHub URL or folder path
              </span>
              <Input
                nativeInput
                autoFocus
                value={source}
                placeholder="https://github.com/owner/repo or /path/to/plugin"
                onChange={(event) => setSource(event.currentTarget.value)}
              />
            </label>
            {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" disabled={!canInstall} onClick={() => void install()}>
            {isInstalling ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Install plugin
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
