/**
 * CodexExecRollouts — recognise `codex exec` runs and read the rollout files
 * they leave behind.
 *
 * A Claude thread that shells out to `codex exec …` in the background is, from
 * the user's point of view, running a second agent. The Claude SDK only reports
 * it as a `local_bash` task with a command string, so everything else that
 * makes an agent row rich — which model ran, at what effort, and what it
 * actually did — has to come from the rollout JSONL every `codex exec`
 * invocation writes under `$CODEX_HOME/sessions/YYYY/MM/DD/`.
 *
 * This module owns the three jobs that needs: deciding whether a shell command
 * really is a `codex exec` invocation, correlating a started task with the
 * rollout file it produced, and mapping that file into transcript entries.
 *
 * @module provider/Drivers/CodexExecRollouts
 */
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os";

import type { ProviderSubagentTranscriptEntry } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";

/** Prefix that marks a subagent id as a `codex exec` rollout rather than a
 *  provider-native agent thread. The remainder is the rollout's session id. */
export const CODEX_EXEC_AGENT_ID_PREFIX = "codex-exec:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const TRANSCRIPT_TEXT_MAX_CHARS = 4_000;
const TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS = 2_000;
/** Head lines scanned for the first `turn_context`. It lands within the first
 *  handful of records; a cap keeps a huge rollout from being read whole. */
const HEAD_SCAN_MAX_LINES = 64;
/** Date directories walked when resolving a rollout from its id alone. Codex
 *  files one directory per day, so this is years of history. */
const SESSION_DATE_DIRECTORY_SCAN_LIMIT = 90;
const READ_CHUNK_BYTES = 64 * 1_024;
/** Ceiling on the `session_meta` line, past which the file is not one of ours. */
const FIRST_LINE_MAX_CHARS = 512 * 1_024;

export interface CodexExecInvocation {
  /** Model from an explicit `-m`/`--model` flag. */
  readonly model?: string;
  /** Effort from an explicit `-c model_reasoning_effort=…`. */
  readonly reasoningEffort?: string;
  /** The prompt argument, when it is a plain positional. */
  readonly prompt?: string;
}

/** `codex-exec:<uuid>` → `<uuid>`; anything else is not one of ours. */
export function parseCodexExecAgentId(agentId: string): string | null {
  if (!agentId.startsWith(CODEX_EXEC_AGENT_ID_PREFIX)) {
    return null;
  }
  const sessionId = agentId.slice(CODEX_EXEC_AGENT_ID_PREFIX.length);
  return UUID_PATTERN.test(sessionId) ? sessionId.toLowerCase() : null;
}

export function codexExecAgentId(sessionId: string): string {
  return `${CODEX_EXEC_AGENT_ID_PREFIX}${sessionId}`;
}

interface ShellToken {
  readonly text: string;
  /** False when any part of the token came from inside quotes. A quoted word
   *  can never be the command being run, which is what keeps
   *  `python -c "codex exec …"` from reading as a codex invocation. */
  readonly bare: boolean;
}

/**
 * Split a command line into words the way a shell would, keeping track of
 * which words were quoted. Operators that start a new command
 * (`&&`, `||`, `;`, `|`, newline) become their own segment boundary.
 */
function tokenizeShellSegments(command: string): ReadonlyArray<ReadonlyArray<ShellToken>> {
  const segments: Array<Array<ShellToken>> = [[]];
  let current: string | null = null;
  let bare = true;

  const pushToken = () => {
    if (current !== null) {
      segments[segments.length - 1]!.push({ text: current, bare });
      current = null;
      bare = true;
    }
  };
  const pushSegment = () => {
    pushToken();
    segments.push([]);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\" && index + 1 < command.length) {
      // A line continuation joins the next line; any other escape contributes
      // its literal character to the current word.
      const next = command[index + 1]!;
      index += 1;
      if (next !== "\n") {
        current = (current ?? "") + next;
      }
      continue;
    }
    if (char === `"` || char === "'") {
      const closing = command.indexOf(char, index + 1);
      const body = closing === -1 ? command.slice(index + 1) : command.slice(index + 1, closing);
      current = (current ?? "") + body;
      bare = false;
      index = closing === -1 ? command.length : closing;
      continue;
    }
    if (char === "\n" || char === ";") {
      pushSegment();
      continue;
    }
    if (char === "&" || char === "|") {
      // `cmd &` backgrounds rather than chains, but either way the next word
      // starts a fresh command position, which is all we need.
      if (command[index + 1] === char) {
        index += 1;
      }
      pushSegment();
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      pushToken();
      continue;
    }
    current = (current ?? "") + char;
  }
  pushToken();
  return segments.filter((segment) => segment.length > 0);
}

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/** `NAME=value`, the only thing allowed to precede the program name. */
function isEnvironmentAssignment(token: ShellToken): boolean {
  return token.bare && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.text);
}

