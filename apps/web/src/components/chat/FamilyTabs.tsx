/**
 * Family tabs (docs/design/lead-chat.md, "Family tabs"): under the chat
 * header, one row for the open thread's family, the parent first and then
 * the threads it started. A tab is a thread open: the same chat with its own
 * message box, scroll position and draft.
 *
 * The row belongs to the family, not to the open thread: it is keyed by the
 * parent, so switching between members keeps it mounted and still. It reads
 * a narrow model (`sameFamilyTabs`), so a reply streaming in one thread does
 * not redraw it.
 *
 * A child on a computer this app can't see opens read through the link
 * (LinkedThreadView), where the parent's computer can do that; the row then
 * shows with that child's tab open.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CrownIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { useInboxThreads } from "../../hooks/useInboxThreads";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useRemoteFamilyChildren } from "../../hooks/useRemoteFamilyChildren";
import { useKept } from "../../hooks/useStableIdentity";
import { useThreadMenu } from "../../hooks/useThreadMenu";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { useConnectedComputerCapabilityCheck } from "../../environments/computerCapabilities";
import { linkedThreadRouteParams } from "../../environments/links/linkedThreads";
import { requestIdleThreadDetailPrewarm } from "../../environments/runtime/service";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { LeadChatCard, LeadChatSuggestion } from "./LeadChatHints";
import {
  FAMILY_TAB_MIN_WIDTH_PX,
  type FamilyTab,
  type FamilyTabs as FamilyTabsModel,
  familyTabsOf,
  fitFamilyTabs,
  sameFamilyTabs,
} from "./familyTabs.logic";

/** The members of the family whose row is on screen, newline-joined; "" for none. */
const useFamilyTabsShownStore = create<{ readonly memberKeys: string }>()(() => ({
  memberKeys: "",
}));

/**
 * Whether the family row is showing for `threadKey`: the header then drops
 * its "Lead chat" and "Started by" chips, since the row says both.
 */
export function useFamilyTabsShown(threadKey: string | null): boolean {
  return useFamilyTabsShownStore(
    (state) => threadKey !== null && state.memberKeys.split("\n").includes(threadKey),
  );
}

/** A tab's box, shared by the drawn tabs and their measured copies so the two match. */
const TAB_BOX_CLASS = "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs";
/** The "+N" button's box, shared the same way. */
const OVERFLOW_BOX_CLASS = "relative flex h-6 shrink-0 items-center rounded-md px-2 text-xs";

/** What a tab shows as its title: the lead's is "Lead". */
function tabText(tab: FamilyTab): string {
  return tab.kind === "parent" && tab.lead ? "Lead" : tab.shortTitle;
}

/** The row as drawn: its width inside the padding, the gap between tabs, and each tab's own width. */
interface RowMeasure {
  readonly rowPx: number;
  readonly gapPx: number;
  /** Each tab at its title's full length, up to the 200px cap, by key. */
  readonly tabPx: ReadonlyMap<string, number>;
  /** "+N" with the most digits it can need. */
  readonly overflowPx: number;
}

function sameRowMeasure(left: RowMeasure | null, right: RowMeasure): boolean {
  return (
    left !== null &&
    left.rowPx === right.rowPx &&
    left.gapPx === right.gapPx &&
    left.overflowPx === right.overflowPx &&
    left.tabPx.size === right.tabPx.size &&
    [...right.tabPx].every(([key, px]) => left.tabPx.get(key) === px)
  );
}

/**
 * Reads the row and the hidden copies of its tabs (`measureRef`): what fits
 * is decided before a tab is drawn, and one behind "+N" isn't drawn at all.
 * The copies are the tabs' own markup and classes, so a larger browser font,
 * a theme's font, or a font that loads late shows up as a resize the
 * observer reports. Null until the row is on screen, and on a phone.
 */
