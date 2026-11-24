/**
 * Live diff estimates for a Claude file tool whose input JSON is still
 * streaming.
 *
 * While `input_json_delta` fragments accumulate, the concatenated buffer is
 * not valid JSON until the stream ends, so the adapter cannot parse it and
 * the UI knows nothing about the edit in progress. This module scans the
 * partial buffer directly: JSON string literals are tokenized with full
 * escape handling, a literal is a key when the next non-space character is
 * `:`, and the values of the file-tool fields (`file_path`, `old_string`,
 * `new_string`, `content`, …) fold into a per-file +/- line estimate.
 *
 * Each `old_string` pairs with its `new_string` by occurrence order
 * (MultiEdit repeats them per edit). A pair's common line prefix — and its
 * common suffix once both sides are complete — is trimmed so an appending
 * edit reads as `+N/-0` rather than `+(context+N)/-context`. Estimates only
 * drive the live badge; the exact stat from the PostToolUse structuredPatch
 * replaces them at completion.
 *
 * @module provider/Layers/claudePartialToolInput
 */
import type { FileChangeStat } from "@threadlines/shared/diffStats";

export interface PartialFileChangeEstimate {
  readonly stat: FileChangeStat;
  /** Minimal input preview (`{ file_path }` / `{ notebook_path }`) so
   *  consumers derive the changed-file subject the same way they would from
   *  a fully parsed input. */
  readonly input: Record<string, string>;
}

interface FileChangeToolInputKeys {
  readonly pathKey: string;
  readonly additionsKey: string;
  readonly deletionsKey?: string;
}

const FILE_CHANGE_TOOL_INPUT_KEYS: Record<string, FileChangeToolInputKeys> = {
  Edit: { pathKey: "file_path", additionsKey: "new_string", deletionsKey: "old_string" },
  MultiEdit: { pathKey: "file_path", additionsKey: "new_string", deletionsKey: "old_string" },
  Write: { pathKey: "file_path", additionsKey: "content" },
  NotebookEdit: { pathKey: "notebook_path", additionsKey: "new_source" },
};

interface JsonStringValue {
  readonly text: string;
  readonly terminated: boolean;
}

const JSON_ESCAPE_MAP: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Collects the string values of `keys` from a (possibly truncated) JSON
 * buffer, in occurrence order. The final value may be unterminated — it is
 * returned with `terminated: false` so callers can treat it as still
 * streaming. Values are attributed to the closest preceding key, which is
 * exact for the flat object shapes file-tool inputs use.
 */
