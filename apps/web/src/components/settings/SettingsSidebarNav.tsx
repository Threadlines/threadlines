import { useCallback } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "../ui/sidebar";
import { SidebarVersionTag } from "../sidebar/SidebarVersionTag";
import { isHostedStaticApp } from "../../hostedPairing";
import {
  HOSTED_STATIC_SETTINGS_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  type SettingsSectionPath,
} from "./settingsNavigation";

/**
 * Desktop-only settings section rail. Mobile viewports never render this:
 * there the sidebar sheet keeps showing threads and `/settings` renders a
 * full-page section index instead.
 */
export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navItems =
    typeof window !== "undefined" && isHostedStaticApp(new URL(window.location.href))
      ? HOSTED_STATIC_SETTINGS_NAV_ITEMS
      : SETTINGS_NAV_ITEMS;
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      void navigate({ to, replace: true });
    },
    [navigate],
  );
  const handleBackClick = useCallback(() => {
    if (canGoBack) {
      // Through the router's history (not window.history) so hash and memory
      // histories stay within the app document.
      router.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate, router]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => handleSectionClick(item.to)}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-primary-readable"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1.5">
            <SidebarMenuButton
              size="sm"
              className="flex-1 gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
            <SidebarVersionTag />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
