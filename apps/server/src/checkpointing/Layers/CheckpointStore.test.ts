// @effect-diagnostics nodeBuiltinImport:off
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vitest";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CHECKPOINT_REFS_PREFIX, LEGACY_CHECKPOINT_REFS_PREFIX } from "../../vcs/checkpointRefs.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type { VcsError } from "@threadlines/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@threadlines/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = path.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });

  describe("selective revert operations", () => {
    it.effect("diffs checkpoint entries and restores only the requested paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-selective-restore");
        const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const latestCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* writeTextFile(path.join(tmp, "mine.txt"), "mine v1\n");
        yield* writeTextFile(path.join(tmp, "doomed.txt"), "doomed v1\n");
        yield* writeTextFile(path.join(tmp, "foreign.txt"), "foreign v1\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: targetCheckpointRef });

        // The thread edits mine.txt, deletes doomed.txt, and creates fresh.txt.
        yield* writeTextFile(path.join(tmp, "mine.txt"), "mine v2\n");
        yield* fileSystem.remove(path.join(tmp, "doomed.txt"));
        yield* writeTextFile(path.join(tmp, "fresh.txt"), "fresh v1\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: latestCheckpointRef });

        // Another session changes foreign.txt after the thread's last snapshot.
        yield* writeTextFile(path.join(tmp, "foreign.txt"), "foreign v2\n");

        const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: targetCheckpointRef,
        });
        const latestCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: latestCheckpointRef,
        });
        expect(targetCommit).not.toBeNull();
        expect(latestCommit).not.toBeNull();

        const entries = yield* checkpointStore.diffCheckpointEntries({
          cwd: tmp,
          fromCommit: targetCommit ?? "",
          toCommit: latestCommit ?? "",
        });
        const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
        expect([...entryByPath.keys()].toSorted()).toEqual(["doomed.txt", "fresh.txt", "mine.txt"]);
        expect(entryByPath.get("mine.txt")?.fromOid).not.toBeNull();
        expect(entryByPath.get("mine.txt")?.toOid).not.toBeNull();
        expect(entryByPath.get("doomed.txt")?.toOid).toBeNull();
        expect(entryByPath.get("fresh.txt")?.fromOid).toBeNull();

        const worktreeStates = yield* checkpointStore.hashWorktreePaths({
          cwd: tmp,
          paths: ["mine.txt", "doomed.txt", "fresh.txt"],
        });
        const stateByPath = new Map(worktreeStates.map((state) => [state.path, state]));
        expect(stateByPath.get("mine.txt")?.kind).toBe("file");
        expect(stateByPath.get("mine.txt")?.oid).toBe(entryByPath.get("mine.txt")?.toOid);
        expect(stateByPath.get("doomed.txt")?.kind).toBe("missing");
        expect(stateByPath.get("fresh.txt")?.oid).toBe(entryByPath.get("fresh.txt")?.toOid);

        yield* checkpointStore.restoreCheckpointPaths({
          cwd: tmp,
          checkpointCommit: targetCommit ?? "",
          restorePaths: ["mine.txt", "doomed.txt"],
          deletePaths: ["fresh.txt"],
        });

        expect(yield* fileSystem.readFileString(path.join(tmp, "mine.txt"))).toBe("mine v1\n");
        expect(yield* fileSystem.readFileString(path.join(tmp, "doomed.txt"))).toBe("doomed v1\n");
        expect(yield* fileSystem.exists(path.join(tmp, "fresh.txt"))).toBe(false);
        // The untouched path keeps the other session's content.
        expect(yield* fileSystem.readFileString(path.join(tmp, "foreign.txt"))).toBe(
          "foreign v2\n",
        );
      }),
    );

    it.effect("applies inverse hunks around non-overlapping later edits and rejects overlaps", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-hunk-restore");
        const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const latestCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        const lines = (first: string, last: string): string =>
          [first, "line2", "line3", "line4", "line5", "line6", "line7", "line8", "line9", last]
            .join("\n")
            .concat("\n");

        const filePath = path.join(tmp, "lines.txt");
        yield* writeTextFile(filePath, lines("line1", "line10"));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: targetCheckpointRef });

        // The thread edits the first line.
        yield* writeTextFile(filePath, lines("line1-thread", "line10"));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: latestCheckpointRef });

        // Another actor later edits the last line, far from the thread's hunk.
        yield* writeTextFile(filePath, lines("line1-thread", "line10-other"));

        const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: targetCheckpointRef,
        });
        const latestCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: latestCheckpointRef,
        });

        const applied = yield* checkpointStore.restoreCheckpointFileHunks({
          cwd: tmp,
          fromCommit: latestCommit ?? "",
          toCommit: targetCommit ?? "",
          path: "lines.txt",
        });
        expect(applied).toBe(true);
        // The thread's edit is undone while the other actor's edit survives.
        expect(yield* fileSystem.readFileString(filePath)).toBe(lines("line1", "line10-other"));

        // Overlapping case: the other actor rewrites the same line the
        // thread touched, so the inverse patch must be refused.
        yield* writeTextFile(filePath, lines("line1", "line10"));
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: checkpointRefForThreadTurn(threadId, 3),
        });
        yield* writeTextFile(filePath, lines("line1-thread-again", "line10"));
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: checkpointRefForThreadTurn(threadId, 4),
        });
        yield* writeTextFile(filePath, lines("line1-other-overwrite", "line10"));

        const overlapTargetCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: checkpointRefForThreadTurn(threadId, 3),
        });
        const overlapLatestCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: checkpointRefForThreadTurn(threadId, 4),
        });
        const overlapApplied = yield* checkpointStore.restoreCheckpointFileHunks({
          cwd: tmp,
          fromCommit: overlapLatestCommit ?? "",
          toCommit: overlapTargetCommit ?? "",
          path: "lines.txt",
        });
        expect(overlapApplied).toBe(false);
        expect(yield* fileSystem.readFileString(filePath)).toBe(
          lines("line1-other-overwrite", "line10"),
        );
      }),
    );

    it.effect("hunk-reverts an EOF append when another session appended right after it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-eof-append");
        const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const latestCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        const baseline = ["# TODO", "", "- [ ] existing item"].join("\n").concat("\n");
        const threadBlock = ["", "## thread scratchpad", "", "- [ ] mine"].join("\n").concat("\n");
        const foreignBlock = ["", "## second session", "", "- [ ] theirs"].join("\n").concat("\n");

        const filePath = path.join(tmp, "notes.md");
        yield* writeTextFile(filePath, baseline);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: targetCheckpointRef });

        // The thread appends its block at the end of the file.
        yield* writeTextFile(filePath, baseline + threadBlock);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: latestCheckpointRef });

        // Another session appends its own block directly after the thread's.
        yield* writeTextFile(filePath, baseline + threadBlock + foreignBlock);

        const targetCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: targetCheckpointRef,
        });
        const latestCommit = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: latestCheckpointRef,
        });

        const applied = yield* checkpointStore.restoreCheckpointFileHunks({
          cwd: tmp,
          fromCommit: latestCommit ?? "",
          toCommit: targetCommit ?? "",
          path: "notes.md",
        });

        expect(applied).toBe(true);
        expect(yield* fileSystem.readFileString(filePath)).toBe(baseline + foreignBlock);
      }),
    );

    it.effect("reports non-file worktree paths and honors head fallback resolution", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-selective-kinds");
        const missingCheckpointRef = checkpointRefForThreadTurn(threadId, 0);

        yield* fileSystem.makeDirectory(path.join(tmp, "a-directory"));

        const states = yield* checkpointStore.hashWorktreePaths({
          cwd: tmp,
          paths: ["a-directory", "not-there.txt"],
        });
        expect(states).toEqual([
          { path: "a-directory", kind: "other", oid: null },
          { path: "not-there.txt", kind: "missing", oid: null },
        ]);

        const withoutFallback = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: missingCheckpointRef,
        });
        expect(withoutFallback).toBeNull();

        const headCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        const withFallback = yield* checkpointStore.resolveCheckpointCommit({
          cwd: tmp,
          checkpointRef: missingCheckpointRef,
          fallbackToHead: true,
        });
        expect(withFallback).toBe(headCommit);
      }),
    );
  });

  describe("legacy checkpoint ref migration", () => {
    const toLegacyRef = (checkpointRef: string): string =>
      checkpointRef.replace(CHECKPOINT_REFS_PREFIX, LEGACY_CHECKPOINT_REFS_PREFIX);

    const listLegacyRefs = (cwd: string) =>
      git(cwd, ["for-each-ref", "--format=%(refname)", LEGACY_CHECKPOINT_REFS_PREFIX]);

    it.effect("moves refs/t3 checkpoint refs to the threadlines namespace on first use", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-legacy-migration");
        const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
        const headCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["update-ref", toLegacyRef(checkpointRef), headCommit]);

        const hasCheckpoint = yield* checkpointStore.hasCheckpointRef({
          cwd: tmp,
          checkpointRef,
        });

        expect(hasCheckpoint).toBe(true);
        expect(yield* git(tmp, ["rev-parse", checkpointRef])).toBe(headCommit);
        expect(yield* listLegacyRefs(tmp)).toBe("");
      }),
    );

    it.effect("keeps existing threadlines refs on collision and still drops legacy refs", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-legacy-collision");
        const collidingRef = checkpointRefForThreadTurn(threadId, 1);
        const legacyOnlyRef = checkpointRefForThreadTurn(threadId, 2);

        const firstCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# updated\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "second commit"]);
        const secondCommit = yield* git(tmp, ["rev-parse", "HEAD"]);

        yield* git(tmp, ["update-ref", collidingRef, secondCommit]);
        yield* git(tmp, ["update-ref", toLegacyRef(collidingRef), firstCommit]);
        yield* git(tmp, ["update-ref", toLegacyRef(legacyOnlyRef), firstCommit]);

        const hasCheckpoint = yield* checkpointStore.hasCheckpointRef({
          cwd: tmp,
          checkpointRef: collidingRef,
        });

        expect(hasCheckpoint).toBe(true);
        expect(yield* git(tmp, ["rev-parse", collidingRef])).toBe(secondCommit);
        expect(yield* git(tmp, ["rev-parse", legacyOnlyRef])).toBe(firstCommit);
        expect(yield* listLegacyRefs(tmp)).toBe("");
      }),
    );
  });
});
