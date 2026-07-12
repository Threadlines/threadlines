import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@threadlines/contracts";
import { mergeGitStatusParts } from "@threadlines/shared/git";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.minutes(2);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.minutes(2);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const VCS_STATUS_REFRESH_UNCHANGED_MAX_DELAY = Duration.minutes(10);
// Collapse the burst of git-dir events a single commit produces (index,
// COMMIT_EDITMSG, ref update, reflog append) into one refresh, and absorb the
// echo of our own `git status` opportunistically rewriting the index.
const GIT_DIR_WATCH_DEBOUNCE = Duration.millis(300);
const GIT_DIR_RESOLVE_RETRY_INTERVAL = Duration.seconds(30);
const SNAPSHOT_LOCAL_REVALIDATE_AGE = Duration.seconds(5);
const SNAPSHOT_REMOTE_REVALIDATE_AGE = Duration.seconds(30);

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly updatedAtMs: number;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface CachedUpdate<T> {
  readonly changed: boolean;
  readonly value: T;
}

interface ActiveCwdMonitor {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export function remoteRefreshSuccessDelay(
  consecutiveUnchangedRefreshes: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveUnchangedRefreshes - 1);
  const backoffMs = Duration.toMillis(configuredInterval) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(backoffMs), VCS_STATUS_REFRESH_UNCHANGED_MAX_DELAY);
}

