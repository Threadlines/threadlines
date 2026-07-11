import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@threadlines/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
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
  UPDATE_STATUS_SURFACE_STYLES,
  UPDATE_STATUS_TEXT_STYLES,
  UpdateSegmentedRail,
  UpdateStatusBadge,
  type UpdateStatusTone,
} from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

// Hover feedback lives on the container but only when the main button (not
// the dismiss affordance) is hovered, hence the has selector.
const PROVIDER_UPDATE_SURFACE_HOVER_STYLES: Record<Exclude<UpdateStatusTone, "neutral">, string> = {
  progress:
    "has-[button.provider-update-main:hover]:border-primary/40 has-[button.provider-update-main:hover]:bg-sidebar-accent/75",
  success:
    "has-[button.provider-update-main:hover]:border-success/40 has-[button.provider-update-main:hover]:bg-sidebar-accent/72",
  warning:
    "has-[button.provider-update-main:hover]:border-warning/45 has-[button.provider-update-main:hover]:bg-sidebar-accent/72",
  error:
    "has-[button.provider-update-main:hover]:border-destructive/45 has-[button.provider-update-main:hover]:bg-sidebar-accent/72",
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

function ProviderUpdateItemIcon({ tone }: { tone: ProviderUpdateSidebarPillItem["tone"] }) {
  switch (tone) {
    case "running":
      return (
        <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-primary-readable motion-reduce:animate-none" />
      );
    case "queued":
      return <CircleDashedIcon className="size-3 shrink-0 text-muted-foreground/60" />;
    case "success":
      return <CheckIcon className="size-3 shrink-0 text-success" />;
    case "warning":
      return <TriangleAlertIcon className="size-3 shrink-0 text-warning" />;
    case "error":
      return <CircleAlertIcon className="size-3 shrink-0 text-destructive" />;
  }
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
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-0.5"
          key={item.key}
        >
          <ProviderUpdateItemIcon tone={item.tone} />
          <span className="min-w-0 truncate text-[11px] leading-4 text-foreground/85">
            {item.label}
          </span>
          <span
            className={cn(
              "shrink-0 text-[10px] leading-4 font-medium",
              UPDATE_STATUS_TEXT_STYLES[itemToneToStatusTone(item.tone)],
            )}
          >
            {item.statusLabel}
          </span>
          {item.message !== undefined && (
            <span className="col-span-2 col-start-2 min-w-0 truncate text-[10px] leading-3.5 text-muted-foreground">
              {item.message}
            </span>
          )}
        </div>
      ))}
    </div>
  );
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
  // Views are keyed by batch, not by status, so content changes within a key
  // must render live; the frozen snapshot only backs the exit animation.
  const displayedView =
    exitingKey === null && view !== null && renderedView !== null && view.key === renderedView.key
      ? view
      : (renderedView ?? view);
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;

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
      setRenderedView(view);
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

  const items = displayedView.items;
  const singleItem = items.length === 1 ? items[0]! : null;

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md text-xs font-medium transform-gpu transition-all duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
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
                "provider-update-main relative z-[1] flex w-full min-w-0 flex-col gap-1.5 px-2 py-2 text-left",
                displayedView.dismissible && "pr-6",
              )}
              onClick={openProviderSettings}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                {singleItem !== null && <ProviderUpdateItemIcon tone={singleItem.tone} />}
                <span className="min-w-0 flex-1 truncate text-[11px] leading-4 font-semibold text-foreground">
                  {displayedView.title}
                </span>
                <UpdateStatusBadge tone={itemToneToStatusTone(displayedView.statusChipTone)}>
                  {displayedView.statusChipLabel}
                </UpdateStatusBadge>
              </span>
              <UpdateSegmentedRail
                className="h-1"
                segments={items.map((item) => ({
                  key: item.key,
                  tone: itemToneToStatusTone(item.tone),
                }))}
              />
              {singleItem !== null ? (
                singleItem.message !== undefined && (
                  <span className="min-w-0 truncate text-[10px] leading-3.5 text-muted-foreground">
                    {singleItem.message}
                  </span>
                )
              ) : (
                <SidebarProviderUpdateRows items={items} />
              )}
            </button>
          }
        />
        <TooltipPopup side="top">
          <span className="block">{displayedView.description}</span>
          <span className="block text-muted-foreground">Click to open provider settings.</span>
        </TooltipPopup>
      </Tooltip>
      {displayedView.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="absolute top-1 right-1 z-[2] inline-flex size-[1.125rem] items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100"
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
