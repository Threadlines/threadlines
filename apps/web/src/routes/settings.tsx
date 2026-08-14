import { ArrowLeftIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import {
  isVisibleSettingsSectionPath,
  rememberVisibleSettingsSection,
  resolveSettingsEntryRedirect,
  settingsSectionLabelForPath,
} from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { DesktopPageTitlebar } from "../components/DesktopPageTitlebar";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { useNavigateBackWithinApp } from "../hooks/useNavigateBackWithinApp";

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
  const navigateBackWithinApp = useNavigateBackWithinApp();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const isHostedStatic = authGateState.status === "hosted-static";
  const showRestoreDefaults = location.pathname === "/settings/general" && !isHostedStatic;
  const isSettingsIndex = location.pathname === "/settings" || location.pathname === "/settings/";
  // On mobile the header titles the current section and offers ← back to the
  // full-page section index; desktop always titles the page "Settings" (the
  // sidebar rail shows the section).
  const mobileHeaderTitle = isSettingsIndex
    ? "Settings"
    : (settingsSectionLabelForPath(location.pathname) ?? "Settings");
  const handleRestored = () => setRestoreSignal((value) => value + 1);
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
          <header
            className={cn(
              "border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              {!isSettingsIndex ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="All settings"
                  className="shrink-0 text-muted-foreground hover:text-foreground md:hidden"
                  onClick={() => void navigate({ to: "/settings", replace: true })}
                >
                  <ArrowLeftIcon />
                </Button>
              ) : null}
              <span className="text-sm font-medium text-foreground">
                <span className="md:hidden">{mobileHeaderTitle}</span>
                <span className="hidden md:inline">Settings</span>
              </span>
              {isHostedStatic ? (
                <span className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Phone
                </span>
              ) : null}
              <div className="ms-auto flex items-center gap-2">
                {showRestoreDefaults ? <RestoreDefaultsButton onRestored={handleRestored} /> : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close settings"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={navigateBackWithinApp}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          </header>
        )}

        <DesktopPageTitlebar label="Settings">
          {showRestoreDefaults ? (
            <div className="ms-auto flex items-center gap-2">
              <RestoreDefaultsButton onRestored={handleRestored} />
            </div>
          ) : null}
        </DesktopPageTitlebar>

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

    // Matches useIsMobile()'s max-md breakpoint. Checked here (outside React)
    // because the redirect decision has to land before the route renders.
    const isMobileViewport =
      typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const redirectTo = resolveSettingsEntryRedirect({
      pathname: location.pathname,
      isHostedStatic,
      isMobileViewport,
    });
    if (redirectTo !== null) {
      throw redirect({ to: redirectTo, replace: true });
    }

    if (isVisibleSettingsSectionPath(location.pathname)) {
      rememberVisibleSettingsSection(location.pathname);
    }
  },
  component: SettingsRouteLayout,
});
