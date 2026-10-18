import {
  type OrchestrationThreadGoal,
  ProviderDriverKind,
  type ThreadGoalStatus,
} from "@threadlines/contracts";
import { CheckIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export interface ComposerGoalSetInput {
  readonly objective?: string;
  readonly status?: ThreadGoalStatus;
  readonly tokenBudget?: number | null;
}

/** What a provider's goals offer, which decides the bar's controls. */
export interface ThreadGoalControls {
  /** Pause and resume. */
  readonly pause: boolean;
  /** A token budget the goal stops at. */
  readonly tokenBudget: boolean;
  /** What the bar counts: tokens spent (Codex) or checks run (Claude). */
  readonly progress: "tokens" | "checks";
}

const CODEX_GOAL_CONTROLS: ThreadGoalControls = {
  pause: true,
  tokenBudget: true,
  progress: "tokens",
};
const CLAUDE_GOAL_CONTROLS: ThreadGoalControls = {
  pause: false,
  tokenBudget: false,
  progress: "checks",
};

/** The goal controls of the agent a goal goes to; null when it has no goals. */
export function threadGoalControls(
  driverKind: ProviderDriverKind | null | undefined,
): ThreadGoalControls | null {
  switch (driverKind) {
    case ProviderDriverKind.make("codex"):
      return CODEX_GOAL_CONTROLS;
    case ProviderDriverKind.make("claudeAgent"):
      return CLAUDE_GOAL_CONTROLS;
    default:
      return null;
  }
}

export function formatGoalChecks(checks: number): string {
  return `${checks} ${checks === 1 ? "check" : "checks"}`;
}

interface ComposerGoalBarProps {
  readonly goal: OrchestrationThreadGoal | null;
  readonly controls: ThreadGoalControls;
  readonly editorOpen: boolean;
  readonly isDispatching: boolean;
  readonly onOpenEditor: () => void;
  readonly onCloseEditor: () => void;
  readonly onSetGoal: (input: ComposerGoalSetInput) => void;
  readonly onClearGoal: () => void;
}

const STATUS_PRESENTATION: Record<
  ThreadGoalStatus,
  { readonly label: string; readonly dotClassName: string }
> = {
  active: { label: "Active", dotClassName: "bg-emerald-500" },
  paused: { label: "Paused", dotClassName: "bg-amber-500" },
  blocked: { label: "Blocked", dotClassName: "bg-red-500" },
  usageLimited: { label: "Usage limited", dotClassName: "bg-amber-500" },
  budgetLimited: { label: "Budget limited", dotClassName: "bg-amber-500" },
  complete: { label: "Complete", dotClassName: "bg-sky-500" },
};

export function formatGoalTokensCompact(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }
  return String(value);
}

