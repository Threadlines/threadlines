/**
 * Records a provider session as a replay transcript (see transcript.ts), and
 * keeps private data out of it: machine paths become placeholders, emails are
 * masked, and the file is refused when anything that looks private is left.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import {
  replaceInStrings,
  serializeTranscript,
  type FileChange,
  type TranscriptEntry,
  type TranscriptHeader,
} from "./transcript.ts";

export interface ReplayPaths {
  /** The test's git workspace: the agent's working folder. */
  readonly workspaceDir: string;
  /** The harness's temp root (server state, attachments). */
  readonly rootDir: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Each real path in a frame, as the placeholder the transcript stores. */
/**
 * A path as Claude names its project folder after it: every character but
 * letters and digits becomes a dash.
 */
const dashed = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

/** Each machine path a transcript may hold, with its placeholder, longest first. */
function pathPairs(paths: ReplayPaths): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  const add = (real: string, placeholder: string) => {
    for (const variant of new Set([real, safeRealpath(real)])) {
      if (variant.length <= 1) continue;
      pairs.push([variant, placeholder]);
      pairs.push([dashed(variant), dashed(placeholder)]);
    }
  };
  add(paths.workspaceDir, "<workspace>");
  add(paths.rootDir, "<root>");
  add(os.tmpdir(), "<tmp>");
  add(os.homedir(), "<home>");
  // Longest first: the workspace sits inside the root, inside the temp folder.
  return pairs.toSorted((left, right) => right[0].length - left[0].length);
}

/** Per-user temp folders Claude makes for task output (`/private/tmp/claude-<uid>`). */
const CLAUDE_TEMP = /(?:\/private)?\/tmp\/claude-\d+/g;

function replacePattern(value: unknown, pattern: RegExp, to: string): unknown {
  if (typeof value === "string") return value.replace(pattern, to);
  if (Array.isArray(value)) return value.map((entry) => replacePattern(entry, pattern, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replacePattern(entry, pattern, to)]),
    );
  }
  return value;
}

export function makePathScrubber(paths: ReplayPaths): (value: unknown) => unknown {
  const pairs = pathPairs(paths);
  return (value) =>
    replacePattern(
      pairs.reduce(
        (current, [real, placeholder]) => replaceInStrings(current, real, placeholder),
        value,
      ),
      CLAUDE_TEMP,
      "<claude-tmp>",
    );
}

/**
 * The reverse, for frames a replay delivers: each placeholder becomes this
 * run's real path, so our code sees its own workspace (a session reporting
 * `<workspace>` as its folder would look moved and be restarted).
 */
export function makePathMaterializer(paths: ReplayPaths): (value: unknown) => unknown {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["<workspace>", paths.workspaceDir],
    ["<root>", paths.rootDir],
    ["<tmp>", os.tmpdir()],
    ["<home>", os.homedir()],
  ].flatMap(([placeholder, real]) => [
    [placeholder!, real!] as const,
    [dashed(placeholder!), dashed(real!)] as const,
  ]);
  return (value) =>
    pairs.reduce(
      (current, [placeholder, real]) => replaceInStrings(current, placeholder, real),
      value,
    );
}

function safeRealpath(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

function maskEmails(value: unknown): unknown {
  if (typeof value === "string") return value.replace(EMAIL, "<email>");
  if (Array.isArray(value)) return value.map(maskEmails);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, maskEmails(entry)]),
    );
  }
  return value;
}

/**
 * Why `text` must not be committed, or null when it looks clean. Checks for
 * the home folder, a user's folder path, emails, bearer tokens and the value
 * of any environment variable long enough to be a secret.
 */
export function privateDataIn(
  text: string,
  machine: {
    readonly environment: NodeJS.ProcessEnv;
    readonly homeDir: string;
    readonly userName: string;
  } = { environment: process.env, homeDir: os.homedir(), userName: os.userInfo().username },
): string | null {
  const { environment, homeDir, userName } = machine;
  if (text.includes(homeDir)) return "the home folder path";
  if (text.includes(dashed(homeDir))) return "the home folder path, as a project folder name";
  const temp = safeRealpath(os.tmpdir());
  if (temp.length > 8 && (text.includes(temp) || text.includes(dashed(temp)))) {
    return "this machine's temp folder path";
  }
  // Any temp folder, in case the run used another one (macOS per-user, Claude's).
  if (/\/var\/folders\/[^/"<]+\/|\/private\/tmp\/|\/tmp\/claude-\d/.test(text)) {
    return "a temp folder path";
  }
  if (
    /"(?:x-)?(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password)"\s*:\s*"[^"<]{8,}"/i.test(
      text,
    )
  ) {
    return "a credential-looking field";
  }
  // This user's folder in any form (another drive, a JSON-escaped Windows path).
  if (
    [`/Users/${userName}`, `/home/${userName}`, `\\\\Users\\\\${userName}`].some((folder) =>
      text.includes(folder),
    )
  ) {
    return "a user folder path";
  }
  if (new RegExp(EMAIL.source).test(text)) return "an email address";
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(text)) return "a bearer token";
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.length < 16 || value.startsWith("/") || value.includes(":/")) {
      continue;
    }
    if (text.includes(value)) return `the value of $${name}`;
  }
  return null;
}

