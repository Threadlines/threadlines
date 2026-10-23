import {
  ChevronDownIcon,
  ChevronRightIcon,
  LaptopIcon,
  MonitorIcon,
  QrCodeIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
  type InboundComputerLink,
  RELAY_DEVICE_SESSION_SUBJECT as RELAY_DEVICE_SUBJECT,
} from "@threadlines/contracts";

import {
  describeComputerLinkFailure,
  removeComputerLinkHalf,
  useComputerLinksStore,
} from "../../environments/links/computerLinks";
import { useAuthAccess, usePrimarySessionAccess } from "../../hooks/useAuthAccess";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { isClipboardCopySupported } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { formatExpiresInLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { COMPUTER_LINK_ACCESS_LABELS } from "../fleet/fleetLinks.logic";
import { ConnectDeviceDialog } from "./connections/ConnectDeviceDialog";
import { ConnectionStatusDot, formatAccessTimestamp } from "./connections/ConnectionStatusDot";
import { openConnectComputerDialog } from "./connections/JoinComputerDialog";
import { useRelayAccess } from "./connections/useRelayAccess";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { RestartWorkWarning, WithLocalWorkAtRisk } from "../desktop/RestartWorkWarning";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import {
  createServerPairingCredential,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  isLoopbackHostname,
  usePrimaryEnvironmentDescriptor,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { useSavedEnvironmentRegistryStore } from "~/environments/runtime";
import { useUiStateStore } from "~/uiStateStore";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { useServerConfig } from "~/rpc/serverState";
import { OutsideAgentsSection } from "../outsideAgents/OutsideAgentsSection";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;

/** A row directly in a settings group: the group's inset divider and row padding. */
const ITEM_ROW_CLASSNAME = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3");
const NO_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];
const ENDPOINT_ROW_CLASSNAME = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

type AccessSectionPresentation = "current" | "endpoint-rail";

function accessRowClassName(_presentation: AccessSectionPresentation) {
  return ITEM_ROW_CLASSNAME;
}

function endpointRowClassName(presentation: AccessSectionPresentation, isAvailable: boolean) {
  if (presentation === "endpoint-rail") {
    return cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3", !isAvailable && "bg-muted/20");
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && "bg-muted/24");
}

function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const hostedPairingUrl = useMemo(
    () =>
      endpointUrl != null && endpointUrl !== ""
        ? resolveHostedPairingUrl(endpointUrl, pairingLink.credential)
        : null,
    [endpointUrl, pairingLink.credential],
  );
  const endpointPairingUrl = useMemo(() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint ? resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential) : null;
  }, [defaultEndpointKey, endpoints, pairingLink.credential]);
  const endpointCopyOptions = useMemo(
    () =>
      endpoints
        .filter((endpoint) => endpoint.status !== "unavailable")
        .map((endpoint) => {
          const url = resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential);
          return {
            key: endpointDefaultPreferenceKey(endpoint),
            label: endpoint.label,
            url,
            detail: isHostedAppPairingUrl(url) ? "Threadlines web link" : "Direct computer link",
          };
        }),
    [endpoints, pairingLink.credential],
  );
  const shareablePairingUrl =
    endpointPairingUrl ??
    (endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  const isShareableHostedAppPairingUrl =
    shareablePairingUrl !== null && isHostedAppPairingUrl(shareablePairingUrl);
  // Pairing links are minted on the LAN origin (plain http), where the async
  // Clipboard API is missing. `isClipboardCopySupported` also accepts the
  // execCommand fallback, so the copy buttons survive there.
  const canCopyToClipboard = isClipboardCopySupported();

  const { copyToClipboard } = useCopyToClipboard<"code" | "hosted-link" | "link">({
    onCopy: (kind) => {
      toastManager.add({
        type: "success",
        title:
          kind === "hosted-link"
            ? "Device link copied"
            : kind === "link"
              ? "Device link copied"
              : "Pairing code copied",
        description:
          kind === "hosted-link"
            ? "Open it in the browser on your phone or tablet."
            : kind === "link"
              ? "Open it on the device you want to connect."
              : "Use it on another device to finish connecting.",
      });
    },
    onError: (error, kind) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "hosted-link"
              ? "Could not copy device link"
              : kind === "link"
                ? "Could not copy device link"
                : "Could not copy pairing code"
            : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const copyPairingValue = useCallback(
    (value: string, kind: "code" | "hosted-link" | "link") => {
      copyToClipboard(value, kind);
    },
    [copyToClipboard],
  );

  const copyKindForUrl = useCallback(
    (url: string): "hosted-link" | "link" => (isHostedAppPairingUrl(url) ? "hosted-link" : "link"),
    [],
  );

  const handleCopyCode = useCallback(() => {
    copyPairingValue(pairingLink.credential, "code");
  }, [copyPairingValue, pairingLink.credential]);

  const handleCopyDefaultLink = useCallback(() => {
    if (!shareablePairingUrl) return;
    copyPairingValue(shareablePairingUrl, copyKindForUrl(shareablePairingUrl));
  }, [copyKindForUrl, copyPairingValue, shareablePairingUrl]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel = pairingLink.role === "owner" ? "Owner" : "Device";
  const primaryLabel = pairingLink.label ?? `${roleLabel} link`;
  const defaultEndpointCopyOption =
    endpointCopyOptions.find((option) => option.key === defaultEndpointKey) ??
    endpointCopyOptions[0] ??
    null;
  const defaultEndpointCopyLabel = defaultEndpointCopyOption?.label ?? "URL";
  const backendEndpointCopyOptions = endpointCopyOptions.filter(
    (option) => !isHostedAppPairingUrl(option.url),
  );
  const hostedEndpointCopyOptions = endpointCopyOptions.filter((option) =>
    isHostedAppPairingUrl(option.url),
  );
  const renderEndpointMenuItems = (
    options: typeof endpointCopyOptions = endpointCopyOptions,
    renderDetail = true,
  ) =>
    options.map((option) => (
      <MenuItem
        key={option.key}
        onClick={() => copyPairingValue(option.url, copyKindForUrl(option.url))}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{option.label}</span>
          {renderDetail ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {option.detail}
            </span>
          ) : null}
        </span>
      </MenuItem>
    ));
  const renderPairingCodeMenuItem = (renderDetail = true) => (
    <MenuItem onClick={handleCopyCode}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">Copy code</span>
        {renderDetail ? (
          <span className="block truncate text-[11px] text-muted-foreground">Token only</span>
        ) : null}
      </span>
    </MenuItem>
  );
  const renderCompactEndpointGroup = (
    label: string,
    options: typeof endpointCopyOptions,
    includeSeparator: boolean,
  ) =>
    options.length > 0 ? (
      <>
        {includeSeparator ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          {renderEndpointMenuItems(options, false)}
        </MenuGroup>
      </>
    ) : null;
  const renderGroupedCopyMenuItems = (options?: { codeFirst?: boolean }) => (
    <>
      {options?.codeFirst ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>Pairing code</MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
        </>
      ) : null}
      {renderCompactEndpointGroup("Direct computer links", backendEndpointCopyOptions, false)}
      {renderCompactEndpointGroup(
        "Threadlines web link",
        hostedEndpointCopyOptions,
        backendEndpointCopyOptions.length > 0,
      )}
      {!options?.codeFirst ? (
        <>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            <MenuGroupLabel>Pairing code</MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem onClick={() => setIsRevealDialogOpen(true)}>
        <span className="min-w-0 flex-1 truncate">Show link, code, and QR</span>
      </MenuItem>
    </>
  );

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                        aria-label="Show QR code"
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title="Device link - scan to open on another device"
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {[roleLabel, formatExpiresInLabel(pairingLink.expiresAt, nowMs)].join(" · ")}
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground">
              Open Threadlines at this computer&apos;s network address to get a link a phone can
              scan. From localhost there is no address a phone can reach, so pair with the code
              instead.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard && shareablePairingUrl ? (
              <Group aria-label="Copy selected endpoint">
                <Button
                  size="xs"
                  variant="outline"
                  className="max-w-56"
                  tooltip={`Copy link for: ${defaultEndpointCopyLabel}`}
                  onClick={handleCopyDefaultLink}
                >
                  <span className="truncate">Copy link for: {defaultEndpointCopyLabel}</span>
                </Button>
                <GroupSeparator />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="outline"
                        aria-label="More link and code options"
                      />
                    }
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="min-w-60">
                    {renderGroupedCopyMenuItems()}
                  </MenuPopup>
                </Menu>
              </Group>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "Show link" : "Show code"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>{shareablePairingUrl ? "Device link" : "Pairing code"}</DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? isShareableHostedAppPairingUrl
                      ? "Scan the code or open this link in the browser on your phone or tablet. You can also type the pairing code by hand."
                      : "Scan the code or open this link on the device you want to connect. You can also type the pairing code by hand."
                    : "Enter this code on the device you want to connect."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                {shareablePairingUrl ? (
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Setup link
                    </span>
                    <Textarea
                      readOnly
                      value={shareablePairingUrl}
                      rows={4}
                      className="text-xs leading-relaxed"
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                    />
                  </label>
                ) : null}
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    Pairing code
                  </span>
                  <Input
                    readOnly
                    value={pairingLink.credential}
                    className="font-mono text-sm tracking-wide"
                    onFocus={(event) => event.target.select()}
                    onClick={(event) => event.currentTarget.select()}
                  />
                </label>
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-group-divider bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Device link - scan to open on another device"
                    />
                  </div>
                ) : null}
                {canCopyToClipboard ? null : (
                  <p className="text-xs text-muted-foreground">
                    This browser will not let Threadlines copy for you. Select the text above to
                    copy it by hand.
                  </p>
                )}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
                {canCopyToClipboard ? (
                  <>
                    <Button variant="outline" onClick={handleCopyCode}>
                      Copy code
                    </Button>
                    {shareablePairingUrl ? (
                      <Button onClick={handleCopyDefaultLink}>Copy link</Button>
                    ) : null}
                  </>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Removing..." : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
});

type DeviceAccessRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

function deviceKindLabel(
  deviceType: ServerClientSessionRecord["client"]["deviceType"],
): string | null {
  switch (deviceType) {
    case "desktop":
      return "Computer";
    case "mobile":
      return "Phone";
    case "tablet":
      return "Tablet";
    default:
      return null;
  }
}

/**
 * One device that can use this computer. Devices that joined with a code show
 * as Computer / Phone with their platform; same-network links say so.
 */
const DeviceAccessRow = memo(function DeviceAccessRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
}: DeviceAccessRowProps) {
  const nowMs = useRelativeTimeTick(30_000);
  const isLive = clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const isRelayDevice = clientSession.subject === RELAY_DEVICE_SUBJECT;
  const statusText = isLive
    ? "Connected now"
    : lastConnectedAt
      ? `Last connected ${formatRelativeTimeLabel(lastConnectedAt, nowMs)}`
      : "Not connected yet";
  const KindIcon =
    clientSession.client.deviceType === "mobile" || clientSession.client.deviceType === "tablet"
      ? SmartphoneIcon
      : MonitorIcon;
  const metaBits = [
    deviceKindLabel(clientSession.client.deviceType),
    isRelayDevice ? null : "Same network",
    clientSession.client.os ?? null,
    isRelayDevice ? null : (clientSession.client.browser ?? null),
    statusText,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      "Unnamed device");

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={
                lastConnectedAt ? `Last connected ${formatAccessTimestamp(lastConnectedAt)}` : null
              }
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
            />
            <KindIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-[13px] font-semibold text-foreground">{primaryLabel}</h3>
          </div>
          <p className="text-xs text-muted-foreground">{metaBits.join(" · ")}</p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingClientSessionId === clientSession.sessionId}
            onClick={() => void onRevokeSession(clientSession.sessionId)}
          >
            {revokingClientSessionId === clientSession.sessionId ? "Removing..." : "Remove access"}
          </Button>
        </div>
      </div>
    </div>
  );
});

