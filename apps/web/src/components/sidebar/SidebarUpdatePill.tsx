import { CheckIcon, DownloadIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarUpdatePill() {
  const queryClient = useQueryClient();
  const state = useDesktopUpdateState().data ?? null;
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const versionKey = state?.downloadedVersion ?? state?.availableVersion ?? null;
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Update available";
  const disabled = isDesktopUpdateButtonDisabled(state);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const canDismiss = action === "download" && state?.status === "available";
  const dismissed = canDismiss && versionKey !== null && dismissedVersion === versionKey;
  const visible = isElectron && shouldShowDesktopUpdateButton(state) && !dismissed;
  const isDownloaded = action === "install" || state?.status === "downloaded";
  const isDownloading = state?.status === "downloading";
  const isError = shouldHighlightDesktopUpdateError(state);
  const progressPercent = isDownloaded
    ? 100
    : isDownloading && typeof state?.downloadPercent === "number"
      ? Math.max(0, Math.min(100, state.downloadPercent))
      : 0;
  const progressClass = isDownloaded
    ? "bg-emerald-500/20 opacity-100"
    : isDownloading
      ? "bg-sky-500/16 opacity-100"
      : "opacity-0";
  const toneClass = isDownloaded
    ? "border border-emerald-400/30 bg-emerald-500/12 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]"
    : isDownloading
      ? "border border-sky-400/25 bg-sky-500/12 text-sky-400"
      : isError
        ? "border border-rose-400/25 bg-rose-500/12 text-rose-400"
        : "border border-primary/15 bg-primary/15 text-primary";

  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;

  const handleAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || action === "none") return;

    if (action === "download") {
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
        .catch((error) => {
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

    if (action === "install") {
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
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    }
  }, [action, disabled, queryClient, state]);

  if (!visible && !showArm64Warning) return null;

  return (
    <div className="flex flex-col gap-1">
      {showArm64Warning && arm64Description && (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
          <TriangleAlertIcon />
          <AlertTitle>Intel build on Apple Silicon</AlertTitle>
          <AlertDescription>{arm64Description}</AlertDescription>
        </Alert>
      )}
      {visible && (
        <div
          className={`group/update relative flex h-7 w-full items-center overflow-hidden rounded-lg text-xs font-medium transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ${toneClass} ${
            disabled ? " cursor-not-allowed opacity-60" : ""
          }`}
        >
          <div
            className={`pointer-events-none absolute inset-y-0 left-0 transition-[width,opacity,background-color] duration-500 ease-out ${progressClass}`}
            style={{ width: `${progressPercent}%` }}
          />
          <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors group-has-[button.update-main:hover]/update:bg-current/[0.08]" />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={tooltip}
                  aria-disabled={disabled || undefined}
                  disabled={disabled}
                  className="update-main relative flex h-full flex-1 items-center gap-2 px-2 enabled:cursor-pointer"
                  onClick={handleAction}
                >
                  {action === "install" ? (
                    <>
                      <CheckIcon className="size-3.5" />
                      <span>Restart to update</span>
                    </>
                  ) : state?.status === "downloading" ? (
                    <>
                      <DownloadIcon className="size-3.5" />
                      <span>
                        Downloading
                        {typeof state.downloadPercent === "number"
                          ? ` (${Math.floor(state.downloadPercent)}%)`
                          : "..."}
                      </span>
                    </>
                  ) : (
                    <>
                      <RotateCwIcon className="size-3.5" />
                      <span>Update available</span>
                    </>
                  )}
                </button>
              }
            />
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
          {canDismiss && versionKey !== null && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Dismiss update"
                    className="relative mr-1 inline-flex size-5 items-center justify-center rounded-md text-current/60 transition-colors hover:text-current"
                    onClick={() => setDismissedVersion(versionKey)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