const STREAM_KEYS = new Set(["delta", "partial_json", "text", "thinking"]);

/** Every streamed text piece in the transcript, in order, joined. */
function streamedText(entries: ReadonlyArray<TranscriptEntry>): string {
  const pieces: Array<string> = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (STREAM_KEYS.has(key) && typeof entry === "string") pieces.push(entry);
        else walk(entry);
      }
    }
  };
  entries.forEach(walk);
  return pieces.join("");
}

/** The workspace's files (outside .git), by relative path. */
function readWorkspace(workspaceDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        files.set(nodePath.relative(workspaceDir, full), fs.readFileSync(full, "utf8"));
    }
  };
  walk(workspaceDir);
  return files;
}

/** Writes recorded file changes into a replay's workspace. */
export function applyFileChanges(workspaceDir: string, changes: ReadonlyArray<FileChange>) {
  for (const change of changes) {
    const full = nodePath.join(workspaceDir, change.path);
    if (change.content === null) {
      fs.rmSync(full, { force: true });
    } else {
      fs.mkdirSync(nodePath.dirname(full), { recursive: true });
      fs.writeFileSync(full, change.content);
    }
  }
}

/**
 * A protocol's redaction: the frame as stored, without the user's own setup
 * (their plugins, connected services, plan, machine name) or the agent's
 * reasoning text, which can quote their personal instructions. Null drops it.
 */
export type FrameRedactor = (frame: unknown, direction: "in" | "out") => unknown;

/** Keeps only `keys` of `value`. */
export function pick(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  const source = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap((key) => (key in source ? [[key, source[key]]] : [])));
}

export function makeRecorder(
  header: Omit<TranscriptHeader, "type" | "recordedAt">,
  paths: ReplayPaths,
  redact: FrameRedactor,
) {
  const entries: Array<TranscriptEntry> = [];
  let snapshot = readWorkspace(paths.workspaceDir);
  return {
    out(channel: number, frame: unknown) {
      const stored = redact(frame, "out");
      if (stored === null) return;
      entries.push({ type: "out", channel, frame: stored });
    },
    in(channel: number, frame: unknown) {
      const stored = redact(frame, "in");
      if (stored === null) return;
      entries.push({ type: "in", channel, frame: stored });
    },
    exit(channel: number, code: number) {
      entries.push({ type: "exit", channel, code });
    },
    /** Records what the agent changed in the workspace since the last call. */
    syncFiles() {
      const current = readWorkspace(paths.workspaceDir);
      const changes: Array<FileChange> = [];
      for (const [path, content] of current) {
        if (snapshot.get(path) !== content) changes.push({ path, content });
      }
      for (const path of snapshot.keys()) {
        if (!current.has(path)) changes.push({ path, content: null });
      }
      snapshot = current;
      if (changes.length > 0) entries.push({ type: "fs", changes });
    },
    /** Scrubs the transcript and writes it, or throws when it still holds private data. */
    finish(outputPath: string) {
      const scrub = makePathScrubber(paths);
      const transcript = {
        header: { type: "transcript", ...header, recordedAt: new Date().toISOString() } as const,
        entries: entries.map((entry) => maskEmails(scrub(entry)) as TranscriptEntry),
      };
      const text = serializeTranscript(transcript);
      // Streamed pieces, joined: a path or address can be split across them.
      const leak = privateDataIn(text) ?? privateDataIn(streamedText(transcript.entries));
      if (leak !== null) {
        const where = transcript.entries.findIndex(
          (entry) => privateDataIn(JSON.stringify(entry)) !== null,
        );
        const entry = transcript.entries[where] as { frame?: { method?: unknown } } | undefined;
        throw new Error(
          `Not writing ${outputPath}: the recording still contains ${leak} (entry ${where}, ${String(entry?.frame?.method ?? "a reply")}).`,
        );
      }
      fs.mkdirSync(nodePath.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, text);
      return transcript;
    },
  };
}

export type Recorder = ReturnType<typeof makeRecorder>;
