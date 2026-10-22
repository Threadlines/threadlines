import {
  CloudIcon,
  FolderIcon,
  ListIcon,
  MessageSquareIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
} from "lucide-react";
import React, { memo } from "react";
import type { EnvironmentId, SidebarGrouping } from "@threadlines/contracts";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One computer the inbox can be narrowed to. */
export interface EnvironmentScopeOption {
  environmentId: EnvironmentId;
  label: string;
  isPrimary: boolean;
}

/** The radio value for every computer: no environment id is empty. */
const ALL_COMPUTERS = "";

const OPTION_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground/70";

/**
 * What the button says while it hides part of the list, or null while it shows
 * everything. Grouping is not a filter: it hides nothing, and the list's own
 * headers already show it.
 */
export function describeInboxViewFilters(input: {
  readonly scopedEnvironment: EnvironmentScopeOption | null;
  readonly roomsOnly: boolean;
}): string | null {
  const parts = [
    ...(input.scopedEnvironment ? [input.scopedEnvironment.label] : []),
    ...(input.roomsOnly ? ["rooms only"] : []),
  ];
  return parts.length === 0 ? null : `Showing ${parts.join(", ")}`;
}

export interface InboxViewMenuProps {
  /** Empty or single-entry while only one computer is known: no Computer section. */
  environmentOptions: readonly EnvironmentScopeOption[];
  scopedEnvironmentId: string | null;
  onEnvironmentScopeChange: (environmentId: string | null) => void;
  /** Whether the list shows only rooms. Null while Rooms is off: no Show section. */
  roomsOnly: boolean | null;
  onRoomsOnlyChange: (roomsOnly: boolean) => void;
  grouping: SidebarGrouping;
  onGroupingChange: (grouping: SidebarGrouping) => void;
}

/**
 * How the thread list is shown, beside the project picker: which computer,
 * which kind of thread, and how rows are grouped.
 *
 * These are set once and left, unlike the projects you switch between all day,
 * so they sit behind their own small button instead of lengthening the project
 * menu. While one of them hides part of the list the button carries a small
 * dot, so a narrowed list never looks like a short one. The dot is the
 * foreground color, not blue: blue dots on the rows below mean an agent is
 * working.
 */
export const InboxViewMenu = memo(function InboxViewMenu(props: InboxViewMenuProps) {
  const {
    environmentOptions,
    scopedEnvironmentId,
    onEnvironmentScopeChange,
    roomsOnly,
    onRoomsOnlyChange,
    grouping,
    onGroupingChange,
  } = props;
  // One computer is not a choice: its section only appears once there is
  // somewhere else the work could be.
  const showComputers = environmentOptions.length > 1;
  const scopedEnvironment =
    showComputers && scopedEnvironmentId !== null
      ? (environmentOptions.find((option) => option.environmentId === scopedEnvironmentId) ?? null)
      : null;
  const activeFilters = describeInboxViewFilters({
    scopedEnvironment,
    roomsOnly: roomsOnly === true,
  });

  const sections: { readonly key: string; readonly node: React.ReactNode }[] = [];
  if (showComputers) {
    sections.push({
      key: "computer",
      node: (
        <MenuGroup>
          <MenuGroupLabel>Computer</MenuGroupLabel>
          <MenuRadioGroup
            value={scopedEnvironment?.environmentId ?? ALL_COMPUTERS}
            onValueChange={(value) => {
              onEnvironmentScopeChange(value === ALL_COMPUTERS ? null : String(value));
            }}
          >
            <MenuRadioItem value={ALL_COMPUTERS} data-testid="inbox-machine-scope-all">
              <MonitorSmartphoneIcon className={OPTION_ICON_CLASS_NAME} />
              <span className="min-w-0 flex-1 truncate">All computers</span>
            </MenuRadioItem>
            {environmentOptions.map((option) => (
              <MenuRadioItem
                key={option.environmentId}
                value={option.environmentId}
                data-testid={`inbox-machine-scope-${option.environmentId}`}
              >
                {option.isPrimary ? (
                  <MonitorIcon className={OPTION_ICON_CLASS_NAME} />
                ) : (
                  <CloudIcon className={OPTION_ICON_CLASS_NAME} />
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }
  if (roomsOnly !== null) {
    sections.push({
      key: "show",
      node: (
        <MenuGroup>
          <MenuGroupLabel>Show</MenuGroupLabel>
          <MenuRadioGroup
            value={roomsOnly ? "rooms" : "all"}
            onValueChange={(value) => {
              onRoomsOnlyChange(value === "rooms");
            }}
          >
            <MenuRadioItem value="all" data-testid="inbox-rooms-filter-all">
              <MessageSquareIcon className={OPTION_ICON_CLASS_NAME} />
              <span className="min-w-0 flex-1 truncate">All threads</span>
            </MenuRadioItem>
            <MenuRadioItem value="rooms" data-testid="inbox-rooms-filter-only">
              <UsersRoundIcon className={OPTION_ICON_CLASS_NAME} />
              <span className="min-w-0 flex-1 truncate">Rooms only</span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }
  sections.push({
    key: "group",
    node: (
      <MenuGroup>
        <MenuGroupLabel>Group</MenuGroupLabel>
        <MenuRadioGroup
          value={grouping}
          onValueChange={(value) => {
            if (value === "none" || value === "project" || value === "computer") {
              onGroupingChange(value);
            }
          }}
        >
          <MenuRadioItem value="none" data-testid="inbox-grouping-none">
            <ListIcon className={OPTION_ICON_CLASS_NAME} />
            <span className="min-w-0 flex-1 truncate">Don&apos;t group</span>
          </MenuRadioItem>
          <MenuRadioItem value="project" data-testid="inbox-grouping-project">
            <FolderIcon className={OPTION_ICON_CLASS_NAME} />
            <span className="min-w-0 flex-1 truncate">By project</span>
          </MenuRadioItem>
          {showComputers ? (
            <MenuRadioItem value="computer" data-testid="inbox-grouping-computer">
              <MonitorSmartphoneIcon className={OPTION_ICON_CLASS_NAME} />
              <span className="min-w-0 flex-1 truncate">By computer</span>
            </MenuRadioItem>
          ) : null}
        </MenuRadioGroup>
      </MenuGroup>
    ),
  });

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={activeFilters ? `View options: ${activeFilters}` : "View options"}
                  data-testid="inbox-view-trigger"
                  data-filtered={activeFilters ? "true" : undefined}
                  className="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-ring"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon className="size-3.5" />
          {activeFilters ? (
            <span
              aria-hidden
              data-testid="inbox-view-filter-dot"
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{activeFilters ?? "View options"}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        {sections.map((section, index) => (
          <React.Fragment key={section.key}>
            {index > 0 ? <MenuSeparator /> : null}
            {section.node}
          </React.Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
});
