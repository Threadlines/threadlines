import type { DesktopDiscoveredSshHost, DesktopSshEnvironmentTarget } from "@threadlines/contracts";
import { ChevronsLeftRightEllipsisIcon, RefreshCwIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  addSavedEnvironment,
  connectDesktopSshEnvironment,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
} from "~/environments/runtime";
import { readHostedPairingRequest } from "~/hostedPairing";
import { cn } from "~/lib/utils";
import { getPairingTokenFromUrl } from "~/pairingUrl";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { SETTINGS_GROUP_ROW_CLASS } from "../settingsLayout";
import {
  formatDesktopSshConnectionError,
  formatDesktopSshTarget,
  parseManualDesktopSshTarget,
} from "./sshTarget";

function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest?.kind === "direct") {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }
    if (hostedPairingRequest?.kind === "relay") {
      return null;
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

function parseRemotePairingFields(input: { readonly host: string; readonly pairingCode: string }): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter the address for the other computer.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  connectingHostAlias,
  onConnect,
}: {
  readonly target: DesktopDiscoveredSshHost;
  readonly connectingHostAlias: string | null;
  readonly onConnect: (target: DesktopDiscoveredSshHost) => void;
}) {
  const address = formatDesktopSshTarget(target);
  const showAddress = address !== target.alias;
  const buttonLabel = connectingHostAlias === target.alias ? "Adding..." : "Add";

  return (
    <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3")}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{target.alias}</h3>
          {showAddress ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});

/**
 * The older ways to reach a computer, behind "Other ways to connect" in the
 * Connect to a computer dialog: an address with a one-time pairing code, and
 * on the desktop app SSH (typed, or picked from the SSH config and known
 * hosts). `onConnected` gets the saved computer once it works.
 */
export function OtherWaysToConnect({
  hosted,
  onConnected,
}: {
  /** The hosted app or a phone: no SSH. */
  readonly hosted: boolean;
  readonly onConnected: (record: SavedEnvironmentRecord, how: "address" | "ssh") => void;
}) {
  const desktopBridge = window.desktopBridge;
  const sshAvailable = Boolean(desktopBridge) && !hosted;
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedDesktopSshEnvironmentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const record of Object.values(savedEnvironmentsById)) {
      const target = record.desktopSsh;
      if (!target) continue;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  }, [savedEnvironmentsById]);
  const [mode, setMode] = useState<"remote" | "ssh">("remote");
  const [host, setHost] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [discoveredSshHosts, setDiscoveredSshHosts] = useState<
    ReadonlyArray<DesktopDiscoveredSshHost>
  >([]);
  const [hasLoadedDiscoveredSshHosts, setHasLoadedDiscoveredSshHosts] = useState(false);
  const [isLoadingDiscoveredSshHosts, setIsLoadingDiscoveredSshHosts] = useState(false);
  const [discoveredSshHostsError, setDiscoveredSshHostsError] = useState<string | null>(null);
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);
  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) => {
        const address = formatDesktopSshTarget(target);
        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        );
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  );

  const loadDiscoveredSshHosts = useCallback(async () => {
    if (!desktopBridge) {
      setDiscoveredSshHosts([]);
      setHasLoadedDiscoveredSshHosts(false);
      setDiscoveredSshHostsError(null);
      return;
    }
    setIsLoadingDiscoveredSshHosts(true);
    setDiscoveredSshHostsError(null);
    try {
      const hosts = await desktopBridge.discoverSshHosts();
      setDiscoveredSshHosts(hosts);
      setHasLoadedDiscoveredSshHosts(true);
    } catch (loadError) {
      setDiscoveredSshHostsError(
        loadError instanceof Error ? loadError.message : "Failed to find SSH computers.",
      );
      setHasLoadedDiscoveredSshHosts(true);
    } finally {
      setIsLoadingDiscoveredSshHosts(false);
    }
  }, [desktopBridge]);

  useEffect(() => {
    if (!sshAvailable || mode !== "ssh") return;
    if (hasLoadedDiscoveredSshHosts || isLoadingDiscoveredSshHosts) return;
    void loadDiscoveredSshHosts();
  }, [
    hasLoadedDiscoveredSshHosts,
    isLoadingDiscoveredSshHosts,
    loadDiscoveredSshHosts,
    mode,
    sshAvailable,
  ]);

  const connectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget) => {
      setConnectingSshHostAlias(target.alias);
      setError(null);
      try {
        const record = await connectDesktopSshEnvironment(target);
        setSshHost("");
        setSshUsername("");
        setSshPort("");
        onConnected(record, "ssh");
      } catch (connectError) {
        setError(formatDesktopSshConnectionError(connectError));
      } finally {
        setConnectingSshHostAlias(null);
      }
    },
    [onConnected],
  );

  const add = useCallback(async () => {
    setAdding(true);
    setError(null);
    try {
      if (mode === "ssh") {
        const target = parseManualDesktopSshTarget({
          host: sshHost,
          username: sshUsername,
          port: sshPort,
        });
        const record = await connectDesktopSshEnvironment(target, { label: "" });
        onConnected(record, "ssh");
      } else {
        const record = await addSavedEnvironment({
          label: "",
          ...parseRemotePairingFields({ host, pairingCode }),
        });
        onConnected(record, "address");
      }
      setHost("");
      setPairingCode("");
      setSshHost("");
      setSshUsername("");
      setSshPort("");
    } catch (addError) {
      setError(
        mode === "ssh"
          ? formatDesktopSshConnectionError(addError)
          : addError instanceof Error
            ? addError.message
            : "Failed to add computer.",
      );
    } finally {
      setAdding(false);
    }
  }, [host, mode, onConnected, pairingCode, sshHost, sshPort, sshUsername]);

  const onHostChange = (value: string) => {
    const parsed = parsePairingUrlFields(value);
    if (parsed) {
      setHost(parsed.host);
      setPairingCode(parsed.pairingCode);
      return;
    }
    setHost(value);
  };

  const modeCard = (input: {
    readonly mode: "remote" | "ssh";
    readonly title: string;
    readonly description: string;
    readonly icon: ReactNode;
  }) => {
    const selected = mode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex items-start gap-3 rounded-lg border p-3 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={adding}
        onClick={() => {
          setMode(input.mode);
          setError(null);
        }}
      >
        <span
          className={cn(
            "mt-0.5 shrink-0",
            selected ? "text-primary-readable" : "text-muted-foreground",
          )}
        >
          {input.icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const remoteFields = (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Computer address</span>
          <Input
            value={host}
            onChange={(event) => onHostChange(event.target.value)}
            placeholder="Paste a link or address"
            disabled={adding}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={adding}
            spellCheck={false}
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        For a one-time link from Connection options on the other computer. Pasting the whole link
        fills in the code.
      </p>
    </div>
  );

  const sshFields = (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">
          Computer name or SSH host
        </span>
        <Input
          value={sshHost}
          onChange={(event) => setSshHost(event.target.value)}
          placeholder="Search saved hosts or type devbox"
          disabled={adding}
          spellCheck={false}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">User name</span>
          <Input
            value={sshUsername}
            onChange={(event) => setSshUsername(event.target.value)}
            placeholder="root"
            disabled={adding}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
          <Input
            value={sshPort}
            onChange={(event) => setSshPort(event.target.value)}
            placeholder="22"
            inputMode="numeric"
            disabled={adding}
            spellCheck={false}
          />
        </label>
      </div>
      {unsavedDiscoveredSshHosts.length > 0 || isLoadingDiscoveredSshHosts ? (
        <div className="border-t border-group-divider pt-2">
          <div className="flex items-center justify-between gap-3 py-1">
            <p className="text-xs text-muted-foreground">From your SSH config and known hosts</p>
            <Button
              size="xs"
              variant="ghost"
              disabled={isLoadingDiscoveredSshHosts}
              onClick={() => void loadDiscoveredSshHosts()}
            >
              <RefreshCwIcon
                className={cn("size-3", isLoadingDiscoveredSshHosts && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
          <ScrollArea scrollFade className="max-h-48">
            <div>
              {unsavedDiscoveredSshHosts.map((target) => (
                <DesktopSshHostRow
                  key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                  target={target}
                  connectingHostAlias={connectingSshHostAlias}
                  onConnect={(next) => void connectSshHost(next)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className={cn("grid gap-2", sshAvailable && "sm:grid-cols-2")}>
        {modeCard({
          mode: "remote",
          title: "Address and pairing code",
          description: "A one-time link for the same network or Tailscale.",
          icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
        })}
        {sshAvailable
          ? modeCard({
              mode: "ssh",
              title: "SSH",
              description: "For computers you already reach with SSH keys.",
              icon: <TerminalIcon aria-hidden className="size-4" />,
            })
          : null}
      </div>
      {mode === "ssh" && sshAvailable ? sshFields : remoteFields}
      {error || discoveredSshHostsError ? (
        <p className="text-xs text-destructive-foreground">{error ?? discoveredSshHostsError}</p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        disabled={adding}
        onClick={() => void add()}
      >
        {adding ? "Adding..." : "Add this computer"}
      </Button>
    </div>
  );
}
