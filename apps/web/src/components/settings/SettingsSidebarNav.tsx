import { useCallback, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  FileTextIcon,
  KeyboardIcon,
  PlugIcon,
  Settings2Icon,
  SmartphoneIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { SourceControlIcon } from "../Icons";
import { SidebarVersionTag } from "../sidebar/SidebarVersionTag";
import { isHostedStaticApp } from "../../hostedPairing";
import {
  HOSTED_STATIC_SETTINGS_SECTION_PATHS,
  type SettingsSectionPath,
} from "./settingsNavigation";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Plugins", to: "/settings/plugins", icon: PlugIcon },
  { label: "Agent Instructions", to: "/settings/instructions", icon: FileTextIcon },
  { label: "Source Control", to: "/settings/source-control", icon: SourceControlIcon },
  { label: "Devices", to: "/settings/connections", icon: SmartphoneIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Archives", to: "/settings/archived", icon: ArchiveIcon },
];

export const HOSTED_STATIC_SETTINGS_NAV_ITEMS = SETTINGS_NAV_ITEMS.filter((item) =>
  (HOSTED_STATIC_SETTINGS_SECTION_PATHS as readonly string[]).includes(item.to),
);

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const navItems =
    typeof window !== "undefined" && isHostedStaticApp(new URL(window.location.href))
      ? HOSTED_STATIC_SETTINGS_NAV_ITEMS
      : SETTINGS_NAV_ITEMS;
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

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
