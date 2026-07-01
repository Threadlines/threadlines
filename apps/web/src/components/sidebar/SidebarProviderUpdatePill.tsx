import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@threadlines/contracts";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { useDismissedProviderUpdateNotificationKeys } from "../../providerUpdateDismissal";
import { useServerProviders } from "../../rpc/serverState";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillItem,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

const PROVIDER_UPDATE_SURFACE_STYLES = {
  loading:
    "border-primary/22 bg-sidebar-accent/55 text-foreground group-has-[button.provider-update-main:hover]/provider-update:border-primary/35 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/75",
  success:
    "border-success/24 bg-sidebar-accent/50 text-foreground group-has-[button.provider-update-main:hover]/provider-update:border-success/40 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
  warning:
    "border-warning/28 bg-sidebar-accent/50 text-foreground group-has-[button.provider-update-main:hover]/provider-update:border-warning/45 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
  error:
    "border-destructive/28 bg-sidebar-accent/50 text-foreground group-has-[button.provider-update-main:hover]/provider-update:border-destructive/45 group-has-[button.provider-update-main:hover]/provider-update:bg-sidebar-accent/72",
} as const;

const PROVIDER_UPDATE_PILL_PROGRESS_STYLES = {
  success: "bg-success/70",
  warning: "bg-warning/70",
  error: "bg-destructive/70",
} as const;

const PROVIDER_UPDATE_ITEM_DOT_STYLES = {
  queued: "bg-muted-foreground/45",
  running: "bg-primary-readable ring-2 ring-primary/15 provider-update-active-dot",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
} as const;

const PROVIDER_UPDATE_ITEM_TEXT_STYLES = {
  queued: "text-muted-foreground",
  running: "text-primary-readable",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

const PROVIDER_UPDATE_SEGMENT_STYLES = {
  queued: "bg-muted-foreground/25",
  running: "bg-primary-readable provider-update-active-segment",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
} as const;

const PROVIDER_UPDATE_STATUS_BADGE_STYLES = {
  queued: "border-muted-foreground/20 bg-muted-foreground/8 text-muted-foreground",
  running: "border-primary/18 bg-primary/8 text-primary-readable",
  success: "border-success/20 bg-success/8 text-success",
  warning: "border-warning/24 bg-warning/8 text-warning",
  error: "border-destructive/24 bg-destructive/8 text-destructive",
} as const;

const PROVIDER_UPDATE_RAIL_FILL_STYLES = {
  queued: "w-1/3 bg-muted-foreground/40",
  running: "w-[45%] bg-primary-readable provider-update-indeterminate-rail",
  success: "w-full bg-success",
  warning: "w-full bg-warning",
  error: "w-full bg-destructive",
} as const;

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

function SidebarProviderUpdateSegmentRail({
  items,
}: {
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>;
}) {
  return (
    <div
      aria-hidden="true"
      className="grid h-1 w-full gap-px overflow-hidden rounded-full bg-foreground/8"
      style={
        {
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        } as CSSProperties
      }
    >
      {items.map((item) => (
        <span
          className={cn("min-w-0 rounded-full", PROVIDER_UPDATE_SEGMENT_STYLES[item.tone])}
          key={item.key}
        />
      ))}
    </div>
  );
}

function SidebarProviderUpdateRows({
  items,
}: {
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>;
}) {
  return (
    <div className="grid w-full gap-0.5">
      {items.map((item) => (
        <div
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1"
          key={item.key}
        >
          <span
            aria-hidden="true"
            className={cn("size-1 rounded-full", PROVIDER_UPDATE_ITEM_DOT_STYLES[item.tone])}
          />
          <span className="min-w-0 truncate text-[10.5px] leading-3 text-foreground/82">
            {item.label}
          </span>
          <span
            className={cn(
              "shrink-0 text-[9.5px] leading-3 font-medium",
              PROVIDER_UPDATE_ITEM_TEXT_STYLES[item.tone],
            )}
          >
            {item.statusLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

function SidebarProviderUpdateSingleRail({ item }: { item: ProviderUpdateSidebarPillItem | null }) {
  const tone = item?.tone ?? "running";
  return (
    <div
      aria-hidden="true"
      className="relative h-1 w-full overflow-hidden rounded-full bg-foreground/8"
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          PROVIDER_UPDATE_RAIL_FILL_STYLES[tone],
        )}
      />
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
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>();
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestProviderCheckedAt(providers);
  const view = getProviderUpdateSidebarPillView(providers, {
    ...(effectiveVisibleAfterIso !== undefined
      ? { visibleAfterIso: effectiveVisibleAfterIso }
      : {}),
    dismissedKeys: dismissedNotificationKeys,
  });

  useEffect(() => {
    if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
      setVisibleAfterIso(effectiveVisibleAfterIso);
    }
  }, [effectiveVisibleAfterIso, visibleAfterIso]);

  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);
  const displayedView = renderedView ?? view;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;
  const showDismissProgress =
    dismissAfterVisibleMs !== undefined &&
    displayedView?.tone !== "loading" &&
    exitingKey !== viewKey;
  const displayedItems = displayedView?.items ?? [];
  const showMultiProviderDetails = displayedItems.length > 1;
  const singleItem = displayedItems.length === 1 ? displayedItems[0]! : null;
  const primaryTone =
    singleItem?.tone ??
    (displayedView ? sidebarProviderUpdatePrimaryTone(displayedView.tone) : "running");
  const statusLabel =
    singleItem?.statusLabel ??
    (displayedView ? sidebarProviderUpdateFallbackStatus(displayedView.tone) : "");

  const startExit = useCallback(
    (key: string, nextView: ProviderUpdateSidebarPillView | null, dismissKey?: string) => {
      if (exitingKey === key) {
        return;
      }
      if (dismissKey !== undefined) {
        dismissNotificationKey(dismissKey);
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
        "border shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
        PROVIDER_UPDATE_SURFACE_STYLES[displayedView.tone],
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
      {showDismissProgress ? (
        <div
          key={displayedView.key}
          aria-hidden="true"
          className={`provider-update-pill-progress pointer-events-none absolute bottom-0 left-0 h-0.5 w-full origin-left ${
            PROVIDER_UPDATE_PILL_PROGRESS_STYLES[displayedView.tone]
          }`}
          style={
            {
              "--provider-update-pill-dismiss-ms": `${dismissAfterVisibleMs}ms`,
            } as CSSProperties
          }
        />
      ) : null}
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
                    PROVIDER_UPDATE_ITEM_DOT_STYLES[primaryTone],
                  )}
                />
                <span className="grid min-w-0 flex-1">
                  <span className="min-w-0 truncate text-[11px] leading-3.5 font-semibold text-foreground">
                    {displayedView.title}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-sm border px-1.5 py-px text-[9.5px] leading-3 font-medium",
                    PROVIDER_UPDATE_STATUS_BADGE_STYLES[primaryTone],
                  )}
                >
                  {showMultiProviderDetails && displayedView.summary
                    ? displayedView.summary
                    : statusLabel}
                </span>
              </span>
              {showMultiProviderDetails ? (
                <>
                  <SidebarProviderUpdateSegmentRail items={displayedItems} />
                  <SidebarProviderUpdateRows items={displayedItems} />
                </>
              ) : (
                <SidebarProviderUpdateSingleRail item={singleItem} />
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
