import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { memo, useCallback, useMemo, type CSSProperties } from "react";

import type {
  SubagentProgressItem,
  ThreadSubagentHistoryEntry,
  WorkLogEntry,
} from "../../session-logic";
import { cn } from "~/lib/utils";
import { selectAgentsPanelAgent, useSelectedAgentId } from "../../agentsPanelStore";
import type { Icon } from "../Icons";
import { Button } from "../ui/button";
import { LiveNode, SectionLabel } from "../ui/threadline";
import { providerIconForDriverLabel } from "./providerIconUtils";
import { SubagentInspector } from "./SubagentInspector";
import { deriveSubagentDisplayDetails, type ThreadBackgroundRunItem } from "./threadActivity";
import {
  buildAgentsPanelView,
  findAgentsPanelSubagent,
  formatAgentsHeaderMeta,
  formatAgentsPanelSummary,
  hasRunningAgentActivity,
  type AgentBranch,
  type AgentBranchStatus,
} from "./agentsPanel.logic";

const EMPTY_WORK_ENTRIES: ReadonlyArray<WorkLogEntry> = [];

export interface AgentsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagents: ReadonlyArray<SubagentProgressItem>;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** Background runs already listed above as subagents, keyed by the tool call
   *  that launched them. They are not rendered as rows; they only give the
   *  matching agent row a stop handle. */
  subagentRuns?: ReadonlyMap<string, ThreadBackgroundRunItem> | undefined;
  /** Every agent the thread has run, from its durable activity projection. Keeps
   *  the panel populated (and receipts resolvable) after the turn ends. */
  history?: ReadonlyArray<ThreadSubagentHistoryEntry> | undefined;
  /** Work attributed to spawned children. These rows are intentionally absent
   *  from the main conversation and belong in the selected child's inspector. */
  workEntries?: ReadonlyArray<WorkLogEntry> | undefined;
  /** Drives the trunk hue, the branch glyphs and the provenance chip, e.g. `codex`. */
  providerLabel?: string | null | undefined;
  /** Whether a turn is running right now. Only changes the empty state: a turn
   *  that has not reached the provider yet may still spawn agents, so the panel
   *  says it is waiting instead of saying the thread has never run one. */
  turnInFlight?: boolean;
  /** Working directory, used to resolve file references in agent prose. */
  threadCwd?: string | null | undefined;
  /** Set when the panel renders inside the sidebar's tab strip, which already
   *  carries the window chrome, the panel's name and its dismissal. */
  embedded?: boolean;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onClose?: (() => void) | undefined;
}

/** The trunk takes the provider's own hue so the panel reads as that
 *  provider's work; anything else falls back to the hairline colour. */
function trunkColor(providerLabel: string | null | undefined): string {
  const provider = providerLabel?.trim().toLowerCase();
  if (provider?.includes("claude")) {
    return "var(--provider-claude)";
  }
  if (provider?.includes("codex")) {
    return "var(--provider-codex)";
  }
  return "var(--border)";
}

const TRUNK_STYLE: CSSProperties = {
  background:
    "linear-gradient(to bottom, color-mix(in oklab, var(--agents-trunk) 38%, transparent), color-mix(in oklab, var(--agents-trunk) 10%, transparent) 72%, transparent)",
};

const ARM_STYLE: CSSProperties = {
  background: "color-mix(in oklab, var(--agents-trunk) 26%, transparent)",
};

function BranchNode({ status }: { status: AgentBranchStatus }) {
  if (status === "running") {
    return <LiveNode className="size-2" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-2 shrink-0 rounded-full",
        status === "waiting" && "bg-amber-500",
        status === "failed" && "bg-destructive",
        status === "completed" && "bg-muted-foreground/35",
      )}
    />
  );
}

/**
 * Live work branches off a trunk; finished work is filed away flat.
 *
 * `branch` draws the tree: the trunk down the panel's left, an arm out to each
 * row, content on a 20px gutter. `flat` drops all of it and uses the left
 * sidebar's row language instead -- content on the panel's 12px gutter, the time
 * on the row's own right edge -- because a settled agent is a record, and a
 * record does not need to show what it hangs off.
 */
type BranchRowVariant = "branch" | "flat";

/** A row that opens something says so at its right edge, on hover and focus
 *  only. The column is always reserved, so nothing shifts when it appears. */
