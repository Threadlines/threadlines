import type { EnvironmentId } from "@threadlines/contracts";
import { ChevronRightIcon, CircleCheckIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  cancelPendingRelayJoin,
  canJoinWithCode,
  RelayJoinError,
  startCodeJoin,
  type SubmitCodeJoinViaServer,
  useRelayJoinStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { RelayRequestError } from "~/relayDevice";
import { cn } from "~/lib/utils";
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

/**
 * "Connect to a computer": type the code the other computer shows, match the
 * 2-digit number while it decides, then the computer appears under Computers
 * you use from here. `otherWays` holds the older paths (address + pairing
 * code, SSH) behind a disclosure.
 */
export function JoinComputerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly viaServer: SubmitCodeJoinViaServer | null;
  readonly replaceExisting: (environmentId: EnvironmentId) => Promise<void>;
  readonly selfEnvironmentId: EnvironmentId | null;
  readonly otherWays?: ReactNode;
  readonly otherWaysSummary?: string;
}) {
  const { open, onOpenChange } = props;
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [showOtherWays, setShowOtherWays] = useState(false);
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
        viaServer: props.viaServer,
        replaceExisting: props.replaceExisting,
        selfEnvironmentId: props.selfEnvironmentId,
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
  let body: ReactNode;
  let footer: ReactNode;

  if (outcome?.state === "waiting" && !outcome.matchNumber) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Getting the number from {hostLabel}
      </p>
    );
    footer = (
      <>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => void cancelWaiting()}>
          Cancel
        </Button>
      </>
    );
  } else if (outcome?.state === "waiting") {
    body = (
      <div className="flex items-center gap-4 border-y border-group-divider py-3.5">
        <span className="font-mono text-[28px] leading-none tracking-[0.1em] text-foreground">
          {outcome.matchNumber}
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          On {hostLabel}, check it shows{" "}
          <span className="font-medium text-foreground">{outcome.matchNumber}</span> too, then click{" "}
          <span className="font-medium text-foreground">Allow</span>.
        </p>
      </div>
    );
    footer = (
      <>
        <span className="flex min-w-0 flex-1 items-center text-xs text-muted-foreground">
          Waiting for {hostLabel}
        </span>
        <Button size="sm" variant="outline" onClick={() => void cancelWaiting()}>
          Cancel
        </Button>
      </>
    );
  } else if (outcome?.state === "approved") {
    description = null;
    body = (
      <Notice tone="done" title={`Connected to ${hostLabel}.`}>
        {runtime?.connectionState === "connected"
          ? "Its projects are in your sidebar now."
          : "Its projects will show up in your sidebar in a moment."}
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
    body = (
      <Notice tone="warn" title={copy.title}>
        {copy.detail}
      </Notice>
    );
    footer = (
      <>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={close}>
          Close
        </Button>
        <Button size="sm" onClick={reset}>
          Try another code
        </Button>
      </>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Code from the other computer</p>
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
        {props.otherWays ? (
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
              {props.otherWaysSummary ? (
                <span className="text-muted-foreground">· {props.otherWaysSummary}</span>
              ) : null}
            </button>
            {showOtherWays ? props.otherWays : null}
          </div>
        ) : null}
      </div>
    );
    footer = (
      <>
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
      <DialogPopup className="max-h-[85dvh] max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect to a computer</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>{body}</DialogPanel>
        <DialogFooter className="items-center">{footer}</DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
