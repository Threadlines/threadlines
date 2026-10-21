import { ArrowLeftIcon, ArrowRightIcon, PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";

import { useAppHistory } from "../../appHistory";
import { shortcutLabelForCommand } from "../../keybindings";
import { useServerKeybindings } from "../../rpc/serverState";
import { useSidebar } from "../ui/sidebar";
import { AppWordmark } from "./AppWordmark";
import { ChromeIconButton, ChromeTooltip } from "./ChromeIconButton";
import { destinationHasList } from "./destinationLists";
import { useRouteShortcutContext, useSelectedDestination } from "./NavigationRail";
import { NAVIGATION_DESTINATION_LABELS } from "./navigationRail.logic";

/**
 * The window's title row on a wide screen, part of the frame with the rail:
 * past the macOS traffic lights (or from the left edge elsewhere, with the
 * window controls at the right), the list toggle, back and forward, then the
 * app's name. Nothing in it moves when the list hides; it moves the window.
 * On a page with no list (Pull Requests, Usage) the toggle stays, disabled.
 */
export function AppTitleBar() {
  const { open, toggleSidebar, isMobile } = useSidebar();
  const keybindings = useServerKeybindings();
  const history = useAppHistory();
  const selected = useSelectedDestination();
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const shortcutOptions = { platform, context: useRouteShortcutContext() };
  if (isMobile) return null;
  const hasList = destinationHasList(selected);
  const pageLabel = NAVIGATION_DESTINATION_LABELS[selected];
  const toggleLabel = open ? "Hide sidebar" : "Show sidebar";

  return (
    <div
      data-testid="app-titlebar"
      className="drag-region flex h-(--app-titlebar-height) shrink-0 items-center gap-0.5 bg-frame ps-(--app-titlebar-leading) pe-(--workspace-native-controls-inset)"
    >
      <ChromeIconButton
        size="titlebar"
        side="bottom"
        label={hasList ? toggleLabel : "Sidebar"}
        testId="titlebar-sidebar-toggle"
        disabled={!hasList}
        tooltip={
          <ChromeTooltip
            label={hasList ? toggleLabel : "Sidebar"}
            shortcut={
              hasList
                ? shortcutLabelForCommand(keybindings, "sidebar.toggle", shortcutOptions)
                : null
            }
            detail={hasList ? null : `${pageLabel} has no list.`}
          />
        }
        onClick={toggleSidebar}
      >
        {open ? <PanelLeftCloseIcon aria-hidden="true" /> : <PanelLeftIcon aria-hidden="true" />}
      </ChromeIconButton>
      <ChromeIconButton
        size="titlebar"
        side="bottom"
        label="Back"
        testId="titlebar-back"
        disabled={!history.canGoBack}
        tooltip={
          <ChromeTooltip
            label="Back"
            shortcut={shortcutLabelForCommand(keybindings, "navigate.back", shortcutOptions)}
          />
        }
        onClick={history.back}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </ChromeIconButton>
      <ChromeIconButton
        size="titlebar"
        side="bottom"
        label="Forward"
        testId="titlebar-forward"
        disabled={!history.canGoForward}
        tooltip={
          <ChromeTooltip
            label="Forward"
            shortcut={shortcutLabelForCommand(keybindings, "navigate.forward", shortcutOptions)}
          />
        }
        onClick={history.forward}
      >
        <ArrowRightIcon aria-hidden="true" />
      </ChromeIconButton>
      <div className="ms-1.5 flex min-w-0">
        <AppWordmark />
      </div>
    </div>
  );
}
