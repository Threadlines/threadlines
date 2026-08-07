/**
 * The "Install" control, shared by the settings provider card and the
 * first-run setup card.
 *
 * Starting an install is one RPC: the same `server.updateProvider` the Update
 * button calls, with `action: "install"`. Everything after that arrives on the
 * provider snapshot, so both surfaces render progress from
 * `deriveProviderInstallView` and neither has to poll or hold its own copy of
 * the run. While the command is running the button gives way to the status
 * line, because the row already says what is happening and a second click
 * would only be refused.
 *
 * @module ProviderInstallAction
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@threadlines/contracts";
import { LoaderIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isProviderInstallInFlight,
  providerInstallStatusText,
  type ProviderInstallView,
} from "./providerInstall";

function useProviderInstallStart(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
}): { readonly isStarting: boolean; readonly start: () => void } {
  const { instanceId, driverKind, displayName } = input;
  const [isStarting, setIsStarting] = useState(false);

  const start = useCallback(() => {
    if (isStarting) {
      return;
    }
    setIsStarting(true);
    void ensureLocalApi()
      .server.updateProvider({ provider: driverKind, instanceId, action: "install" })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not install ${displayName ?? PROVIDER_DISPLAY_NAMES[driverKind] ?? driverKind}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider install command could not be started.",
          }),
        );
      })
      .finally(() => {
        setIsStarting(false);
      });
  }, [displayName, driverKind, instanceId, isStarting]);

  return { isStarting, start };
}

export function ProviderInstallAction({
  instanceId,
  driverKind,
  displayName,
  view,
  statusClassName,
  buttonVariant,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly view: ProviderInstallView;
  readonly statusClassName?: string | undefined;
  readonly buttonVariant?: "default" | "outline" | undefined;
}): ReactNode {
  const { isStarting, start } = useProviderInstallStart({
    instanceId,
    driverKind,
    displayName,
  });
  const name = displayName ?? PROVIDER_DISPLAY_NAMES[driverKind] ?? String(driverKind);
  const statusText = providerInstallStatusText({ view, isStarting });
  const inFlight = isProviderInstallInFlight({ view, isStarting });

  return (
    <>
      {statusText === null ? null : (
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-[12px]",
            inFlight ? "text-muted-foreground" : "text-destructive",
            statusClassName,
          )}
          data-provider-install-status={inFlight ? "running" : "failed"}
        >
          {inFlight ? <LoaderIcon className="size-3 shrink-0 animate-spin" aria-hidden /> : null}
          <span className="min-w-0 truncate">{statusText}</span>
        </span>
      )}
      {inFlight ? null : (
        <Button
          size="xs"
          variant={buttonVariant ?? "default"}
          aria-label={view.status === "failed" ? `Retry installing ${name}` : `Install ${name}`}
          onClick={start}
        >
          {view.status === "failed" ? "Retry" : "Install"}
        </Button>
      )}
    </>
  );
}
