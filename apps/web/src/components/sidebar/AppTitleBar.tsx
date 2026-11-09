import { ArrowLeftIcon, ArrowRightIcon, PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { type CSSProperties, useCallback, useRef, useState } from "react";

import { useAppHistory } from "../../appHistory";
import { shortcutLabelForCommand } from "../../keybindings";
import { useServerKeybindings } from "../../rpc/serverState";
import { useSidebar } from "../ui/sidebar";
import { AppWordmark } from "./AppWordmark";
import { ChromeIconButton, ChromeTooltip } from "./ChromeIconButton";
import { destinationHasList } from "./destinationLists";
import { useRouteShortcutContext, useSelectedDestination } from "./NavigationRail";
import { NAVIGATION_DESTINATION_LABELS } from "./navigationRail.logic";
import { publishTitleBarRoom, useTitleBarNameHidden } from "./titleBarSlot";
import { cn } from "../../lib/utils";

/**
 * Where the open page's slot starts, from the title row's left edge: over the
 * page's content column (past the rail, the work panel's hairline, the list
 * while it shows, and a header's own 20px padding), and never nearer the
 * buttons on its left than 12px. `--titlebar-list-width` transitions on the
 * list's own curve (index.css), and the clamp applies on every frame, so the
 * slot travels with the content column until it meets those buttons.
 */
/** The name's margin before the buttons (`me-2.5`) and the cluster's gap. */
const NAME_TRAILING_GAP_PX = 12;
/** The least the slot keeps from the buttons on its left (SLOT_START's 12px). */
const SLOT_MIN_START_PX = 12;

const SLOT_START =
  "max(12px, calc(var(--app-rail-width) + 1px + var(--titlebar-list-width) + 20px - var(--titlebar-cluster-end)))";

/**
 * The window's title row on a wide screen, part of the frame with the rail:
 * past the macOS traffic lights (or from the left edge elsewhere), the app's
 * name, then the list toggle, back and forward. The name comes first so the
 * buttons stand between it and the page's header: a thread's project and
 * title never read as the next steps of a path that starts at "Threadlines".
 * Nothing there moves when the list hides. On a page with no list (Pull
 * Requests, Usage) the toggle stays, disabled.
 *
 * The rest of the row belongs to the open page (TitleBarContent): a thread's
 * header, Settings' Restore defaults. It ends clear of the window controls
 * (12px from the edge on macOS, past the Windows and Linux buttons). Empty
 * space anywhere in the row moves the window; its controls never do.
 *
 * In a narrow window the name gives way first, then a header too wide for
 * what's left moves to a row of its own (titleBarSlot.tsx). The row measures
 * the room for both, the name's included while it's hidden, so neither
 * choice depends on the other's outcome.
 */
export function AppTitleBar({
  slotRef,
}: {
  /** Receives the open page's slot, for TitleBarContent's portal. */
  readonly slotRef: (element: HTMLElement | null) => void;
}) {
  const { open, overlay, toggleSidebar, isMobile } = useSidebar();
  const nameHidden = useTitleBarNameHidden();
  const nameRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const keybindings = useServerKeybindings();
  const history = useAppHistory();
  const selected = useSelectedDestination();
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const shortcutOptions = { platform, context: useRouteShortcutContext() };
  const [clusterEnd, setClusterEnd] = useState(0);
  // Off until the slot first stands where it belongs, so opening the window
  // does not slide it in from the left.
  const [slotSlides, setSlotSlides] = useState(false);
  // Where the frame's own buttons end, measured as they mount (before the
  // first paint) and whenever their width changes; the list's slide moves
  // the slot by CSS alone.
  const measureCluster = useCallback((cluster: HTMLDivElement | null) => {
    const row = cluster?.parentElement;
    if (!cluster || !row) return;
    const measure = () => {
      setClusterEnd(
        Math.round(cluster.getBoundingClientRect().right - row.getBoundingClientRect().left),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cluster);
    const frame = window.requestAnimationFrame(() => setSlotSlides(true));
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);
  // The page's room in the row, now and as it would be with the name: the
  // row's width between the window controls, less the name (its full width,
  // read even while it's folded away), the buttons and the slot's 12px start.
  const measureSlot = useCallback((slot: HTMLDivElement | null) => {
    const row = slot?.parentElement;
    if (!slot || !row) return;
    const measure = () => {
      const rowStyle = getComputedStyle(row);
      const inner =
        row.clientWidth -
        (Number.parseFloat(rowStyle.paddingLeft) || 0) -
        (Number.parseFloat(rowStyle.paddingRight) || 0);
      const name = (nameRef.current?.offsetWidth ?? 0) + NAME_TRAILING_GAP_PX;
      const buttons = buttonsRef.current?.offsetWidth ?? 0;
      publishTitleBarRoom(
        slot.clientWidth,
        Math.max(0, Math.floor(inner - name - buttons - SLOT_MIN_START_PX)),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(slot);
    if (nameRef.current) observer.observe(nameRef.current);
    if (buttonsRef.current) observer.observe(buttonsRef.current);
    measure();
    return () => {
      observer.disconnect();
      publishTitleBarRoom(null, null);
    };
  }, []);
  // A ref that returns a cleanup isn't called again with null, so the cleanup
  // hands the slot back: a page must never portal into a row that's gone (a
  // browser narrowed into the phone layout).
  const setSlot = useCallback(
    (slot: HTMLDivElement | null) => {
      slotRef(slot);
      const stopMeasuring = measureSlot(slot);
      return () => {
        stopMeasuring?.();
        slotRef(null);
      };
    },
    [measureSlot, slotRef],
  );
  if (isMobile) return null;
  const hasList = destinationHasList(selected);
  const pageLabel = NAVIGATION_DESTINATION_LABELS[selected];
  const toggleLabel = open ? "Hide sidebar" : "Show sidebar";

  return (
    <div
      data-slot="app-titlebar"
      data-testid="app-titlebar"
      data-titlebar-slides={slotSlides ? "" : undefined}
      className="drag-region flex h-(--app-titlebar-height) shrink-0 items-center bg-frame ps-(--app-titlebar-leading) pe-(--workspace-controls-right)"
      style={
        {
          // A floating list covers the page rather than moving it.
          "--titlebar-list-width": open && !overlay ? "var(--sidebar-width)" : "0px",
          "--titlebar-cluster-end": `${clusterEnd}px`,
        } as CSSProperties
      }
    >
      <div ref={measureCluster} className="flex shrink-0 items-center gap-0.5">
        {/* Folded to nothing when the page needs the room; the name inside
            keeps its full width, which is what the row measures. */}
        <div
          data-testid="titlebar-name"
          inert={nameHidden}
          className={cn("flex min-w-0 overflow-hidden", nameHidden ? "w-0" : "me-2.5")}
        >
          <div ref={nameRef} className="flex w-max shrink-0">
            <AppWordmark />
          </div>
        </div>
        <div ref={buttonsRef} className="flex shrink-0 items-center gap-0.5">
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label={hasList ? toggleLabel : "Sidebar"}
            testId="titlebar-sidebar-toggle"
            disabled={!hasList}
            tooltip={
              <ChromeTooltip
                label={hasList ? toggleLabel : "Sidebar"}
                shortcut={
                  hasList
                    ? shortcutLabelForCommand(keybindings, "sidebar.toggle", shortcutOptions)
                    : null
                }
                detail={hasList ? null : `${pageLabel} has no list.`}
              />
            }
            onClick={toggleSidebar}
          >
            {open ? (
              <PanelLeftCloseIcon aria-hidden="true" />
            ) : (
              <PanelLeftIcon aria-hidden="true" />
            )}
          </ChromeIconButton>
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label="Back"
            testId="titlebar-back"
            disabled={!history.canGoBack}
            tooltip={
              <ChromeTooltip
                label="Back"
                shortcut={shortcutLabelForCommand(keybindings, "navigate.back", shortcutOptions)}
              />
            }
            onClick={history.back}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </ChromeIconButton>
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label="Forward"
            testId="titlebar-forward"
            disabled={!history.canGoForward}
            tooltip={
              <ChromeTooltip
                label="Forward"
                shortcut={shortcutLabelForCommand(keybindings, "navigate.forward", shortcutOptions)}
              />
            }
            onClick={history.forward}
          >
            <ArrowRightIcon aria-hidden="true" />
          </ChromeIconButton>
        </div>
      </div>
      <div
        ref={setSlot}
        data-testid="titlebar-slot"
        // A header wider than the slot (a wide list in a narrow window) is
        // cut at the slot's end rather than running under the window
        // controls; the clip margin keeps focus rings whole.
        className="flex h-full min-w-0 flex-1 items-center overflow-clip [overflow-clip-margin:4px]"
        style={{ marginInlineStart: SLOT_START }}
      />
    </div>
  );
}
