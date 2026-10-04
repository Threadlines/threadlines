/**
 * Shared data shapes and display helpers for thread activity — the spawned
 * agents and background runs a turn produces. The header popover, the agents
 * panel and the timeline's turn row all read from here so a run reads the same
 * way wherever it surfaces. Pure: nothing here touches React or the network.
 */
import { urlLabel } from "./activityWording";

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
  /** When the run started, when anything says; its age then ticks. */
  startedAt?: string | null | undefined;
  /** The newest line the run printed, when its output reaches the client. */
  outputLine?: string | null | undefined;
  /** Where Claude is writing a background command's output. The popover reads
   *  the newest line from it while open; nothing streams it. */
  outputFile?: string | null | undefined;
  /** False when the provider said a task runs but not what it is. */
  described?: boolean | undefined;
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

/** What a run is, by what it gives the user: a page to open, a terminal, a
 *  command or task the agent started, or a process found on the machine. */
export type BackgroundRunKind = "preview" | "terminal" | "command" | "task" | "process";

export function backgroundRunKind(run: ThreadBackgroundRunItem): BackgroundRunKind {
  if (run.urls.length > 0 || run.port !== null) return "preview";
  if (run.source === "terminal") return "terminal";
  if (run.source === "detected") return "process";
  return run.providerKind === "command" || Boolean(run.command?.trim()) ? "command" : "task";
}

/** The page a run serves, labelled the short way ("localhost:5173"). */
export function backgroundRunLink(
  run: ThreadBackgroundRunItem,
): { readonly href: string; readonly label: string } | null {
  const href = run.urls[0] ?? (run.port !== null ? `http://localhost:${run.port}` : null);
  if (!href) return null;
  return { href, label: urlLabel(href) ?? href };
}

export interface BackgroundRunDetailLine {
  readonly kind: "output" | "command" | "prose";
  readonly text: string;
}

function isInformativeBackgroundRunCommand(commandText: string): boolean {
  return (
    commandText.includes(" ") ||
    commandText.length > 18 ||
    commandText.includes("/") ||
    commandText.includes("\\")
  );
}

/**
 * The second line of a run: the newest thing it printed when that reaches
 * us, else the command behind it when the name doesn't already say it, else
 * a plain sentence for a task nobody described.
 */
export function backgroundRunDetailLine(
  run: ThreadBackgroundRunItem,
): BackgroundRunDetailLine | null {
  const output = run.outputLine?.trim();
  if (output) return { kind: "output", text: output };
  if (run.described === false) {
    return run.detail ? { kind: "prose", text: run.detail } : null;
  }
  const command = backgroundRunCommandText(run).trim();
  if (command && command !== run.label.trim() && isInformativeBackgroundRunCommand(command)) {
    return { kind: "command", text: command };
  }
  return null;
}

export type BackgroundRunAge =
  | { readonly live: true; readonly since: string }
  | { readonly live: false; readonly label: string };

/** How long a run has been going: a ticking clock from its start when known,
 *  else whatever fixed age the machine reported. */
export function backgroundRunAge(run: ThreadBackgroundRunItem): BackgroundRunAge | null {
  if (run.startedAt && Number.isFinite(Date.parse(run.startedAt))) {
    return { live: true, since: run.startedAt };
  }
  return run.elapsed ? { live: false, label: run.elapsed } : null;
}

/** Everything a run row leaves out, for its name's tooltip. */
export function backgroundRunTooltip(run: ThreadBackgroundRunItem): string {
  const command = backgroundRunCommandText(run).trim();
  return [
    [backgroundRunSourceLabel(run), ...backgroundRunMetaItems(run)].join(" · "),
    command && command !== run.label.trim() ? command : null,
    run.urls.length > 1 ? run.urls.join("\n") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/** When a process started, from the `ps` elapsed time the machine reported at
 *  `reportedAtMs`, so its age can keep ticking after the one report. */
export function processStartedAt(
  elapsed: string | null | undefined,
  reportedAtMs: number,
): string | null {
  const elapsedMs = parseProcessElapsedMs(elapsed);
  return elapsedMs === null ? null : new Date(reportedAtMs - elapsedMs).toISOString();
}

/** The `ps` elapsed time ("12:34", "01:02:03", "2-01:02:03") in milliseconds,
 *  or null when it isn't one. */
function parseProcessElapsedMs(elapsed: string | null | undefined): number | null {
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/u.exec(elapsed?.trim() ?? "");
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds) * 1_000
  );
}
