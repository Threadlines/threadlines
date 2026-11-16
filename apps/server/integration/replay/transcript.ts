/**
 * Recorded provider sessions for replay tests.
 *
 * A transcript is NDJSON: a header line, then entries in the order they
 * happened during recording.
 * - `out`: a frame our code sent (a request, a reply to the provider, a
 *   control call). Replay checks that our code sends an equal frame.
 * - `in`: a frame the provider sent. Replay hands it to our code.
 * - `fs`: files the agent changed in the workspace, so checkpoints and revert
 *   see real files.
 * - `exit`: the provider process ended.
 *
 * Matching is causal rather than strictly ordered: an outbound frame may match
 * any unmatched `out` entry with an equal (normalised) frame among those
 * recorded before the next provider frame, so independent calls our code makes
 * in a different order still match, but a call made before the reply it
 * depended on does not. Provider frames are
 * released strictly in order, each one only once every `out` entry recorded
 * before it has been matched. A reply never reaches our code before the call
 * that caused it, and a changed request or one our code stopped sending fails
 * the replay with the expected and actual frames.
 */
import * as fs from "node:fs";

export interface TranscriptHeader {
  readonly type: "transcript";
  readonly provider: "codex" | "claude";
  readonly protocol: string;
  readonly providerVersion: string;
  readonly scenario: string;
  readonly recordedAt: string;
}

export interface FileChange {
  /** Relative to the workspace. */
  readonly path: string;
  /** Null: the file was deleted. */
  readonly content: string | null;
}

export type TranscriptEntry =
  | {
      readonly type: "out";
      /** The provider process (Codex spawns one per session) or SDK query it belongs to. */
      readonly channel: number;
      readonly frame: unknown;
    }
  | { readonly type: "in"; readonly channel: number; readonly frame: unknown }
  | { readonly type: "fs"; readonly changes: ReadonlyArray<FileChange> }
  | { readonly type: "exit"; readonly channel: number; readonly code: number };

export interface Transcript {
  readonly header: TranscriptHeader;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

export function parseTranscript(text: string): Transcript {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const [first, ...rest] = lines;
  if (first === undefined) throw new Error("Empty transcript");
  const header = JSON.parse(first) as TranscriptHeader;
  if (header.type !== "transcript") throw new Error("Transcript is missing its header line");
  return { header, entries: rest.map((line) => JSON.parse(line) as TranscriptEntry) };
}

export function serializeTranscript(transcript: Transcript): string {
  return (
    [transcript.header, ...transcript.entries].map((line) => JSON.stringify(line)).join("\n") + "\n"
  );
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(fs.readFileSync(path, "utf8"));
}

/** JSON with object keys sorted, so equal frames compare equal as strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Each string with every occurrence of `from` replaced by `to`, at any depth. */
export function replaceInStrings(value: unknown, from: string, to: string): unknown {
  if (from.length === 0) return value;
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((entry) => replaceInStrings(entry, from, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceInStrings(entry, from, to)]),
    );
  }
  return value;
}

export class ReplayMismatchError extends Error {
  override readonly name = "ReplayMismatchError";
}

export interface ReplayRules {
  /** The frame as compared: drop or rewrite what varies between runs. */
  readonly normalizeOutbound: (frame: unknown, channel: number) => unknown;
  /**
   * A recorded outbound frame our code may or may not send, depending on
   * timing: it never holds back what follows it, and need not be sent.
   */
  readonly optional?: (frame: unknown) => boolean;
  /**
   * An outbound frame our code sends that the transcript doesn't have: an
   * answer to give it (it is optional and depends on timing), or undefined to
   * fail the replay.
   */
  readonly unrecordedOutbound?: (
    frame: unknown,
    channel: number,
  ) => { readonly answer: unknown } | undefined;
}

export interface ReplayHandlers {
  readonly deliver: (channel: number, frame: unknown) => void;
  readonly applyFiles: (changes: ReadonlyArray<FileChange>) => void;
  readonly exit: (channel: number, code: number) => void;
}

