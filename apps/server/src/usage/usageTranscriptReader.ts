// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 90-day window is on the
 * order of a gigabyte across thousands of files, and `readline` over a read
 * stream is roughly an order of magnitude cheaper than materialising each file.
 * The equivalent Effect stream pipeline is idiomatic but not fast enough to sit
 * behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@threadlines/contracts";

import { isUsageLedgerProvider, parseUsageLedgerLine } from "./usageLedger.ts";
import {
  initialCodexScanState,
  initialMuseScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseMuseLine,
  parsePiLine,
  piSessionIdFromFileName,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino?: number;
}

const STAT_CONCURRENCY = 16;

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const count = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < items.length) {
        const current = items[index++]!;
        await worker(current);
      }
    }),
  );
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page. `onUnreadableFolder` hears of a folder that exists but
 * could not be listed, for callers that must know the listing is partial.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  /** Only files with this name (Grok keeps usage in `updates.jsonl` beside other logs). */
  fileName?: string,
  onUnreadableFolder?: (dir: string) => void,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A folder removed mid-walk held nothing to miss.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        onUnreadableFolder?.(dir);
      }
      return;
    }
    const subdirs: string[] = [];
    const candidateFiles: string[] = [];
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      if (fileName !== undefined && entry.name !== fileName) continue;
      candidateFiles.push(child);
    }
    await runWithConcurrency(candidateFiles, STAT_CONCURRENCY, async (child) => {
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    });
    await runWithConcurrency(subdirs, STAT_CONCURRENCY, walk);
  };

  await walk(root);
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines and its fork marker on
 * `session_meta`, neither of which holds usage of its own, so those still have
 * to pass through the reducer to keep attribution and fork suppression correct.
 *
 * `mtimeMs` dates the Muse records that carry no real time of their own.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  mtimeMs: number,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const museState = initialMuseScanState();
  const piSessionId = provider === "pi" ? piSessionIdFromFileName(NodePath.basename(filePath)) : "";

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      if (provider === "grok") {
        records.push(...parseGrokLine(line));
        continue;
      }
      if (provider === "pi") {
        const record = parsePiLine(line, piSessionId);
        if (record !== null) records.push(record);
        continue;
      }
      if (provider === "muse") {
        const record = parseMuseLine(line, museState, mtimeMs);
        if (record !== null) records.push(record);
        continue;
      }
      if (isUsageLedgerProvider(provider)) {
        const record = parseUsageLedgerLine(line, provider);
        if (record !== null) records.push(record);
        continue;
      }
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}

const STREAM_CHUNK_BYTES = 64 * 1024;
const TAIL_ANCHOR_BYTES = 64;

export interface IncrementalClaudeTranscriptResult {
  readonly records: readonly UsageRecord[];
  readonly nextOffset: number;
  /** Last up to 64 bytes immediately preceding `nextOffset`, to detect rewrites/rotations. */
  readonly tailSignature: string;
}

/**
 * Streams Claude transcript lines starting at `startOffset` in fixed 64 KiB
 * chunks so cold scans never allocate full-file buffers.
 *
 * When `expectedTail` is provided (for `startOffset > 0`), verifies the bytes
 * immediately preceding `startOffset` match before trusting the incremental
 * read; a mismatch returns `null` so the caller falls back to a full read from
 * offset 0. Handles valid EOF records without a trailing `\n` while leaving a
 * half-written JSON line unread until the writer completes it.
 */
export async function readClaudeTranscriptRecordsFromOffset(
  filePath: string,
  startOffset: number,
  expectedTail?: string,
): Promise<IncrementalClaudeTranscriptResult | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(filePath, "r");
    const stats = await handle.stat();
    if (stats.size < startOffset) {
      return null;
    }

    const tailStart = Math.max(0, startOffset - TAIL_ANCHOR_BYTES);
    const tailLen = startOffset - tailStart;
    let tailBuf: Buffer = Buffer.alloc(0);
    if (tailLen > 0) {
      tailBuf = Buffer.allocUnsafe(tailLen);
      let readTail = 0;
      while (readTail < tailLen) {
        const { bytesRead } = await handle.read(
          tailBuf,
          readTail,
          tailLen - readTail,
          tailStart + readTail,
        );
        if (bytesRead === 0) break;
        readTail += bytesRead;
      }
      if (readTail !== tailLen) return null;
      if (expectedTail !== undefined && tailBuf.toString("hex") !== expectedTail) {
        return null;
      }
    }

    if (stats.size === startOffset) {
      return {
        records: [],
        nextOffset: startOffset,
        tailSignature: tailBuf.toString("hex"),
      };
    }

    const records: UsageRecord[] = [];
    const chunkBuf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let filePos = startOffset;
    let nextOffset = startOffset;
    let carry: Buffer = Buffer.alloc(0);

    const updateTail = (consumed: Buffer) => {
      if (consumed.length === 0) return;
      if (consumed.length >= TAIL_ANCHOR_BYTES) {
        tailBuf = Buffer.from(consumed.subarray(consumed.length - TAIL_ANCHOR_BYTES));
      } else {
        const combined = Buffer.concat([tailBuf, consumed]);
        tailBuf =
          combined.length > TAIL_ANCHOR_BYTES
            ? combined.subarray(combined.length - TAIL_ANCHOR_BYTES)
            : combined;
      }
    };

    const processLineBytes = (lineBytes: Buffer) => {
      let end = lineBytes.length;
      if (end > 0 && lineBytes[end - 1] === 0x0d) {
        end -= 1;
      }
      if (end === 0) return;
      const line = lineBytes.toString("utf8", 0, end);
      if (mightCarryUsage(line, "claude")) {
        const record = parseClaudeLine(line);
        if (record !== null) records.push(record);
      }
    };

    while (filePos < stats.size) {
      const toRead = Math.min(STREAM_CHUNK_BYTES, stats.size - filePos);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, filePos);
      if (bytesRead === 0) break;
      filePos += bytesRead;
      const chunk =
        carry.length > 0
          ? Buffer.concat([carry, chunkBuf.subarray(0, bytesRead)])
          : chunkBuf.subarray(0, bytesRead);

      let lineStart = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, lineStart);
        if (nl < 0) break;
        processLineBytes(chunk.subarray(lineStart, nl));
        lineStart = nl + 1;
      }
      if (lineStart > 0) {
        updateTail(chunk.subarray(0, lineStart));
        nextOffset += lineStart;
      }
      carry = lineStart < chunk.length ? Buffer.from(chunk.subarray(lineStart)) : Buffer.alloc(0);
    }

    // Handle a trailing EOF line without `\n`: parse it only when it is already
    // complete JSON so closed transcripts without a final newline are counted
    // while mid-write partial lines stay pending until completed.
    if (carry.length > 0) {
      let end = carry.length;
      if (end > 0 && carry[end - 1] === 0x0d) {
        end -= 1;
      }
      if (end > 0) {
        const line = carry.toString("utf8", 0, end);
        let completeJson = false;
        try {
          JSON.parse(line);
          completeJson = true;
        } catch {
          completeJson = false;
        }
        if (completeJson) {
          if (mightCarryUsage(line, "claude")) {
            const record = parseClaudeLine(line);
            if (record !== null) records.push(record);
          }
          updateTail(carry);
          nextOffset += carry.length;
        }
      }
    }

    return {
      records,
      nextOffset,
      tailSignature: tailBuf.toString("hex"),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
