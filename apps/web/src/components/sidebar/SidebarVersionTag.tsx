import { useCallback, useRef } from "react";
import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import type { DesktopUpdateState } from "@threadlines/contracts";

import { APP_BUILD_CHANNEL_LABEL, APP_VERSION } from "../../branding";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
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

function getCardActionLabel(state: DesktopUpdateState | null, actionKind: DesktopUpdateActionKind) {
  if (actionKind === "install") return "Restart";
  if (actionKind === "download") return state?.status === "error" ? "Retry" : "Download";
  return "Check";
}

function getCardActionAriaLabel(actionKind: DesktopUpdateActionKind) {
  if (actionKind === "check") return "Check now";
  if (actionKind === "download") return "Download update";
  if (actionKind === "install") return "Restart to install";
  return undefined;
}

/**
 * Build/updater details behind the sidebar version chip. The header states
 * the installed build channel over the full version; the footer strip
 * carries updater status text beside the single adaptive action — the only
 * button-shaped element on the card, so the affordance is unambiguous. A
 * browser session shows just the header; a fixed footer height keeps the
 * card footprint stable across updater states.
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
  const checkedLabel = state?.checkedAt
    ? `Checked ${formatRelativeTimeLabel(state.checkedAt)}`
    : "Not checked yet";
  const statusText = statusLine?.text ?? (showUpdaterControls ? checkedLabel : null);
  // While a check is in flight the action kind resolves to "none"; keep the
  // (disabled) Check button mounted so the footer never reflows.
  const showAction = showUpdaterControls && (actionKind !== "none" || isCheckingForUpdate);
  // Pending-update actions (download/install/retry) get the primary button;
  // a routine check stays as the quiet outline. Beside a primary button the
  // progress-blue status text is redundant (same hue, same message) and
  // drops to neutral; success green and error red stay — they carry state
  // the button color doesn't, and keep the card in tune with the chip.
  const actionIsPrimary = actionKind === "download" || actionKind === "install";
  const statusToneClass =
    statusLine && (!actionIsPrimary || statusLine.tone !== "progress")
      ? UPDATE_STATUS_TEXT_STYLES[statusLine.tone]
      : "text-muted-foreground/70";
  const downloadPercent =
    state?.status === "downloading" && typeof state.downloadPercent === "number"
      ? state.downloadPercent
      : null;

  return (
    // The version header alone sets the card width: the footer's inner row is
    // w-0/min-w-full so its (state-dependent) status text never contributes
    // to the intrinsic size, keeping the footprint stable across updater
    // states without padding the card out to a wide fixed width.
    <div
      className={cn("flex w-fit max-w-64 flex-col", showUpdaterControls && "min-w-48")}
      data-testid="sidebar-version-card"
    >
      <div className="flex flex-col gap-1 px-1 pt-1 pb-1.5">
        <span className="text-[9px] font-semibold tracking-[0.1em] uppercase text-muted-foreground/60">
          {APP_BUILD_CHANNEL_LABEL}
        </span>
        <code
          className="truncate text-[11px] leading-none font-medium tabular-nums text-foreground/90 select-all"
          title={`v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </code>
      </div>
      {statusText !== null || showAction ? (
        <div className="-mx-2 -mb-1 rounded-b-[calc(var(--radius-md)-1px)] border-t border-border/60 bg-muted/30">
          <div className="flex h-7 w-0 min-w-full items-center gap-2 px-3">
            {/* Action sits bottom-left: the popup opens above the chip, so the
                cursor only travels straight up from the hover target. */}
            {showAction ? (
              <Button
                aria-label={getCardActionAriaLabel(actionKind)}
                className="h-5 min-w-14 shrink-0 rounded-sm px-2 text-[10px] leading-none sm:h-5 sm:text-[10px]"
                disabled={actionDisabled || isCheckingForUpdate}
                onClick={onAction}
                size="xs"
                variant={actionIsPrimary ? "default" : "outline"}
              >
                {getCardActionLabel(state, actionKind)}
              </Button>
            ) : isDownloadingUpdate ? (
              <UpdateProgressRail
                className="w-12 shrink-0"
                indeterminate={downloadPercent === null}
                percent={downloadPercent ?? 0}
                tone="progress"
              />
            ) : null}
            <p
              aria-live={isCheckingForUpdate || isDownloadingUpdate ? "polite" : undefined}
              className={cn(
                "min-w-0 flex-1 truncate text-right text-[10px] leading-4",
                statusToneClass,
              )}
              role={isCheckingForUpdate || isDownloadingUpdate ? "status" : undefined}
              title={statusText ?? undefined}
            >
              {statusText}
            </p>
          </div>
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
  // Running the update action from a hover-opened card pins it: the user is
  // now waiting on the result, so moving the pointer away must not dismiss
  // it. Outside-press/escape closes still clear the pin below.
  const pinnedByActionRef = useRef(false);
  const runAndPin = useCallback(() => {
    pinnedByActionRef.current = true;
    run();
  }, [run]);
  const handleOpenChange = useCallback(
    (open: boolean, eventDetails: { reason: string; cancel: () => void }) => {
      if (open) return;
      if (
        pinnedByActionRef.current &&
        (eventDetails.reason === "trigger-hover" || eventDetails.reason === "focus-out")
      ) {
        eventDetails.cancel();
        return;
      }
      pinnedByActionRef.current = false;
    },
    [],
  );
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
            "motion-safe:animate-status-pulse",
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
                "motion-safe:animate-status-pulse",
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
      ? `${APP_BUILD_CHANNEL_LABEL} · Version ${APP_VERSION}`
      : presentation.tooltip;

  return (
    <Popover onOpenChange={handleOpenChange}>
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
          onAction={runAndPin}
          state={state}
        />
      </PopoverPopup>
    </Popover>
  );
}
