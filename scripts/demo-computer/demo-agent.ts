#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * Demo agent (scripted): the coding agent of the demo computer that
 * assistant-directory reviewers connect to (docs/design/assistants.md, "The
 * demo computer"). Threadlines runs it in place of Codex, Claude or another
 * real agent, so a review costs no model bill and touches no real code.
 *
 * It is a plain Node script with no dependencies, speaking the Agent Client
 * Protocol (newline-delimited JSON-RPC over stdio). It does real work on the
 * sample repos: it edits files in the session's folder, can commit them, can
 * ask the user a question, ask for an approval, keep working until stopped,
 * or fail on purpose. What it does is picked by keyword rules from the user's
 * message (see `pickPlan`), and every reply says it is scripted.
 *
 * Threadlines starts it through an ACP provider instance whose `binaryPath`
 * points here (`demo-fixtures.ts settings` writes it), so it also answers the
 * status checks of the drivers that can host it: `about --format json`
 * (Cursor's, the one the demo uses) and `--version` / `status --json` (fx's).
 *
 * Environment:
 * - DEMO_AGENT_STEP_MS: pause between steps, so a watcher sees it working (default 400).
 * - DEMO_AGENT_WATCH_MINUTES: how long a "keep working" turn lasts if nobody stops it (default 1440).
 * - DEMO_AGENT_RUN_DIR: where it records the folders it works in (agentFolders.ts).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import { forgetThisAgent, recordAgentFolders } from "./agentFolders.ts";

const AGENT_NAME = "Demo agent (scripted)";
const AGENT_VERSION = "1.0.0";
const MODEL_ID = "scripted";
const MODEL_NAME = "Scripted demo";
/** What the status checks report as the signed-in account: there is none. */
const NO_ACCOUNT = "No account (scripted demo)";
const COMMIT_AUTHOR = ["-c", "user.name=Demo agent (scripted)"] as const;
const COMMIT_EMAIL = ["-c", "user.email=demo-agent@threadlines.invalid"] as const;
/** Threadlines' text generation (titles, branch names, commit messages) names itself so. */
const TEXT_GENERATION_CLIENT = "threadlines-git-text";

const STEP_MS = numberFromEnv("DEMO_AGENT_STEP_MS", 400);
const WATCH_MS = numberFromEnv("DEMO_AGENT_WATCH_MINUTES", 24 * 60) * 60_000;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

type JsonObject = { readonly [key: string]: unknown };

interface RpcError {
  readonly code: number;
  readonly message: string;
}

class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

let nextOutgoingId = 1;
const awaitingReplies = new Map<
  number,
  { readonly resolve: (value: unknown) => void; readonly reject: (error: RpcFailure) => void }
>();

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function notify(method: string, params: JsonObject): void {
  send({ method, params });
}

/** A request to the client (Threadlines), answered by id. */
function request(method: string, params: JsonObject): Promise<unknown> {
  const id = nextOutgoingId++;
  return new Promise((resolve, reject) => {
    awaitingReplies.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

const asObject = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface Session {
  readonly id: string;
  readonly cwd: string;
  modelId: string;
  /** Set by `session/cancel`; the running turn checks it between steps. */
  cancelled: boolean;
  readonly onCancel: Set<() => void>;
}

const sessions = new Map<string, Session>();
let clientName = "";

const configOptions = (session: Session) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.modelId,
    options: [
      {
        value: MODEL_ID,
        name: MODEL_NAME,
        description: "Follows keyword rules. No language model.",
      },
    ],
  },
];

function sessionOf(params: JsonObject): Session {
  const id = asString(params.sessionId) ?? "";
  const session = sessions.get(id);
  if (!session) throw new RpcFailure(-32602, `Unknown session: ${id}`);
  return session;
}

async function handleRequest(method: string, params: JsonObject): Promise<unknown> {
  switch (method) {
    case "initialize": {
      clientName = asString(asObject(params.clientInfo).name) ?? "";
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
        },
        authMethods: [],
        agentInfo: { name: "demo-agent", title: AGENT_NAME, version: AGENT_VERSION },
      };
    }
    case "authenticate":
      return {};
    case "session/new": {
      const cwd = asString(params.cwd) ?? process.cwd();
      const session: Session = {
        // Unique per session: Threadlines keys reply ids on it.
        id: `demo-${randomUUID()}`,
        cwd,
        modelId: MODEL_ID,
        cancelled: false,
        onCancel: new Set(),
      };
      sessions.set(session.id, session);
      recordAgentFolders([process.cwd(), ...[...sessions.values()].map((entry) => entry.cwd)]);
      return { sessionId: session.id, configOptions: configOptions(session) };
    }
    case "session/set_config_option": {
      const session = sessionOf(params);
      if (params.configId === "model" && params.value === MODEL_ID) session.modelId = MODEL_ID;
      return { configOptions: configOptions(session) };
    }
    case "session/set_model":
      sessionOf(params);
      return {};
    case "session/set_mode":
      // No modes: text generation asks for "ask" and carries on without it.
      throw new RpcFailure(-32602, "This agent has no modes.");
    case "session/close":
      sessions.delete(asString(params.sessionId) ?? "");
      return {};
    case "cursor/list_available_models":
      return { models: [{ value: MODEL_ID, configOptions: [] }] };
    case "session/prompt": {
      const session = sessionOf(params);
      session.cancelled = false;
      const text = promptText(params.prompt);
      return clientName === TEXT_GENERATION_CLIENT || isTextGenerationPrompt(text)
        ? answerTextGeneration(session, text)
        : runTurn(session, userMessageOf(text));
    }
    default:
      throw new RpcFailure(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, params: JsonObject): void {
  if (method !== "session/cancel") return;
  const session = sessions.get(asString(params.sessionId) ?? "");
  if (!session) return;
  session.cancelled = true;
  for (const wake of session.onCancel) wake();
  session.onCancel.clear();
}

function handleLine(line: string): void {
  if (line.trim() === "") return;
  let message: JsonObject;
  try {
    message = asObject(JSON.parse(line));
  } catch {
    return;
  }
  const id = message.id;
  const method = asString(message.method);
  if (method === undefined) {
    // A reply to one of our requests.
    const waiting = typeof id === "number" ? awaitingReplies.get(id) : undefined;
    if (!waiting || typeof id !== "number") return;
    awaitingReplies.delete(id);
    const error = message.error as RpcError | undefined;
    if (error) waiting.reject(new RpcFailure(error.code, error.message));
    else waiting.resolve(message.result);
    return;
  }
  const params = asObject(message.params);
  if (id === undefined || id === null) {
    handleNotification(method, params);
    return;
  }
  handleRequest(method, params).then(
    (result) => send({ id, result: result ?? {} }),
    (cause: unknown) => {
      const failure =
        cause instanceof RpcFailure
          ? cause
          : new RpcFailure(INTERNAL_ERROR, cause instanceof Error ? cause.message : String(cause));
      send({ id, error: { code: failure.code, message: failure.message } });
    },
  );
}

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      const entry = asObject(block);
      return entry.type === "text" ? (asString(entry.text) ?? "") : "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

const PREAMBLE_SEPARATOR = "\n\n---\n\n";

/**
 * The user's own words: Threadlines may put a note about the sending device
 * or a handoff summary in front of them, separated by a rule.
 */
function userMessageOf(text: string): string {
  let rest = text.trim();
  for (;;) {
    if (rest.startsWith("<conversation-handoff")) {
      const end = rest.indexOf("</conversation-handoff>");
      if (end < 0) return rest;
      rest = rest.slice(end + "</conversation-handoff>".length).replace(/^\s*---\s*/u, "");
      continue;
    }
    if (rest.startsWith("The user sent this message")) {
      const end = rest.indexOf(PREAMBLE_SEPARATOR);
      if (end < 0) return rest;
      rest = rest.slice(end + PREAMBLE_SEPARATOR.length);
      continue;
    }
    return rest.trim();
  }
}

function update(session: Session, value: JsonObject): void {
  notify("session/update", { sessionId: session.id, update: value });
}

function say(session: Session, text: string): void {
  update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

/** Waits `ms`, or less if the turn is cancelled. */
function pause(session: Session, ms: number): Promise<void> {
  if (ms <= 0 || session.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      session.onCancel.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    session.onCancel.add(wake);
  });
}

// ---------------------------------------------------------------------------
// What to do: keyword rules
// ---------------------------------------------------------------------------

type RepoKind = "javascript" | "python" | "docs";

type PlanKind =
  | "fail"
  | "watch"
  | "explain"
  | "question"
  | "approval"
  | "helper"
  | "readme"
  | "changelog"
  | "page";

interface Plan {
  readonly kind: PlanKind;
  /** Also commit what it changed. */
  readonly commit: boolean;
}

const has = (text: string, pattern: RegExp) => pattern.test(text);

/**
 * The keyword rules, first match wins. Documented for reviewers in
 * docker/demo/README.md; keep the two in step.
 */
function pickPlan(message: string, repo: RepoKind): Plan {
  const text = message.toLowerCase();
  const commit = has(text, /\bcommit\b/u);
  const plan = (kind: PlanKind): Plan => ({ kind, commit });
  if (has(text, /\bfail\b/u)) return plan("fail");
  if (has(text, /\bkeep (working|watching|going)\b|\bwatch\b|\blong[- ]running\b/u)) {
    return plan("watch");
  }
  if (has(text, /\bask me\b|\bquestion\b|\bwhich (one|change)\b/u)) return plan("question");
  if (has(text, /\bapproval\b|\bpermission\b|\bdelete\b|\bremove\b/u)) return plan("approval");
  if (has(text, /\bexplain\b|\bsummar(y|i[sz]e)\b|\bwhat does\b|\bdescribe\b/u)) {
    return plan("explain");
  }
  if (has(text, /\breadme\b/u)) return plan("readme");
  if (has(text, /\bchangelog\b/u)) return plan("changelog");
  if (has(text, /\bpage\b|\bdocs?\b/u) && repo === "docs") return plan("page");
  return plan(repo === "docs" ? "page" : "helper");
}

function repoKindOf(cwd: string): RepoKind {
  if (exists(cwd, "package.json")) return "javascript";
  if (
    exists(cwd, "pyproject.toml") ||
    NodeFS.readdirSync(cwd).some((name) => name.endsWith(".py"))
  ) {
    return "python";
  }
  return "docs";
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

interface FileChange {
  /** Relative to the session's folder. */
  readonly path: string;
  readonly before: string | null;
  /** Null deletes the file. */
  readonly after: string | null;
}

interface Helper {
  readonly name: string;
  readonly pythonName: string;
  readonly keywords: RegExp;
  readonly summary: string;
  readonly js: string;
  readonly jsTest: string;
  readonly python: string;
  readonly pythonTest: string;
}

const HELPERS: ReadonlyArray<Helper> = [
  {
    name: "clamp",
    pythonName: "clamp",
    keywords: /\bclamp|\brange\b|\blimit/u,
    summary: "keeps a number inside a range",
    js: `/** Keeps \`value\` between \`min\` and \`max\`. */
export function clamp(value, min, max) {
  if (min > max) throw new RangeError("min must not be greater than max");
  return Math.min(Math.max(value, min), max);
}
`,
    jsTest: `test("clamp keeps a value inside the range", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(42, 0, 10), 10);
});
`,
    python: `def clamp(value: float, low: float, high: float) -> float:
    """Keep value between low and high."""
    if low > high:
        raise ValueError("low must not be greater than high")
    return min(max(value, low), high)
`,
    pythonTest: `def test_clamp_keeps_a_value_inside_the_range():
    assert clamp(5, 0, 10) == 5
    assert clamp(-3, 0, 10) == 0
    assert clamp(42, 0, 10) == 10
`,
  },
  {
    name: "slugify",
    pythonName: "slugify",
    keywords: /\bslug/u,
    summary: "turns a title into a URL-safe slug",
    js: `/** Lowercases \`text\` and joins its words with dashes, for URLs. */
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`,
    jsTest: `test("slugify joins words with dashes", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Many   spaces  "), "many-spaces");
});
`,
    python: `import re


def slugify(text: str) -> str:
    """Lowercase text and join its words with dashes, for URLs."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
`,
    pythonTest: `def test_slugify_joins_words_with_dashes():
    assert slugify("Hello, World!") == "hello-world"
    assert slugify("  Many   spaces  ") == "many-spaces"
`,
  },
  {
    name: "chunk",
    pythonName: "chunk",
    keywords: /\bchunk|\bbatch|\bsplit/u,
    summary: "splits a list into fixed-size pieces",
    js: `/** Splits \`items\` into arrays of at most \`size\` items. */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const pieces = [];
  for (let start = 0; start < items.length; start += size) {
    pieces.push(items.slice(start, start + size));
  }
  return pieces;
}
`,
    jsTest: `test("chunk splits a list into pieces", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});
`,
    python: `def chunk(items: list, size: int) -> list:
    """Split items into lists of at most size items."""
    if size < 1:
        raise ValueError("size must be a positive integer")
    return [items[start : start + size] for start in range(0, len(items), size)]
`,
    pythonTest: `def test_chunk_splits_a_list_into_pieces():
    assert chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert chunk([], 3) == []
`,
  },
  {
    name: "titleCase",
    pythonName: "title_case",
    keywords: /\btitle/u,
    summary: "capitalizes each word of a phrase",
    js: `/** Capitalizes the first letter of each word in \`text\`. */
export function titleCase(text) {
  return text.replace(/\\b([a-z])/g, (letter) => letter.toUpperCase());
}
`,
    jsTest: `test("titleCase capitalizes each word", () => {
  assert.equal(titleCase("the quick brown fox"), "The Quick Brown Fox");
});
`,
    python: `def title_case(text: str) -> str:
    """Capitalize the first letter of each word in text."""
    return " ".join(word[:1].upper() + word[1:] for word in text.split(" "))
`,
    pythonTest: `def test_title_case_capitalizes_each_word():
    assert title_case("the quick brown fox") == "The Quick Brown Fox"
`,
  },
];

const DOC_PAGES: ReadonlyArray<{
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}> = [
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    body: "If something looks wrong, start here.\n\n## The command is not found\n\nOpen a new terminal so your shell reloads its PATH, then try again.\n\n## Nothing happens after an update\n\nQuit the app fully and open it again.\n",
  },
  {
    slug: "faq",
    title: "Questions people ask",
    body: "## Does it work offline?\n\nYes. Only updates need the network.\n\n## Where are my settings kept?\n\nIn one file in your home folder, so a backup of that folder includes them.\n",
  },
  {
    slug: "glossary",
    title: "Glossary",
    body: "- **Project:** a folder you work in.\n- **Workspace:** the set of projects open together.\n- **Profile:** the settings one person uses.\n",
  },
];

/**
 * Where `path` (relative to the session's folder) really is, or undefined
 * when that is outside the folder: `..` and absolute paths, and symlinks
 * (followed through every part that exists) leading out of it. Every read,
 * write and delete goes through this, since paths can come from the message.
 */
function insideFolder(cwd: string, path: string): string | undefined {
  let root: string;
  try {
    root = NodeFS.realpathSync(cwd);
  } catch {
    return undefined;
  }
  // The deepest part that exists (a link counts, dangling or not), then the rest.
  const missing: Array<string> = [];
  let existing = NodePath.resolve(root, path);
  for (;;) {
    try {
      NodeFS.lstatSync(existing);
      break;
    } catch {
      const parent = NodePath.dirname(existing);
      if (parent === existing) return undefined;
      missing.unshift(NodePath.basename(existing));
      existing = parent;
    }
  }
  let real: string;
  try {
    real = NodeFS.realpathSync(existing);
  } catch {
    // A dangling link: writing through it would land wherever it points.
    return undefined;
  }
  const resolved = NodePath.join(real, ...missing);
  const relative = NodePath.relative(root, resolved);
  const outside =
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative);
  return outside ? undefined : resolved;
}

function readText(cwd: string, path: string): string | null {
  const real = insideFolder(cwd, path);
  if (real === undefined) return null;
  try {
    return NodeFS.readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

function exists(cwd: string, path: string): boolean {
  const real = insideFolder(cwd, path);
  return real !== undefined && NodeFS.existsSync(real);
}

/** A short, one-line version of the user's request, for notes in files. */
function requestSummary(message: string): string {
  const firstLine = message.split(/\r?\n/u).find((line) => line.trim() !== "") ?? "";
  const words = firstLine
    .trim()
    .replace(/\s+/gu, " ")
    // What to do with the change afterwards isn't part of it.
    .replace(/,? (and|then) commit\b.*$/iu, "")
    .replace(/^(now|please|ok|okay),? /iu, "");
  const clipped = words.length > 90 ? `${words.slice(0, 87).trimEnd()}...` : words;
  const sentence = clipped.replace(/[.!?]+$/u, "");
  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : "Requested change";
}

/** The first helper the message names, else the first one the repo lacks. */
function pickHelper(cwd: string, repo: RepoKind, message: string): Helper | undefined {
  const lower = message.toLowerCase();
  const present = (helper: Helper) =>
    repo === "javascript"
      ? exists(cwd, `src/${helper.name}.js`)
      : exists(cwd, NodePath.join(pythonPackageOf(cwd), `${helper.pythonName}.py`));
  return (
    HELPERS.find((helper) => helper.keywords.test(lower) && !present(helper)) ??
    HELPERS.find((helper) => !present(helper))
  );
}

/** The Python package folder (the first one with an `__init__.py`), else ".". */
function pythonPackageOf(cwd: string): string {
  const folder = NodeFS.readdirSync(cwd, { withFileTypes: true }).find(
    (entry) =>
      entry.isDirectory() && entry.name !== "tests" && exists(cwd, `${entry.name}/__init__.py`),
  );
  return folder?.name ?? ".";
}

function helperChanges(cwd: string, repo: RepoKind, helper: Helper): Array<FileChange> {
  if (repo === "javascript") {
    const changes: Array<FileChange> = [
      { path: `src/${helper.name}.js`, before: null, after: helper.js },
      {
        path: `test/${helper.name}.test.js`,
        before: null,
        after: `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { ${helper.name} } from "../src/${helper.name}.js";\n\n${helper.jsTest}`,
      },
    ];
    const index = readText(cwd, "src/index.js");
    if (index !== null) {
      changes.push({
        path: "src/index.js",
        before: index,
        after: `${index.trimEnd()}\nexport { ${helper.name} } from "./${helper.name}.js";\n`,
      });
    }
    return changes;
  }
  const pkg = pythonPackageOf(cwd);
  const modulePath = pkg === "." ? `${helper.pythonName}.py` : `${pkg}/${helper.pythonName}.py`;
  const importFrom = pkg === "." ? helper.pythonName : `${pkg}.${helper.pythonName}`;
  return [
    { path: modulePath, before: null, after: helper.python },
    {
      path: `tests/test_${helper.pythonName}.py`,
      before: null,
      after: `from ${importFrom} import ${helper.pythonName}\n\n\n${helper.pythonTest}`,
    },
  ];
}

/** Adds `line` under `heading` in a markdown file, creating either if missing. */
function appendUnderHeading(
  cwd: string,
  path: string,
  heading: string,
  line: string,
  fileTitle: string,
): FileChange {
  const before = readText(cwd, path);
  const base = before ?? `# ${fileTitle}\n`;
  const marker = `## ${heading}\n`;
  const at = base.indexOf(marker);
  const after =
    at < 0
      ? `${base.trimEnd()}\n\n${marker}\n${line}\n`
      : `${base.slice(0, at + marker.length)}\n${line}${base.slice(at + marker.length).replace(/^\n?/u, "\n")}`;
  return { path, before, after };
}

function changelogChange(cwd: string, entry: string): FileChange {
  return appendUnderHeading(cwd, "CHANGELOG.md", "Unreleased", `- ${entry}`, "Changelog");
}

function readmeChange(cwd: string, message: string): FileChange {
  return appendUnderHeading(
    cwd,
    "README.md",
    "Recent changes",
    `- ${requestSummary(message)}.`,
    NodePath.basename(cwd),
  );
}

function pageChanges(cwd: string): { readonly changes: Array<FileChange>; readonly title: string } {
  const page = DOC_PAGES.find((candidate) => !exists(cwd, `docs/${candidate.slug}.md`));
  if (!page) {
    return {
      changes: [changelogChange(cwd, "Reviewed the docs pages; nothing new to add.")],
      title: "",
    };
  }
  return {
    title: page.title,
    changes: [
      { path: `docs/${page.slug}.md`, before: null, after: `# ${page.title}\n\n${page.body}` },
      appendUnderHeading(
        cwd,
        "README.md",
        "Pages",
        `- [${page.title}](docs/${page.slug}.md)`,
        NodePath.basename(cwd),
      ),
    ],
  };
}

/** Writes the changes and shows each one as an edit in the thread. */
async function applyChanges(session: Session, changes: ReadonlyArray<FileChange>): Promise<void> {
  for (const change of changes) {
    if (session.cancelled) return;
    const absolute = insideFolder(session.cwd, change.path);
    if (absolute === undefined) {
      throw new RpcFailure(
        INTERNAL_ERROR,
        `Demo agent: refused to touch ${change.path}, which is outside this thread's folder.`,
      );
    }
    const toolCallId = `edit-${randomUUID()}`;
    const title = change.after === null ? `Delete ${change.path}` : `Edit ${change.path}`;
    update(session, {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: change.after === null ? "delete" : "edit",
      status: "in_progress",
      locations: [{ path: absolute }],
    });
    if (change.after === null) {
      NodeFS.rmSync(absolute, { force: true });
    } else {
      NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
      NodeFS.writeFileSync(absolute, change.after);
    }
    update(session, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      ...(change.after === null
        ? {}
        : {
            content: [
              { type: "diff", path: absolute, oldText: change.before, newText: change.after },
            ],
          }),
    });
    await pause(session, STEP_MS);
  }
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Commits everything in the session's folder; returns the short commit id, or why it couldn't. */
function commit(
  session: Session,
  subject: string,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string } {
  try {
    git(session.cwd, ["add", "-A"]);
    git(session.cwd, [...COMMIT_AUTHOR, ...COMMIT_EMAIL, "commit", "--quiet", "-m", subject]);
    return { ok: true, id: git(session.cwd, ["rev-parse", "--short", "HEAD"]).trim() };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return { ok: false, reason: detail ?? "git failed" };
  }
}

const SCRIPTED_NOTE =
  "(I'm the scripted demo agent: I pick a small, fixed change from keywords in your message, and I don't run tests.)";

const fileList = (changes: ReadonlyArray<FileChange>) =>
  changes.map((change) => `\`${change.path}\``).join(", ");

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

type PromptResult = { readonly stopReason: "end_turn" | "cancelled" };

async function runTurn(session: Session, message: string): Promise<PromptResult> {
  if (!NodeFS.existsSync(session.cwd)) {
    throw new RpcFailure(INTERNAL_ERROR, `The folder ${session.cwd} doesn't exist.`);
  }
  const repo = repoKindOf(session.cwd);
  const plan = pickPlan(message, repo);
  update(session, {
    sessionUpdate: "plan",
    entries: [
      { content: "Read the request", priority: "high", status: "completed" },
      { content: planLabel(plan.kind), priority: "high", status: "in_progress" },
    ],
  });
  await pause(session, STEP_MS);
  if (session.cancelled) return { stopReason: "cancelled" };

  switch (plan.kind) {
    case "fail":
      say(
        session,
        "Stopping with an error, because your message asked me to fail. Nothing changed.",
      );
      await pause(session, STEP_MS);
      throw new RpcFailure(
        INTERNAL_ERROR,
        "Demo agent: failed on purpose (the message contained the word 'fail').",
      );
    case "watch":
      return watch(session);
    case "explain":
      say(session, explain(session.cwd, repo));
      return { stopReason: "end_turn" };
    case "question":
      return askThenAct(session, repo, message, plan);
    case "approval":
      return removeWithApproval(session, message, plan);
    default:
      return act(session, repo, message, plan, plan.kind);
  }
}

function planLabel(kind: PlanKind): string {
  switch (kind) {
    case "fail":
      return "Fail on purpose";
    case "watch":
      return "Keep watching until stopped";
    case "explain":
      return "Describe the project";
    case "question":
      return "Ask which change to make";
    case "approval":
      return "Ask before removing a file";
    case "readme":
      return "Update the README";
    case "changelog":
      return "Add a changelog entry";
    case "page":
      return "Add a docs page";
    case "helper":
      return "Add a helper with a test";
  }
}

type EditKind = Extract<PlanKind, "helper" | "readme" | "changelog" | "page">;

async function act(
  session: Session,
  repo: RepoKind,
  message: string,
  plan: Plan,
  kind: EditKind,
): Promise<PromptResult> {
  const cwd = session.cwd;
  let changes: Array<FileChange>;
  let summary: string;
  switch (kind) {
    case "helper": {
      const helper = repo === "docs" ? undefined : pickHelper(cwd, repo, message);
      if (!helper) return act(session, repo, message, plan, "changelog");
      const name = repo === "python" ? helper.pythonName : helper.name;
      changes = [
        ...helperChanges(cwd, repo, helper),
        changelogChange(cwd, `Added \`${name}\`, which ${helper.summary}.`),
      ];
      summary = `I added \`${name}\`, which ${helper.summary}, with a test, and noted it in the changelog. Files: ${fileList(changes)}.`;
      break;
    }
    case "readme":
      changes = [readmeChange(cwd, message)];
      summary = 'I added a line about your request under "Recent changes" in `README.md`.';
      break;
    case "changelog":
      changes = [changelogChange(cwd, `${requestSummary(message)}.`)];
      summary = "I added your request to the Unreleased section of `CHANGELOG.md`.";
      break;
    case "page": {
      const page = pageChanges(cwd);
      changes = page.changes;
      summary = page.title
        ? `I added a "${page.title}" page and linked it from the README. Files: ${fileList(changes)}.`
        : "Every page I know how to write is already here, so I only noted that in `CHANGELOG.md`.";
      break;
    }
  }
  await applyChanges(session, changes);
  if (session.cancelled) return { stopReason: "cancelled" };
  return finish(session, plan, changes, summary);
}

function finish(
  session: Session,
  plan: Plan,
  changes: ReadonlyArray<FileChange>,
  summary: string,
): PromptResult {
  let committed = "The changes aren't committed.";
  if (plan.commit && changes.length > 0) {
    const result = commit(session, commitSubject(changes));
    committed = result.ok
      ? `I committed everything in this checkout as ${result.id}.`
      : `I couldn't commit them: ${result.reason}`;
  }
  say(session, `${summary} ${committed}\n\n${SCRIPTED_NOTE}`);
  return { stopReason: "end_turn" };
}

function commitSubject(changes: ReadonlyArray<FileChange>): string {
  const added = changes.find((change) => change.before === null && change.after !== null);
  return added ? `Add ${NodePath.basename(added.path)}` : `Update ${changes[0]?.path ?? "files"}`;
}

/** A real question: Threadlines shows it, and the user (or an assistant) answers it. */
async function askThenAct(
  session: Session,
  repo: RepoKind,
  message: string,
  plan: Plan,
): Promise<PromptResult> {
  const choices: ReadonlyArray<{ readonly id: EditKind; readonly label: string }> = [
    repo === "docs"
      ? { id: "page", label: "Add a docs page" }
      : { id: "helper", label: "Add a helper with a test" },
    { id: "readme", label: "Update the README" },
    { id: "changelog", label: "Add a changelog entry" },
  ];
  say(session, "Before I change anything, I have a question for you.");
  let picked: EditKind | undefined;
  try {
    const reply = asObject(
      await request("cursor/ask_question", {
        toolCallId: `question-${randomUUID()}`,
        title: "Question",
        questions: [
          {
            id: "change",
            prompt: "Which change should I make?",
            options: choices.map((choice) => ({ id: choice.id, label: choice.label })),
          },
        ],
      }),
    );
    const raw = asObject(reply.answers).change;
    const answer = Array.isArray(raw) ? raw[0] : raw;
    picked = choices.find((choice) => choice.label === answer || choice.id === answer)?.id;
  } catch (cause) {
    if (!(cause instanceof RpcFailure) || cause.code !== METHOD_NOT_FOUND) throw cause;
    // A host without questions (the fx driver): ask for the first choice as an approval.
    const allowed = await askPermission(session, {
      title: `${choices[0]!.label}?`,
      kind: "edit",
      detail: "This host can't show questions, so I'm asking for an approval instead.",
    });
    picked = allowed ? choices[0]!.id : undefined;
  }
  if (session.cancelled) return { stopReason: "cancelled" };
  if (!picked) {
    say(session, `No answer I recognized, so I left everything as it was.\n\n${SCRIPTED_NOTE}`);
    return { stopReason: "end_turn" };
  }
  const label = choices.find((choice) => choice.id === picked)?.label ?? "";
  // Notes in files name the answer, not the "ask me" request.
  return act(session, repo, `${label} (your answer to my question)`, plan, picked);
}

async function askPermission(
  session: Session,
  input: { readonly title: string; readonly kind: string; readonly detail: string },
): Promise<boolean> {
  const toolCallId = `permission-${randomUUID()}`;
  update(session, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: input.title,
    kind: input.kind,
    status: "pending",
  });
  const reply = asObject(
    await request("session/request_permission", {
      sessionId: session.id,
      toolCall: {
        toolCallId,
        title: input.title,
        kind: input.kind,
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: input.detail } }],
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Don't allow", kind: "reject_once" },
      ],
    }),
  );
  const outcome = asObject(reply.outcome);
  const allowed = outcome.outcome === "selected" && outcome.optionId === "allow-once";
  update(session, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: allowed ? "completed" : "failed",
  });
  return allowed;
}

