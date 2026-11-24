/**
 * The side panel's tabs as palette commands, for a route that owns the panel
 * (a thread or a draft). Each runs the route's own tab selector, so the URL
 * follows, and is offered only where the tab is.
 */
import type { RightPanelTab } from "../rightPanelTabs";
import { useCommandHandlers } from "./commandHandlers";

export function usePanelTabCommands(
  availableTabs: ReadonlyArray<RightPanelTab>,
  selectTab: (tab: RightPanelTab) => void,
): void {
  const tabCommand = (tab: RightPanelTab) =>
    availableTabs.includes(tab) && { run: () => selectTab(tab) };
  useCommandHandlers({
    "panel.device": tabCommand("device"),
    "panel.diff": tabCommand("diff"),
    "panel.sourceControl": tabCommand("sourceControl"),
    "panel.agents": tabCommand("agents"),
    "panel.threads": tabCommand("threads"),
  });
}
