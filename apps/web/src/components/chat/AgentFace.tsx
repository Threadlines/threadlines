import type { ProviderInstanceId } from "@threadlines/contracts";
import { memo } from "react";

import { cn } from "../../lib/utils";
import type { AgentBranchStatus, SubagentProviderRef } from "./agentsPanel.logic";
import { AgentProviderGlyph } from "./ProviderInstanceIcon";

/** The ring says how the agent stands: the accent while it works, amber while
 *  it waits on the user, then how its run ended. */
const FACE_RING_CLASS: Record<AgentBranchStatus, string> = {
  running: "border-primary-graph",
  waiting: "border-amber-500",
  completed: "border-success",
  failed: "border-destructive",
  stopped: "border-muted-foreground/50",
};

/**
 * The circle and the mark in it, per size. Both are even, so the mark sits a
 * whole number of pixels from every edge (5 and 6). An odd mark in an even
 * circle lands on a half pixel, which a standard-density screen can only draw
 * blurred and a shade off center.
 */
const FACE_SIZE_CLASS = {
  sm: { face: "size-5", mark: "size-2.5" },
  md: { face: "size-6", mark: "size-3" },
} as const;

/**
 * A spawned agent's face: its provider's mark in a small ring colored by its
 * state. The header draws one per live agent (`sm`) and the conversation draws
 * one on each finished agent's receipt (`md`), so an agent keeps one look from
 * start to landing.
 */
export const AgentFace = memo(function AgentFace({
  status,
  provider,
  threadInstanceId,
  threadDriverKind,
  size = "sm",
  className,
}: {
  status: AgentBranchStatus;
  size?: keyof typeof FACE_SIZE_CLASS;
  /** From `resolveSubagentProvider`; null leaves the thread's own mark. */
  provider: SubagentProviderRef | null;
  threadInstanceId: ProviderInstanceId | null | undefined;
  threadDriverKind: string | null | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      data-agent-face={status}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px] bg-muted",
        FACE_SIZE_CLASS[size].face,
        FACE_RING_CLASS[status],
        className,
      )}
    >
      <AgentProviderGlyph
        agentProvider={provider}
        threadInstanceId={threadInstanceId}
        threadDriverKind={threadDriverKind}
        className={FACE_SIZE_CLASS[size].mark}
      />
    </span>
  );
});
