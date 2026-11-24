/**
 * +/- line counts for replacing a whole file's text, which needs a line diff.
 * Apart from diffStats.ts because the `diff` library it loads keeps module
 * state the bundler can't drop, and the web app reads diffStats at startup.
 */
import { diffLines } from "diff";

import type { DiffLineStats } from "./diffStats.ts";

const TEXT_DIFF_MAX_EDIT_LENGTH = 2_000;
const TEXT_DIFF_TIMEOUT_MS = 100;

/** Exact +/- lines for replacing `oldText` with `newText`; a missing
 *  `oldText` is a new file. Very large rewrites count every line between the
 *  common leading and trailing lines instead. */
export function countTextReplacementStats(
  oldText: string | null | undefined,
  newText: string,
): DiffLineStats {
  const changes = diffLines(oldText ?? "", newText, {
    stripTrailingCr: true,
    maxEditLength: TEXT_DIFF_MAX_EDIT_LENGTH,
    timeout: TEXT_DIFF_TIMEOUT_MS,
  });
  if (changes !== undefined) {
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      if (change.added) additions += change.count;
      else if (change.removed) deletions += change.count;
    }
    return { additions, deletions };
  }
  const lines = (text: string) => {
    if (text.length === 0) return [];
    const split = text.replace(/\r\n/gu, "\n").split("\n");
    return split.at(-1) === "" ? split.slice(0, -1) : split;
  };
  const before = lines(oldText ?? "");
  const after = lines(newText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: after.length - prefix - suffix,
    deletions: before.length - prefix - suffix,
  };
}
