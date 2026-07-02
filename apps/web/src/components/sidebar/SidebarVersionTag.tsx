import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import { useCallback } from "react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { isElectron } from "../../env";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getSidebarDesktopUpdateTagPresentation,
  shouldToastDesktopUpdateActionResult,
  type SidebarDesktopUpdateTagTone,
} from "../desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  UPDATE_STATUS_SURFACE_STYLES,
  UPDATE_STATUS_TEXT_STYLES,
  UpdateProgressRail,
} from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

const VERSION_TAG_TONE_STYLES: Record<SidebarDesktopUpdateTagTone, string> = {
  idle: "cursor-default border-transparent bg-transparent text-muted-foreground/40",
  available: cn(UPDATE_STATUS_SURFACE_STYLES.progress, UPDATE_STATUS_TEXT_STYLES.progress),
  downloading: cn(UPDATE_STATUS_SURFACE_STYLES.progress, UPDATE_STATUS_TEXT_STYLES.progress),
  downloaded: cn(UPDATE_STATUS_SURFACE_STYLES.success, UPDATE_STATUS_TEXT_STYLES.success),
  error: cn(UPDATE_STATUS_SURFACE_STYLES.error, UPDATE_STATUS_TEXT_STYLES.error),
};

function getUpdateIcon(tone: SidebarDesktopUpdateTagTone) {
  if (tone === "downloaded") return CheckIcon;
  if (tone === "error") return RotateCwIcon;
  if (tone === "available" || tone === "downloading") return DownloadIcon;
  return null;
}

/**
 * Faded compact version chip for sidebar footers. During app updates it shows
 * the incoming version with the pending action (download / progress /
 * restart) using the shared updater tones.
 */
export function SidebarVersionTag() {
  const queryClient = useQueryClient();
  // No isElectron gate here: the update-state cache is only ever populated
  // by the desktop bridge (or the dev preview tools), so plain-browser
  // sessions stay idle either way.
  const state = useDesktopUpdateState().data ?? null;
  const presentation = getSidebarDesktopUpdateTagPresentation(state, APP_VERSION);
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
    // h-7 matches the size="sm" footer buttons so both texts center within
    // the same box height instead of drifting apart.
    "relative inline-flex h-7 w-[4.25rem] shrink-0 items-center justify-center overflow-hidden rounded-md border px-1.5 text-[9px] font-medium leading-none tracking-tight tabular-nums transition-[background-color,border-color,color,box-shadow,opacity] duration-300",
    hasKnownDownloadProgress && "w-[4.75rem]",
    VERSION_TAG_TONE_STYLES[presentation.tone],
    canRunAction && "cursor-pointer hover:bg-current/10",
    presentation.disabled && presentation.tone !== "idle" && "cursor-not-allowed opacity-70",
  );

  const contents = (
    <>
      {showDownloadProgressRail ? (
        <UpdateProgressRail
          className="absolute inset-x-1 bottom-1 w-auto"
          indeterminate={!hasKnownDownloadProgress}
          percent={presentation.progressPercent}
          tone="progress"
        />
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

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          canRunAction ? (
            <button
              type="button"
              className={tagClassName}
              aria-label={tooltipText}
              onClick={handleAction}
            >
              {contents}
            </button>
          ) : (
            <span className={tagClassName} aria-label={tooltipText}>
              {contents}
            </span>
          )
        }
      />
      <TooltipPopup align="end" side="top">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
