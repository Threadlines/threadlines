import { MessageCirclePlusIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export interface SidebarDestination {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled?: boolean;
  /**
   * Activity behind the destination. Chats no longer appear on the deck, so
   * without this a running chat would have no ambient signal anywhere. The
   * destination carries its own status rather than earning a second row.
   */
  status?: ThreadStatusPill | null;
  onSelect: () => void;
}

/**
 * Fixed places in the app, pinned above the deck.
 *
 * On Deck changes height as threads come and go, so anything below it moves;
 * navigation has to sit above it to stay in the same pixel every time. These
 * rows are deliberately plain — one line, no counts, no disclosure — so they
 * read as chrome and never compete with the live work underneath.
 */
export function DestinationBand({ destinations }: { destinations: readonly SidebarDestination[] }) {
  if (destinations.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="px-2 pt-1.5 pb-2" data-testid="sidebar-destination-band">
      <SidebarMenu>
        {destinations.map((destination) => {
          const Icon = destination.icon;
          return (
            <SidebarMenuItem key={destination.id}>
              <SidebarMenuButton
                size="sm"
                isActive={destination.active}
                disabled={destination.disabled ?? false}
                data-testid={`sidebar-destination-${destination.id}`}
                className={cn(
                  "gap-1.5 px-2 py-1.5 text-muted-foreground/80 hover:bg-accent hover:text-foreground",
                  destination.active && "text-foreground",
                )}
                onClick={destination.onSelect}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs">{destination.label}</span>
                {destination.status ? (
                  <ThreadStatusDot
                    status={destination.status}
                    className="ms-auto shrink-0 size-1.5"
                  />
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export const DESTINATION_ICONS = {
  newChat: MessageCirclePlusIcon,
  chats: MessagesSquareIcon,
} as const;