function useRowMeasure(
  rowRef: React.RefObject<HTMLDivElement | null>,
  measureRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  tabKeys: string,
): RowMeasure | null {
  const [measure, setMeasure] = useState<RowMeasure | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const layer = measureRef.current;
    if (!enabled || row === null || layer === null) return;
    // The copies of these tabs, by key, and the copy of "+N".
    const copies = tabKeys.split("\n").flatMap((key) => {
      const copy = layer.querySelector<HTMLElement>(`[data-measure-key="${CSS.escape(key)}"]`);
      return copy === null ? [] : [[key, copy] as const];
    });
    const overflowCopy = layer.querySelector<HTMLElement>("[data-measure-overflow]");
    const read = () => {
      const style = getComputedStyle(row);
      const next: RowMeasure = {
        rowPx:
          row.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth),
        gapPx: parseFloat(style.columnGap) || 0,
        tabPx: new Map(copies.map(([key, copy]) => [key, copy.getBoundingClientRect().width])),
        overflowPx: overflowCopy?.getBoundingClientRect().width ?? 0,
      };
      setMeasure((previous) => (sameRowMeasure(previous, next) ? previous : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(row);
    for (const [, copy] of copies) observer.observe(copy);
    if (overflowCopy !== null) observer.observe(overflowCopy);
    return () => observer.disconnect();
  }, [enabled, measureRef, rowRef, tabKeys]);
  return enabled ? measure : null;
}

/** What a tab opens: a thread this app has, or a child read through the link. */
export type FamilyTabTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "linked"; readonly ref: ScopedThreadRef };

/** What a click on `tab` opens; null when it opens nothing. */
function targetOf(tab: FamilyTab): FamilyTabTarget | null {
  if (tab.threadRef !== null) return { kind: "thread", ref: tab.threadRef };
  if (tab.linkedRef !== null) return { kind: "linked", ref: tab.linkedRef };
  return null;
}

/**
 * The row for the open thread's family, or nothing when it has none.
 * `openKey` is the open thread's key; for a child read through the link,
 * `parentKey` names the parent that holds it. While the row shows, the
 * header's "Lead chat" and "Started by" chips give way to it
 * (`useFamilyTabsShown`).
 */
export function FamilyTabs({ openKey, parentKey }: { openKey: string; parentKey?: string }) {
  const family = useFamilyTabs(openKey, parentKey);
  const navigate = useNavigate();

  const open = useCallback(
    (target: FamilyTabTarget) => {
      if (target.kind === "linked") {
        void navigate({
          to: "/linked/$computerId/$linkedThreadId",
          params: linkedThreadRouteParams(target.ref),
        });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target.ref),
      });
    },
    [navigate],
  );

  // The members are a click away: load them ahead, as the sidebar does its rows.
  const memberKeys =
    family === null
      ? ""
      : family.tabs.flatMap((tab) => (tab.threadRef === null ? [] : [tab.key])).join("\n");
  useEffect(() => {
    if (memberKeys === "") return;
    return requestIdleThreadDetailPrewarm(
      memberKeys.split("\n").flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref === null ? [] : [ref];
      }),
    );
  }, [memberKeys]);

  // The header's chips give way while the row shows; it reads this.
  useLayoutEffect(() => {
    useFamilyTabsShownStore.setState({ memberKeys });
  }, [memberKeys]);
  useLayoutEffect(() => () => useFamilyTabsShownStore.setState({ memberKeys: "" }), []);

  if (family === null) return null;
  return <FamilyTabRow key={family.familyKey} family={family} onOpen={open} />;
}

/**
 * The open thread's family as the row draws it, kept while nothing it shows
 * changes. Membership is the sidebar's own rule (`liveFamilyOf`, through
 * `familyTabsOf`), fed by the same filing (`useInboxThreads`).
 */
export function useFamilyTabs(openKey: string, parentKey?: string): FamilyTabsModel | null {
  const { entries, nowIso } = useInboxThreads();
  const remoteFamilyChildren = useRemoteFamilyChildren(nowIso);
  const readsLinked = useConnectedComputerCapabilityCheck("linkedThreadRead");
  const family = useMemo(() => {
    const keys = new Set(entries.map((entry) => entry.threadKey));
    return familyTabsOf({
      openKey,
      parentKey,
      entries,
      remoteChildrenOf: (parent) =>
        remoteFamilyChildren(parent.thread, (threadId) =>
          keys.has(scopedThreadKey({ environmentId: parent.thread.environmentId, threadId })),
        ),
      canReadLinked: (parent) => readsLinked(parent.thread.environmentId),
      now: nowIso,
    });
  }, [entries, nowIso, openKey, parentKey, readsLinked, remoteFamilyChildren]);
  return useKept(family, sameFamilyTabs);
}