export interface VcsStatusBroadcasterShape {
  readonly getStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: VcsStatusInput,
    options?: StreamStatusOptions,
  ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  VcsStatusBroadcasterShape
>()("threadlines/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const layer = Layer.effect(
  VcsStatusBroadcaster,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<VcsStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
    const monitorsRef = yield* SynchronizedRef.make(new Map<string, ActiveCwdMonitor>());

    const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
      cwd: string,
    ) {
      return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
    });

    const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
      function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
        const updatedAtMs = yield* Clock.currentTimeMillis;
        const nextLocal = {
          fingerprint: fingerprintStatusPart(local),
          updatedAtMs,
          value: local,
        } satisfies CachedValue<VcsStatusLocalResult>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            local: nextLocal,
          });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "localUpdated",
              local,
            },
          });
        }

        return local;
      },
    );

    const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
      function* (
        cwd: string,
        remote: VcsStatusRemoteResult | null,
        options?: { publish?: boolean },
      ) {
        const updatedAtMs = yield* Clock.currentTimeMillis;
        const nextRemote = {
          fingerprint: fingerprintStatusPart(remote),
          updatedAtMs,
          value: remote,
        } satisfies CachedValue<VcsStatusRemoteResult | null>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            remote: nextRemote,
          });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "remoteUpdated",
              remote,
            },
          });
        }

        return {
          changed: shouldPublish,
          value: remote,
        } satisfies CachedUpdate<VcsStatusRemoteResult | null>;
      },
    );

    const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
      cwd: string,
    ) {
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local);
    });

    const loadRemoteStatus = Effect.fn("VcsStatusBroadcaster.loadRemoteStatus")(function* (
      cwd: string,
    ) {
      const remote = yield* workflow.remoteStatus({ cwd });
      return (yield* updateCachedRemoteStatus(cwd, remote)).value;
    });

    const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
      cwd: string,
    ) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(cwd);
    });

    const getOrLoadRemoteStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadRemoteStatus")(
      function* (cwd: string) {
        const cached = yield* getCachedStatus(cwd);
        if (cached?.remote) {
          return cached.remote.value;
        }
        return yield* loadRemoteStatus(cwd);
      },
    );

    const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

    const getStatus: VcsStatusBroadcasterShape["getStatus"] = Effect.fn(
      "VcsStatusBroadcaster.getStatus",
    )(function* (input) {
      const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
      const [local, remote] = yield* Effect.all([
        getOrLoadLocalStatus(cwd),
        getOrLoadRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const refreshLocalStatus: VcsStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshLocalStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    });

    const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
      cwd: string,
    ) {
      yield* workflow.invalidateRemoteStatus(cwd);
      const remote = yield* workflow.remoteStatus({ cwd });
      return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
    });

    const refreshStatus: VcsStatusBroadcasterShape["refreshStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      const [local, remote] = yield* Effect.all([
        refreshLocalStatus(cwd),
        refreshRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote.value);
    });

    const refreshAfterGitDirChange = Effect.fn("VcsStatusBroadcaster.refreshAfterGitDirChange")(
      function* (cwd: string) {
        yield* Effect.all([refreshLocalStatus(cwd), refreshRemoteStatus(cwd)], {
          concurrency: "unbounded",
        }).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));
      },
    );

    // Resolves the git metadata directory for a worktree, following the
    // `gitdir:` pointer file used by linked worktrees.
    const resolveGitDir = Effect.fn("VcsStatusBroadcaster.resolveGitDir")(function* (cwd: string) {
      const dotGit = path.join(cwd, ".git");
      const info = yield* fs.stat(dotGit).pipe(Effect.orElseSucceed(() => null));
      if (info === null) {
        return null;
      }
      if (info.type === "Directory") {
        return dotGit;
      }
      if (info.type !== "File") {
        return null;
      }
      const contents = yield* fs.readFileString(dotGit).pipe(Effect.orElseSucceed(() => null));
      const pointer = contents?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (pointer === undefined) {
        return null;
      }
      return path.isAbsolute(pointer) ? pointer : path.resolve(cwd, pointer);
    });

    const directoryExists = (candidate: string) =>
      fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

    // Directories whose direct entries change on local git activity: HEAD /
    // index / packed-refs and reflog appends in the (work)tree git dir, plus
    // loose ref updates in the shared git dir for commits, branch moves, and
    // pushes updating remote-tracking refs. `fs.watch` is non-recursive, so
    // slash-nested ref files are only caught indirectly (via the HEAD reflog).
    const resolveGitDirWatchRoots = Effect.fn("VcsStatusBroadcaster.resolveGitDirWatchRoots")(
      function* (cwd: string) {
        const gitDir = yield* resolveGitDir(cwd);
        if (gitDir === null) {
          return [];
        }
        const commonDirPointer = yield* fs
          .readFileString(path.join(gitDir, "commondir"))
          .pipe(Effect.orElseSucceed(() => null));
        const trimmedCommonDirPointer = commonDirPointer?.trim();
        const commonDir = trimmedCommonDirPointer
          ? path.resolve(gitDir, trimmedCommonDirPointer)
          : gitDir;
        const candidates = [
          gitDir,
          path.join(gitDir, "logs"),
          commonDir,
          path.join(commonDir, "refs", "heads"),
          path.join(commonDir, "refs", "remotes", "origin"),
        ];
        const roots: string[] = [];
        for (const candidate of new Set(candidates)) {
          if (yield* directoryExists(candidate)) {
            roots.push(candidate);
          }
        }
        return roots;
      },
    );

    const isRelevantGitDirEvent = (eventPath: string) => {
      const base = path.basename(eventPath);
      // Lock files churn while git commands run, and FETCH_HEAD is rewritten
      // by our own staleness-gated background fetches; reacting to either
      // would echo refreshes without any status change.
      return !base.endsWith(".lock") && base !== "FETCH_HEAD";
    };

    // Keeps working-tree-affecting git activity (commits, stages, branch
    // switches, merges) flowing to subscribers without polling: watch the git
    // metadata directories and refresh on change. Loops so a cwd that is not
    // a repository yet (or loses its git dir) is picked up later.
    const makeGitDirWatchLoop = (cwd: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        while (true) {
          const roots = yield* resolveGitDirWatchRoots(cwd).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          );
          if (roots.length > 0) {
            const events = roots
              .map((root) => fs.watch(root))
              .reduce((merged, stream) => Stream.merge(merged, stream))
              .pipe(
                Stream.filter((event) => isRelevantGitDirEvent(event.path)),
                Stream.debounce(GIT_DIR_WATCH_DEBOUNCE),
              );
            yield* Stream.runForEach(events, () => refreshAfterGitDirChange(cwd)).pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning("VCS git dir watch failed", {
                  cwd,
                  detail: cause.toString(),
                }),
              ),
              Effect.ignore,
            );
          }
          // Not a repository yet, or the watch stream ended (git dir moved or
          // removed); wait before resolving the watch roots again.
          yield* Effect.sleep(GIT_DIR_RESOLVE_RETRY_INTERVAL);
        }
      });

    const makeRemoteRefreshLoop = (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) => {
      return Effect.gen(function* () {
        const consecutiveFailuresRef = yield* Ref.make(0);
        const consecutiveUnchangedRefreshesRef = yield* Ref.make(0);
        const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          const activeInterval = Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval;
          if (Duration.isZero(configuredInterval)) {
            return activeInterval;
          }

          const cached = yield* getCachedStatus(cwd);
          const cachedRemoteUpdatedAtMs = cached?.remote?.updatedAtMs ?? null;
          if (cachedRemoteUpdatedAtMs !== null) {
            const nowMs = yield* Clock.currentTimeMillis;
            const activeIntervalMs = Duration.toMillis(activeInterval);
            const cacheAgeMs = Math.max(0, nowMs - cachedRemoteUpdatedAtMs);
            if (cacheAgeMs < activeIntervalMs) {
              return Duration.millis(Math.max(1, activeIntervalMs - cacheAgeMs));
            }
          }

          const exit = yield* refreshRemoteStatus(cwd).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            yield* Ref.set(consecutiveFailuresRef, 0);
            const consecutiveUnchangedRefreshes = exit.value.changed
              ? yield* Ref.set(consecutiveUnchangedRefreshesRef, 0).pipe(Effect.as(0))
              : yield* Ref.updateAndGet(consecutiveUnchangedRefreshesRef, (count) => count + 1);
            return remoteRefreshSuccessDelay(consecutiveUnchangedRefreshes, activeInterval);
          }

          const consecutiveFailures = yield* Ref.updateAndGet(
            consecutiveFailuresRef,
            (count) => count + 1,
          );
          const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
          yield* Effect.logWarning("VCS remote status refresh failed", {
            cwd,
            detail: exit.cause.toString(),
            consecutiveFailures,
            nextDelayMs: Duration.toMillis(nextDelay),
          });
          return nextDelay;
        });

        return yield* refreshRemoteStatusIfEnabled.pipe(
          Effect.repeat(
            Schedule.identity<Duration.Duration>().pipe(
              Schedule.addDelay(({ output: delay }) => Effect.succeed(delay)),
            ),
          ),
          Effect.asVoid,
        );
      });
    };

    // One background monitor per subscribed cwd: the periodic remote-status
    // poller plus the git dir watcher that reacts to local git activity.
    const makeCwdMonitor = (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ): Effect.Effect<void, never> =>
      Effect.all(
        [makeRemoteRefreshLoop(cwd, automaticRemoteRefreshInterval), makeGitDirWatchLoop(cwd)],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

    const retainCwdMonitor = Effect.fn("VcsStatusBroadcaster.retainCwdMonitor")(function* (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) {
      yield* SynchronizedRef.modifyEffect(monitorsRef, (activeMonitors) => {
        const existing = activeMonitors.get(cwd);
        if (existing) {
          const nextMonitors = new Map(activeMonitors);
          nextMonitors.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextMonitors] as const);
        }

        return makeCwdMonitor(cwd, automaticRemoteRefreshInterval).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextMonitors = new Map(activeMonitors);
            nextMonitors.set(cwd, {
              fiber,
              subscriberCount: 1,
            });
            return [undefined, nextMonitors] as const;
          }),
        );
      });
    });

    const releaseCwdMonitor = Effect.fn("VcsStatusBroadcaster.releaseCwdMonitor")(function* (
      cwd: string,
    ) {
      const monitorToInterrupt = yield* SynchronizedRef.modify(monitorsRef, (activeMonitors) => {
        const existing = activeMonitors.get(cwd);
        if (!existing) {
          return [null, activeMonitors] as const;
        }

        if (existing.subscriberCount > 1) {
          const nextMonitors = new Map(activeMonitors);
          nextMonitors.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount - 1,
          });
          return [null, nextMonitors] as const;
        }

        const nextMonitors = new Map(activeMonitors);
        nextMonitors.delete(cwd);
        return [existing.fiber, nextMonitors] as const;
      });

      if (monitorToInterrupt) {
        yield* Fiber.interrupt(monitorToInterrupt).pipe(Effect.ignore);
      }
    });

    // The snapshot served to a new subscriber comes straight from the cache;
    // kick off a background refresh for parts that are old enough to have
    // drifted so freshly opened threads converge without a manual refresh.
    const revalidateStaleSnapshot = Effect.fn("VcsStatusBroadcaster.revalidateStaleSnapshot")(
      function* (cwd: string, cached: CachedVcsStatus | null) {
        if (cached === null) {
          return;
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const staleLocal =
          cached.local !== null &&
          nowMs - cached.local.updatedAtMs >= Duration.toMillis(SNAPSHOT_LOCAL_REVALIDATE_AGE);
        const staleRemote =
          cached.remote !== null &&
          nowMs - cached.remote.updatedAtMs >= Duration.toMillis(SNAPSHOT_REMOTE_REVALIDATE_AGE);
        if (!staleLocal && !staleRemote) {
          return;
        }
        yield* Effect.all(
          [
            ...(staleLocal ? [refreshLocalStatus(cwd)] : []),
            ...(staleRemote ? [refreshRemoteStatus(cwd)] : []),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }), Effect.forkIn(broadcasterScope));
      },
    );

    const streamStatus: VcsStatusBroadcasterShape["streamStatus"] = (input, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const cached = yield* getCachedStatus(cwd);
          const initialLocal = cached?.local ? cached.local.value : yield* loadLocalStatus(cwd);
          const initialRemote = cached?.remote?.value ?? null;
          yield* revalidateStaleSnapshot(cwd, cached);
          yield* retainCwdMonitor(
            cwd,
            options?.automaticRemoteRefreshInterval ??
              Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          );

          const release = releaseCwdMonitor(cwd).pipe(Effect.ignore, Effect.asVoid);

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.cwd === cwd),
              Stream.map((event) => event.event),
            ),
          ).pipe(Stream.ensuring(release));
        }),
      );

    return VcsStatusBroadcaster.of({
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    });
  }),
);
