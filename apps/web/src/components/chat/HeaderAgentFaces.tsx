import type { ProviderDriverKind, ProviderInstanceId } from "@threadlines/contracts";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatWorkingDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentFace } from "./AgentFace";
import type { LiveAgentIndicator } from "./agentsPanel.logic";

/** Faces drawn before the rest fold into "+N"; a narrow header draws one. */
const MAX_FACES = 3;
/** Agents listed by name in the tooltip before the rest become "and N more". */
const MAX_TOOLTIP_ROWS = 6;

/** Reads the live agents out loud. Waiting leads, because it is the part that
 *  asks the user for something. */
export function formatLiveAgentsTooltip(
  liveAgents: Pick<LiveAgentIndicator, "count" | "waitingCount">,
): string {
  const { count, waitingCount } = liveAgents;
  const running = count - waitingCount;
  const noun = (value: number) => (value === 1 ? "agent" : "agents");
  if (running === 0) {
    return `${waitingCount} ${noun(waitingCount)} waiting on you.`;
  }
  if (waitingCount === 0) {
    return `${running} ${noun(running)} running.`;
  }
  return `${running} ${noun(running)} running, ${waitingCount} waiting on you.`;
}

/**
 * The header's live subagents: one small face per agent ({@link AgentFace}),
 * outlined in the accent while it works and amber while it waits on the user. Clicking opens the
 * Agents tab; hovering names them. Renders nothing worth reading on its own
 * when no agent is live, so the caller drops it then.
 */
export const HeaderAgentFaces = memo(function HeaderAgentFaces({
  liveAgents,
  providerInstanceId,
  providerDriverKind,
  onOpenAgents,
}: {
  liveAgents: LiveAgentIndicator;
  /** The thread's provider: the mark for an agent with no provider on record. */
  providerInstanceId: ProviderInstanceId | null;
  providerDriverKind: ProviderDriverKind | null;
  onOpenAgents: () => void;
}) {
  const shown = liveAgents.agents.slice(0, MAX_FACES);
  const summary = formatLiveAgentsTooltip(liveAgents);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 gap-1.5 ps-2 pe-1.5"
            onClick={onOpenAgents}
            aria-label={`${summary} Open the Agents tab.`}
            data-header-agent-faces={liveAgents.waitingCount > 0 ? "waiting" : "running"}
          />
        }
      >
        {/* A stack, first face on top. Each later face tucks 3px behind the
            one before it and has a notch masked out of it there, so the faces
            stay apart by a clear 1.5px on any background (hover included) and
            no face's outline crosses a neighbor's mark. The notch stops short
            of the 10px mark, so marks are never clipped. */}
        <span aria-hidden="true" className="flex items-center">
          {shown.map((agent, index) => (
            <AgentFace
              key={agent.id}
              status={agent.waiting ? "waiting" : "running"}
              provider={agent.provider}
              threadInstanceId={providerInstanceId}
              threadDriverKind={providerDriverKind}
              className={
                index > 0
                  ? "-ms-[3px] [mask-image:radial-gradient(circle_at_-7px_50%,transparent_11.5px,#000_12px)] @max-xl/header-actions:hidden"
                  : undefined
              }
            />
          ))}
        </span>
        {/* The overflow count follows how many faces the width draws: three
            on a wide header, one on a narrow one. */}
        {liveAgents.count > MAX_FACES ? (
          <span
            aria-hidden="true"
            className="font-mono text-[10px] leading-none text-muted-foreground @max-xl/header-actions:hidden"
          >
            +{liveAgents.count - MAX_FACES}
          </span>
        ) : null}
        {liveAgents.count > 1 ? (
          <span
            aria-hidden="true"
            className="hidden font-mono text-[10px] leading-none text-muted-foreground @max-xl/header-actions:inline"
          >
            +{liveAgents.count - 1}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80">
        <AgentFacesTooltipBody liveAgents={liveAgents} />
      </TooltipPopup>
    </Tooltip>
  );
});

/** Mounted only while the tooltip is open, so its clock runs only then, and
 *  each agent's time counts up while the user reads it. */
function AgentFacesTooltipBody({ liveAgents }: { liveAgents: LiveAgentIndicator }) {
  const nowMs = useRelativeTimeTick(1_000);
  const rows = liveAgents.agents.slice(0, MAX_TOOLTIP_ROWS);
  const hidden = liveAgents.count - rows.length;
  return (
    <div className="flex min-w-48 flex-col gap-1">
      {rows.map((agent) => (
        <div key={agent.id} className="flex items-center justify-between gap-4">
          <span className="min-w-0 truncate">{agent.name}</span>
          <span
            className={cn(
              "shrink-0",
              agent.waiting ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {agent.waiting ? "Needs you · " : null}
            {formatWorkingDurationLabel(agent.startedAt, nowMs)}
          </span>
        </div>
      ))}
      {hidden > 0 ? <div className="text-muted-foreground">and {hidden} more</div> : null}
      <div className="text-muted-foreground">Open the Agents tab.</div>
    </div>
  );
}
