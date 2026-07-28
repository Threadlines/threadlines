import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ExecuteGitResult } from "../vcs/GitVcsDriver.ts";
import { detectPrTemplate, type ExecuteGitCommand } from "./PrTemplateDetection.ts";

const CWD = "/repo";
const TREEISH = "main";

const gitResult = (
  stdout: string,
  options?: { readonly stdoutTruncated?: boolean },
): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: options?.stdoutTruncated ?? false,
  stderrTruncated: false,
});

interface TreeEntry {
  readonly path: string;
  readonly objectId: string;
  readonly content: string;
  readonly mode?: string;
  readonly type?: string;
}

/** Stub git that serves a fixed tree listing plus its blobs. */
function makeExecuteGit(input: {
  readonly entries: ReadonlyArray<TreeEntry>;
  readonly listingTruncated?: boolean;
}): ExecuteGitCommand {
  const listing = input.entries
    .map(
      (entry) =>
        `${entry.mode ?? "100644"} ${entry.type ?? "blob"} ${entry.objectId}\t${entry.path}\0`,
    )
    .join("");
  const blobs = new Map(input.entries.map((entry) => [entry.objectId, entry.content] as const));

  return (command) => {
    if (command.args[0] === "ls-tree") {
      return Effect.succeed(
        gitResult(listing, { stdoutTruncated: input.listingTruncated ?? false }),
      );
    }
    if (command.args[0] === "cat-file") {
      return Effect.succeed(gitResult(blobs.get(command.args[2] ?? "") ?? ""));
    }
    return Effect.succeed(gitResult(""));
  };
}

const objectId = (seed: string) => seed.padEnd(40, "0");

it.effect("prefers the highest priority exact template path", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: makeExecuteGit({
        entries: [
          {
            path: "docs/pull_request_template.md",
            objectId: objectId("d"),
            content: "## Docs template",
          },
          {
            path: ".github/pull_request_template.md",
            objectId: objectId("a"),
            content: "## Root template",
          },
        ],
      }),
    });

    assert.equal(template, "## Root template");
  }),
);

it.effect("skips blobs that are not regular files", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: makeExecuteGit({
        entries: [
          {
            path: ".github/pull_request_template.md",
            objectId: objectId("a"),
            content: "/etc/passwd",
            mode: "120000",
          },
        ],
      }),
    });

    assert.equal(template, null);
  }),
);

it.effect("reads a single template out of a template directory", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: makeExecuteGit({
        entries: [
          {
            path: ".github/PULL_REQUEST_TEMPLATE/bug.md",
            objectId: objectId("b"),
            content: "## Bug report",
          },
          // Nested files are not offered by GitHub, so they are not templates.
          {
            path: ".github/PULL_REQUEST_TEMPLATE/nested/other.md",
            objectId: objectId("c"),
            content: "## Nested",
          },
        ],
      }),
    });

    assert.equal(template, "## Bug report");
  }),
);

it.effect("applies no template when a directory holds several variants", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: makeExecuteGit({
        entries: [
          {
            path: ".github/PULL_REQUEST_TEMPLATE/bug.md",
            objectId: objectId("b"),
            content: "## Bug report",
          },
          {
            path: ".github/PULL_REQUEST_TEMPLATE/feature.md",
            objectId: objectId("f"),
            content: "## Feature",
          },
        ],
      }),
    });

    assert.equal(template, null);
  }),
);

it.effect("applies no template when the tree listing was truncated", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: makeExecuteGit({
        entries: [
          {
            path: ".github/pull_request_template.md",
            objectId: objectId("a"),
            content: "## Root template",
          },
        ],
        listingTruncated: true,
      }),
    });

    assert.equal(template, null);
  }),
);

it.effect("applies no template when git fails", () =>
  Effect.gen(function* () {
    const template = yield* detectPrTemplate({
      cwd: CWD,
      treeish: TREEISH,
      executeGit: () =>
        Effect.fail(
          new GitCommandError({
            operation: "PrTemplateDetection.listTemplates",
            command: "git ls-tree",
            cwd: CWD,
            detail: "fatal: not a valid object name",
          }),
        ),
    });

    assert.equal(template, null);
  }),
);
