import type {
  RelayAccessSnapshot,
  RelayHostJoinRequest,
  RelayOpenInvite,
} from "@threadlines/contracts";
import {
  CircleCheckIcon,
  ClockIcon,
  LaptopIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { useRelativeTimeTick } from "~/hooks/useRelativeTimeTick";
import { buildRelayJoinUrl } from "~/relayDevice";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { QRCodeSvg } from "../../ui/qr-code";
import { Spinner } from "../../ui/spinner";
import { formatCountdown } from "./useRelayAccess";

type InviteState =
  | { readonly kind: "creating" }
  | { readonly kind: "ready"; readonly invite: RelayOpenInvite }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  return error instanceof Error ? error.message : fallback;
}

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** The request this invite produced, preferring one still waiting on the host. */
function requestForInvite(
  snapshot: RelayAccessSnapshot | null,
  inviteId: string,
): RelayHostJoinRequest | null {
  const requests = snapshot?.requests.filter((request) => request.inviteId === inviteId) ?? [];
  return (
    requests.find((request) => request.state === "pending") ??
    requests.find((request) => request.state === "approved") ??
    requests.find((request) => request.state === "denied" || request.state === "expired") ??
    null
  );
}

function Notice(props: {
  readonly tone: "done" | "warn" | "info";
  readonly title: ReactNode;
  readonly children?: ReactNode;
}) {
  const Icon =
    props.tone === "done" ? CircleCheckIcon : props.tone === "warn" ? TriangleAlertIcon : ClockIcon;
  return (
    <div className="flex items-start gap-2.5">
      <Icon
        aria-hidden
        className={
          props.tone === "done"
            ? "mt-0.5 size-4.5 shrink-0 text-success"
            : props.tone === "warn"
              ? "mt-0.5 size-4.5 shrink-0 text-warning"
              : "mt-0.5 size-4.5 shrink-0 text-muted-foreground"
        }
      />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        {props.children ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{props.children}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Connect a device" on the computer with the projects: shows a 6-digit code
 * for computers and a QR code for phones, then asks the owner to Allow a typed
 * code after matching the 2-digit number (QR scans are approved by the server
 * on their own). Closing the dialog cancels a code nobody used.
 */
export function ConnectDeviceDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly hostLabel: string;
  readonly relayAccess: RelayAccessSnapshot | null;
}) {
  const { open, onOpenChange, hostLabel, relayAccess } = props;
  const [inviteState, setInviteState] = useState<InviteState>({ kind: "creating" });
  const [responding, setResponding] = useState<"allow" | "deny" | null>(null);
  const [respondError, setRespondError] = useState<string | null>(null);
  const nowMs = useRelativeTimeTick(1_000);
  const inviteRef = useRef<RelayOpenInvite | null>(null);

  const createInvite = useCallback(async () => {
    setInviteState({ kind: "creating" });
    setRespondError(null);
    try {
      const invite = await getPrimaryEnvironmentConnection().client.relay.createInvite();
      inviteRef.current = invite;
      setInviteState({ kind: "ready", invite });
    } catch (error) {
      inviteRef.current = null;
      setInviteState({ kind: "error", message: errorMessage(error, "Couldn't make a code.") });
    }
  }, []);

  useEffect(() => {
    if (open) {
      void createInvite();
    }
  }, [createInvite, open]);

  const invite = inviteState.kind === "ready" ? inviteState.invite : null;
  const request = invite ? requestForInvite(relayAccess, invite.inviteId) : null;

  const close = () => {
    const openInvite = inviteRef.current;
    inviteRef.current = null;
    // A code nobody used shouldn't stay live after the dialog is gone.
    if (openInvite && request?.state !== "approved") {
      void getPrimaryEnvironmentConnection()
        .client.relay.cancelInvite({ inviteId: openInvite.inviteId })
        .catch(() => undefined);
    }
    onOpenChange(false);
  };

  const respond = async (allow: boolean) => {
    if (!request) return;
    setResponding(allow ? "allow" : "deny");
    setRespondError(null);
    try {
      await getPrimaryEnvironmentConnection().client.relay.respondToJoinRequest({
        requestId: request.requestId,
        allow,
      });
    } catch (error) {
      setRespondError(
        errorMessage(error, allow ? "Couldn't allow that device." : "Couldn't deny it."),
      );
    } finally {
      setResponding(null);
    }
  };

  const countdown = invite ? formatCountdown(invite.expiresAt, nowMs) : null;
  const inviteExpired = invite !== null && countdown === null && request === null;

  let title = "Connect a device";
  let description: ReactNode = `Use ${hostLabel} from a phone, tablet, or another computer.`;
  let body: ReactNode;
  let footer: ReactNode;

  const closeFooter = (label = "Close") => (
    <>
      <span className="flex-1" />
      <Button size="sm" variant="outline" onClick={close}>
        {label}
      </Button>
    </>
  );
  const newCodeFooter = (
    <>
      <span className="flex-1" />
      <Button size="sm" variant="outline" onClick={close}>
        Close
      </Button>
      <Button size="sm" onClick={() => void createInvite()}>
        Make a new code
      </Button>
    </>
  );

  if (inviteState.kind === "creating") {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Making a code
      </p>
    );
    footer = closeFooter("Cancel");
  } else if (inviteState.kind === "error") {
    body = (
      <Notice tone="warn" title="Couldn't make a code.">
        {inviteState.message} If this keeps happening, devices on the same network can still connect
        with Same network under Connection options.
      </Notice>
    );
    footer = (
      <>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={close}>
          Close
        </Button>
        <Button size="sm" onClick={() => void createInvite()}>
          Try again
        </Button>
      </>
    );
  } else if (request?.state === "pending" && !request.autoApprove && !request.matchNumber) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {request.joiner.label} typed your code. Getting the number to compare.
      </p>
    );
    footer = closeFooter();
  } else if (request?.state === "pending" && !request.autoApprove) {
    title = `Allow ${request.joiner.label}?`;
    description = "A device typed your code. Check the number before you allow it.";
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-4 border-y border-border/60 py-3.5">
          <span className="font-mono text-[28px] leading-none tracking-[0.1em] text-foreground">
            {request.matchNumber}
          </span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {request.joiner.label} should show the same number. If it doesn't, or you're not
            connecting a device right now, click{" "}
            <span className="font-medium text-foreground">Deny</span>.
          </p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Once allowed, it can read and change files and run commands on {hostLabel}. You can remove
          its access any time.
        </p>
        {respondError ? (
          <p className="text-xs text-destructive-foreground">{respondError}</p>
        ) : null}
      </div>
    );
    footer = (
      <>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={responding !== null}
          onClick={() => void respond(false)}
        >
          {responding === "deny" ? "Denying..." : "Deny"}
        </Button>
        <Button size="sm" disabled={responding !== null} onClick={() => void respond(true)}>
          {responding === "allow" ? "Allowing..." : "Allow"}
        </Button>
      </>
    );
  } else if (request?.state === "pending") {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Connecting {request.joiner.label}
      </p>
    );
    footer = closeFooter();
  } else if (request?.state === "approved") {
    body = (
      <Notice tone="done" title={`${request.joiner.label} can now use this computer.`}>
        It's listed under Devices using this computer. Remove its access there any time.
      </Notice>
    );
    footer = (
      <>
        <span className="flex-1" />
        <Button size="sm" onClick={close}>
          Done
        </Button>
      </>
    );
  } else if (request?.state === "denied") {
    body = (
      <Notice tone="info" title={`You denied ${request.joiner.label}.`}>
        That code no longer works. Make a new one to try again.
      </Notice>
    );
    footer = newCodeFooter;
  } else if (request?.state === "expired") {
    body = (
      <Notice tone="info" title="Nobody answered in time.">
        Make a new code and allow the device within a few minutes.
      </Notice>
    );
    footer = newCodeFooter;
  } else if (inviteExpired) {
    body = (
      <Notice tone="info" title="This code expired.">
        Codes last 10 minutes and work once. Nothing connected with it.
      </Notice>
    );
    footer = newCodeFooter;
  } else if (
    invite &&
    relayAccess?.requests.some(
      (entry) => entry.inviteId === invite.inviteId && entry.state === "cancelled",
    )
  ) {
    const cancelled = relayAccess.requests.find(
      (entry) => entry.inviteId === invite.inviteId && entry.state === "cancelled",
    )!;
    body = (
      <Notice tone="info" title={`${cancelled.joiner.label} stopped trying.`}>
        A code works for one try. Make a new one to connect.
      </Notice>
    );
    footer = newCodeFooter;
  } else if (invite) {
    body = (
      <div className="space-y-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-6">
          <div className="space-y-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <LaptopIcon aria-hidden className="size-3.5" />
              On a computer
            </p>
            <p
              className="font-mono text-[36px] leading-none tracking-[0.14em] text-foreground"
              aria-label={`Code ${invite.code.split("").join(" ")}`}
            >
              {formatCode(invite.code)}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Open Threadlines, go to Settings › Connections, click{" "}
              <span className="font-medium text-foreground">Connect to a computer</span>, and type
              this code.
            </p>
          </div>
          <div className="space-y-2.5 border-s border-border/60 ps-6">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <SmartphoneIcon aria-hidden className="size-3.5" />
              On a phone
            </p>
            <div className="inline-flex rounded-md bg-white p-1.5 ring-1 ring-border/60">
              <QRCodeSvg
                value={buildRelayJoinUrl({
                  relayOrigin: invite.relayOrigin,
                  hostId: invite.hostId,
                  inviteId: invite.inviteId,
                  inviteSecret: invite.inviteSecret,
                  hostPublicKey: invite.hostPublicKey,
                })}
                size={160}
                level="L"
                marginSize={1}
                title="Scan with your phone's camera to connect"
              />
            </div>
            <p className="text-xs text-muted-foreground">Scan with your camera.</p>
          </div>
        </div>
      </div>
    );
    footer = (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          Waiting for a device
          {countdown ? (
            <span className="font-mono text-[11px] text-muted-foreground/70">
              Code expires in {countdown} · works once
            </span>
          ) : null}
        </span>
        <Button size="sm" variant="outline" onClick={close}>
          Close
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>{body}</DialogPanel>
        <DialogFooter className="items-center">{footer}</DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