/**
 * Plays one transcript. `outbound` is called for each frame our code sends;
 * `handlers` receive what the provider sends back. The first mismatch is kept
 * in `failure` and stops the replay; `assertComplete` fails when recorded
 * frames were left unsent or undelivered.
 */
export function makeReplayCursor(transcript: Transcript, rules: ReplayRules) {
  const entries = transcript.entries;
  const matched = new Set<number>();
  let handlers: ReplayHandlers | null = null;
  let next = 0;
  let failure: ReplayMismatchError | null = null;

  const isOptional = (entry: TranscriptEntry) =>
    entry.type === "out" && rules.optional?.(entry.frame) === true;
  const fail = (message: string) => {
    failure ??= new ReplayMismatchError(message);
    return failure;
  };

  const pump = () => {
    if (handlers === null || failure !== null) return;
    while (next < entries.length) {
      const entry = entries[next]!;
      if (entry.type === "out") {
        if (!matched.has(next) && !isOptional(entry)) return;
        next += 1;
        continue;
      }
      next += 1;
      if (entry.type === "in") handlers.deliver(entry.channel, entry.frame);
      else if (entry.type === "fs") handlers.applyFiles(entry.changes);
      else handlers.exit(entry.channel, entry.code);
      if (failure !== null) return;
    }
  };

  return {
    get failure() {
      return failure;
    },
    /** Starts delivering: frames recorded before our code's first call go out now. */
    start(input: ReplayHandlers) {
      handlers = input;
      pump();
    },
    /**
     * Our code sent `frame`. Returns the index of the recorded entry it
     * matched, or an unrecorded optional answer.
     */
    outbound(
      channel: number,
      frame: unknown,
    ):
      | { readonly kind: "matched"; readonly index: number }
      | { readonly kind: "unrecorded"; readonly answer: unknown } {
      if (failure !== null) throw failure;
      const actual = stableStringify(rules.normalizeOutbound(frame, channel));
      // Only up to the next provider frame not yet delivered: everything
      // recorded after it may depend on it.
      for (let index = next; index < entries.length; index += 1) {
        const entry = entries[index]!;
        if (entry.type !== "out") break;
        if (entry.channel !== channel || matched.has(index)) continue;
        if (stableStringify(rules.normalizeOutbound(entry.frame, channel)) === actual) {
          matched.add(index);
          queueMicrotask(pump);
          return { kind: "matched", index };
        }
      }
      const unrecorded = rules.unrecordedOutbound?.(frame, channel);
      if (unrecorded !== undefined) return { kind: "unrecorded", answer: unrecorded.answer };
      const expected = entries
        .slice(next)
        .find(
          (entry, offset) =>
            entry.type === "out" && !matched.has(next + offset) && entry.channel === channel,
        );
      throw fail(
        [
          `Replay of '${transcript.header.scenario}' (${transcript.header.provider}): our code sent a frame the recording doesn't have.`,
          `Sent:     ${actual}`,
          `Expected: ${
            expected === undefined
              ? "(nothing more on this channel)"
              : stableStringify(
                  rules.normalizeOutbound((expected as { frame: unknown }).frame, channel),
                )
          }`,
        ].join("\n"),
      );
    },
    /** The recorded entry at `index` (to read a matched call's id, for example). */
    entry(index: number): TranscriptEntry | undefined {
      return entries[index];
    },
    /** Fails unless every recorded frame was sent and delivered. */
    assertComplete() {
      if (failure !== null) throw failure;
      const unsent = entries.flatMap((entry, index) =>
        entry.type === "out" && !isOptional(entry) && !matched.has(index)
          ? [stableStringify(rules.normalizeOutbound(entry.frame, entry.channel))]
          : [],
      );
      if (unsent.length > 0 || next < entries.length) {
        throw fail(
          [
            `Replay of '${transcript.header.scenario}' (${transcript.header.provider}) ended early.`,
            ...(unsent.length > 0
              ? [`Never sent: ${unsent.slice(0, 3).join("\n            ")}`]
              : []),
            `Delivered ${next} of ${entries.length} entries.`,
          ].join("\n"),
        );
      }
    },
  };
}

export type ReplayCursor = ReturnType<typeof makeReplayCursor>;
