/**
 * Plain-language activity steps: everything an agent does between the things it
 * says, in words a person reads rather than the calls a machine made. The chat
 * and the Agents tab both map their own records into steps here, so a step reads
 * the same wherever it shows up:
 *
 * - looking around (reads, searches, lookups) folds into one summary sentence;
 * - edits, check results, failures, and commands that change something get a
 *   line of their own;
 * - whatever is running right now becomes the live label.
 *
 * Claude writes a plain label for each shell command it runs; when a provider
 * does not (Codex), the label is read off the command itself. The exact call
 * stays one click away in `detail`.
 */
import type { WorkLogEntry, WorkLogStepBlock } from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  basePhrase,
  blockedPhrase,
  capitalize,
  countWord,
  describeAgentLabel,
  failedPhrase,
  joinWords,
  looksLikePath,
  pathBasename,
  phrase,
  searchPhrase,
  toolTitleText,
  truncate,
  urlLabel,
  type Phrase,
} from "./activityWording";
import { analyzeShellCommand, checkResultLabel, firstFailureLine } from "./shellCommands";

/** How the summary sentence counts a step that folds into it. */
export type ActivityTally =
  | "read"
  | "search"
  | "list"
  | "git"
  | "github"
  | "web"
  | "fetch"
  | "browser"
  | "plan"
  | "background"
  | "tool";

export interface ActivityTallyMark {
  readonly tally: ActivityTally;
  /** The file a read names, so a lone read can say which file. */
  readonly subject?: string | undefined;
}

export type ActivityIcon =
  | "read"
  | "search"
  | "list"
  | "git"
  | "web"
  | "browser"
  | "edit"
  | "check"
  | "command"
  | "tool"
  | "image"
  | "agent"
  | "question"
  | "thinking"
  | "info"
  | "warning"
  | "error";

export type ActivityTone = "neutral" | "pass" | "fail" | "warning";

