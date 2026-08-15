// @effect-diagnostics nodeBuiltinImport:off
import { assert, it, describe } from "@effect/vitest";
import * as NodeFS from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@threadlines/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type { GitRemoteStatusOptions } from "./GitVcsDriver.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function makeTestLayer(
  state: {
    currentLocalStatus: VcsStatusLocalResult;
    currentRemoteStatus: VcsStatusRemoteResult | null;
    localStatusCalls: number;
    remoteStatusCalls: number;
    localInvalidationCalls: number;
    remoteInvalidationCalls: number;
  },
  options?: {
    readonly onRemoteStatusOptions?: (options: GitRemoteStatusOptions | undefined) => void;
  },
) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, remoteOptions) =>
          Effect.sync(() => {
            options?.onRemoteStatusOptions?.(remoteOptions);
            state.remoteStatusCalls += 1;
            return state.currentRemoteStatus;
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
      }),
    ),
  );
}

describe("VcsStatusBroadcaster", () => {
  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const remoteStatusOptions: Array<GitRemoteStatusOptions | undefined> = [];
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
      assert.deepStrictEqual(remoteStatusOptions, [undefined, { forceRefresh: true }]);
    }).pipe(
      Effect.provide(
        makeTestLayer(state, {
          onRemoteStatusOptions: (options) => remoteStatusOptions.push(options),
        }),
      ),
    );
  });

  it.effect("refreshes only the cached local snapshot when requested", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("normalizes symlinked CWDs before cache lookup and workflow calls", () => {
    const seenCwds: string[] = [];
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowServiceShape>),
      ),
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-real-",
      });
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-link-",
      });
      const linkDir = path.join(linkParent, "repo-link");
      if (process.platform === "win32") {
        yield* Effect.promise(() => NodeFS.symlink(realDir, linkDir, "junction"));
      } else {
        yield* fileSystem.symlink(realDir, linkDir);
      }
      const realPath = yield* fileSystem.realPath(realDir);

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: linkDir });
      yield* broadcaster.getStatus({ cwd: realDir });

      assert.deepStrictEqual(seenCwds, [realPath, realPath]);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("streams a local snapshot first and remote updates later", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "remoteUpdated") {
          return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: baseRemoteStatus,
      } satisfies VcsStatusStreamEvent);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("does not start automatic remote refreshes when disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("does not immediately refresh automatic remote status when the cache is fresh", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const streamScope = yield* Scope.make();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(5)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(streamScope));

      yield* Deferred.await(snapshotDeferred);
      yield* Effect.yieldNow;
      yield* Scope.close(streamScope, Exit.void);

      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("delays the automatic refresh by the remaining interval when cached", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 1);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      240_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      480_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it("backs off unchanged successful remote refreshes up to ten minutes", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(0, Duration.minutes(2))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(1, Duration.minutes(2))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(2, Duration.minutes(2))),
      240_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(3, Duration.minutes(2))),
      480_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(4, Duration.minutes(2))),
      600_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshSuccessDelay(12, Duration.minutes(2))),
      600_000,
    );
  });

  it.effect("revalidates a stale cached snapshot in the background on subscribe", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.localStatusCalls, 1);

      // Two seconds: past the one-second local revalidation age, but inside
      // the remote revalidation window.
      yield* TestClock.adjust(Duration.seconds(2));
      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/revalidated",
      };

      const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "localUpdated"
          ? Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkScoped);

      const localUpdated = yield* Deferred.await(localUpdatedDeferred);
      assert.deepStrictEqual(localUpdated, {
        _tag: "localUpdated",
        local: state.currentLocalStatus,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
      // Two seconds is inside the remote revalidation window, so only the
      // local part refreshes.
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  // Live clock: real fs.watch events have to flow through the debounce.
  it.live("refreshes the status when the git metadata directory changes", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-watch-",
      });
      const gitDir = path.join(repoDir, ".git");
      yield* fileSystem.makeDirectory(gitDir);
      yield* fileSystem.writeFileString(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: repoDir }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "localUpdated") {
          return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(snapshotDeferred);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/watched",
      };

      // The watcher registers asynchronously; keep touching the git dir
      // (spaced out beyond the debounce window) until the refresh lands.
      let attempt = 0;
      while (Option.isNone(yield* Deferred.poll(localUpdatedDeferred))) {
        attempt += 1;
        yield* fileSystem.writeFileString(
          path.join(gitDir, "HEAD"),
          `ref: refs/heads/feature/watched ${attempt}\n`,
        );
        yield* Effect.sleep(Duration.millis(500));
      }

      const localUpdated = yield* Deferred.await(localUpdatedDeferred);
      assert.deepStrictEqual(localUpdated, {
        _tag: "localUpdated",
        local: state.currentLocalStatus,
      } satisfies VcsStatusStreamEvent);
      assert.isAtLeast(state.localStatusCalls, 2);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  // Deleting a checkout out of band (an agent's own `git worktree remove`, or
  // the user in a terminal) used to be discovered only when the next turn
  // crashed inside the provider SDK. The watcher reports it directly.
  it.live("reports a watched checkout that disappears", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-checkout-gone-",
      });
      const resolvedParent = yield* fileSystem.realPath(parent);
      const repoDir = path.join(parent, "worktree");
      yield* fileSystem.makeDirectory(path.join(repoDir, ".git"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(repoDir, ".git", "HEAD"),
        "ref: refs/heads/main\n",
      );

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const missing = yield* Deferred.make<{ readonly cwd: string }>();
      yield* Stream.runForEach(broadcaster.observeMissingCheckouts(), (observation) =>
        Deferred.succeed(missing, observation).pipe(Effect.ignore),
      ).pipe(Effect.forkScoped);
      // Subscribing is what starts the per-cwd monitor that watches presence.
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: repoDir }), () => Effect.void).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep(Duration.millis(200));

      // Nothing is reported while the checkout is still there.
      assert.isTrue(Option.isNone(yield* Deferred.poll(missing)));

      yield* Effect.promise(() => NodeFS.rm(repoDir, { recursive: true, force: true }));

      const observed = yield* Deferred.await(missing).pipe(Effect.timeout(Duration.seconds(20)));
      // Monitors are keyed by the resolved real path (temp dirs are symlinked
      // on macOS), so compare against that rather than the path as handed in.
      assert.strictEqual(observed.cwd, path.join(resolvedParent, "worktree"));
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  // A subscription opened while the checkout is already gone must share its
  // cache/stream key with the statuses published once the folder is recreated.
  // `realPath` alone can't provide that: it resolves /tmp/x to /private/tmp/x
  // only while the directory exists, so a missing-at-subscribe path would key
  // on its raw form and never hear another update after recreation.
  it.live("keys a checkout that is missing at subscribe time like one that exists", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The temp parent is symlinked on macOS, which is exactly the class of
      // path this guards: the canonical form differs from the requested one.
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-checkout-key-",
      });
      const resolvedParent = yield* fileSystem.realPath(parent);
      const repoDir = path.join(parent, "worktree");

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const missing = yield* Deferred.make<{ readonly cwd: string }>();
      yield* Stream.runForEach(broadcaster.observeMissingCheckouts(), (observation) =>
        Deferred.succeed(missing, observation).pipe(Effect.ignore),
      ).pipe(Effect.forkScoped);
      // Subscribe while the directory does not exist yet.
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: repoDir }), () => Effect.void).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep(Duration.millis(200));

      // Create the checkout, let a presence poll see it, then delete it: the
      // announced key must be the canonical path, proving the monitor key did
      // not stick to the raw form from the missing-at-subscribe moment.
      yield* fileSystem.makeDirectory(path.join(repoDir, ".git"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(repoDir, ".git", "HEAD"),
        "ref: refs/heads/main\n",
      );
      yield* Effect.sleep(Duration.seconds(3));
      yield* Effect.promise(() => NodeFS.rm(repoDir, { recursive: true, force: true }));

      const observed = yield* Deferred.await(missing).pipe(Effect.timeout(Duration.seconds(20)));
      assert.strictEqual(observed.cwd, path.join(resolvedParent, "worktree"));
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  // Git renames paths in place during ordinary operations. A directory that
  // reads as missing for an instant must not be announced as deleted.
  it.live("does not report a checkout that reappears inside the confirmation window", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-checkout-blip-",
      });
      const repoDir = path.join(parent, "worktree");
      const makeCheckout = Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.join(repoDir, ".git"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(repoDir, ".git", "HEAD"),
          "ref: refs/heads/main\n",
        );
      });
      yield* makeCheckout;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const missing = yield* Deferred.make<{ readonly cwd: string }>();
      yield* Stream.runForEach(broadcaster.observeMissingCheckouts(), (observation) =>
        Deferred.succeed(missing, observation).pipe(Effect.ignore),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: repoDir }), () => Effect.void).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep(Duration.millis(200));

      // Gone and back well inside the confirmation window.
      yield* Effect.promise(() => NodeFS.rm(repoDir, { recursive: true, force: true }));
      yield* Effect.sleep(Duration.millis(150));
      yield* makeCheckout;

      // Past a full poll plus confirmation window with nothing announced.
      yield* Effect.sleep(Duration.seconds(6));
      assert.isTrue(Option.isNone(yield* Deferred.poll(missing)));
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("stops the remote poller after the last stream subscriber disconnects", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowServiceShape>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });
});
