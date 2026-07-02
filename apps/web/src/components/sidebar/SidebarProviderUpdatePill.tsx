import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@threadlines/contracts";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useDismissedProviderUpdateNotificationKeys } from "../../providerUpdateDismissal";
import { useServerProviders } from "../../rpc/serverState";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillItem,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  UPDATE_STATUS_DOT_STYLES,
  UPDATE_STATUS_SURFACE_STYLES,
  UPDATE_STATUS_TEXT_STYLES,
  UpdateProgressRail,
  UpdateStatusBadge,
  type UpdateStatusTone,
} from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

// Hover feedback lives on the container but only when the main button (not
// the dismiss affordance) is hovered, hence the group-has selector.
const PROVIDER_UPDATE_SURFACE_HOVER_STYLES: Record<Exclude<UpdateStatusTone, "neutral">, string> = {
  progress:
    "group-has-[button.provider-update-main:hover]/provider-update:border-primary/40 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/75",
  success:
    "group-has-[button.provider-update-main:hover]/provider-update:border-success/40 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
  warning:
    "group-has-[button.provider-update-main:hover]/provider-update:border-warning/45 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
  error:
    "group-has-[button.provider-update-main:hover]/provider-update:border-destructive/45 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
};

function viewToneToStatusTone(
  tone: ProviderUpdateSidebarPillView["tone"],
): Exclude<UpdateStatusTone, "neutral"> {
  return tone === "loading" ? "progress" : tone;
}

function itemToneToStatusTone(tone: ProviderUpdateSidebarPillItem["tone"]): UpdateStatusTone {
  if (tone === "running") return "progress";
  if (tone === "queued") return "neutral";
  return tone;
}

let providerUpdateSidebarVisibleAfterIso: string | undefined;

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

