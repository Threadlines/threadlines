import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ACP_REGISTRY_DRIVER_KIND, type ProviderDriverKind } from "@threadlines/contracts";

import { ensureLocalApi } from "../localApi";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { trackProviderUpdates, useProviderUpdateRunStore } from "../providerUpdateRunStore";
import { useServerProviders } from "../rpc/serverState";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdatePromptView,
  providerUpdateGroupKey,
  providerUpdateNotificationKey,
  shouldOpenProviderUpdatePrompt,
} from "./ProviderUpdateLaunchNotification.logic";
import { useHoldLaunchPromptsForSetup } from "./setup/firstRunGateState";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ProviderUpdateToastIconProvider = { readonly driver: ProviderDriverKind };

function ProviderUpdateToastBaseIcon({ provider }: { provider: ProviderDriverKind }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return <DownloadIcon aria-hidden="true" className="size-3.5 text-success" strokeWidth={2.5} />;
  }

  return <ProviderIcon aria-hidden="true" className="size-4" />;
}

function ProviderUpdateToastIcon({ provider }: { provider: ProviderDriverKind }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderIcon aria-hidden="true" className="relative z-0 size-4" />
      <span className="absolute -right-1 -bottom-1 z-10 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

function ProviderUpdateToastIconStack({
  providers,
}: {
  providers: ReadonlyArray<ProviderUpdateToastIconProvider>;
}) {
  if (providers.length === 0) {
    return <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />;
  }

  if (providers.length === 1) {
    return <ProviderUpdateToastIcon provider={providers[0]!.driver} />;
  }

  const visibleProviders = providers.slice(0, 3);
  return (
    <span
      aria-hidden="true"
      className="relative isolate inline-flex h-5 min-w-8 shrink-0 items-center justify-start overflow-visible"
    >
      <span className="flex -space-x-1.5">
        {visibleProviders.map((provider, index) => (
          <span
            className="relative inline-flex size-5 items-center justify-center rounded-full border border-popover bg-popover text-muted-foreground shadow-sm/10"
            key={provider.driver}
            style={{ zIndex: visibleProviders.length - index }}
          >
            <ProviderUpdateToastBaseIcon provider={provider.driver} />
          </span>
        ))}
      </span>
      <span className="absolute -right-0.5 -bottom-1 z-10 inline-flex size-3.5 items-center justify-center rounded-full border border-popover bg-popover">
        <DownloadIcon aria-hidden="true" className="size-3 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

/**
 * The launch prompt: "Updates available" with one-click Update for agents
 * Threadlines can update itself. Clicking Update hands this notice to
 * `ProviderUpdateProgress`, which shows the run there until it finishes.
 */
export function ProviderUpdateLaunchNotification() {
  const navigate = useNavigate();
  const providers = useServerProviders();
  const activePromptRef = useRef<{
    readonly key: string;
    readonly toastId: ProviderUpdateToastId;
  } | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  // Setup owns the screen while it is pending or open, and an update already
  // running (started anywhere) has its own notice: this prompt waits for both.
  const heldForSetup = useHoldLaunchPromptsForSetup();
  const updateRunning = useProviderUpdateRunStore((state) => state.run !== null);
  const held = heldForSetup || updateRunning;

  // Community agents are left out of this prompt: a version Threadlines
  // hasn't reviewed is offered on the agent's own row, where that is said.
  const updateProviders = useMemo(
    () =>
      collectProviderUpdateCandidates(providers).filter(
        (provider) => provider.driver !== ACP_REGISTRY_DRIVER_KIND,
      ),
    [providers],
  );
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(
    (toastId: ProviderUpdateToastId) => {
      toastManager.close(toastId);
      if (activePromptRef.current?.toastId === toastId) {
        activePromptRef.current = null;
      }
      void navigate({ to: "/settings/providers" });
    },
    [navigate],
  );

  useEffect(() => {
    const activePrompt = activePromptRef.current;
    if (activePrompt && (activePrompt.key !== notificationKey || held)) {
      toastManager.close(activePrompt.toastId);
      activePromptRef.current = null;
      // Put away without dismissing it: it comes back once setup or the
      // update is out of the way, if there is still something to offer.
      if (held) seenProviderUpdateNotificationKeys.delete(activePrompt.key);
    }

    if (notificationKey === null) {
      return;
    }
    if (
      !shouldOpenProviderUpdatePrompt({
        notificationKey,
        isDismissed: dismissedNotificationKeys.has(notificationKey),
        isAlreadySeen: seenProviderUpdateNotificationKeys.has(notificationKey),
        hasActiveToast: activePromptRef.current !== null,
        isHeldForSetup: held,
      })
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const view = getProviderUpdatePromptView({ updateProviders, oneClickProviders });

    let toastId!: ProviderUpdateToastId;
    let updateStarted = false;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      dismissNotificationKey(notificationKey);
    };

    const runUpdates = () => {
      if (updateStarted || oneClickProviders.length === 0) {
        return;
      }
      updateStarted = true;
      // From here the notice belongs to the run, not to this prompt.
      activePromptRef.current = null;
      const tracking = trackProviderUpdates(oneClickProviders.map(providerUpdateGroupKey), {
        noticeId: toastId,
      });
      for (const provider of oneClickProviders) {
        ensureLocalApi()
          .server.updateProvider({ provider: provider.driver, instanceId: provider.instanceId })
          .catch((error: unknown) => {
            tracking.reportStartFailure(providerUpdateGroupKey(provider), error);
          });
      }
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps:
          oneClickProviders.length > 0
            ? {
                children: "Update",
                onClick: runUpdates,
              }
            : {
                children: "Settings",
                onClick: openSettings,
              },
        actionVariant: oneClickProviders.length > 0 ? "default" : "outline",
        data: {
          leadingIcon:
            updateProviders.length > 0 ? (
              <ProviderUpdateToastIconStack providers={updateProviders} />
            ) : undefined,
          hideCopyButton: true,
          onClose: dismissPrompt,
          ...(oneClickProviders.length > 0
            ? {
                secondaryActionProps: {
                  children: "Settings",
                  onClick: openSettings,
                },
                secondaryActionVariant: "outline" as const,
              }
            : {}),
        },
      }),
    );
    activePromptRef.current = { key: notificationKey, toastId };
  }, [
    dismissNotificationKey,
    dismissedNotificationKeys,
    held,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    updateProviders,
  ]);

  return null;
}
