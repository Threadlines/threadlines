import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useId } from "react";

import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isElectron } from "../env";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getSidebarDesktopUpdateTagPresentation,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../lib/desktopUpdateReactQuery";
import { cn } from "../lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";

// The chip shows only the release triple ("0.0.19"); prerelease/build tails
// ("-nightly.4") and the release stage stay in the tooltip so the footer
// never crowds the button beside it.
const COMPACT_APP_VERSION = APP_VERSION.split(/[-+]/)[0] ?? APP_VERSION;

function getUpdateIcon(tone: ReturnType<typeof getSidebarDesktopUpdateTagPresentation>["tone"]) {
  if (tone === "downloaded") return CheckIcon;
  if (tone === "error") return RotateCwIcon;
  if (tone === "available" || tone === "downloading") return DownloadIcon;
  return null;
}

/** Faded compact version chip for sidebar footers; hover reveals stage + full version. */
export function SidebarVersionTag() {
  const tooltipId = useId();
  const queryClient = useQueryClient();
  const state = useDesktopUpdateState().data ?? null;
  const presentation = getSidebarDesktopUpdateTagPresentation(
    isElectron ? state : null,
    COMPACT_APP_VERSION,
  );
  const hasKnownDownloadProgress =
    presentation.tone === "downloading" && presentation.indicatorLabel !== null;
  const showDownloadProgressRail = presentation.tone === "downloading";
  const Icon = hasKnownDownloadProgress ? null : getUpdateIcon(presentation.tone);
  const canRunAction =
    isElectron && state !== null && presentation.action !== "none" && !presentation.disabled;

  const handleAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state || presentation.disabled) return;

    if (presentation.action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    if (presentation.action === "install") {
      const confirmed = window.confirm(getDesktopUpdateInstallConfirmationMessage(state));
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    }
  }, [presentation.action, presentation.disabled, queryClient, state]);

  const tagClassName = cn(
    "relative inline-flex h-7 w-[4.25rem] shrink-0 items-center justify-center overflow-hidden rounded-md border px-1.5 text-[9px] font-medium leading-none tracking-tight tabular-nums transition-[background-color,border-color,color,box-shadow,opacity] duration-300",
    hasKnownDownloadProgress && "w-[4.75rem]",
    presentation.tone === "idle" &&
      "cursor-default border-transparent bg-transparent text-muted-foreground/40",
    presentation.tone === "available" &&
      "border-primary/20 bg-primary/10 text-primary-readable shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]",
    presentation.tone === "downloading" && "border-primary/25 bg-primary/12 text-primary-readable",
    presentation.tone === "downloaded" &&
      "border-emerald-400/30 bg-emerald-500/12 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]",
    presentation.tone === "error" && "border-rose-400/25 bg-rose-500/12 text-rose-400",
    canRunAction && "cursor-pointer hover:bg-current/10",
    presentation.disabled && presentation.tone !== "idle" && "cursor-not-allowed opacity-70",
  );

  const contents = (
    <>
      {showDownloadProgressRail ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 bottom-1 h-0.5 overflow-hidden rounded-full bg-primary/14"
          data-testid="desktop-update-progress-track"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full bg-primary-readable",
              hasKnownDownloadProgress
                ? "transition-[width] duration-300 ease-out"
                : "w-[45%] desktop-update-indeterminate-rail",
            )}
            data-testid="desktop-update-progress-fill"
            style={
              hasKnownDownloadProgress ? { width: `${presentation.progressPercent}%` } : undefined
            }
          />
        </span>
      ) : null}
      <span
        className={cn(
          "relative z-10 inline-flex min-w-0 items-center justify-center gap-1",
          presentation.tone === "downloading" &&
            !hasKnownDownloadProgress &&
            "motion-safe:animate-pulse",
        )}
      >
        <span className="min-w-0 truncate">{presentation.label}</span>
        {Icon ? (
          <Icon
            className={cn(
              "shrink-0 -translate-y-px",
              presentation.tone === "error" ? "size-2.5" : "size-3",
              (presentation.tone === "available" ||
                (presentation.tone === "downloading" && !hasKnownDownloadProgress)) &&
                "motion-safe:animate-pulse",
            )}
          />
        ) : null}
        {presentation.indicatorLabel ? (
          <span className="shrink-0 translate-y-[-0.5px] text-[8px] font-semibold">
            {presentation.indicatorLabel}
          </span>
        ) : null}
      </span>
    </>
  );
  const tooltipText =
    presentation.tone === "idle"
      ? `${APP_STAGE_LABEL} · Version ${APP_VERSION}`
      : presentation.tooltip;

  const trigger = canRunAction ? (
    <button
      type="button"
      className={tagClassName}
      aria-describedby={tooltipId}
      aria-label={presentation.tooltip}
      onClick={handleAction}
    >
      {contents}
    </button>
  ) : (
    // h-7 matches the size="sm" footer buttons so both texts center
    // within the same box height instead of drifting apart.
    <span className={tagClassName} aria-describedby={tooltipId} aria-label={presentation.tooltip}>
      {contents}
    </span>
  );

  return (
    <span className="group/version-tag relative inline-flex shrink-0">
      {trigger}
      <span
        className="pointer-events-none absolute right-0 bottom-full z-50 mb-2 w-max max-w-[9rem] translate-y-1 rounded-md border border-border bg-popover px-2 py-1 text-center text-xs leading-tight text-popover-foreground opacity-0 shadow-md transition-[opacity,transform] duration-150 group-focus-within/version-tag:translate-y-0 group-focus-within/version-tag:opacity-100 group-hover/version-tag:translate-y-0 group-hover/version-tag:opacity-100"
        id={tooltipId}
        role="tooltip"
      >
        {tooltipText}
      </span>
    </span>
  );
}