/**
 * Another computer linked to this one (a `peer` session), joined to its
 * inbound link by session id, never by name: two computers can share one.
 * Joined, it says what its agents may do here and offers Manage in Fleet;
 * Remove access removes the link and stops the threads it started here, as
 * Unlink does. A peer session with no link to match reads "Linked computer"
 * and only offers Remove access.
 */
function LinkedComputerAccessRow({
  clientSession,
  link,
  removing,
  onRemove,
}: {
  readonly clientSession: ServerClientSessionRecord;
  readonly link: InboundComputerLink | null;
  readonly removing: boolean;
  readonly onRemove: () => void;
}) {
  const nowMs = useRelativeTimeTick(30_000);
  const navigate = useNavigate();
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusText = clientSession.connected
    ? "Connected now"
    : lastConnectedAt
      ? `Last connected ${formatRelativeTimeLabel(lastConnectedAt, nowMs)}`
      : "Not connected yet";
  const meta = [
    link === null
      ? "Linked computer"
      : `Linked computer · its agents: ${COMPUTER_LINK_ACCESS_LABELS[link.access]}`,
    statusText,
  ].join(" · ");
  return (
    <div
      className={ITEM_ROW_CLASSNAME}
      data-testid={`linked-computer-row-${clientSession.sessionId}`}
    >
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={
                lastConnectedAt ? `Last connected ${formatAccessTimestamp(lastConnectedAt)}` : null
              }
              dotClassName={clientSession.connected ? "bg-success" : "bg-muted-foreground/30"}
            />
            <LaptopIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-[13px] font-semibold text-foreground">
              {link?.label ?? clientSession.client.label ?? "Linked computer"}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">{meta}</p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {link !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void (link.environmentId !== null
                  ? navigate({
                      to: "/fleet/$environmentId",
                      params: { environmentId: link.environmentId },
                    })
                  : navigate({
                      to: "/fleet/device/$deviceId",
                      params: { deviceId: link.deviceId },
                    }))
              }
            >
              Manage in Fleet
            </Button>
          ) : null}
          <Button size="xs" variant="destructive-outline" disabled={removing} onClick={onRemove}>
            {removing ? "Removing..." : "Remove access"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectedDevicesSkeleton({ presentation }: { presentation: AccessSectionPresentation }) {
  return (
    <div
      className={accessRowClassName(presentation)}
      role="status"
      aria-label="Loading connected devices"
      data-testid="connected-devices-skeleton"
    >
      <div className={ITEM_ROW_INNER_CLASSNAME} aria-hidden="true">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-h-5 items-center gap-2">
            <Skeleton className="size-2 shrink-0 rounded-full" />
            <Skeleton className="h-3.5 w-36 max-w-full rounded-full" />
          </div>
          <Skeleton className="h-3 w-52 max-w-full rounded-full" />
        </div>
        <div className="flex w-full shrink-0 items-center sm:w-auto sm:justify-end">
          <Skeleton className="h-7 w-20 rounded-sm" />
        </div>
      </div>
    </div>
  );
}

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  presentation?: AccessSectionPresentation;
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  isUpdatingTailscaleServe: boolean;
};