function collectJsonStringValues(
  buffer: string,
  keys: ReadonlySet<string>,
): Map<string, JsonStringValue[]> {
  const valuesByKey = new Map<string, JsonStringValue[]>();
  let currentKey: string | undefined;
  let index = 0;
  // Track the next backslash across the whole buffer so escape-free strings
  // (e.g. large MultiEdit payloads) never rescan the remaining suffix per token.
  let nextSlash = buffer.indexOf("\\", 0);

  while (index < buffer.length) {
    const openQuote = buffer.indexOf('"', index);
    if (openQuote === -1) {
      break;
    }
    index = openQuote + 1;

    let text = "";
    let chunkStart = index;
    let terminated = false;
    let nextQuote = buffer.indexOf('"', index);
    while (index < buffer.length) {
      if (nextQuote !== -1 && nextQuote < index) {
        nextQuote = buffer.indexOf('"', index);
      }
      if (nextSlash !== -1 && nextSlash < index) {
        nextSlash = buffer.indexOf("\\", index);
      }
      if (nextQuote === -1 && nextSlash === -1) {
        if (chunkStart < buffer.length) {
          text += buffer.slice(chunkStart);
        }
        index = buffer.length;
        break;
      }
      if (nextQuote !== -1 && (nextSlash === -1 || nextQuote < nextSlash)) {
        if (nextQuote > chunkStart) {
          text += buffer.slice(chunkStart, nextQuote);
        }
        terminated = true;
        index = nextQuote + 1;
        break;
      }
      if (nextSlash > chunkStart) {
        text += buffer.slice(chunkStart, nextSlash);
      }
      const escape = buffer[nextSlash + 1];
      if (escape === undefined) {
        // Dangling escape at the buffer end: the pair completes next delta.
        index = buffer.length;
        break;
      }
      if (escape === "u") {
        const hex = buffer.slice(nextSlash + 2, nextSlash + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
          index = buffer.length;
          break;
        }
        text += String.fromCharCode(Number.parseInt(hex, 16));
        index = nextSlash + 6;
        chunkStart = index;
        continue;
      }
      text += JSON_ESCAPE_MAP[escape] ?? escape;
      index = nextSlash + 2;
      chunkStart = index;
    }

    let isKey = false;
    if (terminated) {
      let lookahead = index;
      while (lookahead < buffer.length) {
        const code = buffer.charCodeAt(lookahead);
        if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
          break;
        }
        lookahead += 1;
      }
      isKey = buffer.charCodeAt(lookahead) === 58;
    }

    if (isKey) {
      currentKey = text;
      continue;
    }
    if (currentKey !== undefined && keys.has(currentKey)) {
      const values = valuesByKey.get(currentKey) ?? [];
      values.push({ text, terminated });
      valuesByKey.set(currentKey, values);
    }
    // One string value per key in these inputs; forgetting the key keeps a
    // string array value from piling onto the last seen key.
    currentKey = undefined;
  }

  return valuesByKey;
}

function splitLines(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value.split("\n");
}

/**
 * +/- line counts for one old/new pair. The common line prefix is always
 * trimmed; the common suffix only once both sides are terminated, since a
 * still-streaming new value would transiently over-match its tail.
 */
function pairLineStats(
  oldValue: JsonStringValue | undefined,
  newValue: JsonStringValue | undefined,
): { additions: number; deletions: number } {
  const oldLines = splitLines(oldValue?.text);
  const newLines = splitLines(newValue?.text);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  if (oldValue?.terminated === true && newValue?.terminated === true) {
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
  }

  return {
    additions: Math.max(0, newLines.length - prefix - suffix),
    deletions: Math.max(0, oldLines.length - prefix - suffix),
  };
}

/**
 * Estimated per-file +/- stat for a file-change tool call whose input JSON
 * is still streaming. Returns `null` for non-file tools and until the path
 * value has fully arrived; counts of zero are legitimate (path known, body
 * not yet streamed).
 */
export function estimatePartialFileChangeStat(
  toolName: string,
  partialInputJson: string,
): PartialFileChangeEstimate | null {
  const inputKeys = FILE_CHANGE_TOOL_INPUT_KEYS[toolName];
  if (!inputKeys) {
    return null;
  }

  const keys = new Set([inputKeys.pathKey, inputKeys.additionsKey]);
  if (inputKeys.deletionsKey) {
    keys.add(inputKeys.deletionsKey);
  }
  const valuesByKey = collectJsonStringValues(partialInputJson, keys);

  const path = valuesByKey
    .get(inputKeys.pathKey)
    ?.find((value) => value.terminated)
    ?.text.trim();
  if (!path) {
    return null;
  }

  const newValues = valuesByKey.get(inputKeys.additionsKey) ?? [];
  const oldValues = inputKeys.deletionsKey ? (valuesByKey.get(inputKeys.deletionsKey) ?? []) : [];

  let additions = 0;
  let deletions = 0;
  for (let index = 0; index < Math.max(newValues.length, oldValues.length); index += 1) {
    const pairStats = pairLineStats(oldValues[index], newValues[index]);
    additions += pairStats.additions;
    deletions += pairStats.deletions;
  }

  return {
    stat: { path, kind: "update", additions, deletions },
    input: { [inputKeys.pathKey]: path },
  };
}