/** Wrappers that run their tail as a command, so `codex` may still follow. */
const COMMAND_WRAPPERS = new Set(["env", "nohup", "timeout", "gtimeout", "stdbuf", "nice"]);

function skipWrappers(tokens: ReadonlyArray<ShellToken>): number {
  let index = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    while (index < tokens.length && isEnvironmentAssignment(tokens[index]!)) {
      index += 1;
    }
    const token = tokens[index];
    if (!token?.bare || !COMMAND_WRAPPERS.has(commandBasename(token.text))) {
      return index;
    }
    const wrapper = commandBasename(token.text);
    index += 1;
    // Wrapper options and their operands sit between the wrapper and the real
    // program. `timeout`'s duration is a bare positional, so it is consumed
    // explicitly; everything else stops at the first non-flag word.
    while (index < tokens.length && tokens[index]!.text.startsWith("-")) {
      index += 1;
    }
    if (
      (wrapper === "timeout" || wrapper === "gtimeout") &&
      index < tokens.length &&
      /^\d+(?:\.\d+)?[smhd]?$/u.test(tokens[index]!.text)
    ) {
      index += 1;
    }
  }
  return index;
}

function unquotedFlagValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether this shell command runs `codex exec`, and what it asked for.
 *
 * Deliberately strict: the program word must be a bare `codex` (possibly
 * path-qualified, possibly behind env assignments or a wrapper like
 * `timeout`) at the head of a command position, and the very next word must be
 * the `exec`/`e` subcommand. Anything mentioning "codex exec" as an argument,
 * inside quotes, or under another program is not a match — a false positive
 * would promote an unrelated background command into an agent row, which is
 * worse than leaving a real one as a plain run.
 */
export function matchCodexExecCommand(command: string): CodexExecInvocation | null {
  if (!/\bcodex\b/u.test(command)) {
    return null;
  }
  for (const tokens of tokenizeShellSegments(command)) {
    const start = skipWrappers(tokens);
    const program = tokens[start];
    if (!program?.bare || commandBasename(program.text) !== "codex") {
      continue;
    }
    const subcommand = tokens[start + 1];
    if (!subcommand?.bare || (subcommand.text !== "exec" && subcommand.text !== "e")) {
      continue;
    }
    return readCodexExecFlags(tokens.slice(start + 2));
  }
  return null;
}

