import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: { readonly detect: VcsDriverRegistry.VcsDriverRegistryShape["detect"] }) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

function makeGitHandle(): VcsDriverRegistry.VcsDriverHandle {
  return {
    kind: "git",
    repository: {} as VcsDriverRegistry.VcsDriverHandle["repository"],
    driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
  };
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        headSha: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        headSha: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("mergeRef merges and pushes the current branch", () => {
    const statusDetails = vi.fn(() =>
      Effect.succeed({
        isRepo: true,
        hasOriginRemote: true,
        isDefaultBranch: true,
        branch: "main",
        headSha: null,
        upstreamRef: "origin/main",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
      }),
    );
    const mergeInputs: unknown[] = [];
    const pushInputs: unknown[] = [];
    const mergeRef = vi.fn((input: unknown) => {
      mergeInputs.push(input);
      return Effect.succeed({ refName: "main" });
    });
    const pushCurrentBranch = vi.fn((cwd: string, fallbackBranch: string | null) => {
      pushInputs.push([cwd, fallbackBranch]);
      return Effect.succeed({
        status: "pushed" as const,
        branch: "main",
        upstreamBranch: "origin/main",
        setUpstream: false,
      });
    });

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed(makeGitHandle()),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails,
          mergeRef,
          pushCurrentBranch,
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.mergeRef({ cwd: "/repo", refName: "feature" });

      assert.deepStrictEqual(result, {
        refName: "main",
        push: {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin/main",
          setUpstream: false,
        },
      });
      assert.deepStrictEqual(mergeInputs[0], { cwd: "/repo", refName: "feature" });
      assert.deepStrictEqual(pushInputs[0], ["/repo", "main"]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("mergeRef refuses to merge when the current branch is behind upstream", () => {
    const mergeRef = vi.fn();
    const pushCurrentBranch = vi.fn();
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed(makeGitHandle()),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              headSha: null,
              upstreamRef: "origin/main",
              hasWorkingTreeChanges: false,
              workingTree: {
                files: [],
                insertions: 0,
                deletions: 0,
              },
              hasUpstream: true,
              aheadCount: 0,
              behindCount: 1,
              aheadOfDefaultCount: 0,
            }),
          mergeRef,
          pushCurrentBranch,
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .mergeRef({ cwd: "/repo", refName: "feature" })
        .pipe(Effect.flip);

      assert.match(error.message, /behind upstream/i);
      assert.equal(mergeRef.mock.calls.length, 0);
      assert.equal(pushCurrentBranch.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });
});