export interface ActivityStepFile {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** The exact call behind a step, shown when the reader opens it. */
export interface ActivityStepDetail {
  /** The shell command as it ran. */
  readonly command?: string | undefined;
  /** Any other call, in words: `Read apps/web/src/main.tsx`. */
  readonly call?: string | undefined;
  readonly output?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly files?: ReadonlyArray<ActivityStepFile> | undefined;
}

export interface ActivityStep {
  readonly id: string;
  /** Looking around: folds into the group's summary sentence instead of
   *  taking a line of its own. */
  readonly routine: boolean;
  /** What the summary sentence counts this step as. Empty means the step is
   *  listed when the summary is opened but not counted in it. */
  readonly tallies: ReadonlyArray<ActivityTallyMark>;
  readonly icon: ActivityIcon;
  readonly tone: ActivityTone;
  /** Settled wording: "Read service.ts", "12 tests passed". */
  readonly label: string;
  /** In-progress wording for the live line: "Reading service.ts". */
  readonly liveLabel: string;
  readonly running: boolean;
  readonly diff: { readonly additions: number; readonly deletions: number } | null;
  /** A second line worth showing without a click: a failure's first error
   *  line, a warning's detail, the question an agent asked. */
  readonly note: string | null;
  readonly durationMs: number | null;
  readonly detail: ActivityStepDetail;
  /** Identifies which check a verification step ran, so a rerun of the same
   *  check replaces the earlier result in a turn's summary. */
  readonly checkKey: string | null;
}

// ---------------------------------------------------------------------------
// Steps from the conversation's work log
// ---------------------------------------------------------------------------

export interface ActivityStepOptions {
  readonly workspaceRoot?: string | undefined;
  /** Diff stats for an edit, when the caller has a better source than the
   *  entry's own (the turn's checkpoint diff). */
  readonly diff?: { readonly additions: number; readonly deletions: number } | null | undefined;
}

interface StepDraft {
  readonly routine: boolean;
  readonly tallies?: ReadonlyArray<ActivityTallyMark>;
  readonly icon: ActivityIcon;
  readonly tone?: ActivityTone;
  readonly label: string;
  readonly liveLabel?: string;
  readonly diff?: ActivityStep["diff"];
  readonly note?: string | null;
  readonly detail?: ActivityStepDetail;
  readonly checkKey?: string | null;
}

function finishStep(
  id: string,
  draft: StepDraft,
  timing: { readonly running: boolean; readonly durationMs: number | null },
): ActivityStep {
  return {
    id,
    routine: draft.routine,
    tallies: draft.tallies ?? [],
    icon: draft.icon,
    tone: draft.tone ?? "neutral",
    label: draft.label,
    liveLabel: draft.liveLabel ?? draft.label,
    running: timing.running,
    diff: draft.diff ?? null,
    note: draft.note ?? null,
    durationMs: timing.durationMs,
    detail: draft.detail ?? {},
    checkKey: draft.checkKey ?? null,
  };
}

/**
 * A tool call's result on its step: the output one click away, and a failure
 * worded as one. A routine step that failed stays folded ("Couldn't read a.ts"
 * in the opened list); a notable one turns red with its first error line.
 * Commands, checks, and edits word their own results.
 */
function withOutcome(
  draft: StepDraft,
  outcome: { readonly failed: boolean; readonly output?: string | undefined },
): StepDraft {
  const output = outcome.output?.trim() ? outcome.output : undefined;
  const detail: ActivityStepDetail =
    output && !draft.detail?.output ? { ...draft.detail, output } : (draft.detail ?? {});
  if (!outcome.failed) {
    return { ...draft, detail };
  }
  const errorText = output?.replace(/<\/?tool_use_error>/gu, "");
  return {
    ...draft,
    label: failedPhrase(phrase(draft.label, draft.liveLabel ?? draft.label), null),
    detail,
    ...(draft.routine ? {} : { tone: "fail", note: draft.note ?? firstFailureLine(errorText) }),
  };
}

/** A reasoning row that says nothing beyond "Thinking". */
function isContentFreeThinking(entry: WorkLogEntry): boolean {
  const label = entry.label.trim();
  const detail = entry.detail?.trim() ?? "";
  return (
    (label === "" || /^thinking$/iu.test(label)) &&
    (detail === "" || detail === "Working through the next step")
  );
}

function entryDurationMs(entry: WorkLogEntry): number | null {
  if (entry.executionState === "running" || !entry.completedAt) {
    return null;
  }
  const started = Date.parse(entry.createdAt);
  const completed = Date.parse(entry.completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed > started
    ? completed - started
    : null;
}

function displayPath(path: string, workspaceRoot: string | undefined): string {
  return formatWorkspaceRelativePath(path, workspaceRoot);
}

/** Names which check a command ran, equal across reruns of the same check. */
function checkKeyFor(analysis: ReturnType<typeof analyzeShellCommand>, command: string): string {
  return `${analysis.checks.join("+")}:${(analysis.checkStatement ?? command).replace(/\s+/gu, " ").trim()}`;
}

const CHECK_KEY_CACHE_LIMIT = 5_000;
const checkKeyByCommand = new Map<string, string | null>();

/**
 * Which check a shell command runs, or null when it runs none. Remembered by
 * the command's text: the conversation rebuilds its steps on every activity,
 * but a command's text never changes, so a long thread reads each one once.
 */
export function commandCheckKey(command: string): string | null {
  const cached = checkKeyByCommand.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const analysis = analyzeShellCommand(command);
  const key = analysis.checks.length > 0 ? checkKeyFor(analysis, command) : null;
  if (checkKeyByCommand.size >= CHECK_KEY_CACHE_LIMIT) {
    checkKeyByCommand.clear();
  }
  checkKeyByCommand.set(command, key);
  return key;
}

/** A shell command step: classified by what it did, worded by the agent's own
 *  label when it wrote one. */
export function commandStepDraft(input: {
  readonly command: string;
  readonly description: string | null;
  readonly failed: boolean;
  readonly output: string | undefined;
  readonly exitCode: number | undefined;
}): StepDraft {
  const analysis = analyzeShellCommand(input.command);
  const described = input.description ? describeAgentLabel(input.description) : null;
  const detail: ActivityStepDetail = {
    command: input.command,
    ...(input.output ? { output: input.output } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
  if (analysis.checks.length > 0) {
    const label = checkResultLabel(
      analysis.checks,
      input.failed,
      input.output,
      analysis.formatWrites,
    );
    return {
      routine: false,
      icon: "check",
      tone: input.failed ? "fail" : "pass",
      label,
      liveLabel: described?.live ?? analysis.phrase.live,
      note: input.failed ? firstFailureLine(input.output) : null,
      detail,
      checkKey: checkKeyFor(analysis, input.command),
    };
  }
  const wording = described ?? analysis.phrase;
  if (analysis.routine) {
    // A search that finds nothing exits non-zero; that is an answer, not a
    // failure. One that printed results found something, whatever the exit
    // code says (a second pattern or path may have come up empty). Any other
    // looking-around step that failed says so in the list.
    const onlySearches =
      analysis.tallies.length > 0 && analysis.tallies.every((mark) => mark.tally === "search");
    const label = !input.failed
      ? wording.past
      : onlySearches
        ? input.output?.trim()
          ? wording.past
          : `${wording.past} (no matches)`
        : failedPhrase(wording, input.description);
    return {
      routine: true,
      tallies: analysis.tallies,
      icon: iconForTallies(analysis.tallies),
      label,
      liveLabel: wording.live,
      detail,
    };
  }
  return {
    routine: false,
    icon: "command",
    tone: input.failed ? "fail" : "neutral",
    label: input.failed ? failedPhrase(wording, input.description) : wording.past,
    liveLabel: wording.live,
    note: input.failed ? (firstFailureLine(input.output) ?? exitCodeNote(input.exitCode)) : null,
    detail,
  };
}

function exitCodeNote(exitCode: number | undefined): string | null {
  return exitCode !== undefined && exitCode !== 0 ? `Exit code ${exitCode}` : null;
}

function iconForTallies(tallies: ReadonlyArray<ActivityTallyMark>): ActivityIcon {
  switch (tallies[0]?.tally) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "list":
      return "list";
    case "git":
      return "git";
    case "github":
    case "fetch":
    case "web":
      return "web";
    case "browser":
      return "browser";
    default:
      return "command";
  }
}

const READ_ONLY_TOOL_VERBS =
  /^(?:get|list|search|read|query|fetch|find|describe|status|view|show|lookup|count|aggregate|retrieve|check|inspect|browse|snapshot)(?:_|$)/iu;

const BROWSER_TOOL_PHRASES: Readonly<Record<string, Phrase>> = {
  browser_click: phrase("Clicked on the page", "Clicking on the page"),
  browser_close_tab: phrase("Closed a browser tab", "Closing a browser tab"),
  browser_drag: phrase("Dragged on the page", "Dragging on the page"),
  browser_evaluate: phrase("Ran a script in the page", "Running a script in the page"),
  browser_move: phrase("Moved the pointer", "Moving the pointer"),
  browser_open_tab: phrase("Opened a browser tab", "Opening a browser tab"),
  browser_press: phrase("Pressed a key in the page", "Pressing a key in the page"),
  browser_resize: phrase("Resized the page", "Resizing the page"),
  browser_screenshot: phrase("Took a screenshot", "Taking a screenshot"),
  browser_scroll: phrase("Scrolled the page", "Scrolling the page"),
  browser_select_tab: phrase("Switched browser tabs", "Switching browser tabs"),
  browser_set_appearance: phrase("Switched the page theme", "Switching the page theme"),
  browser_snapshot: phrase("Read the page", "Reading the page"),
  browser_status: phrase("Checked the browser", "Checking the browser"),
  browser_tabs: phrase("Checked the browser tabs", "Checking the browser tabs"),
  browser_type: phrase("Typed into the page", "Typing into the page"),
  browser_wait_for: phrase("Waited for the page", "Waiting for the page"),
};

function words(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
}

function serverLabel(server: string): string {
  const name = server
    .replace(/^claude_ai_/iu, "")
    .replace(/^plugin_[^_]+_/iu, "")
    .replace(/_mcp$/iu, "");
  return capitalize(words(name));
}

/** `server · tool: args` or `mcp__server__tool`, as providers name MCP calls. */
function parseMcpCall(value: string): { server: string; tool: string; args: string | null } | null {
  const dotted = /^([^·]+?)\s*·\s*([\w.-]+)(?::\s*(.*))?$/su.exec(value.trim());
  if (dotted) {
    return { server: dotted[1]!.trim(), tool: dotted[2]!.trim(), args: dotted[3]?.trim() || null };
  }
  const prefixed = /^mcp__(.+?)__(.+)$/u.exec(value.trim());
  if (prefixed) {
    return { server: prefixed[1]!, tool: prefixed[2]!, args: null };
  }
  return null;
}

function mcpDraft(call: { server: string; tool: string; args: string | null }): StepDraft {
  const tool = call.tool.toLowerCase();
  if (/browser$/iu.test(call.server) || tool.startsWith("browser_")) {
    const url = call.args ? /url=(\S+)/u.exec(call.args)?.[1] : undefined;
    const known =
      tool === "browser_navigate" && url
        ? phrase(`Opened ${urlLabel(url) ?? url}`, `Opening ${urlLabel(url) ?? url}`)
        : BROWSER_TOOL_PHRASES[tool];
    const wording = known ?? phrase("Used the browser", "Using the browser");
    return {
      routine: true,
      tallies: [{ tally: "browser" }],
      icon: "browser",
      label: wording.past,
      liveLabel: wording.live,
      detail: { call: `${call.server} · ${call.tool}${call.args ? `: ${call.args}` : ""}` },
    };
  }
  if (call.server === "threadlines" && tool === "mark_long_running") {
    const wording = phrase(
      "Left a command running in the background",
      "Leaving a command running in the background",
    );
    return {
      routine: true,
      tallies: [{ tally: "tool" }],
      icon: "tool",
      label: wording.past,
      liveLabel: wording.live,
      detail: { call: `${call.server} · ${call.tool}${call.args ? `: ${call.args}` : ""}` },
    };
  }
  const server = serverLabel(call.server);
  const action = words(call.tool);
  const label = `Used ${server}: ${action}`;
  return {
    routine: READ_ONLY_TOOL_VERBS.test(call.tool),
    tallies: READ_ONLY_TOOL_VERBS.test(call.tool) ? [{ tally: "tool" }] : [],
    icon: "tool",
    label,
    liveLabel: `Using ${server}: ${action}`,
    detail: { call: `${call.server} · ${call.tool}${call.args ? `: ${call.args}` : ""}` },
  };
}

function browserReceiptDraft(detail: string | undefined): StepDraft {
  const opened = detail ? /Opened (\S+)/u.exec(detail)?.[1] : undefined;
  const where = opened ? urlLabel(opened) : null;
  const wording = where
    ? phrase(`Checked ${where} in the browser`, `Checking ${where} in the browser`)
    : phrase("Used the browser", "Using the browser");
  return {
    routine: true,
    tallies: [{ tally: "browser" }],
    icon: "browser",
    label: wording.past,
    liveLabel: wording.live,
    detail: detail ? { call: detail } : {},
  };
}

function editDraft(entry: WorkLogEntry, options: ActivityStepOptions): StepDraft {
  const files = entry.changedFiles ?? [];
  const first = files[0] ?? entry.detail ?? null;
  const name = first && looksLikePath(first) ? pathBasename(first) : null;
  const subject = name
    ? files.length > 1
      ? `${name} and ${countWord(files.length - 1, "more file")}`
      : name
    : files.length > 1
      ? countWord(files.length, "file")
      : "a file";
  const wrote = /^write$/iu.test(entry.detail?.trim() ?? "");
  const stats = entry.changedFileStats ?? [];
  const diff =
    options.diff !== undefined
      ? options.diff
      : stats.length > 0
        ? stats.reduce(
            (total, stat) => ({
              additions: total.additions + stat.additions,
              deletions: total.deletions + stat.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : null;
  const detail: ActivityStepDetail = {
    files: files.map((path) => {
      const stat = stats.find((candidate) => pathsMatch(candidate.path, path));
      return {
        path: displayPath(path, options.workspaceRoot),
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
      };
    }),
  };
  if (entry.executionState === "failed") {
    // An edit that did not apply is the agent's to retry, not the reader's to
    // act on: it stays in the opened list, uncounted.
    return {
      routine: true,
      icon: "edit",
      label: `Couldn't edit ${subject}`,
      liveLabel: `Editing ${subject}`,
      detail,
    };
  }
  return {
    routine: false,
    icon: "edit",
    label: `${wrote ? "Wrote" : "Edited"} ${subject}`,
    liveLabel: `${wrote ? "Writing" : "Editing"} ${subject}`,
    diff: diff && (diff.additions > 0 || diff.deletions > 0) ? diff : null,
    detail,
  };
}

function pathsMatch(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(/^\.\/+/u, "")
      .replace(/^\/+/u, "")
      .toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function readDraft(path: string | undefined, options: ActivityStepOptions): StepDraft {
  const file = path ? pathBasename(path) : null;
  return {
    routine: true,
    tallies: [{ tally: "read", subject: file ?? undefined }],
    icon: "read",
    label: file ? `Read ${file}` : "Read a file",
    liveLabel: file ? `Reading ${file}` : "Reading a file",
    detail: path ? { call: `Read ${displayPath(path, options.workspaceRoot)}` } : {},
  };
}

function searchDraft(detail: string | undefined): StepDraft {
  const text = detail?.trim() ?? "";
  const scopeIndex = text.lastIndexOf(" in ");
  const query = scopeIndex > 0 ? text.slice(0, scopeIndex) : text;
  const wording = searchPhrase(query || null);
  return {
    routine: true,
    tallies: [{ tally: "search" }],
    icon: "search",
    label: wording.past,
    liveLabel: wording.live,
    detail: text ? { call: `Search ${text}` } : {},
  };
}

/** A tool call the provider named but we have no wording for. */
function genericToolDraft(title: string, detail: string | undefined): StepDraft {
  const named = /^([\w.-]+):\s*(.*)$/su.exec(detail?.trim() ?? "");
  const tool = truncate(named?.[1] ?? title, 40);
  // A provider's placeholder title names no tool at all.
  if (/^(?:mcp tool call|dynamic tool call|tool call|tool)$/iu.test(tool)) {
    return {
      routine: true,
      tallies: [{ tally: "tool" }],
      icon: "tool",
      label: "Used a tool",
      liveLabel: "Using a tool",
      detail: detail ? { call: detail } : {},
    };
  }
  // Some providers already title the call as a sentence ("Used context7").
  const sentence = /^used\s+(.+)$/iu.exec(tool);
  return {
    routine: true,
    tallies: [{ tally: "tool" }],
    icon: "tool",
    label: sentence ? tool : `Used ${tool}`,
    liveLabel: `Using ${sentence ? sentence[1] : tool}`,
    detail: detail ? { call: detail } : {},
  };
}

function dynamicToolDraft(entry: WorkLogEntry, options: ActivityStepOptions): StepDraft {
  const title = toolTitleText(entry.toolTitle ?? entry.label);
  switch (title.toLowerCase()) {
    case "read file":
      return readDraft(entry.detail, options);
    case "search":
      return searchDraft(entry.detail);
    case "web fetch": {
      const where = entry.detail ? urlLabel(entry.detail) : null;
      return {
        routine: true,
        tallies: [{ tally: "fetch" }],
        icon: "web",
        label: where ? `Read ${where}` : "Read a web page",
        liveLabel: where ? `Reading ${where}` : "Reading a web page",
        detail: entry.detail ? { call: entry.detail } : {},
      };
    }
    case "tool search":
      return {
        routine: true,
        icon: "tool",
        label: "Loaded tools",
        liveLabel: "Loading tools",
        detail: entry.detail ? { call: entry.detail } : {},
      };
    case "update tasks":
      return {
        routine: true,
        tallies: [{ tally: "plan" }],
        icon: "tool",
        label: "Updated the plan",
        liveLabel: "Updating the plan",
        detail: entry.detail ? { call: entry.detail } : {},
      };
    case "question":
      return {
        routine: false,
        icon: "question",
        label: "Asked you a question",
        liveLabel: "Asking you a question",
        note: entry.detail ? truncate(entry.detail, 200) : null,
      };
    case "skill": {
      const skill = entry.detail?.split(":")[0]?.trim();
      return {
        routine: true,
        tallies: [{ tally: "tool" }],
        icon: "tool",
        label: skill ? `Used the ${truncate(skill, 40)} skill` : "Used a skill",
        liveLabel: skill ? `Using the ${truncate(skill, 40)} skill` : "Using a skill",
        detail: entry.detail ? { call: entry.detail } : {},
      };
    }
    default:
      return genericToolDraft(title, entry.detail);
  }
}

function isCommandEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "command_execution" ||
    entry.requestKind === "command" ||
    entry.command !== undefined
  );
}

function commandLikeTitle(entry: WorkLogEntry): boolean {
  return /^(?:bash|powershell|shell|command run|ran command)$/iu.test(
    toolTitleText(entry.toolTitle ?? entry.label),
  );
}

/**
 * Entries the conversation keeps quiet about entirely: the working row
 * already narrates them. Cheap enough to ask of every entry on every update,
 * unlike building the step.
 */
export function isSilentWorkLogEntry(entry: WorkLogEntry): boolean {
  return (
    Boolean(entry.providerLifecyclePhase) ||
    (entry.redactedThinking === true && entry.executionState !== "failed") ||
    entry.activityKind === "user-input.requested" ||
    entry.activityKind === "user-input.resolved" ||
    entry.activityKind === "task.progress" ||
    (entry.tone === "thinking" && isContentFreeThinking(entry))
  );
}

/**
 * One work-log entry as a step, or null for entries the conversation keeps
 * quiet about entirely (the anchor already narrates them).
 */
export function activityStepFromWorkLogEntry(
  entry: WorkLogEntry,
  options: ActivityStepOptions = {},
): ActivityStep | null {
  if (isSilentWorkLogEntry(entry)) {
    return null;
  }
  const running = entry.executionState === "running";
  const failed = entry.executionState === "failed";
  const timing = { running, durationMs: entryDurationMs(entry) };
  const draft = entry.blocked
    ? blockedDraft(entry, entryDraft(entry, options, false), entry.blocked)
    : entryDraft(entry, options, failed);
  return finishStep(entry.id, draft, timing);
}

/**
 * A step something turned down before it ran, worded from what it would have
 * done. A reviewer's block gets a line of its own, like Codex's "Auto-review
 * blocked a step"; a guard's or the user's stays in the opened list, uncounted.
 */
function blockedDraft(
  entry: WorkLogEntry,
  natural: StepDraft,
  blocked: WorkLogStepBlock,
): StepDraft {
  const wording = phrase(natural.label, natural.liveLabel ?? natural.label);
  const detail: ActivityStepDetail = {
    ...natural.detail,
    ...(entry.outputPreview ? { output: entry.outputPreview } : {}),
  };
  if (blocked.by === "auto-mode" || blocked.by === "safety-check") {
    const what = capitalize(basePhrase(wording, entry.description ?? null) ?? natural.label);
    return {
      routine: false,
      icon: "warning",
      tone: "warning",
      label:
        blocked.by === "auto-mode" ? "Auto mode blocked a step" : "A safety check blocked a step",
      liveLabel: wording.live,
      note: blocked.reason ? `${what} (${blocked.reason})` : what,
      detail,
    };
  }
  return {
    routine: true,
    icon: natural.icon,
    label: blockedPhrase(wording, entry.description ?? null, blocked.by === "user"),
    liveLabel: wording.live,
    detail,
  };
}

function entryDraft(entry: WorkLogEntry, options: ActivityStepOptions, failed: boolean): StepDraft {
  const label = entry.label.trim();

  if (entry.authReconnect || entry.mcpAuthReconnect) {
    return {
      routine: false,
      icon: entry.authReconnect ? "error" : "warning",
      tone: entry.authReconnect ? "fail" : "warning",
      label: label || "Sign-in needed",
    };
  }

  // Codex's automatic approval review: a pass is housekeeping, a denial is
  // something the reader should see.
  if (/^auto-approved\b/iu.test(label)) {
    return {
      routine: true,
      icon: "info",
      label: "Auto-approved a step",
      detail: entry.detail ? { call: entry.detail } : {},
    };
  }
  if (/^auto-review\s+(?:denied|rejected|blocked)\b/iu.test(label)) {
    return {
      routine: false,
      icon: "warning",
      tone: "warning",
      label: "Auto-review blocked a step",
      note: entry.detail ? truncate(entry.detail, 200) : null,
    };
  }

  if (isCommandEntry(entry) && entry.command) {
    return commandStepDraft({
      command: entry.command,
      description: entry.description ?? null,
      failed,
      output: entry.outputPreview,
      exitCode: entry.exitCode,
    });
  }
  if (isCommandEntry(entry) || commandLikeTitle(entry)) {
    // A command the provider has not shown us yet (it is still starting).
    const wording = entry.description
      ? describeAgentLabel(entry.description)
      : phrase("Ran a command", "Running a command");
    return {
      routine: false,
      icon: "command",
      tone: failed ? "fail" : "neutral",
      label: failed ? failedPhrase(wording, entry.description ?? null) : wording.past,
      liveLabel: wording.live,
      note: failed ? firstFailureLine(entry.outputPreview) : null,
    };
  }

  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) {
    return editDraft(entry, options);
  }

  const outcome = { failed, output: entry.outputPreview };

  if (entry.itemType === "image_view" || (entry.images?.length ?? 0) > 0) {
    const name = entry.detail && looksLikePath(entry.detail) ? pathBasename(entry.detail) : null;
    return withOutcome(
      {
        routine: false,
        icon: "image",
        label: name ? `Viewed ${name}` : "Viewed an image",
        liveLabel: name ? `Viewing ${name}` : "Viewing an image",
      },
      outcome,
    );
  }

  if (entry.itemType === "web_search") {
    const query = entry.detail ? truncate(entry.detail, 60) : null;
    return withOutcome(
      {
        routine: true,
        tallies: [{ tally: "web" }],
        icon: "web",
        label: query ? `Searched the web for ${query}` : "Searched the web",
        liveLabel: query ? `Searching the web for ${query}` : "Searching the web",
        detail: entry.detail ? { call: entry.detail } : {},
      },
      outcome,
    );
  }

  if (entry.toolTitle === "Browser receipt") {
    return withOutcome(browserReceiptDraft(entry.detail), outcome);
  }

  if (entry.itemType === "mcp_tool_call") {
    const call = entry.detail ? parseMcpCall(entry.detail) : null;
    return withOutcome(
      call
        ? mcpDraft(call)
        : genericToolDraft(toolTitleText(entry.toolTitle ?? label), entry.detail),
      outcome,
    );
  }

  if (entry.itemType === "dynamic_tool_call") {
    const draft = dynamicToolDraft(entry, options);
    // How the user answered a question is theirs to tell, not a result.
    return draft.icon === "question" ? draft : withOutcome(draft, outcome);
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return withOutcome(
      {
        routine: false,
        icon: "agent",
        label: entry.detail
          ? `Started an agent: ${truncate(entry.detail, 80)}`
          : "Started an agent",
        liveLabel: "Starting an agent",
      },
      outcome,
    );
  }

  if (entry.tone === "error" || failed) {
    return {
      routine: false,
      icon: "error",
      tone: "fail",
      label: label || "Something failed",
      note: entry.detail ? truncate(entry.detail, 200) : null,
    };
  }

  if (entry.tone === "warning") {
    return {
      routine: false,
      icon: "warning",
      tone: "warning",
      label: label || "Warning",
      note: entry.detail ? truncate(entry.detail, 200) : null,
    };
  }

  if (entry.activityKind === "turn.plan.updated") {
    return {
      routine: true,
      tallies: [{ tally: "plan" }],
      icon: "tool",
      label: "Updated the plan",
      liveLabel: "Updating the plan",
    };
  }

  // A background task the agent started finished (Claude's local shell
  // tasks). Stopped ones are housekeeping; failures took the error path above.
  if (entry.activityKind === "task.completed") {
    const stopped = /^task stopped$/iu.test(label);
    const wording = describeAgentLabel(label || "Background task");
    return {
      routine: true,
      tallies: stopped ? [] : [{ tally: "background" }],
      icon: "command",
      label: stopped ? `Stopped: ${wording.past}` : wording.past,
      liveLabel: wording.live,
    };
  }

  if (entry.tone === "thinking") {
    // A readable thought titled only "Thinking" reads as its own words.
    const genericTitle = /^(?:thinking|reasoning)$/iu.test(label);
    const text = genericTitle && entry.detail ? entry.detail : label;
    return {
      routine: true,
      icon: "thinking",
      label: truncate(text || "Thought it through", 120),
      liveLabel: "Thinking",
      detail: entry.detail && text !== entry.detail ? { call: entry.detail } : {},
    };
  }

  if (entry.tone === "tool") {
    return withOutcome(
      genericToolDraft(toolTitleText(entry.toolTitle ?? label), entry.detail),
      outcome,
    );
  }

  return {
    routine: false,
    icon: "info",
    label: truncate(label || "Update", 120),
    note: entry.detail ? truncate(entry.detail, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Steps from a provider's stored agent transcript (the Agents tab)
// ---------------------------------------------------------------------------

export interface TranscriptToolCall {
  readonly id: string;
  /** The provider's tool name: `Read`, `Bash`, `mcp__server__tool`,
   *  `shell_command`. */
  readonly name: string;
  /** The provider's one-line preview of the call's arguments. */
  readonly summary: string;
  /** The agent's own label for the call, when it wrote one. */
  readonly description?: string | undefined;
  readonly output?: string | undefined;
  readonly failed?: boolean | undefined;
  readonly running?: boolean | undefined;
}

export function activityStepFromTranscriptTool(
  call: TranscriptToolCall,
  options: { readonly workspaceRoot?: string | undefined } = {},
): ActivityStep {
  const name = call.name.trim();
  const lower = name.toLowerCase();
  // Providers fall back to `<tool>: <args>` for tools they have no preview for.
  const rawSummary = call.summary.trim();
  const summary = rawSummary.toLowerCase().startsWith(`${lower}:`)
    ? rawSummary.slice(name.length + 1).trim()
    : rawSummary;
  const failed = call.failed === true;
  const timing = { running: call.running === true, durationMs: null };

  if (
    /^(?:bash|powershell|shell|shell_command|exec_command|local_shell|run_command)$/u.test(lower)
  ) {
    return finishStep(
      call.id,
      commandStepDraft({
        command: summary || name,
        description: call.description?.trim() || null,
        failed,
        output: call.output,
        exitCode: undefined,
      }),
      timing,
    );
  }
  const draft = transcriptToolDraft(name, summary, failed, options);
  const withCall: StepDraft =
    draft.detail && Object.keys(draft.detail).length > 0
      ? draft
      : { ...draft, detail: summary ? { call: `${name}: ${summary}` } : {} };
  return finishStep(call.id, withOutcome(withCall, { failed, output: call.output }), timing);
}

/** A transcript tool call other than a shell command, before its result. */
function transcriptToolDraft(
  name: string,
  summary: string,
  failed: boolean,
  options: { readonly workspaceRoot?: string | undefined },
): StepDraft {
  const lower = name.toLowerCase();
  if (/^(?:read|read_file|view)$/u.test(lower)) {
    return readDraft(summary || undefined, options);
  }
  if (/^(?:grep|glob|search|codebase_search|rg|find)$/u.test(lower)) {
    return searchDraft(summary || undefined);
  }
  if (/^(?:ls|list_dir|list_files)$/u.test(lower)) {
    const folder = summary ? pathBasename(summary) : null;
    return {
      routine: true,
      tallies: [{ tally: "list" }],
      icon: "list",
      label: folder ? `Listed ${folder}` : "Listed files",
      liveLabel: folder ? `Listing ${folder}` : "Listing files",
    };
  }
  if (
    /^(?:edit|write|multiedit|notebookedit|apply_patch|str_replace_editor|create_file)$/u.test(
      lower,
    )
  ) {
    const file = summary && looksLikePath(summary) ? pathBasename(summary) : null;
    const wrote = lower === "write" || lower === "create_file";
    const subject = file ?? "files";
    return {
      // An edit that did not apply is the agent's to retry: it stays folded.
      routine: failed,
      icon: "edit",
      label: `${wrote ? "Wrote" : "Edited"} ${subject}`,
      liveLabel: `${wrote ? "Writing" : "Editing"} ${subject}`,
    };
  }
  if (/^(?:webfetch|web_fetch)$/u.test(lower)) {
    const where = summary ? urlLabel(summary) : null;
    return {
      routine: true,
      tallies: [{ tally: "fetch" }],
      icon: "web",
      label: where ? `Read ${where}` : "Read a web page",
      liveLabel: where ? `Reading ${where}` : "Reading a web page",
    };
  }
  if (/^(?:websearch|web_search)$/u.test(lower)) {
    const query = summary ? truncate(summary, 60) : null;
    return {
      routine: true,
      tallies: [{ tally: "web" }],
      icon: "web",
      label: query ? `Searched the web for ${query}` : "Searched the web",
      liveLabel: query ? `Searching the web for ${query}` : "Searching the web",
    };
  }
  if (/^(?:todowrite|taskcreate|taskupdate|update_plan)$/u.test(lower)) {
    return {
      routine: true,
      tallies: [{ tally: "plan" }],
      icon: "tool",
      label: "Updated the plan",
      liveLabel: "Updating the plan",
    };
  }
  if (lower === "toolsearch") {
    return { routine: true, icon: "tool", label: "Loaded tools", liveLabel: "Loading tools" };
  }
  if (lower === "task" || lower === "agent" || lower === "spawn_agent") {
    return {
      routine: false,
      icon: "agent",
      label: summary ? `Started an agent: ${truncate(summary, 80)}` : "Started an agent",
      liveLabel: "Starting an agent",
    };
  }
  const mcp = parseMcpCall(name);
  if (mcp) {
    return mcpDraft({ ...mcp, args: summary && summary !== name ? summary : null });
  }
  return genericToolDraft(name, undefined);
}

/** Output whose call the reader cannot see (it is on an earlier transcript
 *  page), kept one click away instead of dropped. */
export function activityStepForOrphanOutput(id: string, output: string): ActivityStep {
  return finishStep(
    id,
    {
      routine: true,
      icon: "tool",
      label: "Output from an earlier step",
      detail: { output },
    },
    { running: false, durationMs: null },
  );
}

// ---------------------------------------------------------------------------
// Groups: the summary sentence and the live label
// ---------------------------------------------------------------------------

const TALLY_ORDER: ReadonlyArray<ActivityTally> = [
  "read",
  "search",
  "list",
  "git",
  "github",
  "web",
  "fetch",
  "browser",
  "plan",
  "background",
  "tool",
];

function tallyPhrase(tally: ActivityTally, marks: ReadonlyArray<ActivityTallyMark>): string {
  const count = marks.length;
  switch (tally) {
    case "read": {
      const named = new Set(
        marks.map((mark) => mark.subject?.toLowerCase()).filter((subject) => subject),
      );
      const unnamed = marks.filter((mark) => !mark.subject).length;
      const files = named.size + unnamed;
      const onlySubject = marks.find((mark) => mark.subject)?.subject;
      return files === 1 && onlySubject
        ? `read ${onlySubject}`
        : `read ${countWord(files, "file")}`;
    }
    case "search":
      return count === 1
        ? "searched once"
        : count === 2
          ? "searched twice"
          : `searched ${count} times`;
    case "list":
      return count === 1 ? "listed a folder" : `listed ${countWord(count, "folder")}`;
    case "git":
      return "checked git";
    case "github":
      return "checked GitHub";
    case "web":
      return count === 1
        ? "searched the web"
        : count === 2
          ? "searched the web twice"
          : `searched the web ${count} times`;
    case "fetch":
      return count === 1 ? "read a web page" : `read ${countWord(count, "web page")}`;
    case "browser":
      return count === 1 ? "used the browser" : `used the browser ${count} times`;
    case "plan":
      return "updated the plan";
    case "background":
      return count === 1 ? "finished a background task" : `finished ${count} background tasks`;
    case "tool":
      return count === 1 ? "used a tool" : `used ${countWord(count, "tool")}`;
  }
}

/** The one sentence a run of routine steps folds into:
 *  "Read 5 files, searched 4 times, and checked GitHub". */
export function summarizeRoutineSteps(steps: ReadonlyArray<ActivityStep>): string {
  if (steps.length === 1) {
    return steps[0]!.label;
  }
  const marksByTally = new Map<ActivityTally, ActivityTallyMark[]>();
  for (const step of steps) {
    for (const mark of step.tallies) {
      const marks = marksByTally.get(mark.tally) ?? [];
      marks.push(mark);
      marksByTally.set(mark.tally, marks);
    }
  }
  const parts = TALLY_ORDER.flatMap((tally) => {
    const marks = marksByTally.get(tally);
    return marks && marks.length > 0 ? [tallyPhrase(tally, marks)] : [];
  });
  if (parts.length === 0) {
    return steps.every((step) => step.icon === "thinking")
      ? "Thought it through"
      : countWord(steps.length, "step");
  }
  return capitalize(joinWords(parts));
}

/** Settled order for a group: the routine steps that fold into the summary
 *  sentence, and the ones worth a line of their own. Running steps belong to
 *  the live line, not the group. */
export function partitionActivitySteps(steps: ReadonlyArray<ActivityStep>): {
  readonly routine: ReadonlyArray<ActivityStep>;
  readonly notable: ReadonlyArray<ActivityStep>;
} {
  const routine: ActivityStep[] = [];
  const notable: ActivityStep[] = [];
  for (const step of steps) {
    if (step.running) continue;
    (step.routine ? routine : notable).push(step);
  }
  return { routine, notable };
}

export type ActivityLineItem =
  | { readonly kind: "step"; readonly step: ActivityStep }
  | {
      readonly kind: "edits";
      readonly id: string;
      readonly label: string;
      readonly steps: ReadonlyArray<ActivityStep>;
      readonly diff: ActivityStep["diff"];
    };

const EDIT_RUN_MIN_LENGTH = 3;

/** The lines a group's notable steps take. Three or more edits in a row read
 *  as one "Edited 6 files" line that opens into the files. */
export function activityLineItems(notable: ReadonlyArray<ActivityStep>): ActivityLineItem[] {
  const items: ActivityLineItem[] = [];
  let run: ActivityStep[] = [];
  const flush = () => {
    if (run.length >= EDIT_RUN_MIN_LENGTH) {
      const files = new Set(
        run.flatMap((step) =>
          step.detail.files && step.detail.files.length > 0
            ? step.detail.files.map((file) => file.path.toLowerCase())
            : [step.id],
        ),
      );
      const withDiff = run.filter((step) => step.diff !== null);
      items.push({
        kind: "edits",
        id: `edits:${run[0]!.id}`,
        label: `Edited ${countWord(files.size, "file")}`,
        steps: run,
        diff:
          withDiff.length > 0
            ? withDiff.reduce(
                (total, step) => ({
                  additions: total.additions + step.diff!.additions,
                  deletions: total.deletions + step.diff!.deletions,
                }),
                { additions: 0, deletions: 0 },
              )
            : null,
      });
    } else {
      items.push(...run.map((step) => ({ kind: "step" as const, step })));
    }
    run = [];
  };
  for (const step of notable) {
    if (step.icon === "edit" && step.tone === "neutral") {
      run.push(step);
      continue;
    }
    flush();
    items.push({ kind: "step", step });
  }
  flush();
  return items;
}

/** What the live line says while steps run: the newest one, and how many run
 *  beside it. */
export function liveActivityLabel(steps: ReadonlyArray<ActivityStep>): string | null {
  const running = steps.filter((step) => step.running);
  const latest = running.at(-1);
  if (!latest) {
    return null;
  }
  if (running.length === 1) {
    return latest.liveLabel;
  }
  if (running.every((step) => step.tallies[0]?.tally === "read")) {
    return `Reading ${countWord(running.length, "file")}`;
  }
  return `${latest.liveLabel} and ${running.length - 1} more`;
}

/**
 * The newest words of a thought still running, for the line under the working
 * row: its last paragraph, without markdown emphasis. Null for anything else,
 * including a thought whose words the provider keeps private.
 */
export function liveThoughtText(entry: WorkLogEntry): string | null {
  if (
    entry.tone !== "thinking" ||
    entry.executionState !== "running" ||
    entry.redactedThinking !== false
  ) {
    return null;
  }
  const paragraphs = (entry.detail ?? entry.label)
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .replace(/\*\*|__|`/gu, "")
        .replace(/\s+/gu, " ")
        // The row keeps the newest text and marks a cut start with an ellipsis.
        .replace(/^(?:\.\.\.|…)/u, "")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.at(-1) ?? null;
}

/** Shorter than this, a sentence has barely started; the line keeps the one
 *  before it so it never drops to a word or two. */
const MIN_LIVE_SENTENCE_CHARS = 24;

/**
 * The newest sentence of a live thought, for the single line under the
 * working row's "Thinking". A thought paragraph can run several lines; one
 * sentence keeps the row one line tall while the thought streams.
 */
export function newestThoughtSentence(thought: string): string {
  const sentences = thought
    .split(/(?<=[.!?…])\s+(?=["'([]?[A-Z0-9])/u)
    .filter((sentence) => sentence.length > 0);
  const newest = sentences.at(-1) ?? thought;
  const previous = sentences.at(-2);
  return previous && newest.length < MIN_LIVE_SENTENCE_CHARS ? `${previous} ${newest}` : newest;
}

/**
 * A running agent's step as its provider reported it (Claude's task progress:
 * "Editing src\\game\\paint\\workVan.ts", "Running Recheck the timings", or
 * the task's own label, "Check the mobile header"), in the same words the
 * conversation uses for a step still running.
 */
export function plainAgentStep(step: string): string {
  const text = step.replace(/\s+/gu, " ").trim();
  const file = /^(Reading|Editing|Writing|Viewing|Opening)\s+(.+)$/u.exec(text);
  if (file && looksLikePath(file[2]!)) {
    return `${file[1]} ${truncate(pathBasename(file[2]!), 60)}`;
  }
  const search = /^Searching for\s+(.+)$/u.exec(text);
  if (search) {
    return searchPhrase(search[1]!).live;
  }
  const running = /^Running\s+([A-Z].*)$/u.exec(text);
  if (running) {
    return describeAgentLabel(running[1]!).live;
  }
  // A task label is an imperative, which reads in the present while it runs.
  // When its past tense reads the same ("Read the config"), the label may
  // already be past, so it stays as written.
  const wording = describeAgentLabel(text);
  return wording.past === truncate(text, 120) ? wording.past : wording.live;
}
