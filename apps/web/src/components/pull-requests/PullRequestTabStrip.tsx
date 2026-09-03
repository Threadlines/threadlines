/**
 * The pull requests open beside the list, in the internal browser's visual
 * language: a short row of rounded-top tabs, the active one lifted onto the
 * background, a close ✕ on it and on whichever the pointer is over. It is the
 * thread right panel's strip narrowed to one kind of thing, so the classes are
 * that strip's; its logic is not reusable here, since every tab there is one of
 * a fixed set of surfaces and every tab here is a row the user pressed.
 *
 * There is no `+`: the list beside the column is how a pull request is opened.
 */
import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { MINI_HORIZONTAL_SCROLLBAR_CLASS, ScrollArea } from "../ui/scroll-area";
import { moveBetweenTabs } from "../ui/page-tabs";
import { TooltipWrapper } from "../ui/tooltip";
import { pullRequestBadgeTone } from "./pullRequests.logic";
import type { PullRequestTab } from "./pullRequestTabsStore";

/** Hover on the tab, or keyboard focus anywhere in it, including the ✕ itself. */
const REVEAL_ON_TAB_HOVER_OR_FOCUS =
  "group-hover/pr-tab:opacity-100 group-has-[:focus-visible]/pr-tab:opacity-100";

export function pullRequestTabButtonId(id: string): string {
  return `pull-request-tab-${id}`;
}

export function PullRequestTabStrip({
  tabs,
  activeId,
  panelId,
  onSelect,
  onClose,
}: {
  readonly tabs: readonly PullRequestTab[];
  readonly activeId: string | null;
  /** The detail below, so each tab can name what it controls. */
  readonly panelId: string;
  readonly onSelect: (tab: PullRequestTab) => void;
  readonly onClose: (tab: PullRequestTab) => void;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  // Set by a close the keyboard ran, so the cursor lands on whichever tab took
  // the closed one's place rather than on the body.
  const focusActiveTab = useRef(false);

  // A tab opened while the strip is already full can sit past its right edge,
  // and the active tab is the one the detail below is showing.
  useEffect(() => {
    const active = activeId
      ? list.current?.querySelector<HTMLElement>(
          `[data-pull-request-tab="${activeId}"] [role="tab"]`,
        )
      : null;
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
    // Held until a tab is actually there to take it: the strip drops the closed
    // tab before the route says which one stands in its place.
    if (focusActiveTab.current && active) {
      focusActiveTab.current = false;
      active.focus();
    }
    // Only the active tab matters here, and every way the strip gains or loses
    // one ends with a different tab active.
  }, [activeId]);

  if (tabs.length === 0) {
    return null;
  }
  return (
    <div className="shrink-0 border-b border-border" data-testid="pull-request-tab-strip">
      <div className="flex h-9 items-stretch px-1.5 pt-1.5">
        {/* Tabs are drawn whole and scroll rather than shrink, exactly as the
            thread panel's do: "#12…" names nothing. The bar is the hairline
            overlay every strip in the app uses, so the row keeps its height. */}
        <ScrollArea
          scrollFade="x-end"
          observeContentResize
          horizontalWheelScroll
          contentClassName="h-full"
          className={cn("min-w-0 flex-1 self-stretch", MINI_HORIZONTAL_SCROLLBAR_CLASS)}
        >
          <div
            ref={list}
            role="tablist"
            aria-label="Open pull requests"
            className="flex h-full w-max items-stretch gap-px"
          >
            {tabs.map((tab) => (
              <PullRequestTabStripItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                panelId={panelId}
                onSelect={() => onSelect(tab)}
                onClose={(fromKeyboard) => {
                  focusActiveTab.current = fromKeyboard;
                  onClose(tab);
                }}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function PullRequestTabStripItem({
  tab,
  active,
  panelId,
  onSelect,
  onClose,
}: {
  readonly tab: PullRequestTab;
  readonly active: boolean;
  readonly panelId: string;
  readonly onSelect: () => void;
  /** True when the keyboard ran the close, which then has to hand focus on. */
  readonly onClose: (fromKeyboard: boolean) => void;
}) {
  const tone = pullRequestBadgeTone(tab.state, tab.isDraft);
  return (
    <TooltipWrapper side="bottom" tooltip={`${tab.repository} #${tab.number}`}>
      <div
        role="presentation"
        data-pull-request-tab={tab.id}
        data-active={active ? "true" : undefined}
        className={cn(
          // Padded wider after the number than before the glyph: the glyph
          // anchors the left edge and the tail reserves room for the ✕, which
          // sits over that padding. The room is always kept, since the active
          // tab shows its ✕ all the time and a ✕ over the last digit reads as
          // a truncated number.
          "group/pr-tab relative flex shrink-0 items-center rounded-t-md pr-5.5 pl-1.5 text-xs",
          active
            ? "bg-background text-foreground"
            : "bg-muted/50 text-muted-foreground/80 hover:bg-accent hover:text-foreground",
        )}
        // A tab closes the way browser tabs always have, whether or not its ✕
        // is on show.
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(false);
        }}
        onMouseDown={(event) => {
          // Suppress the middle-click autoscroll cursor; the close itself
          // happens on auxclick, where the gesture is complete.
          if (event.button === 1) event.preventDefault();
        }}
      >
        <button
          type="button"
          role="tab"
          id={pullRequestTabButtonId(tab.id)}
          aria-selected={active}
          aria-controls={panelId}
          tabIndex={active ? 0 : -1}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 py-1 focus-ring"
          onClick={onSelect}
          onKeyDown={moveBetweenTabs}
        >
          <span className={cn("flex size-3 shrink-0 items-center justify-center", tone.className)}>
            <tone.Icon aria-hidden className="size-3" />
          </span>
          {/* The strip has room for the number alone, but two repositories can
              hold the same one, so the name a reader hears carries both. */}
          <span aria-hidden className="font-mono whitespace-nowrap tabular-nums">
            #{tab.number}
          </span>
          <span className="sr-only">{`${tab.repository} #${tab.number} ${tone.label}`}</span>
        </button>
        {/* Overlaid on the tab's right edge rather than given a column of its
            own: reserving width for a control that is invisible most of the
            time is exactly what a strip of tabs cannot spare. */}
        <button
          type="button"
          aria-label={`Close ${tab.repository} #${tab.number}`}
          data-testid="pull-request-tab-close"
          // Only the active tab is in the tab order, as the tabs themselves
          // are: a strip of six would otherwise cost twelve stops, most of
          // them on a ✕ nobody can see.
          tabIndex={active ? 0 : -1}
          className={cn(
            // A 16px ✕ is not a thumb-sized target, so a coarse pointer gets a
            // reach around it rather than a bigger glyph, which would sit over
            // the number the tab is named by.
            "absolute top-1/2 right-1 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded transition-[opacity,background-color,color] hover:bg-foreground/10 hover:text-foreground focus-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']",
            active
              ? "bg-background"
              : cn("bg-muted/50 can-hover:opacity-0", REVEAL_ON_TAB_HOVER_OR_FOCUS),
            "focus-visible:opacity-100",
          )}
          // `detail` is 0 for a click the keyboard ran, which is the one that
          // leaves nothing focused behind it.
          onClick={(event) => onClose(event.detail === 0)}
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </div>
    </TooltipWrapper>
  );
}
