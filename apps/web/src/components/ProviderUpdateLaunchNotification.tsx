import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { type ProviderDriverKind, type ProviderInstanceId } from "@threadlines/contracts";

import { ensureLocalApi } from "../localApi";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { useServerProviders } from "../rpc/serverState";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateRunningToastView,
  providerUpdateNotificationKey,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast =
  | { readonly kind: "prompt"; readonly key: string; readonly toastId: ProviderUpdateToastId }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerDrivers: readonly ProviderDriverKind[];
      readonly providerCount: number;
    };

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

function providerUpdateToastIconForDrivers(drivers: readonly ProviderDriverKind[]): ReactNode {
  return <ProviderUpdateToastIconStack providers={drivers.map((driver) => ({ driver }))} />;
}

function updateProviderUpdateToast(input: {
  readonly toastId: ProviderUpdateToastId;
  readonly view: ProviderUpdateToastView;
  readonly openSettings: () => void;
  readonly leadingIcon?: ReactNode;
}) {
  if (input.view.type === "loading" || input.view.type === "success") {
    toastManager.update(input.toastId, {
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: undefined,
      data: {
        hideCopyButton: true,
        ...(input.leadingIcon !== undefined ? { leadingIcon: input.leadingIcon } : {}),
        ...(input.view.dismissAfterVisibleMs !== undefined
          ? { dismissAfterVisibleMs: input.view.dismissAfterVisibleMs }
          : {}),
      },
    });
    return;
  }

  toastManager.update(
    input.toastId,
    stackedThreadToast({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: {
        children: "Settings",
        onClick: input.openSettings,
      },
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
        ...(input.leadingIcon !== undefined ? { leadingIcon: input.leadingIcon } : {}),
      },
    }),
  );
}

function isTerminalProviderUpdateToastView(view: ProviderUpdateToastView) {
  return view.phase === "failed" || view.phase === "unchanged" || view.phase === "succeeded";
}

export function ProviderUpdateLaunchNotification() {
  const navigate = useNavigate();
  const providers = useServerProviders();
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
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
    (toastId?: ProviderUpdateToastId) => {
      const activeToast = activeToastRef.current;
      if (toastId !== undefined) {
        toastManager.close(toastId);
      } else if (activeToast) {
        toastManager.close(activeToast.toastId);
      }
      if (activeToast && (toastId === undefined || activeToast.toastId === toastId)) {
        activeToastRef.current = null;
      }
      void navigate({ to: "/settings/providers" });
    },
    [navigate],
  );

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeToast.providerInstanceIds.has(provider.instanceId),
    );
    const view = getProviderUpdateProgressToastView({
      providers: activeProviders,
      providerCount: activeToast.providerCount,
    });
    updateProviderUpdateToast({
      toastId: activeToast.toastId,
      view,
      openSettings: () => openProviderSettings(activeToast.toastId),
      leadingIcon: providerUpdateToastIconForDrivers(activeToast.providerDrivers),
    });

    if (isTerminalProviderUpdateToastView(view)) {
      activeToastRef.current = null;
    }
  }, [providers, openProviderSettings]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      !notificationKey ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenProviderUpdateNotificationKeys.has(notificationKey) ||
      activeToastRef.current
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

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

      const providerCount = oneClickProviders.length;
      const providerInstanceIds = new Set(oneClickProviders.map((provider) => provider.instanceId));
      const providerDrivers = oneClickProviders.map((provider) => provider.driver);
      activeToastRef.current = {
        kind: "update",
        key: notificationKey,
        toastId,
        providerInstanceIds,
        providerDrivers,
        providerCount,
      };

      updateProviderUpdateToast({
        toastId,
        view: getProviderUpdateRunningToastView(providerCount),
        openSettings,
        leadingIcon: providerUpdateToastIconForDrivers(providerDrivers),
      });

      void Promise.allSettled(
        oneClickProviders.map(async (provider) =>
          ensureLocalApi().server.updateProvider({
            provider: provider.driver,
            instanceId: provider.instanceId,
          }),
        ),
      ).then((results) => {
        const activeUpdateToast = activeToastRef.current;
        if (activeUpdateToast?.kind !== "update" || activeUpdateToast.toastId !== toastId) {
          return;
        }

        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          updateProviderUpdateToast({
            toastId,
            view: getProviderUpdateRejectedToastView(providerCount, rejectedMessage),
            openSettings,
            leadingIcon: providerUpdateToastIconForDrivers(activeUpdateToast.providerDrivers),
          });
          activeToastRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = getProviderUpdateProgressToastView({
          providers: updatedProviderSnapshots,
          providerCount,
        });
        updateProviderUpdateToast({
          toastId,
          view,
          openSettings,
          leadingIcon: providerUpdateToastIconForDrivers(activeUpdateToast.providerDrivers),
        });

        if (isTerminalProviderUpdateToastView(view)) {
          activeToastRef.current = null;
        }
      });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: initialView.type,
        title: initialView.title,
        description: initialView.description,
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
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    updateProviders,
  ]);

  return null;
}
