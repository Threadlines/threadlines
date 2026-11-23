// @effect-diagnostics nodeBuiltinImport:off -- reads the agent's own subagent records with bounded fs reads.
/**
 * Reads what Antigravity's subagents did from the CLI's own records.
 * THIS READS A PRIVATE FORMAT: Google documents none of it, and a CLI update
 * can change it without notice. ACP tells a client only that the agent ran
 * an `invoke_subagent` tool call and that the call returned at once; which
 * child it started, whether that child has reported, and what it did are
 * only in these files.
 *
 * Layout as of `agy` 1.5.12 to 1.5.14, matching T3 Code's reader
 * (apps/server/src/provider/acp/AntigravityChildWork.ts, commits 066be30005
 * and 194726492b), all under `<profile>/antigravity-acp/brain/`:
 * - `<parent>/.system_generated/subagents/<child>.json`: one per child the
 *   session started, `{ conversationId, subagentDescriptor: { role }, state }`.
 *   `manage_subagents` kill only rewrites `state` to `SUBAGENT_STATE_KILLED`.
 * - `<child>/.system_generated/messages/*.json`: the child's inbox. Its launch
 *   is a message from the parent whose `sourceMetadata.tool.toolCall` is the
 *   parent's `invoke_subagent` call (the ACP tool call id) with its arguments.
 *   `read.json` there is read receipts, not a message.
 * - `<parent>/.system_generated/messages/*.json`: the parent's inbox. A
 *   message whose `sender` is a child is that child's report.
 * - `<child>/.system_generated/logs/transcript.jsonl`: the child's steps, one
 *   JSON line each (`step_index`, `type`, `content`, `tool_calls`).
 *
 * Every path is checked the way the session-log reader checks its own (no
 * links, the expected file or folder, inside the profile Threadlines made),
 * files are opened read-only, and every read is bounded. A record this
 * cannot read proves nothing: callers fall back to what ACP said.
 *
 * @module provider/antigravity/AntigravityChildRecords
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { ProviderSubagentTranscriptEntry } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import { antigravityProfileEntry } from "./AntigravitySessionLog.ts";
import { boundAntigravityText } from "./AntigravityToolCalls.ts";

/** Ids as the CLI names conversations: nothing that walks a path. */
const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_CHILDREN = 64;
const MAX_INBOX_MESSAGES = 256;
const MAX_RECORD_BYTES = 1024 * 1024;
/** All the records one read of a session's children may take together. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** The end of a child's transcript that is read: its recent steps. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const STEP_TEXT_LIMIT = 4_000;
const TOOL_SUMMARY_LIMIT = 1_000;
const KILLED_STATE = "SUBAGENT_STATE_KILLED";
const LAUNCH_TOOLS = new Set(["invoke_subagent", "start_subagent"]);

/** A subagent's role and prompt, as its launch named them. */
export interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

/** One child the session started, as its records describe it. */
export interface AntigravityChild {
  readonly conversationId: string;
  /** The parent's `invoke_subagent` tool call that started it. */
  readonly launchCallId: string | undefined;
  readonly launch: AntigravityChildLaunch;
  /** `reported`: its report is in the parent's inbox. */
  readonly state: "working" | "reported" | "killed";
  /** The report it sent the parent, bounded. */
  readonly report: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringField = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A launch's input: one subagent (`Role`, `Prompt`), or a batch (`Subagents`, before 1.5). */
export function antigravityChildLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  if (!isRecord(input)) return undefined;
  const one = (entry: unknown): AntigravityChildLaunch | undefined => {
    const role = stringField(entry, "Role");
    const prompt = stringField(entry, "Prompt");
    return role !== undefined && prompt !== undefined ? { role, prompt } : undefined;
  };
  const single = one(input);
  if (single !== undefined) return [single];
  if (!Array.isArray(input.Subagents) || input.Subagents.length === 0) return undefined;
  const batch = input.Subagents.map(one);
  return batch.every((entry) => entry !== undefined) ? batch : undefined;
}

/** What one read of the records may still take, in bytes. */
interface ReadBudget {
  bytes: number;
}

/**
 * A small JSON record of the CLI's, or `undefined` when it is missing,
 * linked, too big, past the read's budget, or unreadable.
 */
