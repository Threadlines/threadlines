import { ArrowLeftIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsSearchResults } from "../components/settings/SettingsSearch";
import {
  SETTINGS_SEARCH_FIELD_ATTRIBUTE,
  useSettingsSearchActive,
} from "../components/settings/SettingsSearchField";
import {
  SettingsPlaceSignalsProvider,
  SettingsSurfaceContext,
} from "../components/settings/settingsPlaceAvailability";
import { useSettingsSearchStore } from "../components/settings/settingsSearchStore";
import {
  isVisibleSettingsSectionPath,
  rememberVisibleSettingsSection,
  resolveSettingsEntryRedirect,
  settingsSectionLabelForPath,
} from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { PageTitlebar } from "../components/PageTitlebar";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useNavigateBackWithinApp } from "../hooks/useNavigateBackWithinApp";
import { usePlaceArrival } from "../hooks/usePlaceArrival";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";

function isEditableElementTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** The settings search field, which Escape treats as part of the page once it is empty. */
const isSettingsSearchField = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.hasAttribute(SETTINGS_SEARCH_FIELD_ATTRIBUTE);

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
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
  // One restore for every setting on these two pages (and Source Control's
  // writing settings, which it has always covered).
  const showRestoreDefaults =
    (location.pathname === "/settings/general" || location.pathname === "/settings/threads") &&
    !isHostedStatic;
  const isSettingsIndex = location.pathname === "/settings" || location.pathname === "/settings/";
  // On mobile the header titles the current section and offers ← back to the
  // full-page section index; desktop always titles the page "Settings" (the
  // sidebar rail shows the section).
  const mobileHeaderTitle = isSettingsIndex
    ? "Settings"
    : (settingsSectionLabelForPath(location.pathname) ?? "Settings");
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const isMobile = useIsMobile();
  const { open: listOpen, setOpen: setListOpen } = useSidebar();
  const keybindings = useServerKeybindings();
  // Where the settings menu shows, its field drives results here; on a phone
  // or a narrow window the section index owns both (settings.index.tsx).
  const searching = useSettingsSearchActive() && !isMobile;
  usePlaceArrival();
  useEffect(() => {
    rememberVisibleSettingsSection(location.pathname);
  }, [location.pathname]);
  // A search doesn't outlive Settings: opened again, it starts clean.
  useEffect(() => () => useSettingsSearchStore.getState().clear(), []);
  // Nor its page: any way to another one (a link inside a result, a place
  // link) ends it, so the results never cover where the user went.
  const searchedOnPath = useRef(location.pathname);
  useEffect(() => {
    if (searchedOnPath.current === location.pathname) return;
    searchedOnPath.current = location.pathname;
    useSettingsSearchStore.getState().clear();
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // An open menu or dialog takes its Escape first.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        const search = useSettingsSearchStore.getState();
        if (search.query.trim().length > 0) {
          event.preventDefault();
          search.clear();
          return;
        }
        if (isEditableElementTarget(event.target) && !isSettingsSearchField(event.target)) {
          return;
        }
        event.preventDefault();
        navigateBackWithinApp();
        return;
      }
      // No chat is open here, so its find key searches Settings instead.
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), terminalOpen: false },
      });
      if (command !== "chat.find") return;
      event.preventDefault();
      if (isMobile) {
        if (!isSettingsIndex) void navigate({ to: "/settings", replace: true });
      } else if (!listOpen) {
        setListOpen(true);
      }
      useSettingsSearchStore.getState().requestFocus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    isMobile,
    isSettingsIndex,
    keybindings,
    listOpen,
    navigate,
    navigateBackWithinApp,
    setListOpen,
  ]);

  return (
    <SettingsSurfaceContext.Provider value={isHostedStatic ? "phone" : "full"}>
      <SettingsPlaceSignalsProvider>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate md:h-auto">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
            {!isElectron && (
              <header
                className={cn(
                  "border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 md:hidden",
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
                    {showRestoreDefaults && !searching ? (
                      <RestoreDefaultsButton onRestored={handleRestored} />
                    ) : null}
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

            <PageTitlebar label="Settings" mobile="none">
              {showRestoreDefaults && !searching ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </PageTitlebar>

            <div key={restoreSignal} className="relative min-h-0 flex flex-1 flex-col">
              {searching ? <SettingsSearchResults /> : null}
              {/* Kept mounted under the results, so a half-done page (a sign-in, a
              typed field) and its scroll are there when the search clears. */}
              <div
                className={cn(
                  "min-h-0 flex flex-1 flex-col",
                  searching && "invisible absolute inset-0 overflow-hidden",
                )}
                inert={searching}
              >
                <Outlet />
              </div>
            </div>
          </div>
        </SidebarInset>
      </SettingsPlaceSignalsProvider>
    </SettingsSurfaceContext.Provider>
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
