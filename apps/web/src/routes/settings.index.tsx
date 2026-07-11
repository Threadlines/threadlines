import { ChevronRightIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import {
  HOSTED_STATIC_SETTINGS_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
} from "../components/settings/settingsNavigation";

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

  return (
    <SettingsPageContainer>
      <SettingsSection>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              replace
              className="flex items-center gap-3 border-t border-border/60 px-4 py-3.5 transition-colors first:border-t-0 hover:bg-accent/50 active:bg-accent sm:px-5"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                {item.label}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/50" />
            </Link>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});
