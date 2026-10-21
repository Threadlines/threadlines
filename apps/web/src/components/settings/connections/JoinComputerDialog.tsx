import type { EnvironmentId } from "@threadlines/contracts";
import { ChevronRightIcon, CircleCheckIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import type { ComputerLinkTarget } from "~/environments/links/computerLinks";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import {
  cancelPendingRelayJoin,
  canJoinWithCode,
  getPrimaryEnvironmentConnection,
  RelayJoinError,
  removeSavedEnvironment,
  startCodeJoin,
  type SubmitCodeJoinViaServer,
  useRelayJoinStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { isHostedStaticApp } from "~/hostedPairing";
import { RelayRequestError } from "~/relayDevice";
import { cn } from "~/lib/utils";
import { NewComputerLinkStep, useNewComputerLinkPartners } from "./NewComputerLinkStep";
import { OtherWaysToConnect } from "./OtherWaysToConnect";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";

const CODE_LENGTH = 6;

/** What the joiner sees for each relay error code. */
export function describeJoinError(error: unknown): string {
  const code =
    error instanceof RelayJoinError || error instanceof RelayRequestError ? error.code : null;
  switch (code) {
    case "invalid-code":
      return error instanceof RelayJoinError && error.message.startsWith("That code is for this")
        ? error.message
        : "That code didn't work. It may have expired or been used already. Check the code on the other computer, or make a new one there.";
    case "expired":
      return "That code expired. Make a new one on the other computer.";
    case "busy":
      return "Another device is using this code right now. Wait a moment and try again.";
    case "rate-limited":
      return "Too many tries. Wait a minute, then try again.";
    case "too-many-devices":
      return "That computer already has the most devices it can have. Remove one there first.";
    case "relay-unavailable":
      return "Couldn't reach the relay. Check your internet connection and try again.";
    default:
      return error instanceof Error ? error.message : "That didn't work. Try again.";
  }
}

/**
 * One real input drawn as six boxes, so typing, pasting, and screen readers
 * all treat it as a single code field.
 */
function CodeInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  readonly invalid: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const digits = props.value.padEnd(CODE_LENGTH, " ").slice(0, CODE_LENGTH).split("");
  return (
    <div
      className="relative inline-flex items-center gap-1.5"
      onClick={() => inputRef.current?.focus()}
    >
      {digits.map((digit, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- fixed-length positional boxes
          key={index}
          aria-hidden
          className={cn(
            "flex size-10 items-center justify-center rounded-lg border border-input bg-background font-mono text-lg text-foreground shadow-xs/5 dark:bg-input/32",
            index === 3 && "ms-2",
            props.invalid && "border-destructive/60",
            props.disabled && "opacity-64",
          )}
        >
          {digit.trim()}
        </span>
      ))}
      <input
        ref={inputRef}
        aria-label="Code from the other computer"
        autoComplete="one-time-code"
        autoFocus
        className="absolute inset-0 cursor-text opacity-0"
        disabled={props.disabled}
        inputMode="numeric"
        value={props.value}
        onChange={(event) =>
          props.onChange(event.target.value.replace(/\D/gu, "").slice(0, CODE_LENGTH))
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onSubmit();
        }}
      />
    </div>
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
        className={cn(
          "mt-0.5 size-4.5 shrink-0",
          props.tone === "done" && "text-success",
          props.tone === "warn" && "text-warning",
          props.tone === "info" && "text-muted-foreground",
        )}
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

/** Whether "Connect to a computer" is open; anything in the app can open it. */
const useConnectComputerDialogStore = create<{ readonly open: boolean }>(() => ({ open: false }));

/**
 * Opens "Connect to a computer": from Fleet's "+", the one-computer Fleet
 * state, a computer's page, Settings › Connections and the command palette.
 */
export function openConnectComputerDialog(): void {
  useConnectComputerDialogStore.setState({ open: true });
}

/** Mounted once with the app shell: the dialog, while it is open. */
export function ConnectComputerDialogHost() {
  const open = useConnectComputerDialogStore((state) => state.open);
  return open ? (
    <JoinComputerDialog
      open
      onOpenChange={(next) => {
        if (!next) useConnectComputerDialogStore.setState({ open: false });
      }}
    />
  ) : null;
}

/** Code joins go through this computer's own server, which describes itself to the relay. */
const submitCodeJoinViaPrimaryServer: SubmitCodeJoinViaServer = async (input) => {
  try {
    return await getPrimaryEnvironmentConnection().client.relay.submitJoin(input);
  } catch (error) {
    const detail =
      error && typeof error === "object" && "detail" in error
        ? String(error.detail)
        : error instanceof Error
          ? error.message
          : "That didn't work.";
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
    throw new RelayJoinError(detail, code);
  }
};

/**
 * The step after a computer connects: the link question when it applies
 * (both computers connected and taking links), else the plain "Connected".
 */
function ConnectedStep({
  computer,
  connectedNote,
  plainNote,
  onClose,
}: {
  readonly computer: ComputerLinkTarget;
  readonly connectedNote: string;
  readonly plainNote: ReactNode;
  readonly onClose: () => void;
}) {
  const { ready, partners, choosePartner } = useNewComputerLinkPartners(computer);
  if (ready && partners.length > 0) {
    return (
      <NewComputerLinkStep
        newComputer={computer}
        partners={partners}
        choosePartner={choosePartner}
        connectedNote={connectedNote}
        onClose={onClose}
      />
    );
  }
  return (
    <>
      <DialogPanel>
        <Notice tone="done" title={connectedNote}>
          {plainNote}
        </Notice>
      </DialogPanel>
      <DialogFooter className="items-center">
        <span className="flex-1" />
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * "Connect to a computer": type the code the other computer shows, match the
 * 2-digit number while it decides, and the computer joins this app's
 * computers. The older paths (address and pairing code, SSH on the desktop
 * app) sit behind "Other ways to connect". Once it is connected, the dialog
 * asks whether the agents on it and on the app's other computer may start
 * work on each other (docs/design/fleet.md, R4.3).
 */
export function JoinComputerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { open, onOpenChange } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The hosted app and the phone have no server of their own: no SSH, and
  // code joins go straight to the relay.
  const hosted = isHostedStaticApp();
  const desktopBridge = window.desktopBridge;
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [showOtherWays, setShowOtherWays] = useState(false);
  /** A computer added another way (address, SSH): it is connected already. */
  const [addedOtherWay, setAddedOtherWay] = useState<ComputerLinkTarget | null>(null);
  const outcome = useRelayJoinStore((state) =>
    environmentId ? (state.byEnvironmentId[environmentId] ?? null) : null,
  );
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? (state.byId[environmentId] ?? null) : null,
  );

  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setSubmitting(false);
      setEnvironmentId(null);
      setShowOtherWays(false);
      setAddedOtherWay(null);
    }
  }, [open]);

  const reset = () => {
    if (environmentId) useRelayJoinStore.getState().dismiss(environmentId);
    setEnvironmentId(null);
    setCode("");
    setError(null);
  };

  const submit = async () => {
    if (code.length !== CODE_LENGTH || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const joined = await startCodeJoin({
        code,
        viaServer: hosted ? null : submitCodeJoinViaPrimaryServer,
        replaceExisting: removeSavedEnvironment,
        selfEnvironmentId: primaryEnvironmentId,
      });
      setEnvironmentId(joined);
    } catch (joinError) {
      setError(describeJoinError(joinError));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (environmentId && outcome && outcome.state !== "waiting") {
      useRelayJoinStore.getState().dismiss(environmentId);
    }
    onOpenChange(false);
  };

  const cancelWaiting = async () => {
    if (environmentId) await cancelPendingRelayJoin(environmentId);
    setEnvironmentId(null);
    onOpenChange(false);
  };

  const hostLabel = outcome?.hostLabel ?? "the other computer";
  let description: ReactNode = "Use projects from another computer that runs Threadlines.";
  let content: ReactNode;

  if (addedOtherWay !== null) {
    description = null;
    content = (
      <ConnectedStep
        computer={addedOtherWay}
        connectedNote={`Connected to ${addedOtherWay.label}.`}
        plainNote="Its projects are in your sidebar now."
        onClose={close}
      />
    );
  } else if (outcome?.state === "waiting" && !outcome.matchNumber) {
    content = (
      <>
        <DialogPanel>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Getting the number from {hostLabel}
          </p>
        </DialogPanel>
        <DialogFooter className="items-center">
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => void cancelWaiting()}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  } else if (outcome?.state === "waiting") {
    content = (
      <>
        <DialogPanel>
          <div className="flex items-center gap-4 border-y border-group-divider py-3.5">
            <span className="font-mono text-[28px] leading-none tracking-[0.1em] text-foreground">
              {outcome.matchNumber}
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              On {hostLabel}, check it shows{" "}
              <span className="font-medium text-foreground">{outcome.matchNumber}</span> too, then
              click <span className="font-medium text-foreground">Allow</span>.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter className="items-center">
          <span className="flex min-w-0 flex-1 items-center text-xs text-muted-foreground">
            Waiting for {hostLabel}
          </span>
          <Button size="sm" variant="outline" onClick={() => void cancelWaiting()}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  } else if (outcome?.state === "approved" && environmentId !== null) {
    description = null;
    content = (
      <ConnectedStep
        computer={{ environmentId, label: runtime?.descriptor?.label ?? hostLabel }}
        connectedNote={`Connected to ${hostLabel}.`}
        plainNote={
          runtime?.connectionState === "connected"
            ? "Its projects are in your sidebar now."
            : "Its projects will show up in your sidebar in a moment."
        }
        onClose={close}
      />
    );
  } else if (outcome) {
    description = null;
    const copy =
      outcome.state === "denied"
        ? {
            title: `${hostLabel} didn't allow this computer.`,
            detail: `If that was a mistake, make a new code on ${hostLabel} and try again.`,
          }
        : outcome.state === "cancelled"
          ? {
              title: "The code was cancelled.",
              detail: `Make a new code on ${hostLabel} and try again.`,
            }
          : outcome.state === "failed"
            ? {
                title: "That didn't connect.",
                detail: `${outcome.message ?? "Something went wrong."} Make a new code on ${hostLabel} and try again.`,
              }
            : {
                title: "Nobody allowed it in time.",
                detail: `Make a new code on ${hostLabel} and try again.`,
              };
    content = (
      <>
        <DialogPanel>
          <Notice tone="warn" title={copy.title}>
            {copy.detail}
          </Notice>
        </DialogPanel>
        <DialogFooter className="items-center">
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={close}>
            Close
          </Button>
          <Button size="sm" onClick={reset}>
            Try another code
          </Button>
        </DialogFooter>
      </>
    );
  } else {
    content = (
      <>
        <DialogPanel>
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              Code from the other computer
            </p>
            <CodeInput
              value={code}
              onChange={(next) => {
                setCode(next);
                setError(null);
              }}
              onSubmit={() => void submit()}
              disabled={submitting}
              invalid={error !== null}
            />
            {!canJoinWithCode() ? (
              <p className="text-xs leading-relaxed text-warning">
                This page can't encrypt a code connection. Open Threadlines from its app on this
                computer, or use Other ways to connect below.
              </p>
            ) : error ? (
              <p className="text-xs text-destructive-foreground">{error}</p>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Find it on the computer with your projects: Settings › Connections ›{" "}
                <span className="font-medium text-foreground">Connect a device</span>.
              </p>
            )}
            <div className="space-y-3 pt-1">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={showOtherWays}
                onClick={() => setShowOtherWays((value) => !value)}
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3", showOtherWays && "rotate-90")}
                />
                Other ways to connect
                <span className="text-muted-foreground">
                  · {desktopBridge && !hosted ? "Address and code, SSH" : "Address and code"}
                </span>
              </button>
              {showOtherWays ? (
                <OtherWaysToConnect
                  hosted={hosted}
                  onConnected={(record) =>
                    setAddedOtherWay({ environmentId: record.environmentId, label: record.label })
                  }
                />
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter className="items-center">
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={code.length !== CODE_LENGTH || submitting || !canJoinWithCode()}
            onClick={() => void submit()}
          >
            {submitting ? "Connecting..." : "Connect"}
          </Button>
        </DialogFooter>
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
      <DialogPopup className="max-h-[85dvh] max-w-lg" data-testid="connect-computer-dialog">
        <DialogHeader>
          <DialogTitle>Connect to a computer</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {content}
      </DialogPopup>
    </Dialog>
  );
}
