import type { ProviderDriverKind, ProviderInstanceId } from "@threadlines/contracts";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";
import { formatWorkingDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LiveAgentIndicator, SubagentProviderRef } from "./agentsPanel.logic";
import { ProviderGlyph } from "./ProviderInstanceIcon";

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
 * The header's live subagents: one small face per agent, outlined in the
 * accent while it works and amber while it waits on the user. Clicking opens the
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
        {/* A stack, first face on top. Each later face tucks 4px behind the
            one before it and has a notch masked out of it there, so the faces
            stay apart by a clear 1.5px on any background (hover included) and
            no face's outline crosses a neighbor's mark. The notch stops where
            the 9px mark begins, so marks are never clipped. */}
        <span aria-hidden="true" className="flex items-center">
          {shown.map((agent, index) => (
            <span
              key={agent.id}
              data-agent-face={agent.waiting ? "waiting" : "running"}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-muted",
                agent.waiting ? "border-amber-500" : "border-primary-graph",
                index > 0 &&
                  "-ms-1 [mask-image:radial-gradient(circle_at_-6px_50%,transparent_11.5px,#000_12px)] @max-xl/header-actions:hidden",
              )}
            >
              <AgentFaceGlyph
                agentProvider={agent.provider}
                threadInstanceId={providerInstanceId}
                threadDriverKind={providerDriverKind}
              />
            </span>
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

/**
 * One face's mark: the provider recorded as running the agent, drawn through
 * its instance when one is known so an instance with an icon of its own (a
 * community agent, a second account) keeps it. An agent with nothing recorded
 * carries the thread's mark. Any provider with a mark shows it; one without
 * shows the generic glyph.
 */
function AgentFaceGlyph({
  agentProvider,
  threadInstanceId,
  threadDriverKind,
}: {
  agentProvider: SubagentProviderRef | null;
  threadInstanceId: ProviderInstanceId | null;
  threadDriverKind: ProviderDriverKind | null;
}) {
  return (
    <ProviderGlyph
      instanceId={agentProvider === null ? threadInstanceId : agentProvider.instanceId}
      driverKind={agentProvider === null ? threadDriverKind : agentProvider.driverKind}
      className="size-[9px]"
    />
  );
}

/** Mounted only while the tooltip is open, so each agent's time is read then
 *  rather than whenever the header last rendered. */
function AgentFacesTooltipBody({ liveAgents }: { liveAgents: LiveAgentIndicator }) {
  const [nowMs] = useState(() => Date.now());
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
