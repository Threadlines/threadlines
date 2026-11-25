import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import { fnv1a32 } from "./diffThemeName";
import { stripTerminalControlSequences } from "./terminalText";

export {
  DIFF_THEME_NAMES,
  type DiffThemeName,
  fnv1a32,
  resolveDiffThemeName,
} from "./diffThemeName";

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function normalizePatchForParsing(patch: string): string {
  return stripTerminalControlSequences(patch).trim();
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

/**
 * What a file is called across parses of a moving patch: the path it lands
 * on, plus where it came from for a rename. The parser derives `cacheKey`
 * from the whole patch, so it changes for every file whenever any file
 * changes, and cannot key anything that should outlive a refetch (collapse
 * state, the React element, the diff instance behind it).
 */
export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Whether two parses describe the same change to the same file. */
function areFileDiffContentsEqual(left: FileDiffMetadata, right: FileDiffMetadata): boolean {
  if (
    left.type !== right.type ||
    left.mode !== right.mode ||
    left.prevMode !== right.prevMode ||
    left.newObjectId !== right.newObjectId ||
    left.prevObjectId !== right.prevObjectId ||
    left.hunks.length !== right.hunks.length
  ) {
    return false;
  }
  const hunksEqual = left.hunks.every((hunk, index) => {
    const other = right.hunks[index];
    return (
      other !== undefined &&
      hunk.additionStart === other.additionStart &&
      hunk.additionCount === other.additionCount &&
      hunk.additionLines === other.additionLines &&
      hunk.deletionStart === other.deletionStart &&
      hunk.deletionCount === other.deletionCount &&
      hunk.deletionLines === other.deletionLines &&
      hunk.hunkSpecs === other.hunkSpecs &&
      hunk.hunkContext === other.hunkContext
    );
  });
  return (
    hunksEqual &&
    areStringArraysEqual(left.additionLines, right.additionLines) &&
    areStringArraysEqual(left.deletionLines, right.deletionLines)
  );
}

/**
 * The previous parse per scope, by file identity. A refetched patch is parsed
 * from scratch, and downstream a fresh object reads as "this file changed":
 * the diff instance rebuilds and re-highlights it. Files whose change did not
 * move keep the object they already had, so identity means "same diff" and a
 * save to one file leaves the others untouched.
 */
const lastParsedFilesByScope = new Map<string, ReadonlyMap<string, FileDiffMetadata>>();

function shareUnchangedFiles(files: FileDiffMetadata[], cacheScope: string): FileDiffMetadata[] {
  const previous = lastParsedFilesByScope.get(cacheScope);
  const next = new Map<string, FileDiffMetadata>();
  const shared = files.map((file) => {
    const identity = buildFileDiffRenderKey(file);
    const prior = previous?.get(identity);
    const kept = prior !== undefined && areFileDiffContentsEqual(prior, file) ? prior : file;
    next.set(identity, kept);
    return kept;
  });
  lastParsedFilesByScope.set(cacheScope, next);
  return shared;
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = normalizePatchForParsing(patch);
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = shareUnchangedFiles(
      parsedPatches.flatMap((parsedPatch) => parsedPatch.files),
      cacheScope,
    );
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}