function SidebarProviderUpdateRows({
  items,
}: {
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>;
}) {
  return (
    <div className="grid w-full gap-1">
      {items.map((item) => (
        <div
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1"
          key={item.key}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1 rounded-full",
              UPDATE_STATUS_DOT_STYLES[itemToneToStatusTone(item.tone)],
            )}
          />
          <span className="min-w-0 truncate text-[10.5px] leading-3 text-foreground/82">
            {item.label}
          </span>
          <span
            className={cn(
              "shrink-0 text-[9.5px] leading-3 font-medium",
              UPDATE_STATUS_TEXT_STYLES[itemToneToStatusTone(item.tone)],
            )}
          >
            {item.statusLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

function sidebarProviderUpdateFallbackStatus(
  tone: ProviderUpdateSidebarPillView["tone"],
): ProviderUpdateSidebarPillItem["statusLabel"] {
  switch (tone) {
    case "loading":
      return "Updating";
    case "success":
      return "Updated";
    case "warning":
      return "Review";
    case "error":
      return "Failed";
  }
}

function sidebarProviderUpdatePrimaryTone(
  tone: ProviderUpdateSidebarPillView["tone"],
): ProviderUpdateSidebarPillItem["tone"] {
  switch (tone) {
    case "loading":
      return "running";
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
  }
}

export function SidebarProviderUpdatePill() {
  const navigate = useNavigate();
  const providers = useServerProviders();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const [renderedView, setRenderedView] = useState<ProviderUpdateSidebarPillView | null>(null);
  const [pendingView, setPendingView] = useState<ProviderUpdateSidebarPillView | null>(null);
  const [exitingKey, setExitingKey] = useState<string | null>(null);
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>(
    providerUpdateSidebarVisibleAfterIso,
  );
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestProviderCheckedAt(providers);
  const view = getProviderUpdateSidebarPillView(providers, {
    ...(effectiveVisibleAfterIso !== undefined
      ? { visibleAfterIso: effectiveVisibleAfterIso }
      : {}),
    dismissedKeys: dismissedNotificationKeys,
  });

  useEffect(() => {
    if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
      providerUpdateSidebarVisibleAfterIso = effectiveVisibleAfterIso;
      setVisibleAfterIso(effectiveVisibleAfterIso);
    }
  }, [effectiveVisibleAfterIso, visibleAfterIso]);

  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);
  const displayedView = renderedView ?? view;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;
  const displayedItems = displayedView?.items ?? [];
  const showMultiProviderDetails = displayedItems.length > 1;
  const singleItem = displayedItems.length === 1 ? displayedItems[0]! : null;
  const primaryTone =
    singleItem?.tone ??
    (displayedView ? sidebarProviderUpdatePrimaryTone(displayedView.tone) : "running");
  const statusLabel =
    singleItem?.statusLabel ??
    (displayedView ? sidebarProviderUpdateFallbackStatus(displayedView.tone) : "");
  const badgeLabel =
    showMultiProviderDetails && displayedView?.tone === "loading" && displayedView.progressLabel
      ? displayedView.progressLabel
      : showMultiProviderDetails && displayedView?.summary
        ? displayedView.summary
        : statusLabel;

  const startExit = useCallback(
    (key: string, nextView: ProviderUpdateSidebarPillView | null, dismissKey?: string) => {
      if (exitingKey === key) {
        return;
      }
      if (dismissKey !== undefined) {
        dismissNotificationKey(dismissKey);
        const nextVisibleAfterIso = new Date().toISOString();
        providerUpdateSidebarVisibleAfterIso = nextVisibleAfterIso;
        setVisibleAfterIso(nextVisibleAfterIso);
      }
      setPendingView(nextView);
      setExitingKey(key);
    },
    [dismissNotificationKey, exitingKey],
  );

  useEffect(() => {
    if (exitingKey !== null) {
      return;
    }
    if (!renderedView) {
      if (view) {
        setRenderedView(view);
      }
      return;
    }
    if (!view) {
      startExit(renderedView.key, null);
      return;
    }
    if (view.key !== renderedView.key) {
      startExit(renderedView.key, view);
      return;
    }
  }, [exitingKey, renderedView, startExit, view]);

  useEffect(() => {
    if (!dismissAfterVisibleMs || !viewKey) {
      return;
    }
    if (exitingKey === viewKey) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startExit(viewKey, null, viewKey);
    }, dismissAfterVisibleMs);

    return () => window.clearTimeout(timeoutId);
  }, [dismissAfterVisibleMs, exitingKey, startExit, viewKey]);

  if (!displayedView) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/provider-update relative w-full overflow-hidden rounded-md text-xs font-medium transform-gpu transition-all duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
        showMultiProviderDetails ? "min-h-[4.25rem]" : "min-h-[2.5rem]",
        "border text-foreground",
        UPDATE_STATUS_SURFACE_STYLES[viewToneToStatusTone(displayedView.tone)],
        PROVIDER_UPDATE_SURFACE_HOVER_STYLES[viewToneToStatusTone(displayedView.tone)],
        exitingKey === displayedView.key
          ? "pointer-events-none translate-y-1.5 opacity-0"
          : "translate-y-0 opacity-100",
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (!displayedView || exitingKey !== displayedView.key) {
          return;
        }
        setRenderedView(pendingView);
        setPendingView(null);
        setExitingKey(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={displayedView.description}
              className={cn(
                "provider-update-main relative z-[1] flex w-full min-w-0 flex-col gap-1.5 text-left",
                showMultiProviderDetails ? "px-2 py-2" : "px-2 py-1.5",
                displayedView.dismissible && "pr-6",
              )}
              onClick={openProviderSettings}
            >
              <span className="flex w-full min-w-0 items-start gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    UPDATE_STATUS_DOT_STYLES[itemToneToStatusTone(primaryTone)],
                  )}
                />
                <span className="grid min-w-0 flex-1">
                  <span className="min-w-0 truncate text-[11px] leading-3.5 font-semibold text-foreground">
                    {displayedView.title}
                  </span>
                </span>
                <UpdateStatusBadge tone={itemToneToStatusTone(primaryTone)}>
                  {badgeLabel}
                </UpdateStatusBadge>
              </span>
              {showMultiProviderDetails ? (
                <>
                  <UpdateProgressRail
                    className="h-1"
                    indeterminate={displayedView.progressIndeterminate === true}
                    percent={displayedView.progressPercent}
                    tone={viewToneToStatusTone(displayedView.tone)}
                  />
                  <SidebarProviderUpdateRows items={displayedItems} />
                </>
              ) : (
                <UpdateProgressRail
                  className="h-1"
                  indeterminate={displayedView.progressIndeterminate === true}
                  percent={displayedView.progressPercent}
                  tone={viewToneToStatusTone(displayedView.tone)}
                />
              )}
            </button>
          }
        />
        <TooltipPopup side="top">{displayedView.description}</TooltipPopup>
      </Tooltip>
      {displayedView.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="absolute top-0.5 right-0.5 z-[2] inline-flex size-[1.125rem] items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100"
                onClick={() => startExit(displayedView.key, null, displayedView.key)}
              >
                <XIcon className="size-3" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
