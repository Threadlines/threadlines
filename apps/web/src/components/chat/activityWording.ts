/**
 * Wording shared by activity steps: plain phrases for paths, searches, and
 * counts, and the agent's own step labels turned to past and present tense.
 */

export interface Phrase {
  readonly past: string;
  readonly live: string;
}

export const phrase = (past: string, live: string): Phrase => ({ past, live });

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

/** Providers suffix finished tool titles ("Read file complete"). */
export function toolTitleText(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/iu, "").trim();
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

export function joinWords(parts: ReadonlyArray<string>, conjunction: "and" | "or" = "and"): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} ${conjunction} ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
}

export function countWord(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1).trimEnd()}…` : singleLine;
}

/** The last path segment, whichever separator the path uses. */
export function pathBasename(value: string): string {
  const parts = value
    .trim()
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u);
  return parts.at(-1)?.trim() || value.trim();
}

export function looksLikePath(value: string): boolean {
  return (
    /[\\/]/u.test(value) ||
    /^[A-Za-z]:/u.test(value) ||
    /^\.\.?$/u.test(value) ||
    /\.[A-Za-z0-9]{1,8}$/u.test(value)
  );
}

export function urlLabel(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
    return truncate(`${url.host}${path}`, 48);
  } catch {
    return null;
  }
}

/**
 * The name a search is for: the last identifier of its first alternative, so
 * `export function resolveThreadPullRequest|export interface X` reads as
 * `resolveThreadPullRequest`, with a count of the other alternatives.
 */
export function searchTerm(query: string): { readonly term: string; readonly more: number } {
  const alternatives = splitAlternatives(query);
  const first = (alternatives[0] ?? query)
    .replace(/\\[bBsSdDwW]/gu, " ")
    .replace(/\\(.)/gu, "$1")
    .trim();
  const words = first.match(/[A-Za-z_$@][\w$.@/-]*[\w$]|[A-Za-z_$]/gu) ?? [];
  const term = words.at(-1) ?? truncate(first || query, 40);
  return { term: truncate(term, 48), more: Math.max(0, alternatives.length - 1) };
}

/** Top-level `|` alternatives of a pattern, ignoring escaped pipes and pipes
 *  inside brackets or groups. */
function splitAlternatives(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      current += char + (pattern[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    if ((char === ")" || char === "]") && depth > 0) depth -= 1;
    if (char === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function looksLikeGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern) && !/[|\\^$()+]/u.test(pattern);
}

export function searchPhrase(query: string | null): Phrase {
  if (!query) {
    return phrase("Searched the code", "Searching the code");
  }
  if (looksLikeGlob(query)) {
    const pattern = truncate(query, 48);
    return phrase(`Found files matching ${pattern}`, `Finding files matching ${pattern}`);
  }
  const { term, more } = searchTerm(query);
  const suffix = more > 0 ? ` and ${more} more` : "";
  return phrase(`Searched for ${term}${suffix}`, `Searching for ${term}${suffix}`);
}

// ---------------------------------------------------------------------------
// Agent-written labels. Claude labels every shell command with an imperative
// ("Check both PRs' branches on GitHub"). A settled step reads better in the
// past and a running one in the present, but only the lead verb can be turned
// safely: a label that joins a second verb ("Merge #278 and install") or opens
// with a word we do not know stays exactly as the agent wrote it.
// ---------------------------------------------------------------------------

const IRREGULAR_VERBS: Readonly<Record<string, readonly [past: string, live: string]>> = {
  begin: ["began", "beginning"],
  bring: ["brought", "bringing"],
  build: ["built", "building"],
  catch: ["caught", "catching"],
  commit: ["committed", "committing"],
  cut: ["cut", "cutting"],
  drop: ["dropped", "dropping"],
  find: ["found", "finding"],
  get: ["got", "getting"],
  grep: ["grepped", "grepping"],
  keep: ["kept", "keeping"],
  log: ["logged", "logging"],
  make: ["made", "making"],
  map: ["mapped", "mapping"],
  pin: ["pinned", "pinning"],
  plan: ["planned", "planning"],
  put: ["put", "putting"],
  read: ["read", "reading"],
  rebuild: ["rebuilt", "rebuilding"],
  redo: ["redid", "redoing"],
  reread: ["reread", "rereading"],
  rerun: ["reran", "rerunning"],
  reset: ["reset", "resetting"],
  rewrite: ["rewrote", "rewriting"],
  run: ["ran", "running"],
  scan: ["scanned", "scanning"],
  see: ["saw", "seeing"],
  send: ["sent", "sending"],
  set: ["set", "setting"],
  ship: ["shipped", "shipping"],
  show: ["showed", "showing"],
  skip: ["skipped", "skipping"],
  split: ["split", "splitting"],
  spot: ["spotted", "spotting"],
  stop: ["stopped", "stopping"],
  strip: ["stripped", "stripping"],
  swap: ["swapped", "swapping"],
  tag: ["tagged", "tagging"],
  take: ["took", "taking"],
  think: ["thought", "thinking"],
  trim: ["trimmed", "trimming"],
  undo: ["undid", "undoing"],
  wrap: ["wrapped", "wrapping"],
  write: ["wrote", "writing"],
  zip: ["zipped", "zipping"],
};

const REGULAR_VERBS: ReadonlySet<string> = new Set([
  "add",
  "append",
  "apply",
  "audit",
  "benchmark",
  "bump",
  "capture",
  "change",
  "check",
  "clean",
  "clear",
  "clone",
  "close",
  "collect",
  "compare",
  "compile",
  "compute",
  "confirm",
  "convert",
  "copy",
  "count",
  "create",
  "debug",
  "dedupe",
  "delete",
  "deploy",
  "diff",
  "disable",
  "download",
  "dump",
  "echo",
  "edit",
  "enable",
  "ensure",
  "examine",
  "execute",
  "explore",
  "export",
  "extract",
  "fetch",
  "fill",
  "fix",
  "format",
  "generate",
  "grab",
  "identify",
  "import",
  "inspect",
  "install",
  "kill",
  "launch",
  "lint",
  "list",
  "load",
  "locate",
  "look",
  "mark",
  "measure",
  "merge",
  "move",
  "open",
  "parse",
  "patch",
  "peek",
  "pick",
  "ping",
  "poll",
  "prepare",
  "preview",
  "print",
  "probe",
  "profile",
  "prune",
  "pull",
  "push",
  "query",
  "rebase",
  "recheck",
  "record",
  "refresh",
  "regenerate",
  "reinstall",
  "reload",
  "remove",
  "rename",
  "render",
  "reopen",
  "replace",
  "reproduce",
  "resize",
  "restart",
  "restore",
  "retest",
  "retry",
  "revert",
  "review",
  "sample",
  "save",
  "score",
  "search",
  "seed",
  "simulate",
  "snapshot",
  "sort",
  "stage",
  "start",
  "stash",
  "summarize",
  "sync",
  "tail",
  "test",
  "time",
  "trace",
  "trigger",
  "try",
  "tweak",
  "type",
  "typecheck",
  "unpack",
  "unstage",
  "update",
  "upgrade",
  "upload",
  "use",
  "validate",
  "verify",
  "view",
  "wait",
  "walk",
  "watch",
  "wire",
]);

function regularVerbForms(verb: string): readonly [past: string, live: string] {
  const past = verb.endsWith("e")
    ? `${verb}d`
    : /[^aeiou]y$/u.test(verb)
      ? `${verb.slice(0, -1)}ied`
      : `${verb}ed`;
  const live = verb.endsWith("ie")
    ? `${verb.slice(0, -2)}ying`
    : verb.endsWith("e") && !/[eoy]e$/u.test(verb)
      ? `${verb.slice(0, -1)}ing`
      : `${verb}ing`;
  return [past, live];
}

/** Verbs we never conjugate but must recognize when they follow the lead verb:
 *  "Push the branch and open the PR", "Fix the imports, remove the old sheet". */
const FOLLOWING_VERB_HINTS: ReadonlySet<string> = new Set([
  "adjust",
  "align",
  "ask",
  "hook",
  "join",
  "label",
  "lock",
  "post",
  "publish",
  "re-run",
  "re-test",
  "re-time",
  "re-verify",
  "rerender",
  "reply",
  "report",
  "respond",
  "retime",
  "return",
  "screenshot",
  "tell",
  "type-check",
  "unlock",
]);

function isKnownVerb(word: string): boolean {
  const lower = word.toLowerCase();
  return lower in IRREGULAR_VERBS || REGULAR_VERBS.has(lower) || FOLLOWING_VERB_HINTS.has(lower);
}

/** Whether a second verb follows the lead one, joined by "and", "then", a
 *  comma, or a semicolon. Turning only the first verb would break the
 *  sentence ("Verified the branch, update the PR"). */
function joinsAnotherVerb(rest: string): boolean {
  if (/;|&|\bthen\b/iu.test(rest)) {
    return true;
  }
  for (const match of rest.matchAll(/(?:\band|,)\s+([A-Za-z-]+)/giu)) {
    if (isKnownVerb(match[1]!)) {
      return true;
    }
  }
  return false;
}

function conjugateLeadVerb(label: string, form: "past" | "live"): string | null {
  const match = /^([A-Za-z]+)(\s.*)?$/su.exec(label.trim());
  if (!match) {
    return null;
  }
  const verb = match[1]!;
  const rest = match[2] ?? "";
  if (joinsAnotherVerb(rest)) {
    return null;
  }
  const lower = verb.toLowerCase();
  const forms =
    IRREGULAR_VERBS[lower] ?? (REGULAR_VERBS.has(lower) ? regularVerbForms(lower) : null);
  if (!forms) {
    return null;
  }
  return `${capitalize(form === "past" ? forms[0] : forms[1])}${rest}`;
}

/** The verbs our own derived wording leads with, from the "-ing" form back to
 *  the plain verb, so a failed step can say what it could not do. */
const GERUND_BASES: Readonly<Record<string, string>> = {
  adding: "add",
  applying: "apply",
  building: "build",
  calling: "call",
  cancelling: "cancel",
  changing: "change",
  checking: "check",
  "cherry-picking": "cherry-pick",
  clicking: "click",
  cloning: "clone",
  closing: "close",
  commenting: "comment on",
  committing: "commit",
  continuing: "continue",
  copying: "copy",
  creating: "create",
  deleting: "delete",
  dragging: "drag",
  dropping: "drop",
  editing: "edit",
  fetching: "fetch",
  finding: "find",
  formatting: "format",
  installing: "install",
  linting: "lint",
  listing: "list",
  loading: "load",
  looking: "look",
  marking: "mark",
  merging: "merge",
  moving: "move",
  opening: "open",
  packing: "pack",
  pressing: "press",
  publishing: "publish",
  pulling: "pull",
  pushing: "push",
  reading: "read",
  rebasing: "rebase",
  removing: "remove",
  renaming: "rename",
  reopening: "reopen",
  rerunning: "rerun",
  resetting: "reset",
  resizing: "resize",
  restoring: "restore",
  reverting: "revert",
  reviewing: "review",
  running: "run",
  scrolling: "scroll",
  searching: "search",
  sending: "send",
  staging: "stage",
  starting: "start",
  stashing: "stash",
  stopping: "stop",
  switching: "switch",
  tagging: "tag",
  taking: "take",
  typechecking: "typecheck",
  typing: "type",
  unpacking: "unpack",
  unstaging: "unstage",
  updating: "update",
  using: "use",
  viewing: "view",
  waiting: "wait",
  watching: "watch",
  writing: "write",
};

/** A step as an instruction, the form that follows "Couldn't": "delete
 *  scratch.md". An agent's own label is one already. Null when the lead verb
 *  has no known base form. */
export function basePhrase(wording: Phrase, agentLabel: string | null): string | null {
  const label = agentLabel?.trim();
  if (label) {
    return /^[A-Z][a-z]/u.test(label) ? lowerFirst(label) : label;
  }
  const match = /^([A-Za-z-]+)(.*)$/su.exec(wording.live);
  const base = match ? GERUND_BASES[match[1]!.toLowerCase()] : undefined;
  return base ? `${base}${match![2]}` : null;
}

/** How a step that did not work reads: "Couldn't delete scratch.md". */
export function failedPhrase(wording: Phrase, agentLabel: string | null): string {
  const base = basePhrase(wording, agentLabel);
  return base ? `Couldn't ${base}` : `${wording.past} (failed)`;
}

/** How a step that never ran reads: "You declined to delete scratch.md" when
 *  the user turned it down, "Blocked: delete scratch.md" when a guard did. */
export function blockedPhrase(wording: Phrase, agentLabel: string | null, byUser: boolean): string {
  const base = basePhrase(wording, agentLabel);
  if (!base) {
    return `${wording.past} (${byUser ? "declined" : "blocked"})`;
  }
  return byUser ? `You declined to ${base}` : `Blocked: ${base}`;
}

/** A task's label as it reads while the task runs: "Fix the login bug" turns
 *  to "Fixing the login bug". A lead verb that cannot be turned safely stays
 *  as written, and nothing is cut short. */
export function presentTense(label: string): string {
  return conjugateLeadVerb(label, "live") ?? label;
}

/** An agent-written step label, turned to past and present where that is
 *  safe, else kept as written. */
export function describeAgentLabel(label: string): Phrase {
  const text = truncate(label, 120);
  return phrase(conjugateLeadVerb(text, "past") ?? text, conjugateLeadVerb(text, "live") ?? text);
}
