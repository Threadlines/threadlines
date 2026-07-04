import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import type { DesktopUpdateState } from "@threadlines/contracts";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  type DesktopUpdateActionKind,
  getDesktopUpdateCardActionLabel,
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
  const statusLine = getDesktopUpdateStatusLine(state);
  // Updater state only ever comes from the desktop bridge, so operational
  // updater controls double as the "running in the desktop app" signal.
  const showUpdaterControls = shouldShowDesktopUpdaterControls(state);
  const trackLabel = showUpdaterControls
    ? state?.channel === "nightly"
      ? "Nightly track"
      : "Stable track"
    : null;
  const checkedLabel = state?.checkedAt
    ? `Checked ${formatRelativeTimeLabel(state.checkedAt)}`
    : null;
  const metaLine = [trackLabel, checkedLabel].filter(Boolean).join(" · ");
  // The idle check action rides inline on the meta row; only a pending
  // download/install earns a full action button.
  const showInlineCheckAction = showUpdaterControls && actionKind === "check";
  const showActionButton = actionKind === "download" || actionKind === "install";

  return (
    // Content-hugging width (capped) so short cards — dev builds, plain
    // browser sessions — don't trail empty space after their widest row.
    <div className="flex max-w-56 flex-col gap-1.5 p-1" data-testid="sidebar-version-card">
      <div className="flex items-center justify-between gap-2">
        <UpdateStatusBadge tone="neutral">{APP_STAGE_LABEL}</UpdateStatusBadge>
        <code className="min-w-0 break-all text-right text-[10px] font-medium tabular-nums text-muted-foreground">
          v{APP_VERSION}
        </code>
      </div>
      {metaLine ? (
        <p className="text-[10px] leading-4 text-muted-foreground/70">
          {metaLine}
          {showInlineCheckAction ? (
            <>
              {" · "}
              <button
                className="cursor-pointer font-medium text-foreground/75 underline-offset-2 transition-colors hover:text-foreground hover:underline"
                onClick={onAction}
                type="button"
              >
                Check now
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {statusLine ? (
        <p className={cn("text-[11px] leading-4", UPDATE_STATUS_TEXT_STYLES[statusLine.tone])}>
          {statusLine.text}
        </p>
      ) : null}
      {showActionButton ? (
        <Button
          className="w-full"
          disabled={actionDisabled}
          onClick={onAction}
          size="xs"
          variant={actionKind === "install" ? "default" : "outline"}
        >
          {getDesktopUpdateCardActionLabel(state)}
        </Button>
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
