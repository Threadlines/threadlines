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
 * files are opened read-only without blocking or following a link
 * (`AntigravityFileReads`), and every read is bounded. A record this
 * cannot read proves nothing: callers fall back to what ACP said.
 *
 * @module provider/antigravity/AntigravityChildRecords
 */
import * as NodeFSP from "node:fs/promises";

import type { ProviderSubagentTranscriptEntry } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import { antigravityProfileEntry, openAntigravityProfileFile } from "./AntigravitySessionLog.ts";
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
  /**
   * The parent's `invoke_subagent` tool call (the ACP tool call id) that
   * started it, when the records tie exactly this child to one call.
   */
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

/** The bytes of a file held open, at most `maxBytes`; `undefined` past that. */
async function readHeld(
  handle: NodeFSP.FileHandle,
  maxBytes: number,
  from = 0,
): Promise<Buffer | undefined> {
  // One byte past the cap: a file that grew since it was checked is refused.
  const buffer = Buffer.alloc(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, from + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total > maxBytes ? undefined : buffer.subarray(0, total);
}

/**
 * A small JSON record of the CLI's, or `undefined` when it is missing, not
 * the file at its place in the profile, too big, past the read's budget, or
 * not JSON. Every byte read is charged to the budget.
 */
async function readRecord(profileDir: string, segments: ReadonlyArray<string>, budget: ReadBudget) {
  const file = await openAntigravityProfileFile(profileDir, segments);
  if (typeof file === "string") return undefined;
  try {
    const maxBytes = Math.min(MAX_RECORD_BYTES, budget.bytes);
    if (file.size > maxBytes) return undefined;
    const bytes = await readHeld(file.handle, maxBytes);
    if (bytes === undefined) return undefined;
    budget.bytes -= bytes.length;
    return parseJson(bytes.toString("utf8"));
  } finally {
    await file.handle.close();
  }
}

/**
 * A folder's file names, read one entry at a time: `undefined` past `limit`
 * entries (of any kind), so a huge folder costs no more than the limit.
 */
async function listNames(path: string, limit: number): Promise<Array<string> | undefined> {
  const dir = await NodeFSP.opendir(path, { bufferSize: 32 }).catch(() => undefined);
  if (dir === undefined) return undefined;
  const names: Array<string> = [];
  try {
    for await (const entry of dir) {
      if (names.length >= limit) return undefined;
      names.push(entry.name);
    }
  } catch {
    return undefined;
  }
  return names;
}

const generated = (conversationId: string, ...rest: ReadonlyArray<string>) => [
  "brain",
  conversationId,
  ".system_generated",
  ...rest,
];

/**
 * A conversation's inbox: the messages that read, and how many didn't (one
 * the CLI is still writing reads as broken JSON). `undefined` when the inbox
 * itself can't be listed, is a link or not a folder, or holds more than the
 * limit. No inbox at all is an empty one.
 */
async function readInbox(
  profileDir: string,
  conversationId: string,
  budget: ReadBudget,
): Promise<{ readonly messages: ReadonlyArray<unknown>; readonly unreadable: number } | undefined> {
  const segments = generated(conversationId, "messages");
  const inbox = await antigravityProfileEntry(profileDir, segments, "directory");
  // No inbox is an empty one; one that isn't what it should be is unread.
  if (inbox === "missing") return { messages: [], unreadable: 0 };
  if (inbox === "refused") return undefined;
  // `read.json` (read receipts) and the odd stray file count toward the limit too.
  const names = await listNames(inbox.path, MAX_INBOX_MESSAGES + 1);
  if (names === undefined) return undefined;
  const messages: Array<unknown> = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith(".json") || name === "read.json") continue;
    const message = await readRecord(profileDir, [...segments, name], budget);
    if (isRecord(message)) messages.push(message);
    else unreadable += 1;
  }
  return { messages, unreadable };
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
 * What a session's records say about its children.
 * - `available: false, reason: "no-records"`: the session has no subagent
 *   records at all, so they can't tell "none started" from "not written".
 * - `available: false, reason: "unreadable"`: some record is missing, a
 *   link, too big, not what the layout says, or the session id is not one
 *   the CLI would write. Nothing is proven then.
 * - `available: true`: every child the session started, sorted by state.
 *   A child reported once its report is in the parent's inbox (it may
 *   still be answering a follow-up), and was killed when its entry says so.
 *   A child whose entry doesn't read is `running`, with nothing else known.
 */
export type AntigravityChildrenReading =
  | { readonly available: false; readonly reason: "no-records" | "unreadable" }
  | {
      readonly available: true;
      readonly running: ReadonlyArray<AntigravityChild>;
      readonly reported: ReadonlyArray<AntigravityChild>;
      readonly killed: ReadonlyArray<AntigravityChild>;
      /**
       * Messages and entries that didn't read (one the CLI is still writing,
       * say). A report among them leaves its child `running` until a later
       * reading sees it; nothing is ever marked done for want of a record.
       */
      readonly unreadable: number;
    };