const FamilyTabRow = memo(function FamilyTabRow({
  family,
  onOpen,
}: {
  family: FamilyTabsModel;
  onOpen: (target: FamilyTabTarget) => void;
}) {
  const isMobile = useIsMobile();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const measure = useRowMeasure(
    rowRef,
    measureRef,
    !isMobile,
    family.tabs.map((tab) => tab.key).join("\n"),
  );

  // On a phone the row scrolls sideways instead, with the open tab in view.
  const openTabRef = useRef<HTMLButtonElement | null>(null);
  const openKey = family.openKey;
  useLayoutEffect(() => {
    if (isMobile && openKey !== "") {
      openTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [openKey, isMobile]);

  const { shown, hidden } =
    measure === null
      ? { shown: family.tabs, hidden: [] as readonly FamilyTab[] }
      : fitFamilyTabs({
          tabs: family.tabs,
          openKey: family.openKey,
          rowPx: measure.rowPx,
          overflowPx: measure.overflowPx,
          gapPx: measure.gapPx,
          // A short tab costs its own width; a long one the shared floor; the lead never shrinks.
          floorPx: (tab) => {
            const px = measure.tabPx.get(tab.key) ?? FAMILY_TAB_MIN_WIDTH_PX;
            return tab.kind === "parent" && tab.lead ? px : Math.min(px, FAMILY_TAB_MIN_WIDTH_PX);
          },
        });

  // The parent, open and not leading yet, may be offered as the lead (LeadChatSuggestion).
  const parentTab = family.tabs[0];
  const suggestLead =
    parentTab !== undefined &&
    parentTab.kind === "parent" &&
    !parentTab.lead &&
    parentTab.threadRef !== null &&
    parentTab.key === family.openKey
      ? parentTab.threadRef
      : null;

  return (
    <>
      <div
        ref={rowRef}
        role="tablist"
        aria-label="This thread's family"
        data-testid="family-tabs"
        data-family-key={family.familyKey}
        className={cn(
          "relative flex min-w-0 shrink-0 items-center gap-0.5 border-b border-border px-3 py-1 sm:px-5",
          isMobile && "overflow-x-auto [scrollbar-width:none]",
        )}
      >
        {isMobile ? null : (
          // Every tab and "+N" at full width, unseen, for useRowMeasure.
          <div
            ref={measureRef}
            aria-hidden="true"
            inert
            className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max overflow-hidden"
          >
            {family.tabs.map((tab) => (
              <span
                key={tab.key}
                data-measure-key={tab.key}
                className={cn(TAB_BOX_CLASS, "max-w-50 shrink-0")}
              >
                <FamilyTabFace tab={tab} />
              </span>
            ))}
            <span data-measure-overflow className={OVERFLOW_BOX_CLASS}>
              +{family.tabs.length}
            </span>
          </div>
        )}
        {shown.map((tab) => (
          <FamilyTabButton
            key={tab.key}
            tab={tab}
            active={tab.key === family.openKey}
            fill={!isMobile}
            onOpen={onOpen}
            buttonRef={tab.key === family.openKey ? openTabRef : undefined}
          />
        ))}
        {hidden.length > 0 ? <FamilyTabOverflow hidden={hidden} onOpen={onOpen} /> : null}
      </div>
      {suggestLead !== null ? <LeadChatSuggestion parentRef={suggestLead} /> : null}
    </>
  );
});

const FamilyTabButton = memo(function FamilyTabButton({
  tab,
  active,
  fill,
  onOpen,
  buttonRef,
}: {
  tab: FamilyTab;
  active: boolean;
  /** May shrink when the row is crowded (desktop); on a phone each keeps its width and the row scrolls. */
  fill: boolean;
  onOpen: (target: FamilyTabTarget) => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null> | undefined;
}) {
  const threadMenu = useThreadMenu();
  const target = targetOf(tab);
  const openMenu = useCallback(
    (position: { readonly x: number; readonly y: number }) => {
      if (tab.threadRef !== null) {
        void threadMenu.open({ threadRef: tab.threadRef, inbox: tab.inbox }, position);
      }
    },
    [tab.inbox, tab.threadRef, threadMenu],
  );
  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu],
  );
  const touchHold = useTouchHoldMenu<HTMLButtonElement>({ open: openMenu, onContextMenu });
  const isLeadTab = tab.kind === "parent" && tab.lead;
  const label = isLeadTab
    ? `Lead: ${tab.title}`
    : tab.statusWord !== null
      ? `${tab.title}, ${tab.statusWord}`
      : tab.title;
  const tabButton = (showLeadCard: (() => void) | null) => (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={tab.computerLabel === null ? tab.title : `${tab.title} on ${tab.computerLabel}`}
      data-testid={`family-tab-${tab.key}`}
      data-family-tab-kind={tab.kind}
      disabled={target === null}
      className={cn(
        TAB_BOX_CLASS,
        "transition-colors focus-ring",
        // As wide as its title up to a 200px cap, packed to the left. When the
        // row is crowded, every tab starts from the same 200px basis, so the
        // longest titles give way first and all end up the same width (toward
        // the fit's floor). Sizing from the title instead would squeeze each
        // tab by its full title length and crush the short ones. The lead's
        // crown and "Lead" never shrink: cut, they say nothing.
        !fill || isLeadTab ? "shrink-0" : "min-w-0 max-w-max grow-0 shrink basis-50",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
      )}
      onClick={() => {
        if (target !== null && !active) onOpen(target);
        // A press on the open lead's tab says what a lead is (a phone never hovers).
        else if (active) showLeadCard?.();
      }}
      {...touchHold}
    >
      <FamilyTabFace tab={tab} />
    </button>
  );
  return isLeadTab && tab.threadRef !== null ? (
    <LeadChatCard threadRef={tab.threadRef} renderTrigger={tabButton} />
  ) : (
    tabButton(null)
  );
});