function RowDisclosure({ visible }: { visible: boolean }) {
  return (
    <span className="flex w-3 shrink-0 items-center justify-end self-center">
      {visible ? (
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3 text-muted-foreground/0 transition-colors group-hover/agent-row:text-muted-foreground/45 group-focus-visible/agent-row:text-muted-foreground/45"
          data-agent-branch-disclosure="true"
        />
      ) : null}
    </span>
  );
}

function BranchRow({
  branch,
  variant,
  providerGlyph: ProviderGlyph,
  onSelect,
  onStop,
}: {
  branch: AgentBranch;
  variant: BranchRowVariant;
  /** The thread provider's mark, drawn ahead of a spawned agent's name. Runs
   *  are not the provider's own work, so they keep their text tag instead. */
  providerGlyph: Icon | null;
  onSelect: (branch: AgentBranch) => void;
  onStop: (branch: AgentBranch) => void;
}) {
  const interactive =
    branch.kind === "subagent" ? branch.transcriptAvailable : branch.terminalId !== null;
  const meta = branch.meta.join(" · ");
  const ariaLabel =
    branch.kind === "subagent"
      ? `Open ${branch.name} transcript`
      : `${branch.terminalVisible ? "Close" : "Open"} ${branch.name} terminal`;

  // An agent the provider launched as a background shell command borrows the
  // run rows' stop arm — same control, same placement, same behavior.
  const canStop = branch.kind === "run" ? branch.run.canStop : branch.stoppableRun !== null;
  const flat = variant === "flat";
  // Flat rows carry no trunk to hang a status dot off, and a filed-away agent
  // that simply finished has nothing to say with one. Anything else does.
  const showNode = !flat || branch.status !== "completed";

  const body = (
    <>
      {showNode ? (
        <span
          className={cn("flex shrink-0 items-center", flat ? "mt-1" : "mt-1.5")}
          data-agent-branch-node="true"
        >
          <BranchNode status={branch.status} />
        </span>
      ) : null}
      <span className="min-w-0">
        {/* The name owns its line. `model · effort · tokens` used to sit beside
            it on a 45% leash, which at 330px meant the panel's most answerable
            question -- which model, how hard, how long ago -- was the one thing
            always cut off. It gets the full width underneath instead, paid for
            out of the row's vertical padding rather than its height. */}
        <span className={cn("flex min-w-0 items-baseline gap-2", canStop && "pr-9")}>
          {branch.kind === "subagent" && ProviderGlyph ? (
            <span
              className="translate-y-px shrink-0 text-muted-foreground/70"
              data-agent-branch-provider="true"
            >
              <ProviderGlyph className="size-3" aria-hidden="true" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground/90">
            {branch.name}
          </span>
          {branch.tag ? (
            <span
              className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground/50"
              data-agent-branch-tag="true"
            >
              {branch.tag}
            </span>
          ) : null}
          {/* Where a left thread row puts its time: end of the title line, mono,
              right-aligned. Only a settled row has one to put there. */}
          {branch.time ? (
            <span
              className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground/45 tabular-nums"
              data-agent-branch-time="true"
            >
              {branch.time}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span
            className="block truncate font-mono text-[11px] leading-4 text-muted-foreground/55 tabular-nums"
            data-agent-branch-meta="true"
            title={meta}
          >
            {meta}
          </span>
        ) : null}
        {/* One prose line, not two. What the agent was asked to do mostly
            restated its own name, so it moved to the row's tooltip and to the
            drill-in, leaving the line for the thing that changes: the step it is
            on, or the result it came back with. */}
        {branch.output ? (
          <span
            className={cn(
              "block truncate text-[11px] leading-4",
              branch.status === "running" ? "text-primary-readable/75" : "text-muted-foreground/55",
            )}
            data-agent-branch-output="true"
            title={branch.output}
          >
            {branch.output}
          </span>
        ) : null}
      </span>
      <RowDisclosure visible={interactive} />
    </>
  );

  const rowClassName = cn(
    "group/agent-row grid w-full items-start gap-2 py-1.5 pr-3 text-left",
    showNode ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
    flat
      ? // Everything else on the panel starts here, and so does a filed row.
        "pl-3"
      : // Narrow enough that the tree costs one glyph's width, wide enough that
        // the arm still reads as an arm.
        "gap-x-2.5 pl-[calc(1.25rem+var(--branch-indent))]",
  );
  // What the agent was asked to do, kept hoverable now that it is off the row.
  const rowTitle = branch.task ?? undefined;

  return (
    <li
      className="relative"
      style={{ ["--branch-indent"]: `${branch.depth * 12}px` } as CSSProperties}
      data-agent-branch="true"
      data-agent-branch-kind={branch.kind}
      data-agent-branch-status={branch.status}
      data-agent-branch-variant={variant}
    >
      {/* Centred on the node rather than measured to it: the node sits one line
          height into the row (py-1.5 + half of the name's leading-5), so the arm
          stays level with it whichever way the arm's own thickness goes. */}
      {flat ? null : (
        <span
          aria-hidden="true"
          data-agent-branch-arm="true"
          className="pointer-events-none absolute top-4 left-2.5 h-0.5 w-[calc(0.625rem+var(--branch-indent))] -translate-y-1/2 rounded-full"
          style={ARM_STYLE}
        />
      )}
      {interactive ? (
        <button
          type="button"
          className={cn(rowClassName, "transition-colors hover:bg-foreground/[0.03] focus-ring")}
          aria-label={ariaLabel}
          title={rowTitle}
          aria-pressed={branch.kind === "run" ? branch.terminalVisible : undefined}
          onClick={() => onSelect(branch)}
        >
          {body}
        </button>
      ) : (
        <div className={rowClassName} title={rowTitle}>
          {body}
        </div>
      )}
      {canStop ? (
        <button
          type="button"
          className="absolute top-1.5 right-2 rounded-[var(--app-radius-badge)] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground/55 transition-colors hover:text-destructive focus-ring"
          aria-label={`Stop ${branch.name}`}
          data-agent-branch-stop="true"
          onClick={() => onStop(branch)}
        >
          stop
        </button>
      ) : null}
    </li>
  );
}

export const AgentsPanel = memo(function AgentsPanel({
  environmentId,
  threadId,
  subagents,
  backgroundRuns,
  subagentRuns,
  history,
  workEntries = EMPTY_WORK_ENTRIES,
  providerLabel,
  turnInFlight = false,
  threadCwd,
  embedded = false,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onClose,
}: AgentsPanelProps) {
  const selectedAgentId = useSelectedAgentId();

  const view = useMemo(
    () => buildAgentsPanelView({ subagents, backgroundRuns, subagentRuns, history, providerLabel }),
    [backgroundRuns, history, providerLabel, subagentRuns, subagents],
  );
  const headerMeta = useMemo(() => formatAgentsHeaderMeta({ subagents }), [subagents]);
  const headerSummary = useMemo(
    () => formatAgentsPanelSummary(view, providerLabel),
    [providerLabel, view],
  );
  const providerGlyph = useMemo(() => providerIconForDriverLabel(providerLabel), [providerLabel]);
  const anyRunning = hasRunningAgentActivity({ subagents });
  const selectedSubagent = findAgentsPanelSubagent(view, selectedAgentId);
  const selectedSubagentThreadId = selectedSubagent?.agentThreadId ?? null;
  const selectedSubagentWorkEntries = useMemo(
    () =>
      selectedSubagentThreadId
        ? workEntries.filter(
            (entry) =>
              entry.sourceAgentThreadId === selectedSubagentThreadId ||
              // Background tasks the agent started in its own conversation:
              // for Claude agents the owner spawn call id is the agent's
              // thread id, so they belong to the same drill-in view.
              entry.ownerAgentToolUseId === selectedSubagentThreadId,
          )
        : [],
    [selectedSubagentThreadId, workEntries],
  );

  const handleSelect = useCallback(
    (branch: AgentBranch) => {
      if (branch.kind === "run") {
        if (branch.terminalId) {
          onToggleBackgroundRunTerminal(branch.terminalId);
        }
        return;
      }
      if (branch.item.agentThreadId) {
        selectAgentsPanelAgent(branch.item.agentThreadId);
      }
    },
    [onToggleBackgroundRunTerminal],
  );

  const handleStop = useCallback(
    (branch: AgentBranch) => {
      const run = branch.kind === "run" ? branch.run : branch.stoppableRun;
      if (run) {
        onStopBackgroundRun(run);
      }
    },
    [onStopBackgroundRun],
  );

  const handleBack = useCallback(() => {
    selectAgentsPanelAgent(null);
  }, []);

  const inspector = selectedSubagent ? (
    <SubagentInspector
      environmentId={environmentId}
      threadId={threadId}
      item={selectedSubagent}
      activityEntries={selectedSubagentWorkEntries}
      details={deriveSubagentDisplayDetails(selectedSubagent)}
      cwd={threadCwd ?? undefined}
      dismissVariant="back"
      onClose={handleBack}
    />
  ) : null;

  // A drill-in takes the whole panel: the inspector's own header carries the
  // agent's name and the way back, and there is nothing in the panel header
  // worth keeping over it.
  if (inspector) {
    return (
      <div
        className={cn("flex h-full min-h-0 flex-col bg-rail", !embedded && "drag-region")}
        data-agents-panel="drill-in"
      >
        {inspector}
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-rail"
      aria-label="Agents"
      data-agents-panel="tree"
    >
      {/* Embedded, the strip above already names the panel and closes it, so all
          that is left worth a row is the turn's counts — and only when there
          are any. */}
      {embedded ? (
        headerMeta || headerSummary ? (
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3">
            {anyRunning ? <LiveNode className="size-1.5" /> : null}
            {headerSummary ? (
              <span
                className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground/70"
                data-agents-panel-summary="true"
              >
                {headerSummary}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground/55 tabular-nums">
              {headerMeta}
            </span>
          </div>
        ) : null
      ) : (
        <div className="drag-region shrink-0 border-b border-border">
          <div className="flex h-12 items-center gap-2 px-4 py-2 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
            {anyRunning ? <LiveNode className="size-1.5" /> : null}
            <h2
              aria-label="Agents"
              className="min-w-0 truncate text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
            >
              Agents <span className="text-muted-foreground/35">·</span> this turn
            </h2>
            <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground/55 tabular-nums">
              {headerMeta}
            </span>
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-mr-1 shrink-0"
                aria-label="Close panel"
                onClick={onClose}
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ ["--agents-trunk"]: trunkColor(providerLabel) } as CSSProperties}
      >
        {!view.hasAny ? (
          <p
            className="px-3 py-6 text-[12px] text-muted-foreground/55"
            data-agents-panel-empty="true"
            data-agents-panel-empty-state={turnInFlight ? "waiting" : "never-ran"}
          >
            {turnInFlight
              ? "Waiting on the turn. Agents will appear here when the model spawns them."
              : "No agents yet. Subagents and background runs on this thread will appear here."}
          </p>
        ) : (
          <div>
            {/* The trunk belongs to the live turn and stops with it: alive is
                branching, done is filed away. Where it ends is where Earlier
                begins, which is the whole point of the two row shapes. */}
            {view.current.length > 0 ? (
              <div className="relative">
                <span
                  aria-hidden="true"
                  data-agents-panel-trunk="true"
                  className="pointer-events-none absolute top-0 bottom-0 left-2.5 w-0.5 rounded-full"
                  style={TRUNK_STYLE}
                />
                {/* Faint dividers: enough to separate rows into a list, not
                    enough to box each one into a slab. */}
                <ul className="relative divide-y divide-border/40">
                  {view.current.map((branch) => (
                    <BranchRow
                      key={branch.key}
                      branch={branch}
                      variant="branch"
                      providerGlyph={providerGlyph}
                      onSelect={handleSelect}
                      onStop={handleStop}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
            {view.earlier.length > 0 ? (
              <>
                <SectionLabel className="px-3 py-1.5" tick={false} data-agents-panel-earlier="true">
                  Earlier
                </SectionLabel>
                <ul className="divide-y divide-border/40 border-t border-border/40">
                  {view.earlier.map((branch) => (
                    <BranchRow
                      key={branch.key}
                      branch={branch}
                      variant="flat"
                      providerGlyph={providerGlyph}
                      onSelect={handleSelect}
                      onStop={handleStop}
                    />
                  ))}
                </ul>
              </>
            ) : null}
            {/* Background commands are not agents; they keep their rows (and
                stop handles) below the agents instead of crowding them out. */}
            {view.commands.length > 0 ? (
              <>
                <SectionLabel
                  className="px-3 py-1.5"
                  tick={false}
                  data-agents-panel-commands="true"
                >
                  Commands
                </SectionLabel>
                <ul className="divide-y divide-border/40 border-t border-border/40">
                  {view.commands.map((branch) => (
                    <BranchRow
                      key={branch.key}
                      branch={branch}
                      variant="flat"
                      providerGlyph={providerGlyph}
                      onSelect={handleSelect}
                      onStop={handleStop}
                    />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
});
