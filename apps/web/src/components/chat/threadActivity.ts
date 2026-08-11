/**
 * Shared data shapes and display helpers for thread activity — the spawned
 * agents and background runs a turn produces. The header popover, the agents
 * panel and the timeline's turn row all read from here so a run reads the same
 * way wherever it surfaces. Pure: nothing here touches React or the network.
 */

export interface ThreadBackgroundRunItem {
  id: string;
  source: "terminal" | "provider" | "detected";
  providerKind?: "task" | "command" | undefined;
  label: string;
  command?: string | null;
  detail: string | null;
  cwd: string | null;
  statusLabel: string;
  urls: ReadonlyArray<string>;
  pids?: ReadonlyArray<number> | undefined;
  commandHints?: ReadonlyArray<string> | undefined;
  terminalId: string | null;
  terminalVisible?: boolean | undefined;
  pid: number | null;
  port: number | null;
  elapsed: string | null;
  canStop: boolean;
}

export interface SubagentDisplayDetails {
  goal: string | null;
  /** Where the agent is working, lifted out of the objective prose. */
  context: string | null;
  title: string | null;
}

export function deriveSubagentDisplayDetails(item: {
  objective: string | null;
}): SubagentDisplayDetails {
  const rawObjective = item.objective?.trim() || null;
  const normalizedObjective = rawObjective ? normalizeSubagentInlineText(rawObjective) : null;
  const objectiveParts = normalizedObjective
    ? parseSubagentDisplayObjective(normalizedObjective)
    : null;
  return {
    goal: objectiveParts?.goal || normalizedObjective,
    context: objectiveParts?.context ?? null,
    title: rawObjective,
  };
}

export function normalizeSubagentInlineText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function parseSubagentDisplayObjective(value: string): {
  goal: string | null;
  context: string | null;
} {
  const goalMatch = /\bGoal\s*:/iu.exec(value);
  if (goalMatch) {
    return {
      goal: value.slice(goalMatch.index + goalMatch[0].length).trim() || null,
      context: subagentContextFromGoalPrefix(value.slice(0, goalMatch.index)),
    };
  }

  return subagentObjectiveWithoutLocation(value) ?? { goal: value, context: null };
}

function subagentContextFromGoalPrefix(prefix: string): string | null {
  const cleanedPrefix = normalizeSubagentInlineText(prefix).replace(/[.:\s]+$/u, "");
  if (!cleanedPrefix) {
    return null;
  }

  const locationMatch = /^(.+?)\s+in\s+(.+)$/iu.exec(cleanedPrefix);
  if (locationMatch) {
    const action = normalizeSubagentInlineText(locationMatch[1] ?? "");
    const location = normalizeSubagentInlineText(locationMatch[2] ?? "");
    if (action && looksLikeSubagentLocation(location)) {
      return titleCaseSubagentContext(action);
    }
  }

  return cleanedPrefix.length <= 56 ? titleCaseSubagentContext(cleanedPrefix) : null;
}

function subagentObjectiveWithoutLocation(value: string): {
  goal: string | null;
  context: string | null;
} | null {
  const locationMatch = /^(.+?)\s+in\s+(.+)$/iu.exec(value);
  const action = normalizeSubagentInlineText(locationMatch?.[1] ?? "");
  const remainder = normalizeSubagentInlineText(locationMatch?.[2] ?? "");
  if (!action || !looksLikeSubagentLocation(remainder)) {
    return null;
  }

  const boundaryMatch = /[.!?]\s+(?=\S)/u.exec(remainder);
  if (!boundaryMatch) {
    return null;
  }

  const goal = remainder.slice(boundaryMatch.index + boundaryMatch[0].length).trim();
  if (!goal) {
    return null;
  }

  return {
    goal,
    context: titleCaseSubagentContext(action),
  };
}

function looksLikeSubagentLocation(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("/")
  );
}

function titleCaseSubagentContext(value: string): string {
  const normalized = normalizeSubagentInlineText(value);
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : normalized;
}

export function backgroundRunFallbackDetail(run: ThreadBackgroundRunItem): string {
  if (run.source === "terminal") {
    return "Managed terminal";
  }
  if (run.source === "detected") {
    return "Detected local process";
  }
  return "Provider-managed";
}

export function backgroundRunCommandText(run: ThreadBackgroundRunItem): string {
  if (run.command && run.command.trim().length > 0) {
    return run.command;
  }
  const detail = run.detail ?? run.cwd ?? backgroundRunFallbackDetail(run);
  const detectedCommandSeparator = " - ";
  if (run.source === "detected" && detail.includes(detectedCommandSeparator)) {
    return detail.slice(detail.indexOf(detectedCommandSeparator) + detectedCommandSeparator.length);
  }
  return detail;
}

export function backgroundRunSourceLabel(run: ThreadBackgroundRunItem): string {
  if (run.source === "terminal") {
    return run.terminalVisible ? "Active terminal" : "Terminal";
  }
  if (run.source === "detected") {
    return run.port === null ? "Detected agent process" : "Detected agent preview";
  }
  return run.providerKind === "command" ? "Agent command" : "Agent task";
}

export function backgroundRunMetaItems(run: ThreadBackgroundRunItem): ReadonlyArray<string> {
  return [
    run.pid === null ? null : `PID ${run.pid}`,
    run.port === null ? null : `:${run.port}`,
    run.elapsed ? `Up ${run.elapsed}` : null,
  ].filter((item): item is string => item !== null);
}