async function readRecord(profileDir: string, segments: ReadonlyArray<string>, budget: ReadBudget) {
  const entry = await antigravityProfileEntry(profileDir, segments, "file");
  if (entry === undefined || entry.size > MAX_RECORD_BYTES || entry.size > budget.bytes)
    return undefined;
  budget.bytes -= entry.size;
  const text = await NodeFSP.readFile(entry.path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseJson(text);
}

const generated = (conversationId: string, ...rest: ReadonlyArray<string>) => [
  "brain",
  conversationId,
  ".system_generated",
  ...rest,
];

/**
 * A conversation's inbox: every message, or `undefined` when it can't all be
 * read (one unread message could be the one that matters). No inbox is empty.
 */
async function readInbox(
  profileDir: string,
  conversationId: string,
  budget: ReadBudget,
): Promise<ReadonlyArray<unknown> | undefined> {
  const segments = generated(conversationId, "messages");
  const inbox = await antigravityProfileEntry(profileDir, segments, "directory");
  if (inbox === undefined) return [];
  const names = await NodeFSP.readdir(inbox.path).catch(() => undefined);
  if (names === undefined) return undefined;
  const messages = names.filter((name) => name.endsWith(".json") && name !== "read.json");
  if (messages.length > MAX_INBOX_MESSAGES) return undefined;
  const read: Array<unknown> = [];
  for (const name of messages) read.push(await readRecord(profileDir, [...segments, name], budget));
  return read.every(isRecord) ? read : undefined;
}

/** The parent's launching call in a child's inbox message, when it is one. */
function launchCall(message: unknown, parentId: string) {
  if (stringField(message, "sender") !== parentId) return undefined;
  const tool = isRecord(message) ? message.sourceMetadata : undefined;
  const source = isRecord(tool) ? tool.tool : undefined;
  if (!isRecord(source)) return undefined;
  const fromSession = stringField(source, "conversationId");
  if (fromSession !== undefined && fromSession !== parentId) return undefined;
  const call = source.toolCall;
  const id = stringField(call, "id");
  const name = stringField(call, "name");
  if (id === undefined || name === undefined || !LAUNCH_TOOLS.has(name)) return undefined;
  const args = stringField(call, "argumentsJson");
  return { id, args: args === undefined ? undefined : parseJson(args) };
}

/**
 * Every child the session started, with its launch and state, or
 * `undefined` when the records can't be read whole.
 */
async function readChildren(
  profileDir: string,
  parentId: string,
): Promise<ReadonlyArray<AntigravityChild> | undefined> {
  if (!NATIVE_ID.test(parentId)) return undefined;
  const folder = await antigravityProfileEntry(
    profileDir,
    generated(parentId, "subagents"),
    "directory",
  );
  if (folder === undefined) return [];
  const names = await NodeFSP.readdir(folder.path).catch(() => undefined);
  if (names === undefined) return undefined;
  const childIds = names.flatMap((name) =>
    name.endsWith(".json") && NATIVE_ID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : [],
  );
  if (childIds.length > MAX_CHILDREN) return undefined;
  const budget: ReadBudget = { bytes: MAX_READ_BYTES };
  const parentInbox = await readInbox(profileDir, parentId, budget);
  if (parentInbox === undefined) return undefined;
  const children: Array<AntigravityChild> = [];
  for (const childId of childIds) {
    const record = await readRecord(
      profileDir,
      generated(parentId, "subagents", `${childId}.json`),
      budget,
    );
    if (!isRecord(record)) return undefined;
    const recordedId = stringField(record, "conversationId");
    if (recordedId !== undefined && recordedId !== childId) return undefined;
    const inbox = await readInbox(profileDir, childId, budget);
    if (inbox === undefined) return undefined;
    const launches = inbox.flatMap((message) => {
      const call = launchCall(message, parentId);
      return call === undefined ? [] : [{ call, content: stringField(message, "content") }];
    });
    // Two launches in one inbox can't both be this child's.
    const launch = launches.length === 1 ? launches[0] : undefined;
    const [fromArgs] = antigravityChildLaunches(launch?.call.args) ?? [];
    const descriptor = record.subagentDescriptor;
    const reports = parentInbox.flatMap((message) =>
      stringField(message, "sender") === childId ? [stringField(message, "content") ?? ""] : [],
    );
    children.push({
      conversationId: childId,
      launchCallId: launch?.call.id,
      launch: fromArgs ?? {
        role: stringField(descriptor, "role") ?? "",
        prompt: launch?.content ?? "",
      },
      state:
        reports.length > 0
          ? "reported"
          : stringField(record, "state") === KILLED_STATE
            ? "killed"
            : "working",
      report: reports.length > 0 ? boundAntigravityText(reports.join("\n\n").trim()) : undefined,
    });
  }
  return children;
}

/** The one child a launching call started, or `undefined` when none or several claim it. */
function childOf(children: ReadonlyArray<AntigravityChild>, launchCallId: string) {
  const claimed = children.filter((child) => child.launchCallId === launchCallId);
  return claimed.length === 1 ? claimed[0] : undefined;
}

/**
 * What became of the children these launching calls started, by call id.
 * A call the records don't tie to exactly one child is left out; `undefined`
 * when the records can't be read.
 */
export const antigravityChildStates = (
  profileDir: string,
  parentId: string,
  launchCallIds: ReadonlyArray<string>,
) =>
  Effect.tryPromise(async () => {
    const children = await readChildren(profileDir, parentId);
    if (children === undefined) return undefined;
    const states = new Map<string, AntigravityChild>();
    for (const id of launchCallIds) {
      const child = childOf(children, id);
      if (child !== undefined) states.set(id, child);
    }
    return states as ReadonlyMap<string, AntigravityChild>;
  }).pipe(Effect.orElseSucceed(() => undefined));

// ── A child's steps ──────────────────────────────────────────────────

interface TranscriptLine {
  readonly index: number;
  readonly type: string;
  readonly status: string | undefined;
  readonly content: string | undefined;
  readonly error: string | undefined;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
}

function parseTranscriptLine(line: string): TranscriptLine | undefined {
  const value = parseJson(line);
  if (!isRecord(value)) return undefined;
  const index = value.step_index;
  const type = stringField(value, "type");
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || type === undefined)
    return undefined;
  const calls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
  return {
    index,
    type,
    status: stringField(value, "status"),
    content: stringField(value, "content"),
    error: stringField(value, "error"),
    toolCalls: calls.flatMap((call) => {
      const name = stringField(call, "name");
      return name === undefined ? [] : [{ name, args: isRecord(call) ? call.args : undefined }];
    }),
  };
}

