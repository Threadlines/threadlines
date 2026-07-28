import { FolderIcon, MessagesSquareIcon, ServerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { ProjectHoverSummary } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  HOVER_CARD_POPUP_CLASS_NAME,
  HoverCardDetailRow,
  HoverCardDetails,
  HoverCardStatusLine,
  HoverCardTitle,
} from "./hoverCard";

/**
 * What a project row leaves out.
 *
 * A row shows a name and a count; the rail shows only a favicon. Neither says
 * where the project lives on disk, how much of it is moving right now, or when
 * it last did anything, which is what you actually want before opening it.
 */
export function ProjectHoverCard({
  project,
  side = "right",
  children,
}: {
  project: ProjectHoverSummary;
  side?: "right" | "left" | "top" | "bottom";
  children: ReactNode;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = primaryEnvironmentId !== null && project.environmentId !== primaryEnvironmentId;
  const runtimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[project.environmentId]?.descriptor?.label ?? null,
  );
  const savedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[project.environmentId]?.label ?? null,
  );
  const environmentLabel = isRemote ? (runtimeLabel ?? savedLabel ?? "Remote") : null;

  const threadsLabel = project.threadCount === 1 ? "1 thread" : `${project.threadCount} threads`;
  const countsLabel =
    project.activeCount > 0 ? `${threadsLabel} · ${project.activeCount} active` : threadsLabel;

  return (
    <Tooltip>
      <TooltipTrigger render={children as never} />
      <TooltipPopup
        side={side}
        sideOffset={8}
        align="start"
        className={HOVER_CARD_POPUP_CLASS_NAME}
        data-testid="project-hover-card"
      >
        <HoverCardTitle>{project.name}</HoverCardTitle>
        <HoverCardStatusLine
          status={project.status}
          idleLabel={project.threadCount === 0 ? "No threads yet" : "Idle"}
          timestamp={
            project.lastActivityAt ? formatRelativeTimeLabel(project.lastActivityAt) : null
          }
        />
        <HoverCardDetails>
          <HoverCardDetailRow icon={<MessagesSquareIcon className="size-3.5" />}>
            {countsLabel}
          </HoverCardDetailRow>
          {environmentLabel ? (
            <HoverCardDetailRow icon={<ServerIcon className="size-3.5" />}>
              {environmentLabel}
            </HoverCardDetailRow>
          ) : null}
          {/* Paths truncate at the wrong end by default: the leaf directory is
              the identifying part, so keep the tail visible. */}
          <HoverCardDetailRow
            icon={<FolderIcon className="size-3.5" />}
            className="truncate text-left [direction:rtl]"
          >
            <span className="[direction:ltr] [unicode-bidi:plaintext]">{project.cwd}</span>
          </HoverCardDetailRow>
        </HoverCardDetails>
      </TooltipPopup>
    </Tooltip>
  );
}

export type { ProjectHoverSummary };
