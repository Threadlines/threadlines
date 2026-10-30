import { useCallback } from "react";
import { SearchIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { isHostedStaticApp } from "../../hostedPairing";
import { cn } from "../../lib/utils";
import {
  HOSTED_STATIC_SETTINGS_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  type SettingsNavItem,
  type SettingsSectionPath,
  startsSettingsNavGroup,
} from "./settingsNavigation";
import {
  SettingsPlaceSignalsProvider,
  SettingsSurfaceContext,
  type SettingsPagePlaceId,
} from "./settingsPlaceAvailability";
import { SettingsSearchField } from "./SettingsSearch";
import { useSettingsSearch } from "./settingsSearchIndex";
import { selectSettingsSearchActive, useSettingsSearchStore } from "./settingsSearchStore";

const isHostedStatic = () =>
  typeof window !== "undefined" && isHostedStaticApp(new URL(window.location.href));

/** Settings' list beside the rail: its search, then its sections, for the page on screen. */
export function SettingsDestinationList() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsSurfaceContext.Provider value={isHostedStatic() ? "phone" : "full"}>
      <SettingsPlaceSignalsProvider>
        <SettingsSidebarNav pathname={pathname} />
      </SettingsPlaceSignalsProvider>
    </SettingsSurfaceContext.Provider>
  );
}

const MENU_ITEM_CLASS = "gap-2.5 px-2.5 py-2 text-left text-[13px]";

function MenuItem({
  item,
  index,
  items,
  active,
  hit,
  count,
  onClick,
}: {
  readonly item: SettingsNavItem;
  readonly index: number;
  readonly items: ReadonlyArray<SettingsNavItem>;
  readonly active: boolean;
  /** While searching: the page has matches, so it reads in full color with its count. */
  readonly hit: boolean;
  readonly count: number | null;
  readonly onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem
      className={
        startsSettingsNavGroup(items, index)
          ? "mt-2 border-t border-sidebar-border pt-2"
          : undefined
      }
    >
      <SidebarMenuButton
        size="sm"
        isActive={active}
        className={cn(
          MENU_ITEM_CLASS,
          active
            ? "font-medium text-foreground"
            : hit
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
        )}
        onClick={onClick}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            active
              ? "text-primary-readable"
              : hit
                ? "text-muted-foreground"
                : "text-muted-foreground/60",
          )}
        />
        <span className="truncate">{item.label}</span>
        {count !== null ? (
          <span className="ms-auto font-mono text-[10.5px] font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Desktop-only settings section rail. Mobile viewports never render this:
 * there the sidebar sheet keeps showing threads and `/settings` renders a
 * full-page section index (with its own search field) instead.
 *
 * While a search holds a query the sections stay where they are: those with
 * matches read in full color with their count and narrow the results to
 * themselves; the rest stay muted and leave the search for their page.
 */
export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const navItems = isHostedStatic() ? HOSTED_STATIC_SETTINGS_NAV_ITEMS : SETTINGS_NAV_ITEMS;
  const searching = useSettingsSearchStore(selectSettingsSearchActive);
  const query = useSettingsSearchStore((state) => state.query);
  const scope = useSettingsSearchStore((state) => state.scope);
  const setScope = useSettingsSearchStore((state) => state.setScope);
  const clear = useSettingsSearchStore((state) => state.clear);
  const search = useSettingsSearch(query);

  const openSection = useCallback(
    (to: SettingsSectionPath) => {
      clear();
      void navigate({ to, replace: true });
    },
    [clear, navigate],
  );

  const handleClick = (item: SettingsNavItem, page: SettingsPagePlaceId) => {
    if (!searching) {
      void navigate({ to: item.to, replace: true });
      return;
    }
    if ((search.countByPage.get(page) ?? 0) > 0) setScope(scope === page ? null : page);
    else openSection(item.to);
  };

  return (
    <SidebarContent className="overflow-x-hidden">
      {/* Where the thread list keeps its search bar, so it doesn't move between pages. */}
      <SidebarGroup className="shrink-0 px-3 pt-3 pb-1">
        <SettingsSearchField />
      </SidebarGroup>
      <SidebarGroup className="px-2 pt-1 pb-3">
        <SidebarMenu>
          {searching ? (
            <SidebarMenuItem className="mb-2 border-b border-sidebar-border pb-2">
              <SidebarMenuButton
                size="sm"
                isActive={scope === null}
                className={cn(
                  MENU_ITEM_CLASS,
                  scope === null
                    ? "font-medium text-foreground"
                    : "text-foreground hover:text-foreground",
                )}
                onClick={() => setScope(null)}
              >
                <SearchIcon
                  className={cn(
                    "size-4 shrink-0",
                    scope === null ? "text-primary-readable" : "text-muted-foreground",
                  )}
                />
                <span className="truncate">All results</span>
                <span className="ms-auto font-mono text-[10.5px] font-normal text-muted-foreground tabular-nums">
                  {search.results.length}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {navItems.map((item, index) => {
            const page = item.place;
            const count = searching ? (search.countByPage.get(page) ?? 0) : 0;
            return (
              <MenuItem
                key={item.to}
                item={item}
                index={index}
                items={navItems}
                active={searching ? scope === page : pathname === item.to}
                hit={searching && count > 0}
                count={searching && count > 0 ? count : null}
                onClick={() => handleClick(item, page)}
              />
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
