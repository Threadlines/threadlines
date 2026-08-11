/**
 * The right sidebar's chrome: one tab strip over one content area, shared by
 * the inline sidebar and the overlay sheet and by both chat routes.
 *
 * The routes supply the mounted surfaces as children and decide which of them
 * is laid out, because they own the queries and worker pools that have to stay
 * warm behind an inactive tab. This component owns everything that is true of
 * the sidebar regardless of which surface is showing — which is also the fix
 * for a bare panel ever appearing: there is one way in, and it brings the strip
 * (or the launcher) with it.
 */
import { XIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "./ui/button";
import { RightPanelLauncher } from "./chat/RightPanelLauncher";
import { RightPanelTabStrip } from "./chat/RightPanelTabStrip";
import type { RightPanelTab } from "../rightPanelTabs";

export function ChatRightPanel(props: {
  openTabs: ReadonlyArray<RightPanelTab>;
  availableTabs: ReadonlyArray<RightPanelTab>;
  activeTab: RightPanelTab | null;
  liveTabs?: ReadonlyArray<RightPanelTab>;
  onSelectTab: (tab: RightPanelTab) => void;
  onCloseTab: (tab: RightPanelTab) => void;
  /** Present in overlay mode, where the sidebar covers the conversation. */
  onDismiss?: (() => void) | undefined;
  children: ReactNode;
}): ReactElement {
  const { activeTab, onDismiss } = props;
  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-rail"
      data-chat-right-panel="true"
    >
      <RightPanelTabStrip
        openTabs={props.openTabs}
        availableTabs={props.availableTabs}
        activeTab={activeTab}
        {...(props.liveTabs ? { liveTabs: props.liveTabs } : {})}
        onSelectTab={props.onSelectTab}
        onCloseTab={props.onCloseTab}
        {...(onDismiss
          ? {
              trailing: (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close panel"
                  onClick={onDismiss}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ),
            }
          : {})}
      />
      {activeTab === null ? (
        <RightPanelLauncher
          availableTabs={props.availableTabs}
          openTabs={props.openTabs}
          onOpenTab={props.onSelectTab}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      )}
    </div>
  );
}