export function formatGoalElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${Math.max(0, Math.floor(totalSeconds))}s`;
}

function parseTokenBudgetDraft(draft: string): number | null | undefined {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed.replaceAll(/[_,\s]/gu, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

/**
 * Compact goal strip above the composer input (Codex and Claude goal mode).
 * One line while collapsed: status dot, objective, progress (tokens used
 * against budget for Codex, checks run for Claude), and elapsed time, with
 * the clear control and, where the provider has it, pause/resume. Expands
 * into a small prefilled editor; `/goal` opens the same editor.
 */
export function ComposerGoalBar({
  goal,
  controls,
  editorOpen,
  isDispatching,
  onOpenEditor,
  onCloseEditor,
  onSetGoal,
  onClearGoal,
}: ComposerGoalBarProps) {
  if (editorOpen) {
    return (
      <ComposerGoalEditor
        goal={goal}
        controls={controls}
        isDispatching={isDispatching}
        onClose={onCloseEditor}
        onSetGoal={onSetGoal}
      />
    );
  }
  if (!goal) {
    return null;
  }

  const presentation = STATUS_PRESENTATION[goal.status];
  const pauseResumeAction = !controls.pause
    ? null
    : goal.status === "active"
      ? ({ label: "Pause goal", nextStatus: "paused", icon: PauseIcon } as const)
      : goal.status === "paused" || goal.status === "blocked" || goal.status === "usageLimited"
        ? ({ label: "Resume goal", nextStatus: "active", icon: PlayIcon } as const)
        : null;
  // Claude's evaluator says why the goal is not met yet, or why it is done.
  const title = [`${presentation.label} goal: ${goal.objective}`, goal.lastCheck]
    .filter((line) => line !== undefined)
    .join("\n\n");

  return (
    <div
      data-composer-goal-bar="true"
      className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs sm:px-4"
    >
      {goal.status === "complete" ? (
        <CheckIcon
          className="size-3 shrink-0 text-sky-500"
          aria-hidden="true"
          data-goal-complete="true"
        />
      ) : (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", presentation.dotClassName)}
          title={`Goal ${presentation.label.toLowerCase()}`}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-foreground/90 hover:text-foreground"
        title={title}
        aria-label="Edit goal"
        onClick={onOpenEditor}
      >
        {goal.objective}
      </button>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {controls.progress === "checks" ? (
          formatGoalChecks(goal.checks ?? 0)
        ) : (
          <>
            {formatGoalTokensCompact(goal.tokensUsed)}
            {goal.tokenBudget !== null ? ` / ${formatGoalTokensCompact(goal.tokenBudget)}` : null}
          </>
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatGoalElapsed(goal.timeUsedSeconds)}
      </span>
      {pauseResumeAction ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={pauseResumeAction.label}
          disabled={isDispatching}
          onClick={() => onSetGoal({ status: pauseResumeAction.nextStatus })}
        >
          <pauseResumeAction.icon className="size-3.5" />
        </Button>
      ) : null}
      <GoalClearButton
        isDispatching={isDispatching}
        // Clearing a live goal abandons work in flight; clearing a finished
        // one is just tidying up, so the confirm step only guards live goals.
        requireConfirm={goal.status !== "complete"}
        onClearGoal={onClearGoal}
      />
    </div>
  );
}

/**
 * Clearing detaches a goal the agent is actively driving toward, so the ✕ arms a
 * destructive confirm instead of firing immediately; the armed state reverts
 * on its own after a beat if the user looks away.
 */
function GoalClearButton({
  isDispatching,
  requireConfirm,
  onClearGoal,
}: {
  readonly isDispatching: boolean;
  readonly requireConfirm: boolean;
  readonly onClearGoal: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) {
      return;
    }
    const timeoutId = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [confirming]);

  if (confirming) {
    return (
      <Button
        size="xs"
        variant="destructive-outline"
        aria-label="Confirm clear goal"
        disabled={isDispatching}
        onClick={() => {
          setConfirming(false);
          onClearGoal();
        }}
        onBlur={() => setConfirming(false)}
      >
        Clear goal?
      </Button>
    );
  }

  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Clear goal"
      className={requireConfirm ? "text-muted-foreground hover:text-destructive-foreground" : ""}
      disabled={isDispatching}
      onClick={() => {
        if (requireConfirm) {
          setConfirming(true);
          return;
        }
        onClearGoal();
      }}
    >
      <XIcon className="size-3.5" />
    </Button>
  );
}

function ComposerGoalEditor({
  goal,
  controls,
  isDispatching,
  onClose,
  onSetGoal,
}: {
  readonly goal: OrchestrationThreadGoal | null;
  readonly controls: ThreadGoalControls;
  readonly isDispatching: boolean;
  readonly onClose: () => void;
  readonly onSetGoal: (input: ComposerGoalSetInput) => void;
}) {
  const [objectiveDraft, setObjectiveDraft] = useState(goal?.objective ?? "");
  const [tokenBudgetDraft, setTokenBudgetDraft] = useState(
    goal?.tokenBudget != null ? String(goal.tokenBudget) : "",
  );
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    objectiveRef.current?.focus();
    objectiveRef.current?.setSelectionRange(
      objectiveRef.current.value.length,
      objectiveRef.current.value.length,
    );
  }, []);

  const trimmedObjective = objectiveDraft.trim();
  const tokenBudget = controls.tokenBudget ? parseTokenBudgetDraft(tokenBudgetDraft) : null;
  const tokenBudgetInvalid = tokenBudget === undefined;
  const canSubmit = trimmedObjective.length > 0 && !tokenBudgetInvalid && !isDispatching;

  const submit = () => {
    if (!canSubmit) {
      return;
    }
    // Editing a finished, limited, or blocked goal re-arms it — Codex only
    // resumes driving once the goal is active again. A deliberately paused
    // goal stays paused; resume is its own control.
    const reactivate = goal !== null && goal.status !== "active" && goal.status !== "paused";
    onSetGoal({
      objective: trimmedObjective,
      ...(controls.tokenBudget ? { tokenBudget: tokenBudget ?? null } : {}),
      ...(reactivate ? { status: "active" as const } : {}),
    });
  };

  return (
    <div data-composer-goal-editor="true" className="space-y-2 px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground/90">
          {goal ? "Edit goal" : "Set a goal"}
        </span>
        {goal ? (
          <span className="text-xs text-muted-foreground">
            {STATUS_PRESENTATION[goal.status].label}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <Button size="icon-xs" variant="ghost" aria-label="Close goal editor" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <Textarea
        ref={objectiveRef}
        size="sm"
        rows={2}
        value={objectiveDraft}
        placeholder="Objective for the agent to drive toward, e.g. “Get the test suite green and open a PR”"
        onChange={(event) => setObjectiveDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {controls.tokenBudget ? (
          <Input
            size="sm"
            inputMode="numeric"
            value={tokenBudgetDraft}
            placeholder="Token budget (optional)"
            aria-invalid={tokenBudgetInvalid}
            className="w-44"
            onChange={(event) => setTokenBudgetDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">Checked each time the agent stops</span>
        )}
        <span className="min-w-0 flex-1" />
        <Button size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="xs" disabled={!canSubmit} onClick={submit}>
          {goal ? "Update goal" : "Set goal"}
        </Button>
      </div>
    </div>
  );
}