const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  presentation = "current",
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: AdvertisedEndpointListRowProps) {
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  const isEndpointRail = presentation === "endpoint-rail";
  return (
    <div className={endpointRowClassName(presentation, isAvailable)}>
      {isEndpointRail && isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          {shouldShowEndpointUrl ? (
            <p
              className="min-w-0 truncate text-xs leading-5 text-muted-foreground"
              title={endpoint.httpBaseUrl}
            >
              {endpoint.httpBaseUrl}
            </p>
          ) : null}
          {!isAvailable ? (
            <span className="shrink-0 rounded-md border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
              Needs setup
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary-readable">
              Default
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onSetupTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "Restarting..." : "Set up"}
            </Button>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "Restarting..." : "Disable"}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              Set as default
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? "Hide" : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">Connection address</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

/**
 * Settings › Connections. Organized by direction so it's always clear which
 * computer is which:
 * - This computer: its name.
 * - Devices that can use this computer: "Connect a device" (code + QR
 *   through the relay) and every device with access, each with Remove access.
 *   Linked computers are joined to their links by session id.
 * - Computers you use from here: how many, with Open Fleet and "Connect to a
 *   computer" (Fleet manages them, docs/design/fleet.md R4.4).
 * - Connection options: Same network, Tailscale, one-time network links.
 * The hosted app (`surface="phone"`) only has the middle-but-one section.
 */
export function ConnectionsSettings({
  surface = "full",
  focusSection,
}: {
  surface?: "full" | "phone";
  /** A group to bring into view on arrival (the command palette's "Connect an agent"). */
  focusSection?: "agents" | undefined;
}) {
  const isPhoneSurface = surface === "phone";
  const navigate = useNavigate();
  const desktopBridge = window.desktopBridge;
  const { role: currentSessionRole, authPolicy: currentAuthPolicy } =
    usePrimarySessionAccess(!isPhoneSurface);
  const savedComputerCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const [storedServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
  const [storedAdvertisedEndpoints, setDesktopAdvertisedEndpoints] = useState<
    ReadonlyArray<AdvertisedEndpoint>
  >([]);
  const [storedServerExposureError, setDesktopServerExposureError] = useState<string | null>(null);
  const [desktopAccessManagementError, setDesktopAccessManagementError] = useState<string | null>(
    null,
  );
  const authAccess = useAuthAccess(!isPhoneSurface && currentSessionRole === "owner", {
    // Any fresh word from the server clears the message a failed removal left.
    onEvent: () => setDesktopAccessManagementError(null),
  });
  const desktopPairingLinks = authAccess.pairingLinks;
  const desktopClientSessions = authAccess.clientSessions;
  const isLoadingDesktopAccessManagement = authAccess.isLoading;
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [confirmRemoveAllOpen, setConfirmRemoveAllOpen] = useState(false);
  const [connectDeviceOpen, setConnectDeviceOpen] = useState(false);
  const [connectionOptionsOpen, setConnectionOptionsOpen] = useState(false);
  const [directLinkDialogOpen, setDirectLinkDialogOpen] = useState(false);
  const [directLinkLabel, setDirectLinkLabel] = useState("");
  const [isCreatingDirectLink, setIsCreatingDirectLink] = useState(false);
  const [retiredPhoneLinkNotice, setRetiredPhoneLinkNotice] = useState(false);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [isDesktopServerExposureDialogOpen, setIsDesktopServerExposureDialogOpen] = useState(false);
  const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false);
  const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
    useState<AdvertisedEndpoint | null>(null);
  const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false);
  const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
    String(DEFAULT_TAILSCALE_SERVE_PORT),
  );
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const primaryServerConfig = useServerConfig();
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
  const thisComputerLabel = primaryServerConfig?.environment.label ?? "This computer";
  const thisEnvironmentId = primaryServerConfig?.environment.environmentId ?? null;
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canManageLocalBackend = currentSessionRole === "owner";
  // Agents outside Threadlines sign in to this computer's server; its owner
  // manages them, where the server takes them.
  const takesOutsideAgents = usePrimaryEnvironmentDescriptor()?.capabilities.outsideAgents === true;
  const showsOutsideAgents = !isPhoneSurface && canManageLocalBackend && takesOutsideAgents;
  // How this computer is reachable is its owner's business, on the desktop app.
  const showsServerExposure = !isPhoneSurface && canManageLocalBackend && Boolean(desktopBridge);
  const desktopServerExposureState = showsServerExposure ? storedServerExposureState : null;
  const desktopAdvertisedEndpoints = showsServerExposure
    ? storedAdvertisedEndpoints
    : NO_ADVERTISED_ENDPOINTS;
  const desktopServerExposureError = showsServerExposure ? storedServerExposureError : null;
  const relayAccess = useRelayAccess(!isPhoneSurface && canManageLocalBackend);
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";
  const trimmedTailscaleServePortInput = tailscaleServePortInput.trim();
  const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput);
  const isTailscaleServePortValid =
    /^\d+$/u.test(trimmedTailscaleServePortInput) &&
    Number.isInteger(parsedTailscaleServePort) &&
    parsedTailscaleServePort >= 1 &&
    parsedTailscaleServePort <= 65_535;

  useEffect(() => {
    if (!desktopBridge || isPhoneSurface) return;
    let cancelled = false;
    void desktopBridge
      .getRetiredPhoneLinkNotice()
      .then((notice) => {
        if (!cancelled) setRetiredPhoneLinkNotice(notice);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktopBridge, isPhoneSurface]);

  const dismissRetiredPhoneLinkNotice = useCallback(() => {
    setRetiredPhoneLinkNotice(false);
    void desktopBridge?.dismissRetiredPhoneLinkNotice().catch(() => undefined);
  }, [desktopBridge]);

  const pendingTailscaleServeBaseUrl = useMemo(() => {
    if (!pendingTailscaleServeEndpoint) return null;
    if (!isTailscaleServePortValid) return pendingTailscaleServeEndpoint.httpBaseUrl;
    if (parsedTailscaleServePort === DEFAULT_TAILSCALE_SERVE_PORT) {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }
    try {
      const url = new URL(pendingTailscaleServeEndpoint.httpBaseUrl);
      url.port = String(parsedTailscaleServePort);
      return url.toString().replace(/\/$/u, "");
    } catch {
      return pendingTailscaleServeEndpoint.httpBaseUrl;
    }
  }, [isTailscaleServePortValid, parsedTailscaleServePort, pendingTailscaleServeEndpoint]);

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureError(null);
      try {
        const nextState = await desktopBridge.setServerExposureMode(
          checked ? "network-accessible" : "local-only",
        );
        setDesktopServerExposureState(nextState);
        setIsDesktopServerExposureDialogOpen(false);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update device access.";
        setIsDesktopServerExposureDialogOpen(false);
        setDesktopServerExposureError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update device access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleConfirmTailscaleServeSetup = useCallback(async () => {
    if (!desktopBridge) return;
    if (!isTailscaleServePortValid) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureError(null);
    try {
      const nextState = await desktopBridge.setTailscaleServeEnabled({
        enabled: true,
        port: parsedTailscaleServePort,
      });
      setDesktopServerExposureState(nextState);
      setPendingTailscaleServeEndpoint(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to set up the Tailscale link.";
      setDesktopServerExposureError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not set up the Tailscale link",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, isTailscaleServePortValid, parsedTailscaleServePort]);

  const handleStartTailscaleServeSetup = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setTailscaleServePortInput(
        String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
      );
      setPendingTailscaleServeEndpoint(endpoint);
    },
    [desktopServerExposureState?.tailscaleServePort],
  );

  const handleConfirmTailscaleServeDisable = useCallback(async () => {
    if (!desktopBridge) return;
    setIsUpdatingTailscaleServe(true);
    setDesktopServerExposureError(null);
    try {
      const nextState = await desktopBridge.setTailscaleServeEnabled({
        enabled: false,
        port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      });
      setDesktopServerExposureState(nextState);
      setDisableTailscaleServeDialogOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to turn off the Tailscale link.";
      setDesktopServerExposureError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not turn off the Tailscale link",
          description: message,
        }),
      );
    } finally {
      setIsUpdatingTailscaleServe(false);
    }
  }, [desktopBridge, desktopServerExposureState?.tailscaleServePort]);

  const handleStartTailscaleServeDisable = useCallback((_endpoint: AdvertisedEndpoint) => {
    setDisableTailscaleServeDialogOpen(true);
  }, []);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to cancel the link.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cancel the link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to remove access.";
        setDesktopAccessManagementError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  // Linked computers among the devices: their inbound links, by session.
  const thisComputerLinks = useComputerLinksStore((state) =>
    thisEnvironmentId === null ? null : (state.byEnvironmentId[thisEnvironmentId] ?? null),
  );
  const inboundLinkBySession = useMemo(() => {
    const bySession = new Map<string, InboundComputerLink>();
    for (const link of thisComputerLinks?.snapshot.inbound ?? []) {
      if (link.sessionId !== null) bySession.set(link.sessionId, link);
    }
    return bySession;
  }, [thisComputerLinks]);

  // Removing a linked computer's access is removing its link here, which also
  // stops the threads it started here (as Unlink does).
  const handleRemoveLinkedComputer = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"], link: InboundComputerLink) => {
      if (thisEnvironmentId === null) return;
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementError(null);
      try {
        await removeComputerLinkHalf(
          { environmentId: thisEnvironmentId, label: thisComputerLabel },
          { direction: "inbound", deviceId: link.deviceId, stopRunning: true },
        );
      } catch (error) {
        const message = describeComputerLinkFailure(error, "Failed to remove access.");
        setDesktopAccessManagementError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [thisComputerLabel, thisEnvironmentId],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Removed 1 device" : `Removed ${revokedCount} devices`,
        description: "They'll need to connect again to use this computer.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove devices.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove devices",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const handleCreateDirectLink = useCallback(async () => {
    setIsCreatingDirectLink(true);
    try {
      await createServerPairingCredential(directLinkLabel);
      setDirectLinkLabel("");
      setDirectLinkDialogOpen(false);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not make a link",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    } finally {
      setIsCreatingDirectLink(false);
    }
  }, [directLinkLabel]);

  // How this computer is reachable, for its owner on the desktop app. The
  // devices with access come live from `useAuthAccess` above.
  useEffect(() => {
    if (!showsServerExposure || !desktopBridge) {
      return;
    }

    let cancelled = false;
    void desktopBridge
      .getServerExposureState()
      .then((state) => {
        if (cancelled) return;
        setDesktopServerExposureState(state);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Failed to load device access settings.";
        setDesktopServerExposureError(message);
      });
    void desktopBridge
      .getAdvertisedEndpoints()
      .then((endpoints) => {
        if (cancelled) return;
        setDesktopAdvertisedEndpoints(endpoints);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Failed to load connection addresses.";
        setDesktopServerExposureError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge, showsServerExposure]);

  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  // Only owners see this list, and the owner's own window or tab is "this
  // computer", not a device using it.
  const visibleDeviceSessions = useMemo(
    () => desktopClientSessions.filter((clientSession) => !clientSession.current),
    [desktopClientSessions],
  );
  const otherDeviceCount = visibleDeviceSessions.length;
  const tailscaleHttpsEndpoint = useMemo(
    () => desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [desktopAdvertisedEndpoints],
  );
  const visibleDesktopNetworkAdvertisedEndpoints = useMemo(
    () =>
      isLocalBackendNetworkAccessible
        ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
        : [],
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  );
  const visibleDesktopAdvertisedEndpoints = useMemo(
    () =>
      tailscaleHttpsEndpoint
        ? [...visibleDesktopNetworkAdvertisedEndpoints, tailscaleHttpsEndpoint]
        : visibleDesktopNetworkAdvertisedEndpoints,
    [tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints],
  );
  const isLocalBackendRemotelyReachable =
    isLocalBackendNetworkAccessible || tailscaleHttpsEndpoint?.status === "available";
  const defaultDesktopNetworkAdvertisedEndpoint = useMemo(
    () =>
      selectPairingEndpoint(visibleDesktopNetworkAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopNetworkAdvertisedEndpoints],
  );
  const defaultDesktopAdvertisedEndpoint = useMemo(
    () =>
      defaultDesktopNetworkAdvertisedEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      ),
    [defaultAdvertisedEndpointKey, defaultDesktopNetworkAdvertisedEndpoint, tailscaleHttpsEndpoint],
  );
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );
  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === "network-accessible"}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) => {
        setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
        setIsDesktopServerExposureDialogOpen(true);
      }}
      aria-label="Same network"
    />
  );

  const relayUsage = relayAccess?.usage ?? null;
  // Event tasks' events through the relay today (docs/design/event-tasks.md).
  const relayEventsLine =
    relayUsage?.hooks !== undefined && relayUsage.hooks > 0
      ? `Events today: ${relayUsage.hooks.toLocaleString()}${
          relayUsage.hookLimit !== undefined ? ` of ${relayUsage.hookLimit.toLocaleString()}` : ""
        }`
      : null;
  const relayUseLine =
    relayUsage && (relayUsage.messages > 0 || visibleDeviceSessions.length > 0)
      ? relayUsage.limited
        ? `Today's relay allowance is used up. It resets at midnight UTC.`
        : `Relay use today: ${Math.min(100, Math.ceil((relayUsage.messages / Math.max(relayUsage.messageLimit, 1)) * 100))}% of the free daily allowance`
      : null;
  const relayStatusLine =
    relayAccess?.status === "unsupported" || relayAccess?.status === "disabled"
      ? (relayAccess.error ?? "Device codes are off on this relay.")
      : relayAccess?.status === "offline"
        ? (relayAccess.error ?? "Can't reach the relay right now.")
        : [relayUseLine, relayEventsLine].filter((line) => line !== null).join(" · ") || null;

  const devicesSection = (
    <SettingsSection
      title="Devices that can use this computer"
      headerAction={
        otherDeviceCount >= 2 ? (
          <Button
            size="xs"
            variant="ghost"
            className="h-5 rounded-sm px-1 text-[11px] font-normal text-muted-foreground hover:text-muted-foreground"
            disabled={isRevokingOtherDesktopClients}
            onClick={() => setConfirmRemoveAllOpen(true)}
          >
            {isRevokingOtherDesktopClients ? "Removing..." : "Remove all"}
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Connect a phone, tablet, or computer"
        description="Get a code to type on the other device, or a QR code for a phone. Works from anywhere while this computer is on."
        status={
          relayStatusLine ? (
            <span
              className={cn(
                relayAccess?.status === "offline" ||
                  relayAccess?.status === "unsupported" ||
                  relayUsage?.limited
                  ? "text-warning"
                  : undefined,
              )}
            >
              {relayStatusLine}
            </span>
          ) : null
        }
        control={
          <Button size="xs" onClick={() => setConnectDeviceOpen(true)}>
            <SmartphoneIcon className="size-3.5" />
            Connect a device
          </Button>
        }
      />
      {desktopAccessManagementError ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-destructive-foreground">{desktopAccessManagementError}</p>
        </div>
      ) : null}
      {isLoadingDesktopAccessManagement && visibleDeviceSessions.length === 0 ? (
        <ConnectedDevicesSkeleton presentation="current" />
      ) : null}
      {visibleDeviceSessions.map((clientSession) => {
        if (clientSession.role !== "peer") {
          return (
            <DeviceAccessRow
              key={clientSession.sessionId}
              clientSession={clientSession}
              revokingClientSessionId={revokingDesktopClientSessionId}
              onRevokeSession={handleRevokeDesktopClientSession}
            />
          );
        }
        const link = inboundLinkBySession.get(clientSession.sessionId) ?? null;
        return (
          <LinkedComputerAccessRow
            key={clientSession.sessionId}
            clientSession={clientSession}
            link={link}
            removing={revokingDesktopClientSessionId === clientSession.sessionId}
            onRemove={() =>
              void (link === null
                ? handleRevokeDesktopClientSession(clientSession.sessionId)
                : handleRemoveLinkedComputer(clientSession.sessionId, link))
            }
          />
        );
      })}
      {visibleDesktopPairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={desktopServerExposureState?.endpointUrl}
          endpoints={visibleDesktopAdvertisedEndpoints}
          defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
          revokingPairingLinkId={revokingDesktopPairingLinkId}
          onRevoke={handleRevokeDesktopPairingLink}
        />
      ))}
    </SettingsSection>
  );

  // The computers this app uses live in Fleet now (docs/design/fleet.md, R4.4):
  // here is only how many, and the two ways there.
  const computersSection = (
    <SettingsSection title="Computers you use from here">
      <SettingsRow
        data-testid="connections-computers-summary"
        title={
          savedComputerCount === 0
            ? "No computers yet"
            : savedComputerCount === 1
              ? "1 computer"
              : `${savedComputerCount} computers`
        }
        description="See what they're doing and manage them in Fleet."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/fleet" })}>
              Open Fleet
            </Button>
            <Button size="xs" variant="outline" onClick={openConnectComputerDialog}>
              <LaptopIcon className="size-3.5" />
              Connect to a computer
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );

  const connectionOptionsSection = (
    <SettingsSection
      title="Connection options"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground hover:text-muted-foreground"
          aria-expanded={connectionOptionsOpen}
          onClick={() => setConnectionOptionsOpen((value) => !value)}
        >
          {connectionOptionsOpen ? "Hide" : "Show"}
          <ChevronRightIcon className={cn("size-3", connectionOptionsOpen && "rotate-90")} />
        </Button>
      }
      {...(connectionOptionsOpen ? {} : { contentClassName: "hidden" })}
    >
      {desktopBridge ? (
        <>
          <SettingsRow
            title="Same network"
            description="Devices on your home or office network connect straight to this computer, which can be faster and doesn't use the relay. Turning it on or off restarts Threadlines."
            status={
              desktopServerExposureError ? (
                <span className="block text-destructive-foreground">
                  {desktopServerExposureError}
                </span>
              ) : isLocalBackendNetworkAccessible ? (
                <NetworkAccessDescription
                  endpoint={defaultDesktopNetworkAdvertisedEndpoint}
                  hiddenEndpointCount={Math.max(
                    visibleDesktopNetworkAdvertisedEndpoints.length - 1,
                    0,
                  )}
                  expanded={isAdvertisedEndpointListExpanded}
                  onToggleExpanded={() =>
                    setIsAdvertisedEndpointListExpanded((expanded) => !expanded)
                  }
                  fallback={
                    desktopServerExposureState?.endpointUrl
                      ? `Address ${desktopServerExposureState.endpointUrl}`
                      : null
                  }
                />
              ) : null
            }
            control={renderNetworkAccessToggle()}
          />
          {isAdvertisedEndpointListExpanded
            ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => (
                <AdvertisedEndpointListRow
                  key={endpoint.id}
                  endpoint={endpoint}
                  isDefault={
                    endpointDefaultPreferenceKey(endpoint) === defaultDesktopAdvertisedEndpointKey
                  }
                  presentation="endpoint-rail"
                  onSetDefault={handleSetDefaultAdvertisedEndpoint}
                  onSetupTailscaleServe={handleStartTailscaleServeSetup}
                  onDisableTailscaleServe={handleStartTailscaleServeDisable}
                  isUpdatingTailscaleServe={isUpdatingTailscaleServe}
                />
              ))
            : null}
          <SettingsRow
            title="Tailscale"
            description={
              tailscaleHttpsEndpoint?.status === "available"
                ? tailscaleHttpsEndpoint.httpBaseUrl
                : tailscaleHttpsEndpoint
                  ? "If you use Tailscale (an app that links your devices privately), devices on it can reach this computer. Turning it on restarts Threadlines."
                  : "Start Tailscale on this computer to use it here."
            }
            control={
              tailscaleHttpsEndpoint ? (
                <Switch
                  checked={tailscaleHttpsEndpoint.status === "available"}
                  disabled={isUpdatingTailscaleServe}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      handleStartTailscaleServeSetup(tailscaleHttpsEndpoint);
                      return;
                    }
                    handleStartTailscaleServeDisable(tailscaleHttpsEndpoint);
                  }}
                  aria-label="Tailscale"
                />
              ) : null
            }
          />
        </>
      ) : (
        <SettingsRow
          title="Same network"
          description={
            currentAuthPolicy === "remote-reachable"
              ? "This computer is already reachable on its network. Change this where Threadlines was started."
              : "Only devices using a code can reach this computer. To allow same-network connections, restart Threadlines with network access on."
          }
        />
      )}
      {isLocalBackendRemotelyReachable ? (
        <SettingsRow
          title="One-time link for this network"
          description="For devices that can reach this computer directly. The link works once and expires in 5 minutes."
          control={
            <Button size="xs" variant="outline" onClick={() => setDirectLinkDialogOpen(true)}>
              Make a link
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );

  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/connections" />
      {retiredPhoneLinkNotice ? (
        <SettingsSection title="Phone links changed">
          <SettingsRow
            title="Connect your phone again"
            description="Phone links were replaced by Connect a device. Phones paired the old way need to scan a new QR code once."
            control={
              <Button size="xs" variant="outline" onClick={dismissRetiredPhoneLinkNotice}>
                Got it
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      {isPhoneSurface ? null : (
        <SettingsSection title="This computer">
          <SettingsRow
            title={
              <span className="flex items-center gap-1.5">
                <LaptopIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                {thisComputerLabel}
              </span>
            }
            description="Projects on this computer run here. Other devices see it by this name."
            status={
              primaryVersionMismatch ? (
                <span className="flex items-center gap-1 text-warning">
                  <TriangleAlertIcon className="size-3.5 shrink-0" />
                  This app is version {primaryVersionMismatch.clientVersion}; the server is{" "}
                  {primaryVersionMismatch.serverVersion}. Update both if things act up.
                </span>
              ) : null
            }
          />
        </SettingsSection>
      )}

      {isPhoneSurface ? null : canManageLocalBackend ? (
        devicesSection
      ) : (
        <SettingsSection title="Devices that can use this computer">
          <SettingsRow
            title="Owner only"
            description="Only the computer's owner can connect devices or remove their access."
          />
        </SettingsSection>
      )}

      {showsOutsideAgents ? (
        <OutsideAgentsSection revealOnArrival={focusSection === "agents"} />
      ) : null}

      {computersSection}

      {!isPhoneSurface && canManageLocalBackend ? connectionOptionsSection : null}

      {canManageLocalBackend && !isPhoneSurface ? (
        <ConnectDeviceDialog
          open={connectDeviceOpen}
          onOpenChange={setConnectDeviceOpen}
          hostLabel={thisComputerLabel}
          relayAccess={relayAccess}
        />
      ) : null}
      <AlertDialog open={confirmRemoveAllOpen} onOpenChange={setConfirmRemoveAllOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove every device?</AlertDialogTitle>
            <AlertDialogDescription>
              {otherDeviceCount} devices will lose access to this computer and need to connect
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemoveAllOpen(false);
                void handleRevokeOtherDesktopClients();
              }}
            >
              Remove all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Dialog
        open={directLinkDialogOpen}
        onOpenChange={(open) => {
          setDirectLinkDialogOpen(open);
          if (!open) setDirectLinkLabel("");
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>One-time link for this network</DialogTitle>
            <DialogDescription>
              The link shows up under Devices that can use this computer. Open it on the other
              device, or paste it there under Connect to a computer › Other ways to connect.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Name for the other device (optional)
              </span>
              <Input
                value={directLinkLabel}
                onChange={(event) => setDirectLinkLabel(event.target.value)}
                placeholder="e.g. Work laptop"
                disabled={isCreatingDirectLink}
                autoFocus
              />
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingDirectLink}
              onClick={() => setDirectLinkDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={isCreatingDirectLink} onClick={() => void handleCreateDirectLink()}>
              {isCreatingDirectLink ? "Making..." : "Make link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={isDesktopServerExposureDialogOpen}
        onOpenChange={(open) => {
          if (isUpdatingDesktopServerExposure) return;
          setIsDesktopServerExposureDialogOpen(open);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setPendingDesktopServerExposureMode(null);
        }}
      >
        <AlertDialogPopup>
          <WithLocalWorkAtRisk>
            {(work) => (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {pendingDesktopServerExposureMode === "network-accessible"
                      ? "Let devices on this network connect?"
                      : "Stop same-network connections?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {pendingDesktopServerExposureMode === "network-accessible"
                      ? "Threadlines will restart so devices on your network can reach this computer directly."
                      : "Threadlines will restart. Devices that joined with a code keep working."}{" "}
                    <RestartWorkWarning work={work} />
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  {/* With work in flight, Enter must not be the key that stops it. */}
                  <AlertDialogClose
                    disabled={isUpdatingDesktopServerExposure}
                    render={
                      <Button
                        data-alert-dialog-primary-action={work.count > 0 ? "true" : undefined}
                        variant="outline"
                        disabled={isUpdatingDesktopServerExposure}
                      />
                    }
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    variant={
                      pendingDesktopServerExposureMode === "local-only" || work.count > 0
                        ? "destructive"
                        : "default"
                    }
                    onClick={handleConfirmDesktopServerExposureChange}
                    disabled={
                      pendingDesktopServerExposureMode === null || isUpdatingDesktopServerExposure
                    }
                  >
                    {isUpdatingDesktopServerExposure ? (
                      <>
                        <Spinner className="size-3.5" />
                        Restarting...
                      </>
                    ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                      "Restart and allow"
                    ) : (
                      "Restart and stop"
                    )}
                  </Button>
                </AlertDialogFooter>
              </>
            )}
          </WithLocalWorkAtRisk>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={disableTailscaleServeDialogOpen}
        onOpenChange={(open) => {
          if (isUpdatingTailscaleServe) return;
          setDisableTailscaleServeDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <WithLocalWorkAtRisk>
            {(work) => (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn off Tailscale?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Threadlines will restart and stop using Tailscale for device access.{" "}
                    <RestartWorkWarning work={work} />
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    disabled={isUpdatingTailscaleServe}
                    render={
                      <Button
                        data-alert-dialog-primary-action={work.count > 0 ? "true" : undefined}
                        variant="outline"
                        disabled={isUpdatingTailscaleServe}
                      />
                    }
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    variant="destructive"
                    onClick={() => void handleConfirmTailscaleServeDisable()}
                    disabled={isUpdatingTailscaleServe}
                  >
                    {isUpdatingTailscaleServe ? (
                      <>
                        <Spinner className="size-3.5" />
                        Restarting...
                      </>
                    ) : (
                      "Restart and turn off"
                    )}
                  </Button>
                </AlertDialogFooter>
              </>
            )}
          </WithLocalWorkAtRisk>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={pendingTailscaleServeEndpoint !== null}
        onOpenChange={(open) => {
          if (isUpdatingTailscaleServe) return;
          if (!open) setPendingTailscaleServeEndpoint(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <WithLocalWorkAtRisk>
            {(work) => (
              <>
                <DialogHeader>
                  <DialogTitle>Turn on Tailscale?</DialogTitle>
                  <DialogDescription>
                    Threadlines will restart and ask Tailscale to make this computer available on
                    your private Tailscale network. <RestartWorkWarning work={work} />
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                  <label className="block">
                    <span className="text-sm font-medium text-foreground">HTTPS port</span>
                    <Input
                      className="mt-2"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65_535}
                      step={1}
                      value={tailscaleServePortInput}
                      onChange={(event) => setTailscaleServePortInput(event.target.value)}
                      disabled={isUpdatingTailscaleServe}
                    />
                  </label>
                  {!isTailscaleServePortValid ? (
                    <p className="mt-2 text-xs text-destructive-foreground">
                      Enter a port from 1 to 65535.
                    </p>
                  ) : null}
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={pendingTailscaleServeBaseUrl ?? undefined}
                  >
                    Address: {pendingTailscaleServeBaseUrl ?? "Waiting for Tailscale"}
                  </p>
                </DialogPanel>
                <DialogFooter>
                  <DialogClose
                    disabled={isUpdatingTailscaleServe}
                    render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button
                    variant={work.count > 0 ? "destructive" : "default"}
                    onClick={() => void handleConfirmTailscaleServeSetup()}
                    disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                  >
                    {isUpdatingTailscaleServe ? (
                      <>
                        <Spinner className="size-3.5" />
                        Restarting...
                      </>
                    ) : (
                      "Turn on"
                    )}
                  </Button>
                </DialogFooter>
              </>
            )}
          </WithLocalWorkAtRisk>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
