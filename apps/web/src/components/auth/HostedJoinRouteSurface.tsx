import type { EnvironmentId } from "@threadlines/contracts";
import { useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  listSavedEnvironmentRecords,
  removeSavedEnvironment,
  startInviteClaim,
  useRelayJoinStore,
  waitForSavedEnvironmentRegistryHydration,
} from "../../environments/runtime";
import { readRelayJoinUrl } from "../../relayDevice";
import { describeJoinError } from "../settings/connections/JoinComputerDialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const RESCAN_HINT =
  "On your computer, open Threadlines, go to Settings › Connections › Connect a device, and scan the new QR code.";

/**
 * Where a "Connect a device" QR code lands (`/join` on the hosted app). Claims
 * the invite, saves the computer in this browser, waits for the host's
 * automatic approval, then opens the app. The invite secret is read once and
 * stripped from the address bar so it never lingers in history; a reload
 * without it opens the app when this browser already has computers, and the
 * app resumes a join that is still waiting.
 */
export function HostedJoinRouteSurface() {
  const [invite] = useState(() => readRelayJoinUrl());
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingSaved, setCheckingSaved] = useState(invite === null);
  const startedRef = useRef(false);
  const outcome = useRelayJoinStore((state) =>
    environmentId ? (state.byEnvironmentId[environmentId] ?? null) : null,
  );

  useEffect(() => {
    if (!invite || startedRef.current) return;
    startedRef.current = true;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.toString());
    void startInviteClaim({ invite, replaceExisting: removeSavedEnvironment })
      .then(setEnvironmentId)
      .catch((claimError: unknown) => setError(describeJoinError(claimError)));
  }, [invite]);

  useEffect(() => {
    if (invite) return;
    let cancelled = false;
    void waitForSavedEnvironmentRegistryHydration().then(() => {
      if (cancelled) return;
      if (listSavedEnvironmentRecords().length > 0) {
        window.location.replace("/");
        return;
      }
      setCheckingSaved(false);
    });
    return () => {
      cancelled = true;
    };
  }, [invite]);

  const hostLabel = outcome?.hostLabel ?? "your computer";
  let title: string;
  let message: string;
  let busy = false;
  let openApp = false;

  if (!invite && checkingSaved) {
    title = "Opening Threadlines";
    message = "One moment.";
    busy = true;
  } else if (!invite) {
    title = "Scan the code again";
    message = `This page only works straight from the QR code. ${RESCAN_HINT}`;
  } else if (error) {
    title = "That didn't work";
    message = `${error} ${RESCAN_HINT}`;
  } else if (outcome?.state === "approved") {
    title = `Connected to ${hostLabel}`;
    message = "This browser remembers it. Open app.threadlines.dev here to get back to it.";
    openApp = true;
  } else if (outcome && outcome.state !== "waiting" && outcome.state !== "pending") {
    title = outcome.state === "denied" ? `${hostLabel} said no` : "That code ran out";
    message = RESCAN_HINT;
  } else {
    title = outcome ? `Connecting to ${hostLabel}` : "Connecting";
    message = "Hold on while your computer lets this device in.";
    busy = true;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="relative w-full max-w-md space-y-3">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          {busy ? <Spinner className="size-5 shrink-0 text-muted-foreground" /> : null}
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
        {openApp ? (
          <Button className="mt-2" size="sm" onClick={() => (window.location.href = "/")}>
            Open projects
          </Button>
        ) : null}
      </section>
    </div>
  );
}