/**
 * The file a removal is about: one the message names, else the sample's
 * outdated page. Only a regular file inside the thread's folder qualifies.
 */
function removalTarget(cwd: string, message: string): string | undefined {
  const isFile = (path: string) => {
    const real = insideFolder(cwd, path);
    return (
      real !== undefined && NodeFS.statSync(real, { throwIfNoEntry: false })?.isFile() === true
    );
  };
  const named = message
    .split(/\s+/u)
    .map((word) => word.replace(/^[`'"(]+|[`'",.;:)]+$/gu, ""))
    .find((word) => word.includes(".") && isFile(word));
  if (named) return named;
  return ["docs/old-install.md", "OLD_NOTES.md"].find(isFile);
}

async function removeWithApproval(
  session: Session,
  message: string,
  plan: Plan,
): Promise<PromptResult> {
  const target = removalTarget(session.cwd, message);
  if (!target) {
    say(
      session,
      `I couldn't find a file to remove: name one that exists in this project.\n\n${SCRIPTED_NOTE}`,
    );
    return { stopReason: "end_turn" };
  }
  const allowed = await askPermission(session, {
    title: `Delete ${target}`,
    kind: "delete",
    detail: `Removes ${target} from the project.`,
  });
  if (session.cancelled) return { stopReason: "cancelled" };
  if (!allowed) {
    say(session, `You didn't allow it, so \`${target}\` stays.\n\n${SCRIPTED_NOTE}`);
    return { stopReason: "end_turn" };
  }
  const changes: Array<FileChange> = [
    { path: target, before: readText(session.cwd, target), after: null },
  ];
  const readme = readText(session.cwd, "README.md");
  if (readme?.includes(`(${target})`)) {
    changes.push({
      path: "README.md",
      before: readme,
      after: readme
        .split("\n")
        .filter((line) => !line.includes(`(${target})`))
        .join("\n"),
    });
  }
  await applyChanges(session, changes);
  if (session.cancelled) return { stopReason: "cancelled" };
  return finish(session, plan, changes, `I removed \`${target}\` (and any README link to it).`);
}

/** Keeps the turn open, without writing anything, until it is stopped. */
async function watch(session: Session): Promise<PromptResult> {
  const toolCallId = `watch-${randomUUID()}`;
  update(session, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Watch the build until stopped",
    kind: "execute",
    status: "in_progress",
  });
  say(
    session,
    "I'm watching the build and will keep this turn open until you stop it. Nothing changes while I watch.",
  );
  await pause(session, WATCH_MS);
  update(session, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  if (session.cancelled) return { stopReason: "cancelled" };
  say(session, `\n\nI watched for the whole time and saw nothing to fix.\n\n${SCRIPTED_NOTE}`);
  return { stopReason: "end_turn" };
}

function explain(cwd: string, repo: RepoKind): string {
  const readme = readText(cwd, "README.md") ?? "";
  const intro =
    readme
      .split(/\n\s*\n/u)
      .map((block) => block.trim())
      .find((block) => block !== "" && !block.startsWith("#")) ?? "It has no README yet.";
  const files = NodeFS.readdirSync(cwd)
    .filter((name) => !name.startsWith("."))
    .toSorted()
    .map((name) => `\`${name}\``)
    .join(", ");
  const language =
    repo === "javascript"
      ? "a JavaScript package"
      : repo === "python"
        ? "a Python package"
        : "a set of docs";
  return `This project is ${language}. Its README says: ${intro}\n\nTop-level files: ${files}. I didn't change anything.\n\n${SCRIPTED_NOTE}`;
}

// ---------------------------------------------------------------------------
// Text generation (titles, branch names, commit messages): JSON only
// ---------------------------------------------------------------------------

function isTextGenerationPrompt(text: string): boolean {
  return /^Return a JSON object with keys?: /mu.test(text);
}

/** The keys Threadlines asked for, from "Return a JSON object with keys: a, b." */
function requestedKeys(text: string): ReadonlyArray<string> {
  const match = /^Return a JSON object with keys?: ([^\n]+?)\.?$/mu.exec(text);
  return (match?.[1] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

function quotedMessage(text: string): string {
  const start = text.indexOf("<<<\n");
  const end = text.lastIndexOf("\n>>>");
  return start >= 0 && end > start ? text.slice(start + 4, end) : text;
}

function answerTextGeneration(session: Session, text: string): PromptResult {
  const summary = requestSummary(quotedMessage(text));
  const words = summary
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/\s+/u)
    .filter((word) => word !== "");
  const titleWords = words.slice(0, 6);
  // A cut title shouldn't end on "to the".
  while (
    titleWords.length > 2 &&
    /^(a|an|and|for|in|of|on|the|to|with)$/iu.test(titleWords.at(-1)!)
  ) {
    titleWords.pop();
  }
  const title = titleWords.join(" ") || "Demo task";
  const slug =
    summary
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word !== "")
      .slice(0, 4)
      .join("-") || "demo-task";
  const values: Record<string, string> = {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    branch: `chore/${slug}`,
    subject: "Update the sample project",
    body: "Changes made by the scripted demo agent.",
  };
  const answer = Object.fromEntries(requestedKeys(text).map((key) => [key, values[key] ?? ""]));
  say(session, JSON.stringify(answer));
  return { stopReason: "end_turn" };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main(argv: ReadonlyArray<string>): void {
  if (argv.includes("acp")) {
    // The fixtures wait for this record to go before deleting the folders in it.
    recordAgentFolders([process.cwd()]);
    process.on("exit", forgetThisAgent);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => process.exit(0));
    }
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", handleLine);
    lines.on("close", () => process.exit(0));
    return;
  }
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(`demo-agent ${AGENT_VERSION}`);
    return;
  }
  if (command === "about") {
    // Cursor's status check. Threadlines only hands threads to a signed-in
    // agent, and an account is how Cursor says so; this one has none to sign
    // in to, and the name it reports says that.
    console.log(
      rest.includes("json")
        ? JSON.stringify({ cliVersion: AGENT_VERSION, userEmail: NO_ACCOUNT })
        : `CLI Version         ${AGENT_VERSION}\nUser Email          ${NO_ACCOUNT}`,
    );
    return;
  }
  if (command === "status") {
    // fx's status check: no account, nothing to sign in to.
    console.log(JSON.stringify({ auth: NO_ACCOUNT, model: MODEL_ID }));
    return;
  }
  console.error(`${AGENT_NAME}: a scripted ACP agent for the Threadlines demo computer.
Usage: demo-agent acp | --version | about [--format json] | status --json`);
  process.exitCode = 2;
}

main(process.argv.slice(2));
