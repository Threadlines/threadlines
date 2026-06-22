import { RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import {
  HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH,
  isHostedStaticSettingsSectionPath,
  isVisibleSettingsSectionPath,
  rememberVisibleSettingsSection,
  resolveSettingsEntryPath,
} from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarOpenTrigger, useSidebar } from "../components/ui/sidebar";
import {
  ELECTRON_HEADER_HEIGHT_CLASS,
  MAC_TRAFFIC_LIGHT_CLEARANCE_HEADER_CLASS,
  needsMacTrafficLightClearance,
} from "../desktopChrome";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

function isEditableElementTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { open: sidebarOpen } = useSidebar();
  const useMacTitlebarClearance = needsMacTrafficLightClearance(sidebarOpen);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const isHostedStatic = authGateState.status === "hosted-static";
  const showRestoreDefaults = location.pathname === "/settings/general" && !isHostedStatic;
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    rememberVisibleSettingsSection(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (isEditableElementTarget(event.target)) {
          return;
        }
        event.preventDefault();
        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-5">
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <SidebarOpenTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Settings</span>
              {isHostedStatic ? (
                <span className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Phone
                </span>
              ) : null}
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex shrink-0 items-center gap-2 border-b border-border px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              useMacTitlebarClearance
                ? MAC_TRAFFIC_LIGHT_CLEARANCE_HEADER_CLASS
                : ELECTRON_HEADER_HEIGHT_CLASS,
            )}
          >
            <SidebarOpenTrigger className="size-7 shrink-0" />
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            {showRestoreDefaults ? (
              <div className="ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        )}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    const isHostedStatic = context.authGateState.status === "hosted-static";

    if (location.pathname === "/settings") {
      throw redirect({
        to: isHostedStatic
          ? HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH
          : resolveSettingsEntryPath(),
        replace: true,
      });
    }

    if (isHostedStatic && !isHostedStaticSettingsSectionPath(location.pathname)) {
      throw redirect({ to: HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH, replace: true });
    }

    if (isVisibleSettingsSectionPath(location.pathname)) {
      rememberVisibleSettingsSection(location.pathname);
    }
  },
  component: SettingsRouteLayout,
});
