/**
 * Pull request template detection.
 *
 * Templates are read out of the committed tree (`git ls-tree` + `git cat-file`)
 * rather than off disk. That is deliberate: a worktree can contain a symlink,
 * a junction, or an unrelated working-tree file at any of these paths, and
 * reading it directly would let a checked-out branch decide which host file
 * gets pasted into a model prompt. Blobs reachable from a treeish are always
 * repository content.
 *
 * @module PrTemplateDetection
 */
import * as Effect from "effect/Effect";

import type { ExecuteGitInput, ExecuteGitResult } from "../vcs/GitVcsDriver.ts";
import type { GitCommandError } from "@threadlines/contracts";

export type ExecuteGitCommand = (
  input: ExecuteGitInput,
) => Effect.Effect<ExecuteGitResult, GitCommandError>;

/** Exact template locations, most specific first. */
export const PR_TEMPLATE_PATHS: ReadonlyArray<string> = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

/** Directories that may hold one or more template variants. */
export const PR_TEMPLATE_DIRECTORIES: ReadonlyArray<string> = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
];

/** Cap on the tree listing. A repository that needs more than this to list a
 *  handful of known paths is not one we want to keep parsing. */
const TREE_LISTING_MAX_OUTPUT_BYTES = 100_000;
/** Cap on a single template blob. */
const TEMPLATE_MAX_OUTPUT_BYTES = 8_000;
const TRUNCATION_MARKER = "\n\n[truncated]";
const GIT_TIMEOUT_MS = 10_000;

/** Regular files only. Symlinks (120000), gitlinks (160000), and trees are
 *  never templates. */
const BLOB_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;

interface TemplateBlob {
  readonly path: string;
  readonly objectId: string;
}

/**
 * Parse `git ls-tree -r -z --full-tree` output. Records are
 * `<mode> SP <type> SP <object> TAB <path>` separated by NUL.
 */
export function parseTreeBlobs(stdout: string): ReadonlyArray<TemplateBlob> {
  const blobs: TemplateBlob[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;

    const [mode, type, objectId] = record.slice(0, tabIndex).split(/\s+/);
    const path = record.slice(tabIndex + 1);
    if (type !== "blob" || path.length === 0) continue;
    if (mode === undefined || !BLOB_FILE_MODES.has(mode)) continue;
    if (objectId === undefined || !OBJECT_ID_PATTERN.test(objectId)) continue;

    blobs.push({ path, objectId });
  }
  return blobs;
}

function isDirectChildMarkdown(path: string, directory: string): boolean {
  const prefix = `${directory}/`;
  if (!path.startsWith(prefix)) return false;
  const remainder = path.slice(prefix.length);
  return (
    remainder.length > 0 && !remainder.includes("/") && remainder.toLowerCase().endsWith(".md")
  );
}

export interface DetectPrTemplateInput {
  readonly cwd: string;
  /** Commit-ish the template should be read from, usually the PR base branch. */
  readonly treeish: string;
  readonly executeGit: ExecuteGitCommand;
}

const readPrTemplate = Effect.fn("readPrTemplate")(function* (input: DetectPrTemplateInput) {
  const listing = yield* input.executeGit({
    operation: "PrTemplateDetection.listTemplates",
    cwd: input.cwd,
    args: [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      input.treeish,
      "--",
      ...PR_TEMPLATE_PATHS,
      ...PR_TEMPLATE_DIRECTORIES,
    ],
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
    appendTruncationMarker: false,
  });

  // A truncated listing may have cut a record mid-path, so no entry can be
  // trusted to point at the object it claims.
  if (listing.stdoutTruncated) {
    return null;
  }

  const blobs = parseTreeBlobs(listing.stdout);
  if (blobs.length === 0) {
    return null;
  }
  const blobsByPath = new Map(blobs.map((blob) => [blob.path, blob] as const));

  const readTemplate = Effect.fn("detectPrTemplate.readTemplate")(function* (objectId: string) {
    const result = yield* input.executeGit({
      operation: "PrTemplateDetection.readTemplate",
      cwd: input.cwd,
      args: ["cat-file", "blob", objectId],
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: TEMPLATE_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    const content = result.stdoutTruncated ? `${result.stdout}${TRUNCATION_MARKER}` : result.stdout;
    return content.trim().length > 0 ? content : null;
  });

  for (const templatePath of PR_TEMPLATE_PATHS) {
    const blob = blobsByPath.get(templatePath);
    if (!blob) continue;
    const template = yield* readTemplate(blob.objectId);
    if (template !== null) {
      return template;
    }
  }

  for (const directory of PR_TEMPLATE_DIRECTORIES) {
    const candidates = blobs.filter((blob) => isDirectChildMarkdown(blob.path, directory));
    if (candidates.length === 0) continue;

    const templates: string[] = [];
    for (const candidate of candidates) {
      const template = yield* readTemplate(candidate.objectId);
      if (template !== null) {
        templates.push(template);
      }
    }

    // Several variants means the repository expects the author to pick one.
    // Guessing would silently apply the wrong structure, so apply none.
    if (templates.length > 1) {
      return null;
    }
    if (templates.length === 1) {
      return templates[0] ?? null;
    }
  }

  return null;
});

/**
 * Read the repository's pull request template out of `treeish`, or `null` when
 * there is no template, more than one candidate in a template directory, or
 * git fails for any reason. Detection is best effort: it never fails the PR.
 */
export const detectPrTemplate = (
  input: DetectPrTemplateInput,
): Effect.Effect<string | null, never> =>
  readPrTemplate(input).pipe(Effect.orElseSucceed(() => null));
