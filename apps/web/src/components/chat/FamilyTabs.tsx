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
import { requestIdleThreadDetailPrewarm } from "../../environments/runtime/service";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
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

/** What "+N" takes on the row, its own width. */
const OVERFLOW_PX = 44;

/**
 * The row for `threadRef`'s family, or nothing when it has none. While it
 * shows, the header's "Lead chat" and "Started by" chips give way to it
 * (`useFamilyTabsShown`).
 */
export function FamilyTabs({ threadRef }: { threadRef: ScopedThreadRef }) {
  const family = useFamilyTabs(threadRef);
  const navigate = useNavigate();

  const open = useCallback(
    (target: ScopedThreadRef) => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
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
export function useFamilyTabs(threadRef: ScopedThreadRef): FamilyTabsModel | null {
  const openKey = scopedThreadKey(threadRef);
  const { entries, nowIso } = useInboxThreads();
  const remoteFamilyChildren = useRemoteFamilyChildren(nowIso);
  const family = useMemo(() => {
    const keys = new Set(entries.map((entry) => entry.threadKey));
    return familyTabsOf({
      openKey,
      entries,
      remoteChildrenOf: (parent) =>
        remoteFamilyChildren(parent.thread, (threadId) =>
          keys.has(scopedThreadKey({ environmentId: parent.thread.environmentId, threadId })),
        ),
      now: nowIso,
    });
  }, [entries, nowIso, openKey, remoteFamilyChildren]);
  return useKept(family, sameFamilyTabs);
}

const FamilyTabRow = memo(function FamilyTabRow({
  family,
  onOpen,
}: {
  family: FamilyTabsModel;
  onOpen: (target: ScopedThreadRef) => void;
}) {
  const isMobile = useIsMobile();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowPx, setRowPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null || isMobile) return;
    setRowPx(row.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRowPx(Math.round(entry.contentRect.width));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [isMobile]);

  // On a phone the row scrolls sideways instead, with the open tab in view.
  const openTabRef = useRef<HTMLButtonElement | null>(null);
  const openKey = family.openKey;
  useLayoutEffect(() => {
    if (isMobile && openKey !== "") {
      openTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [openKey, isMobile]);

  const { shown, hidden } =
    isMobile || rowPx === null
      ? { shown: family.tabs, hidden: [] as readonly FamilyTab[] }
      : fitFamilyTabs({
          tabs: family.tabs,
          openKey: family.openKey,
          rowPx,
          overflowPx: OVERFLOW_PX,
        });

  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label="This thread's family"
      data-testid="family-tabs"
      data-family-key={family.familyKey}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-0.5 border-b border-border px-3 py-1 sm:px-5",
        isMobile && "overflow-x-auto [scrollbar-width:none]",
      )}
    >
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
  onOpen: (target: ScopedThreadRef) => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null> | undefined;
}) {
  const threadMenu = useThreadMenu();
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
  const label =
    tab.kind === "parent" && tab.lead
      ? `Lead: ${tab.title}`
      : tab.statusWord !== null
        ? `${tab.title}, ${tab.statusWord}`
        : tab.title;
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={tab.computerLabel === null ? tab.title : `${tab.title} on ${tab.computerLabel}`}
      data-testid={`family-tab-${tab.key}`}
      data-family-tab-kind={tab.kind}
      disabled={tab.threadRef === null}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors focus-ring",
        // As wide as its title up to a cap, packed to the left like the right
        // panel's strip; tabs only shrink (toward the fit's floor) when crowded.
        fill ? "min-w-0 max-w-50 shrink" : "shrink-0",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
      )}
      onClick={() => {
        if (tab.threadRef !== null && !active) onOpen(tab.threadRef);
      }}
      {...touchHold}
    >
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
      <span className="min-w-0 truncate">
        {tab.kind === "parent" && tab.lead ? "Lead" : tab.title}
      </span>
    </button>
  );
});

/** "+N": the tabs that don't fit, with their status; amber while one needs the user. */
function FamilyTabOverflow({
  hidden,
  onOpen,
}: {
  hidden: readonly FamilyTab[];
  onOpen: (target: ScopedThreadRef) => void;
}) {
  // The colour of the first hidden thread that needs the user: no new colour.
  const needsYouDot = hidden.find((tab) => tab.needsYou)?.dotClass ?? null;
  return (
    <Menu>
      <MenuTrigger
        data-testid="family-tabs-overflow"
        className="relative flex h-6 shrink-0 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-ring"
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
            disabled={tab.threadRef === null}
            onClick={() => {
              if (tab.threadRef !== null) onOpen(tab.threadRef);
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