/** A tab's mark (the lead's crown, a child's status dot or check) and title. */
function FamilyTabFace({ tab }: { tab: FamilyTab }) {
  return (
    <>
      {tab.kind === "parent" ? (
        tab.lead ? (
          <CrownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : null
      ) : tab.done ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            tab.dotClass ?? "bg-muted-foreground/40",
          )}
        />
      )}
      <span className="min-w-0 truncate">{tabText(tab)}</span>
    </>
  );
}

/** "+N": the tabs that don't fit, with their status; amber while one needs the user. */
function FamilyTabOverflow({
  hidden,
  onOpen,
}: {
  hidden: readonly FamilyTab[];
  onOpen: (target: FamilyTabTarget) => void;
}) {
  // The colour of the first hidden thread that needs the user: no new colour.
  const needsYouDot = hidden.find((tab) => tab.needsYou)?.dotClass ?? null;
  return (
    <Menu>
      <MenuTrigger
        data-testid="family-tabs-overflow"
        className={cn(
          OVERFLOW_BOX_CLASS,
          "text-muted-foreground transition-colors hover:text-foreground focus-ring",
        )}
      >
        +{hidden.length}
        {needsYouDot !== null ? (
          <span
            aria-label="A thread here needs you"
            data-testid="family-tabs-overflow-attention"
            className={cn("absolute top-0.5 right-0.5 size-1.5 rounded-full", needsYouDot)}
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end">
        {hidden.map((tab) => (
          <MenuItem
            key={tab.key}
            disabled={targetOf(tab) === null}
            onClick={() => {
              const target = targetOf(tab);
              if (target !== null) onOpen(target);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {tab.done ? (
                <CheckIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[7px] shrink-0 rounded-full",
                    tab.dotClass ?? "bg-muted-foreground/40",
                  )}
                />
              )}
              <span className="min-w-0 truncate">{tab.title}</span>
              {tab.statusWord !== null ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {tab.statusWord}
                </span>
              ) : null}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