function readCodexExecFlags(tokens: ReadonlyArray<ShellToken>): CodexExecInvocation {
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const text = token.text;
    if (text === "-m" || text === "--model") {
      model = unquotedFlagValue(tokens[index + 1]?.text ?? "");
      index += 1;
      continue;
    }
    if (text.startsWith("--model=")) {
      model = unquotedFlagValue(text.slice("--model=".length));
      continue;
    }
    if (text === "-c" || text === "--config") {
      const override = tokens[index + 1]?.text ?? "";
      reasoningEffort = readReasoningEffortOverride(override) ?? reasoningEffort;
      index += 1;
      continue;
    }
    if (text.startsWith("--config=")) {
      reasoningEffort =
        readReasoningEffortOverride(text.slice("--config=".length)) ?? reasoningEffort;
      continue;
    }
    if (text.startsWith("-")) {
      continue;
    }
    if (prompt === undefined && text.trim().length > 0) {
      prompt = text.trim();
    }
  }

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function readReasoningEffortOverride(override: string): string | undefined {
  const match = /^model_reasoning_effort\s*=\s*(.+)$/u.exec(override.trim());
  if (!match) {
    return undefined;
  }
  return unquotedFlagValue(match[1]!.replace(/^["']|["']$/gu, ""));
}

/** `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export function codexExecSessionsRoot(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const configured = environment.CODEX_HOME?.trim();
  const home =
    configured && configured.length > 0
      ? expandHomePath(configured)
      : path.join(homedir(), ".codex");
  return path.resolve(path.join(home, "sessions"));
}

export interface CodexExecRolloutHead {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly startedAt: string | null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) {
    return null;
  }
  try {
    return readRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * The `session_meta` first line, but only for rollouts an `exec` run wrote.
 * App-server sessions share the same directory and filename shape, so the
 * originator is what separates them.
 */
export function readCodexExecRolloutHead(firstLine: string): CodexExecRolloutHead | null {
  const record = parseJsonRecord(firstLine);
  if (!record || record.type !== "session_meta") {
    return null;
  }
  const payload = readRecord(record.payload);
  if (!payload) {
    return null;
  }
  if (readText(payload.originator) !== "codex_exec" && readText(payload.source) !== "exec") {
    return null;
  }
  const sessionId = readText(payload.session_id) ?? readText(payload.id);
  if (!sessionId) {
    return null;
  }
  return {
    sessionId,
    cwd: readText(payload.cwd),
    startedAt: readText(payload.timestamp) ?? readText(record.timestamp),
  };
}

export interface CodexExecTurnContext {
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** Model and effort from the first `turn_context` in the file's head. */
export function readCodexExecTurnContext(lines: Iterable<string>): CodexExecTurnContext | null {
  let scanned = 0;
  for (const line of lines) {
    if (scanned >= HEAD_SCAN_MAX_LINES) {
      break;
    }
    scanned += 1;
    const record = parseJsonRecord(line);
    if (!record || record.type !== "turn_context") {
      continue;
    }
    const payload = readRecord(record.payload);
    if (!payload) {
      continue;
    }
    const model = readText(payload.model);
    const effort =
      readText(payload.effort) ??
      readText(readRecord(readRecord(payload.collaboration_mode)?.settings)?.reasoning_effort);
    if (!model && !effort) {
      continue;
    }
    return {
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  return null;
}

/** Codex's own last word on the run, for the agent row's result line. */
export function readCodexExecFinalMessage(lines: Iterable<string>): string | null {
  let latest: string | null = null;
  for (const line of lines) {
    const record = parseJsonRecord(line);
    if (!record) {
      continue;
    }
    const payload = readRecord(record.payload);
    if (!payload) {
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      latest = readText(payload.last_agent_message) ?? latest;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "agent_message") {
      latest = readText(payload.message) ?? latest;
    }
  }
  return latest;
}

function capText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function readContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      const record = readRecord(part);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export interface CodexExecTranscript {
  readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
  readonly model?: string;
  /** Where the run worked, for the transcript header when there is no prompt. */
  readonly cwd?: string;
  /** The operator's own instruction, which reads better than the cwd. */
  readonly prompt?: string;
}

/**
 * Map a rollout JSONL into renderable transcript entries.
 *
 * Codex records the same turn twice — once as raw `response_item`s for the
 * model and once as `event_msg` summaries for the UI — so this reads the
 * summaries for prose (they carry the user's actual prompt and the agent's
 * finished messages, without the developer-instruction preamble) and the
 * response items for the work (reasoning summaries and tool calls). Tool
 * output is folded back into the call it belongs to by `call_id`.
 */
export function mapCodexExecRolloutTranscript(lines: Iterable<string>): CodexExecTranscript {
  const entries: Array<
    ProviderSubagentTranscriptEntry & { toolUses: Array<{ name: string; summary: string }> }
  > = [];
  const toolEntryByCallId = new Map<string, number>();
  let model: string | undefined;
  let cwd: string | undefined;
  let prompt: string | undefined;

  const push = (
    entry: Omit<ProviderSubagentTranscriptEntry, "toolUses"> & {
      readonly toolUses?: ReadonlyArray<{ name: string; summary: string }>;
    },
  ): number => {
    entries.push({ ...entry, toolUses: [...(entry.toolUses ?? [])] });
    return entries.length - 1;
  };

  for (const line of lines) {
    const record = parseJsonRecord(line);
    if (!record) {
      continue;
    }
    const payload = readRecord(record.payload);
    if (!payload) {
      continue;
    }
    const at = readText(record.timestamp) ?? undefined;
    const withAt = <T extends object>(entry: T) => ({ ...entry, ...(at ? { at } : {}) });

    if (record.type === "session_meta") {
      cwd = readText(payload.cwd) ?? cwd;
      continue;
    }
    if (record.type === "turn_context") {
      model = readText(payload.model) ?? model;
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "user_message") {
        const text = readText(payload.message);
        if (text) {
          prompt = prompt ?? text;
          push(withAt({ role: "user" as const, text: capText(text, TRANSCRIPT_TEXT_MAX_CHARS) }));
        }
        continue;
      }
      if (payload.type === "agent_message") {
        const text = readText(payload.message);
        if (text) {
          push(
            withAt({ role: "assistant" as const, text: capText(text, TRANSCRIPT_TEXT_MAX_CHARS) }),
          );
        }
        continue;
      }
      if (payload.type === "agent_reasoning") {
        const text = readText(payload.text);
        if (text) {
          push(
            withAt({ role: "thinking" as const, text: capText(text, TRANSCRIPT_TEXT_MAX_CHARS) }),
          );
        }
        continue;
      }
      if (payload.type === "web_search_end") {
        const query = readText(payload.query);
        if (query) {
          push(
            withAt({
              role: "assistant" as const,
              text: "",
              toolUses: [{ name: "web_search", summary: query }],
            }),
          );
        }
        continue;
      }
      if (payload.type === "patch_apply_end") {
        const changes = readRecord(payload.changes);
        const summary = changes ? Object.keys(changes).join(", ") : null;
        if (summary) {
          push(
            withAt({
              role: "assistant" as const,
              text: "",
              toolUses: [{ name: "apply_patch", summary }],
            }),
          );
        }
        continue;
      }
      continue;
    }
    if (record.type !== "response_item") {
      continue;
    }

    switch (payload.type) {
      case "reasoning": {
        const summary = Array.isArray(payload.summary)
          ? payload.summary
              .map((part) => {
                const partRecord = readRecord(part);
                return partRecord && typeof partRecord.text === "string" ? partRecord.text : "";
              })
              .filter((text) => text.length > 0)
              .join("\n")
          : "";
        if (summary.trim().length > 0) {
          push(
            withAt({
              role: "thinking" as const,
              text: capText(summary, TRANSCRIPT_TEXT_MAX_CHARS),
            }),
          );
        }
        break;
      }
      case "custom_tool_call":
      case "function_call": {
        const name = readText(payload.name) ?? "tool";
        const rawInput =
          typeof payload.input === "string"
            ? payload.input
            : typeof payload.arguments === "string"
              ? payload.arguments
              : "";
        const index = push(
          withAt({
            role: "assistant" as const,
            text: "",
            toolUses: [{ name, summary: capText(rawInput, TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS) }],
          }),
        );
        const callId = readText(payload.call_id);
        if (callId) {
          toolEntryByCallId.set(callId, index);
        }
        break;
      }
      case "custom_tool_call_output":
      case "function_call_output": {
        const callId = readText(payload.call_id);
        const index = callId === null ? undefined : toolEntryByCallId.get(callId);
        const preview = capText(
          readContentText(payload.output),
          TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS,
        );
        if (index === undefined || preview.length === 0) {
          break;
        }
        entries[index] = { ...entries[index]!, outputPreview: preview };
        break;
      }
      default:
        break;
    }
  }

  return {
    entries,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function readFileLines(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> {
  return fileSystem.readFileString(filePath).pipe(Effect.map((text) => text.split("\n")));
}

/**
 * The rollout's `session_meta` line, read without pulling in the rest of the
 * file. Every candidate in a day's directory gets opened during correlation
 * and a long transcript runs to megabytes, so this stops at the first newline.
 * `session_meta` carries the full base instructions and is itself tens of
 * kilobytes, hence the generous cap.
 */
function readFirstLine(fileSystem: FileSystem.FileSystem, filePath: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(filePath);
      const decoder = new TextDecoder();
      let head = "";
      while (head.length < FIRST_LINE_MAX_CHARS) {
        const chunk = yield* file.readAlloc(READ_CHUNK_BYTES);
        if (Option.isNone(chunk) || chunk.value.length === 0) {
          break;
        }
        head += decoder.decode(chunk.value, { stream: true });
        const newline = head.indexOf("\n");
        if (newline !== -1) {
          return head.slice(0, newline);
        }
      }
      return head;
    }),
  ).pipe(Effect.catch(() => Effect.succeed("")));
}

function dateDirectorySegments(date: Date): ReadonlyArray<string> {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day];
}

function realPath(fileSystem: FileSystem.FileSystem, candidate: string) {
  return fileSystem.realPath(candidate).pipe(Effect.catch(() => Effect.succeed(candidate)));
}

export interface CodexExecRolloutMatch {
  readonly rolloutPath: string;
  readonly sessionId: string;
}

export interface FindCodexExecRolloutInput {
  readonly sessionsRoot: string;
  /** Working directory of the Claude session that launched the run. */
  readonly cwd: string;
  /** Epoch millis the task started, minus whatever slack the caller wants. */
  readonly notBeforeMs: number;
  /** Rollout paths already attributed to another run in this session. */
  readonly claimedPaths: ReadonlySet<string>;
}

/**
 * Find the rollout an in-flight `codex exec` run is writing.
 *
 * Candidates are narrowed by date directory and mtime before any file is
 * opened, then confirmed by reading only the `session_meta` line: it must be
 * an exec-originated rollout whose recorded cwd resolves to the same real path
 * as the Claude session's. The earliest unclaimed match wins, so two
 * concurrent runs in one thread settle onto different files.
 */
export const findCodexExecRollout = Effect.fn("findCodexExecRollout")(function* (
  input: FindCodexExecRolloutInput,
): Effect.fn.Return<
  CodexExecRolloutMatch | null,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expectedCwd = yield* realPath(fileSystem, input.cwd);

  // A run started just before midnight writes into the previous day's
  // directory, so both are searched.
  const startedAt = new Date(input.notBeforeMs);
  const directories = [
    path.join(input.sessionsRoot, ...dateDirectorySegments(startedAt)),
    path.join(
      input.sessionsRoot,
      ...dateDirectorySegments(new Date(input.notBeforeMs + 86_400_000)),
    ),
  ];

  const candidates: Array<{ readonly filePath: string; readonly mtimeMs: number }> = [];
  for (const directory of new Set(directories)) {
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.catch(() => Effect.succeed<Array<string>>([])));
    for (const entry of entries) {
      if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(directory, entry);
      if (input.claimedPaths.has(filePath)) {
        continue;
      }
      const info = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
      if (info === null) {
        continue;
      }
      const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
      if (modifiedAt !== undefined && modifiedAt < input.notBeforeMs) {
        continue;
      }
      candidates.push({ filePath, mtimeMs: modifiedAt ?? input.notBeforeMs });
    }
  }

  for (const candidate of candidates.toSorted((left, right) => {
    const byTime = left.mtimeMs - right.mtimeMs;
    return byTime !== 0 ? byTime : left.filePath.localeCompare(right.filePath);
  })) {
    const head = readCodexExecRolloutHead(yield* readFirstLine(fileSystem, candidate.filePath));
    if (!head?.cwd) {
      continue;
    }
    // The mtime gate above cannot exclude an older run that is still writing —
    // its file stays fresh for as long as it runs. The recorded start time can:
    // a rollout that began before this task did belongs to some other run.
    const headStartedAtMs = head.startedAt === null ? Number.NaN : Date.parse(head.startedAt);
    if (!Number.isNaN(headStartedAtMs) && headStartedAtMs < input.notBeforeMs) {
      continue;
    }
    const candidateCwd = yield* realPath(fileSystem, head.cwd);
    if (candidateCwd !== expectedCwd) {
      continue;
    }
    return { rolloutPath: candidate.filePath, sessionId: head.sessionId };
  }
  return null;
});

/**
 * Resolve a rollout from its session id alone, so a transcript stays readable
 * after the server restarts and nothing remembers where the file was.
 */
export const locateCodexExecRolloutBySessionId = Effect.fn("locateCodexExecRolloutBySessionId")(
  function* (input: {
    readonly sessionsRoot: string;
    readonly sessionId: string;
  }): Effect.fn.Return<
    string | null,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const suffix = `-${input.sessionId}.jsonl`;
    const readSorted = (directory: string) =>
      fileSystem
        .readDirectory(directory)
        .pipe(Effect.catch(() => Effect.succeed<Array<string>>([])))
        .pipe(Effect.map((entries) => entries.toSorted().toReversed()));

    let scanned = 0;
    for (const year of yield* readSorted(input.sessionsRoot)) {
      for (const month of yield* readSorted(path.join(input.sessionsRoot, year))) {
        for (const day of yield* readSorted(path.join(input.sessionsRoot, year, month))) {
          if (scanned >= SESSION_DATE_DIRECTORY_SCAN_LIMIT) {
            return null;
          }
          scanned += 1;
          const directory = path.join(input.sessionsRoot, year, month, day);
          for (const entry of yield* readSorted(directory)) {
            if (entry.startsWith("rollout-") && entry.endsWith(suffix)) {
              return path.join(directory, entry);
            }
          }
        }
      }
    }
    return null;
  },
);

/** Read a rollout's lines, or an empty list when it cannot be read. */
export const readCodexExecRolloutLines = Effect.fn("readCodexExecRolloutLines")(function* (
  rolloutPath: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* readFileLines(fileSystem, rolloutPath).pipe(
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
  );
});
