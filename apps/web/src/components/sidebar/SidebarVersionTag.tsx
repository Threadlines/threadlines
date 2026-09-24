import { useCallback, useRef } from "react";
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
  UPDATE_STATUS_DOT_STYLES,
  UPDATE_STATUS_TEXT_STYLES,
  UpdateProgressRail,
  type UpdateStatusTone,
} from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

const VERSION_TAG_STATUS_TONES: Record<
  Exclude<SidebarDesktopUpdateTagTone, "idle">,
  UpdateStatusTone
> = {
  available: "progress",
  downloading: "progress",
  downloaded: "success",
  error: "error",
};

// Flat text, no chip surface: tone lives in the text color and the dot.
// Progress text stays neutral while downloading; the dot keeps the blue.
const VERSION_TAG_TONE_STYLES: Record<SidebarDesktopUpdateTagTone, string> = {
  idle: "font-mono font-normal text-muted-foreground/40 hover:text-muted-foreground/70",
  available: UPDATE_STATUS_TEXT_STYLES.progress,
  downloading: "tabular-nums text-muted-foreground",
  downloaded: UPDATE_STATUS_TEXT_STYLES.success,
  error: UPDATE_STATUS_TEXT_STYLES.error,
};

/**
 * Build/updater details behind the sidebar version chip. The header states
 * the installed build channel over the full version; the footer strip
 * carries the updater status line. Pending download/install/retry actions
 * live on the chip itself, so the card's only button is Check — the one
 * action the chip can't run. A browser session shows just the header; a
 * fixed footer height keeps the card footprint stable across updater states.
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
  const showCheck = showUpdaterControls && (actionKind === "check" || isCheckingForUpdate);

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
      {statusText !== null || showCheck ? (
        <div className="-mx-2 -mb-1 rounded-b-[calc(var(--radius-md)-1px)] border-t border-border/60 bg-muted/30">
          <div className="flex h-7 w-0 min-w-full items-center gap-2 px-3">
            {/* Check sits bottom-left: the popup opens above the chip, so the
                cursor only travels straight up from the hover target. */}
            {showCheck ? (
              <Button
                aria-label="Check now"
                className="h-5 min-w-14 shrink-0 rounded-sm px-2 text-[10px] leading-none sm:h-5 sm:text-[10px]"
                disabled={actionDisabled || isCheckingForUpdate}
                onClick={onAction}
                size="xs"
                variant="outline"
              >
                Check
              </Button>
            ) : null}
            <p
              aria-live={isCheckingForUpdate || isDownloadingUpdate ? "polite" : undefined}
              className={cn(
                "min-w-0 flex-1 truncate text-[10px] leading-4",
                showCheck ? "text-right" : "text-left",
                statusLine
                  ? UPDATE_STATUS_TEXT_STYLES[statusLine.tone]
                  : "text-muted-foreground/70",
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
 * Sidebar footer version slot. Idle it shows the faded running version;
 * when the updater has work it becomes a dot plus one word ("Update",
 * "Restart", "Retry") and clicking runs that action directly — download is
 * one click, restart still goes through the install confirmation. While a
 * download runs the word is the percent, over a progress rail. Hovering
 * reveals the build-details card; with no action pending, clicking pins the
 * card so its "Check" button is usable.
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
  const runsActionOnClick = presentation.action !== "none" && !presentation.disabled;
  const isIdle = presentation.tone === "idle";
  const ariaLabel = isIdle
    ? `${APP_BUILD_CHANNEL_LABEL} · Version ${APP_VERSION}`
    : presentation.tooltip;

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger
        closeDelay={100}
        delay={250}
        onClick={(event) => {
          if (!runsActionOnClick) return;
          // Skip the popover's click toggle: the click is the action itself.
          event.preventBaseUIHandler();
          run();
        }}
        openOnHover
        render={
          <button
            aria-label={ariaLabel}
            className={cn(
              // h-7 matches the size="sm" footer buttons so both texts center
              // within the same box height.
              "relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[11px] leading-none font-medium whitespace-nowrap transition-colors hover:bg-accent",
              // One shared width across Update → progress → Restart so the
              // slot reads as one control changing its word, not resizing.
              !isIdle && "min-w-[4.5rem]",
              VERSION_TAG_TONE_STYLES[presentation.tone],
            )}
            data-testid="sidebar-version-chip"
            type="button"
          />
        }
      >
        {presentation.tone === "idle" ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              UPDATE_STATUS_DOT_STYLES[VERSION_TAG_STATUS_TONES[presentation.tone]],
            )}
          />
        )}
        {presentation.label}
        {presentation.tone === "downloading" ? (
          <UpdateProgressRail
            className="absolute inset-x-2 bottom-1 w-auto"
            indeterminate={typeof state?.downloadPercent !== "number"}
            percent={presentation.progressPercent}
            tone="progress"
          />
        ) : null}
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
