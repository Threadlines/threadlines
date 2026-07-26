import { MessageCirclePlusIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export interface SidebarDestination {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled?: boolean;
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
    <SidebarGroup className="px-2 pt-2 pb-1" data-testid="sidebar-destination-band">
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
                  "gap-2 px-2 py-1.5 text-muted-foreground/80 hover:bg-accent hover:text-foreground",
                  destination.active && "text-foreground",
                )}
                onClick={destination.onSelect}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate text-xs">{destination.label}</span>
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