const UNREADABLE = { available: false, reason: "unreadable" } as const;

/** Every child the session started, or why the records can't say. */
async function readChildren(
  profileDir: string,
  parentId: string,
): Promise<
  | { readonly children: ReadonlyArray<AntigravityChild>; readonly unreadable: number }
  | { readonly reason: "no-records" | "unreadable" }
> {
  if (!NATIVE_ID.test(parentId)) return { reason: "unreadable" };
  const folder = await antigravityProfileEntry(
    profileDir,
    generated(parentId, "subagents"),
    "directory",
  );
  if (folder === "missing") return { reason: "no-records" };
  if (folder === "refused") return { reason: "unreadable" };
  const names = await listNames(folder.path, MAX_CHILDREN + 1);
  if (names === undefined) return { reason: "unreadable" };
  const childIds = names.flatMap((name) =>
    name.endsWith(".json") && NATIVE_ID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : [],
  );
  const budget: ReadBudget = { bytes: MAX_READ_BYTES };
  const parentInbox = await readInbox(profileDir, parentId, budget);
  if (parentInbox === undefined) return { reason: "unreadable" };
  let unreadable = parentInbox.unreadable;
  const children: Array<AntigravityChild> = [];
  for (const childId of childIds) {
    const record = await readRecord(
      profileDir,
      generated(parentId, "subagents", `${childId}.json`),
      budget,
    );
    const recordedId = stringField(record, "conversationId");
    const inbox = await readInbox(profileDir, childId, budget);
    // An entry that doesn't read (or names another child) proves nothing:
    // the child counts as running, tied to no launch.
    if (!isRecord(record) || (recordedId !== undefined && recordedId !== childId) || !inbox) {
      unreadable += 1;
      children.push({
        conversationId: childId,
        launchCallId: undefined,
        launch: { role: "", prompt: "" },
        state: "working",
        report: undefined,
      });
      continue;
    }
    unreadable += inbox.unreadable;
    const launches = inbox.messages.flatMap((message) => {
      const call = launchCall(message, parentId);
      return call === undefined ? [] : [{ call, content: stringField(message, "content") }];
    });
    // Two launches in one inbox can't both be this child's.
    const launch = launches.length === 1 ? launches[0] : undefined;
    const [fromArgs] = antigravityChildLaunches(launch?.call.args) ?? [];
    const descriptor = record.subagentDescriptor;
    const reports = parentInbox.messages.flatMap((message) =>
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
  // Two children claiming one call: neither is proven to be its child.
  const claims = new Map<string, number>();
  for (const child of children) {
    if (child.launchCallId !== undefined) {
      claims.set(child.launchCallId, (claims.get(child.launchCallId) ?? 0) + 1);
    }
  }
  return {
    unreadable,
    children: children.map((child) =>
      child.launchCallId !== undefined && claims.get(child.launchCallId) !== 1
        ? { ...child, launchCallId: undefined }
        : child,
    ),
  };
}

/**
 * Which of a session's children are still running, which have reported and
 * which were killed, each with the launching call that started it where the
 * records tie it to one, or why the records can't say. Never fails.
 */
export const readAntigravityChildren = (profileDir: string, sessionId: string) =>
  Effect.tryPromise(async (): Promise<AntigravityChildrenReading> => {
    const read = await readChildren(profileDir, sessionId);
    if ("reason" in read) return { available: false, reason: read.reason };
    const inState = (state: AntigravityChild["state"]) =>
      read.children.filter((child) => child.state === state);
    return {
      available: true,
      running: inState("working"),
      reported: inState("reported"),
      killed: inState("killed"),
      unreadable: read.unreadable,
    };
  }).pipe(Effect.orElseSucceed((): AntigravityChildrenReading => UNREADABLE));

/** The child a launching call started, in a reading, when the records tie it to that call. */
export function antigravityChildOf(
  reading: AntigravityChildrenReading,
  launchCallId: string,
): AntigravityChild | undefined {
  if (!reading.available) return undefined;
  return [...reading.running, ...reading.reported, ...reading.killed].find(
    (child) => child.launchCallId === launchCallId,
  );
}

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
  const file = await openAntigravityProfileFile(
    profileDir,
    generated(childId, "logs", "transcript.jsonl"),
  );
  if (typeof file === "string") return undefined;
  const { handle, size } = file;
  try {
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    // One byte more says whether the window starts on a line boundary.
    const readFrom = Math.max(0, start - 1);
    // A bounded window; a file still growing is read as far as it was checked.
    const buffer = Buffer.alloc(size - readFrom);
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
    const read = await readChildren(profileDir, parentId);
    const child =
      "reason" in read
        ? undefined
        : read.children.find((candidate) => candidate.launchCallId === launchCallId);
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