/** Fields that say what a call works on, in the order worth showing. */
const SUMMARY_FIELDS = [
  "CommandLine",
  "AbsolutePath",
  "TargetFile",
  "Path",
  "SearchPath",
  "Query",
  "Url",
];

/** A tool call's one-line summary. The CLI records each argument value as JSON text. */
function toolSummary(args: unknown): string {
  if (!isRecord(args)) return "";
  const values = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? (parseJson(value) ?? value) : value,
    ]),
  );
  for (const field of SUMMARY_FIELDS) {
    const value = values[field];
    if (typeof value === "string" && value.trim()) {
      return boundAntigravityText(value.trim(), TOOL_SUMMARY_LIMIT);
    }
  }
  return boundAntigravityText(JSON.stringify(values), TOOL_SUMMARY_LIMIT);
}

/** A child's steps as transcript entries, its launch prompt first as its instruction. */
export function antigravityTranscriptEntries(
  lines: ReadonlyArray<TranscriptLine>,
  prompt: string,
): ReadonlyArray<ProviderSubagentTranscriptEntry> {
  const launchPrompt = prompt.trim();
  const entries: Array<ProviderSubagentTranscriptEntry> = launchPrompt
    ? [{ id: "launch", role: "user", text: launchPrompt, toolUses: [] }]
    : [];
  for (const line of lines) {
    const id = `step-${line.index}`;
    const text = boundAntigravityText((line.content ?? line.error ?? "").trim(), STEP_TEXT_LIMIT);
    if (line.type === "PLANNER_RESPONSE") {
      entries.push({
        id,
        role: "assistant",
        text: line.content ? text : "",
        toolUses: line.toolCalls.map((call) => ({
          name: call.name,
          summary: toolSummary(call.args),
        })),
      });
      continue;
    }
    if (line.type === "SYSTEM_MESSAGE" || line.type === "USER_INPUT") {
      // The opening envelope around the launch prompt already shown above.
      if (line.index === 0 && launchPrompt && line.content?.includes(launchPrompt)) continue;
      if (text) entries.push({ id, role: "user", text, toolUses: [] });
      continue;
    }
    // A tool's result (`VIEW_FILE`, `RUN_COMMAND`, `GENERIC`, ...).
    if (!text) continue;
    entries.push({
      id,
      role: "system",
      text: "",
      toolUses: [],
      outputPreview: text,
      ...(line.error !== undefined || line.status === "ERROR" ? { outputIsError: true } : {}),
    });
  }
  return entries;
}

/** The end of a child's transcript, parsed; `undefined` when it has none. */
async function readTranscriptTail(profileDir: string, childId: string) {
  const entry = await antigravityProfileEntry(
    profileDir,
    generated(childId, "logs", "transcript.jsonl"),
    "file",
  );
  if (entry === undefined) return undefined;
  const handle = await NodeFSP.open(
    entry.path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    // One byte more says whether the window starts on a line boundary.
    const readFrom = Math.max(0, start - 1);
    const buffer = Buffer.alloc(stat.size - readFrom);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, readFrom);
    const bytes = buffer.subarray(0, bytesRead);
    const firstLine = start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
    if (start > 0 && firstLine === 0) return { lines: [], truncated: true };
    const lines = bytes
      .toString("utf8", firstLine)
      .split("\n")
      .flatMap((line) => {
        const parsed = parseTranscriptLine(line);
        return parsed === undefined ? [] : [parsed];
      });
    return { lines, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * The child a launching call started and its recent steps, or `undefined`
 * when the records don't name exactly one child for it.
 */
export const antigravityChildTranscript = (
  profileDir: string,
  parentId: string,
  launchCallId: string,
) =>
  Effect.tryPromise(async () => {
    const children = await readChildren(profileDir, parentId);
    const child = children === undefined ? undefined : childOf(children, launchCallId);
    if (child === undefined) return undefined;
    const transcript = await readTranscriptTail(profileDir, child.conversationId).catch(
      () => undefined,
    );
    return {
      child,
      entries: antigravityTranscriptEntries(transcript?.lines ?? [], child.launch.prompt),
      truncated: transcript?.truncated ?? false,
    };
  }).pipe(Effect.orElseSucceed(() => undefined));
