import { CircleArrowUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../../branding";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  getDesktopUpdateStatusLine,
  getSidebarDesktopUpdateTagPresentation,
  shouldShowDesktopUpdaterControls,
  type SidebarDesktopUpdateTagTone,
} from "../desktopUpdate.logic";
import { ChromeIconButton, ChromeTooltip } from "./ChromeIconButton";
import { UPDATE_STATUS_DOT_STYLES, type UpdateStatusTone } from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

// The ring sits 3px inside the 34px button: a 28-unit box, radius 13.
const RING_RADIUS = 13;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const DOT_TONE: Record<SidebarDesktopUpdateTagTone, UpdateStatusTone | null> = {
  idle: null,
  available: "progress",
  downloading: null,
  downloaded: "success",
  error: "error",
};

const ACTION_HINT: Record<SidebarDesktopUpdateTagTone, string | null> = {
  idle: "Click to check",
  available: "Click to download",
  downloading: null,
  downloaded: "Click to restart. Running work is listed first.",
  error: "Click to try again",
};

/**
 * The app's update control, one click in the rail above Settings (desktop
 * only; a browser has no updater, and it renders nothing there). Every click
 * runs the single pending action the updater has (check, download, restart,
 * retry), exactly as the old footer chip did: nothing downloads or installs
 * without that click, and restart still goes through the install
 * confirmation.
 *
 * State shows as motion that ends: a dot that pops in (blue available, green
 * ready, red failed), one turn of the icon per check, and a ring that fills as
 * the download runs. Each is a transform or opacity transition, and none of
 * them runs under reduced motion.
 */
export function RailUpdateButton() {
  const { state, kind, disabled, run } = useDesktopUpdateAction();
  useRelativeTimeTick(30_000);
  const checking = state?.status === "checking";
  // One full turn each time a check starts.
  const [turns, setTurns] = useState(0);
  const wasChecking = useRef(checking);
  useEffect(() => {
    if (checking && !wasChecking.current) setTurns((count) => count + 1);
    wasChecking.current = checking;
  }, [checking]);

  if (!shouldShowDesktopUpdaterControls(state)) return null;

  const presentation = getSidebarDesktopUpdateTagPresentation(state, APP_VERSION);
  const statusLine = getDesktopUpdateStatusLine(state);
  const dotTone = DOT_TONE[presentation.tone];
  const downloading = presentation.tone === "downloading";
  const runs = kind !== "none" && !disabled;

  const checkedLabel = state?.checkedAt
    ? `Checked ${formatRelativeTimeLabel(state.checkedAt)}`
    : "Not checked yet";
  const label = checking
    ? "Checking for updates…"
    : presentation.tone === "idle"
      ? `Threadlines v${APP_VERSION}`
      : (statusLine?.text ?? presentation.tooltip);
  const detail = checking
    ? null
    : presentation.tone === "idle"
      ? runs
        ? `${checkedLabel} · click to check`
        : checkedLabel
      : runs
        ? ACTION_HINT[presentation.tone]
        : null;

  return (
    <ChromeIconButton
      size="rail"
      label={detail ? `${label}. ${detail}` : label}
      testId="rail-update"
      side="right"
      tooltip={<ChromeTooltip label={label} detail={detail} />}
      // Its card says what the click started ("Checking for updates…", then
      // the answer), so it stays up while the pointer does. Restarting opens
      // its confirmation instead.
      keepTooltipOnClick={kind !== "install"}
      // Mid-check and mid-download the click does nothing, but the button
      // keeps full color: the ring and the turning icon are the point then.
      onClick={() => {
        if (runs) run();
      }}
    >
      <span
        aria-hidden="true"
        className="flex transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
        style={{ transform: `rotate(${turns * 360}deg)` }}
      >
        <CircleArrowUpIcon />
      </span>
      <span
        aria-hidden="true"
        data-testid="rail-update-dot"
        data-tone={dotTone ?? undefined}
        className={cn(
          "absolute top-1 right-1 size-[7px] rounded-full ring-2 ring-frame",
          "transition-[transform,background-color] duration-200 ease-[cubic-bezier(0.3,1.6,0.5,1)] motion-reduce:transition-none",
          dotTone ? cn("scale-100", UPDATE_STATUS_DOT_STYLES[dotTone]) : "scale-0",
        )}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 28 28"
        className={cn(
          "pointer-events-none absolute inset-[3px] size-[28px]! transition-opacity duration-200",
          downloading ? "opacity-100" : "opacity-0",
        )}
      >
        <circle
          cx="14"
          cy="14"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - presentation.progressPercent / 100)}
          transform="rotate(-90 14 14)"
          className="text-primary-graph transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
    </ChromeIconButton>
  );
}
