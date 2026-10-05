import { ChevronRightIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";

import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingsGroup,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";
import {
  HOSTED_STATIC_SETTINGS_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  type SettingsNavItem,
  startsSettingsNavGroup,
} from "../components/settings/settingsNavigation";
import { cn } from "../lib/utils";

/**
 * Full-page settings section index. Only reachable on mobile viewports —
 * the settings layout's `beforeLoad` redirects `/settings` to a section on
 * desktop, where the persistent sidebar rail handles section navigation.
 * Intra-settings navigation replaces history so closing settings always
 * returns to wherever the user was before entering.
 */
function SettingsIndexRoute() {
  const { authGateState } = Route.useRouteContext();
  const navItems =
    authGateState.status === "hosted-static"
      ? HOSTED_STATIC_SETTINGS_NAV_ITEMS
      : SETTINGS_NAV_ITEMS;

  // One group per cluster of the menu (you and your threads, what agents can
  // use, this computer's tools), the way the desktop rail draws lines.
  const clusters: SettingsNavItem[][] = [];
  navItems.forEach((item, index) => {
    if (index === 0 || startsSettingsNavGroup(navItems, index)) clusters.push([]);
    clusters.at(-1)?.push(item);
  });

  return (
    <SettingsPageContainer>
      {clusters.map((cluster) => (
        <SettingsGroup key={cluster[0]?.to}>
          {cluster.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                replace
                className={cn(
                  SETTINGS_GROUP_ROW_CLASS,
                  "flex items-center gap-3 px-3.5 py-3 transition-colors first:rounded-t-[inherit] last:rounded-b-[inherit] hover:bg-foreground/[0.03] active:bg-foreground/[0.06]",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
                  {item.label}
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </SettingsGroup>
      ))}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});
