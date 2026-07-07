import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import type { DesktopUpdateState } from "@threadlines/contracts";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  compactVersionLabel,
  type DesktopUpdateActionKind,
  getDesktopUpdateStatusLine,
  getSidebarDesktopUpdateTagPresentation,
  shouldShowDesktopUpdaterControls,
  type SidebarDesktopUpdateTagTone,
} from "../desktopUpdate.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  UPDATE_STATUS_SURFACE_STYLES,
  UPDATE_STATUS_TEXT_STYLES,
  UpdateProgressRail,
  UpdateStatusBadge,
} from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

const VERSION_TAG_TONE_STYLES: Record<SidebarDesktopUpdateTagTone, string> = {
  idle: "border-transparent bg-transparent text-muted-foreground/40 hover:text-muted-foreground/70",
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

function getCompactCardActionLabel(
  state: DesktopUpdateState | null,
  actionKind: DesktopUpdateActionKind,
) {
  if (actionKind === "download") return "Download";
  if (actionKind === "install") return "Restart";
  if (state?.status === "checking") return "Checking";
  if (state?.status === "downloading") return "Downloading";
  return "Check";
}

function getCompactCardActionAriaLabel(actionKind: DesktopUpdateActionKind) {
  if (actionKind === "check") return "Check now";
  if (actionKind === "download") return "Download update";
  if (actionKind === "install") return "Restart to install";
  return undefined;
}

function getCompactDownloadingDetail(state: DesktopUpdateState | null) {
  if (state?.status !== "downloading") return null;
  const targetLabel = state.availableVersion
    ? compactVersionLabel(state.availableVersion)
    : "Update";
  const progressLabel =
    typeof state.downloadPercent === "number" ? `${Math.floor(state.downloadPercent)}%` : null;
  return [targetLabel, progressLabel].filter(Boolean).join(" · ");
}

/**
 * Build/updater details behind the sidebar version chip: build stage, full
 * version, update track, updater status, and the adaptive update action.
 * Rows render only when they carry information — a browser session shows just
 * the stage/version header.
 */
function SidebarVersionCard({
  state,
  actionKind,
  actionDisabled,
  onAction,
}: {
  state: DesktopUpdateState | null;
  actionKind: DesktopUpdateActionKind;
  actionDisabled: boolean;
  onAction: () => void;
}) {
  // Only ticks while the card is open — the popup unmounts on close.
  useRelativeTimeTick(30_000);
  const isCheckingForUpdate = state?.status === "checking";
  const isDownloadingUpdate = state?.status === "downloading";
  const statusLine = getDesktopUpdateStatusLine(state);
  // Updater state only ever comes from the desktop bridge, so operational
  // updater controls double as the "running in the desktop app" signal.
  const showUpdaterControls = shouldShowDesktopUpdaterControls(state);
  const trackLabel = showUpdaterControls
    ? state?.channel === "nightly"
      ? "Nightly"
      : "Stable"
    : null;
  const checkedLabel =
    state?.checkedAt && !isCheckingForUpdate
      ? `Checked ${formatRelativeTimeLabel(state.checkedAt)}`
      : null;
  const downloadingDetail = getCompactDownloadingDetail(state);
  const detailLine =
    downloadingDetail ??
    (isCheckingForUpdate && trackLabel
      ? trackLabel
      : (statusLine?.text ?? [trackLabel, checkedLabel].filter(Boolean).join(" · ")));
  const showCompactAction =
    showUpdaterControls && (actionKind !== "none" || isCheckingForUpdate || isDownloadingUpdate);
  const compactActionLabel = getCompactCardActionLabel(state, actionKind);
  const compactActionTone = statusLine?.tone ?? "neutral";
  const compactAction = showCompactAction ? (
    actionKind === "check" || actionKind === "download" || actionKind === "install" ? (
      <Button
        aria-label={getCompactCardActionAriaLabel(actionKind)}
        className="h-5 min-w-[4.5rem] rounded-sm px-1.5 text-[10px] leading-none sm:h-5 sm:text-[10px]"
        disabled={actionDisabled || isCheckingForUpdate}
        onClick={onAction}
        size="xs"
        variant={actionKind === "install" ? "default" : "outline"}
      >
        {compactActionLabel}
      </Button>
    ) : (
      <span
        aria-live={isCheckingForUpdate ? "polite" : undefined}
        className={cn(
          "inline-flex h-5 min-w-[4.5rem] shrink-0 items-center justify-center rounded-sm border px-1.5 text-[10px] leading-none font-medium",
          compactActionTone === "progress" &&
            "border-primary/18 bg-primary/8 text-primary-readable",
          compactActionTone === "success" && "border-success/20 bg-success/8 text-success",
          compactActionTone === "error" &&
            "border-destructive/24 bg-destructive/8 text-destructive",
          compactActionTone === "neutral" &&
            "border-muted-foreground/20 bg-muted-foreground/8 text-muted-foreground",
        )}
        role={isCheckingForUpdate ? "status" : undefined}
      >
        {compactActionLabel}
      </span>
    )
  ) : null;

  return (
    <div
      className={cn("flex max-w-56 flex-col gap-1 p-1", showUpdaterControls && "w-[13.25rem]")}
      data-testid="sidebar-version-card"
    >
      <div className="flex items-center justify-between gap-2">
        <UpdateStatusBadge tone="neutral">{APP_STAGE_LABEL}</UpdateStatusBadge>
        <code className="min-w-0 break-all text-right text-[10px] font-medium tabular-nums text-muted-foreground">
          v{APP_VERSION}
        </code>
      </div>
      {detailLine || compactAction ? (
        <div className="flex min-h-5 items-center gap-2">
          {detailLine ? (
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-[10px] leading-4",
                statusLine
                  ? UPDATE_STATUS_TEXT_STYLES[statusLine.tone]
                  : "text-muted-foreground/70",
              )}
              title={detailLine}
            >
              {detailLine}
            </p>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {compactAction}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Faded compact version chip for sidebar footers. During app updates it shows
 * the incoming version with the pending action (download / progress /
 * restart) using the shared updater tones. Hovering reveals a build-details
 * card; clicking pins the card open so its update action can be used.
 */
export function SidebarVersionTag() {
  // No isElectron gate here: the update-state cache is only ever populated
  // by the desktop bridge (or the dev preview tools), so plain-browser
  // sessions stay idle either way.
  const { state, kind, disabled, run } = useDesktopUpdateAction();
  const presentation = getSidebarDesktopUpdateTagPresentation(state, APP_VERSION);
  const hasKnownDownloadProgress =
    presentation.tone === "downloading" && presentation.indicatorLabel !== null;
  const showDownloadProgressRail = presentation.tone === "downloading";
  const Icon = hasKnownDownloadProgress ? null : getUpdateIcon(presentation.tone);

  const tagClassName = cn(
    // h-7 matches the size="sm" footer buttons so both texts center within
    // the same box height instead of drifting apart.
    "relative inline-flex h-7 w-[4.25rem] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border px-1.5 text-[9px] font-medium leading-none tracking-tight tabular-nums transition-[background-color,border-color,color,box-shadow,opacity] duration-300 hover:bg-current/10",
    hasKnownDownloadProgress && "w-[4.75rem]",
    VERSION_TAG_TONE_STYLES[presentation.tone],
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
  const ariaLabel =
    presentation.tone === "idle"
      ? `${APP_STAGE_LABEL} · Version ${APP_VERSION}`
      : presentation.tooltip;

  return (
    <Popover>
      <PopoverTrigger
        closeDelay={100}
        delay={250}
        openOnHover
        render={
          <button
            aria-label={ariaLabel}
            className={tagClassName}
            data-testid="sidebar-version-chip"
            type="button"
          />
        }
      >
        {contents}
      </PopoverTrigger>
      <PopoverPopup align="end" side="top" tooltipStyle>
        <SidebarVersionCard
          actionDisabled={disabled}
          actionKind={kind}
          onAction={run}
          state={state}
        />
      </PopoverPopup>
    </Popover>
  );
}
