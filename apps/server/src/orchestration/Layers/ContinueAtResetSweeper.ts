import { randomUUID } from "node:crypto";

import { CommandId, MessageId, type ServerProvider, type ThreadId } from "@threadlines/contracts";
import {
  continueAtResetTimeMs,
  listProviderUsageWindows,
  readProviderUsageBlock,
} from "@threadlines/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadContinueAtReset,
} from "../../persistence/Services/ProjectionThreadSessions.ts";
import { SystemWake } from "../../power/Services/SystemWake.ts";
import { freshOrCurrentSnapshot } from "../../provider/freshProviderSnapshot.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  ContinueAtResetSweeper,
  type ContinueAtResetSweeperShape,
} from "../Services/ContinueAtResetSweeper.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

/** Wall-clock checks, so a computer that slept through a reset continues within this of waking. */
const SWEEP_INTERVAL = Duration.seconds(30);
/** Between threads continuing in one pass, so many stopped threads don't spend the fresh limit at once. */
const CONTINUE_SPACING = Duration.seconds(3);
/** When the account says it is still out of room but not until when. */
const RECHECK_WITHOUT_RESET_MS = 15 * 60 * 1_000;
/** How far a spent window's reset may sit from a wait's and still be the limit that stopped the thread. */
const SAME_RESET_SLACK_MS = 2 * 60 * 1_000;
/**
 * How old a reading of a window may be and still show its limit reset early:
 * two of the slowest periodic checks, so a reading kept while checks fail
 * proves nothing.
 */
const EARLY_RESET_READING_MAX_AGE_MS = 10 * 60 * 1_000;

/**
 * The limit a waiting thread stopped on, as a usage reading showed it during
 * the wait: the spent windows that reset when the wait does, and when each
 * was read.
 */
interface SpentLimitSighting {
  readonly lastErrorAt: string;
  readonly resetsAt: string;
  readonly readAtMsByWindow: ReadonlyMap<string, number>;
}

export interface ContinueAtResetSweeperLiveOptions {
  readonly sweepInterval?: Duration.Input;
  readonly continueSpacing?: Duration.Input;
}

const makeContinueAtResetSweeper = (options?: ContinueAtResetSweeperLiveOptions) =>
  Effect.gen(function* () {
    const sessions = yield* ProjectionThreadSessionRepository;
    const providerRegistry = yield* ProviderRegistry;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const systemWake = yield* SystemWake;
    // The interval and `sweepNow` must not both continue one thread.
    const sweepSemaphore = yield* Semaphore.make(1);
    /**
     * What each waiting thread's limit looked like while spent. Kept in memory
     * only: after a restart a wait continues early only once its limit has
     * been seen spent again, and a limit no reading shows waits for its time.
     */
    const spentSightings = new Map<ThreadId, SpentLimitSighting>();

    /**
     * Whether `provider`'s usage reading says the limit `entry` waits on reset
     * before its time: the user spent a limit reset. True only when every
     * window seen spent during this wait is on the reading, read since and
     * within the last few minutes, and nothing on the reading is spent now. A
     * reading that still shows the limit spent is remembered instead.
     */
    const limitResetEarly = (
      entry: ProjectionThreadContinueAtReset,
      provider: ServerProvider | undefined,
      nowMs: number,
    ): boolean => {
      if (provider === undefined) return false;
      const windows = listProviderUsageWindows(provider, nowMs);
      if (windows === null) return false;
      const waitResetsAtMs = Date.parse(entry.continueAtReset.resetsAt);
      const stopping = windows.filter(
        (window) =>
          window.spent &&
          window.resetsAtMs !== undefined &&
          Math.abs(window.resetsAtMs - waitResetsAtMs) <= SAME_RESET_SLACK_MS,
      );
      const earlier = spentSightings.get(entry.threadId);
      const seen =
        earlier !== undefined &&
        earlier.lastErrorAt === entry.lastErrorAt &&
        earlier.resetsAt === entry.continueAtReset.resetsAt
          ? earlier
          : undefined;
      if (stopping.length > 0) {
        // A window an earlier reading showed spent stays remembered when this
        // one leaves it out: only reading it again clears it.
        const readAtMsByWindow = new Map(seen?.readAtMsByWindow);
        for (const window of stopping) {
          readAtMsByWindow.set(
            window.key,
            Math.max(window.readAtMs, readAtMsByWindow.get(window.key) ?? 0),
          );
        }
        spentSightings.set(entry.threadId, {
          lastErrorAt: entry.lastErrorAt,
          resetsAt: entry.continueAtReset.resetsAt,
          readAtMsByWindow,
        });
        return false;
      }
      if (seen === undefined) return false;
      // Another spent limit would only stop the thread again.
      if (
        windows.some((window) => window.spent) ||
        readProviderUsageBlock(provider, nowMs).state === "blocked"
      ) {
        return false;
      }
      for (const [key, spentReadAtMs] of seen.readAtMsByWindow) {
        const sameKey = windows.filter((candidate) => candidate.key === key);
        if (
          sameKey.length === 0 ||
          sameKey.some(
            (window) =>
              window.readAtMs <= spentReadAtMs ||
              window.readAtMs < nowMs - EARLY_RESET_READING_MAX_AGE_MS,
          )
        ) {
          return false;
        }
      }
      return true;
    };

    const providerOf = (
      entry: ProjectionThreadContinueAtReset,
      providers: ReadonlyArray<ServerProvider>,
    ) => providers.find((candidate) => candidate.instanceId === entry.providerInstanceId);

    /** The waits whose limit reset early, going by the readings the server already holds. */
    const listEarlyResets = (
      waiting: ReadonlyArray<ProjectionThreadContinueAtReset>,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        for (const threadId of spentSightings.keys()) {
          if (!waiting.some((entry) => entry.threadId === threadId)) {
            spentSightings.delete(threadId);
          }
        }
        // A reset time that has passed is the scheduled continue's business.
        const ahead = waiting.filter(
          (entry) =>
            Date.parse(entry.continueAtReset.resetsAt) > nowMs &&
            Date.parse(entry.continueAtReset.at) > nowMs,
        );
        if (ahead.length === 0) return [];
        const providers = yield* providerRegistry.getProviders;
        return ahead.filter((entry) => limitResetEarly(entry, providerOf(entry, providers), nowMs));
      });

    /** The thread's account as a check made now reads it. */
    const readFreshProvider = (entry: ProjectionThreadContinueAtReset) =>
      Effect.gen(function* () {
        const instanceId = entry.providerInstanceId;
        if (instanceId === null) return undefined;
        const providers = yield* freshOrCurrentSnapshot(
          providerRegistry.refreshInstance(instanceId),
          providerRegistry.getProviders,
        );
        return providerOf(entry, providers);
      });

    /**
     * Continues a thread whose limit reset early, once a fresh reading agrees.
     * One try per sighting: a continue that fails leaves the wait to its time.
     */
    const continueEarly = (entry: ProjectionThreadContinueAtReset) =>
      Effect.gen(function* () {
        const provider = yield* readFreshProvider(entry);
        const nowMs = yield* Clock.currentTimeMillis;
        if (!limitResetEarly(entry, provider, nowMs)) return false;
        spentSightings.delete(entry.threadId);
        const createdAt = new Date(nowMs).toISOString();
        yield* orchestrationEngine.dispatch({
          type: "thread.continue-at-reset.fire",
          commandId: CommandId.make(
            `server:continue-at-reset-early:${entry.threadId}:${entry.lastErrorAt}:${createdAt}`,
          ),
          threadId: entry.threadId,
          lastErrorAt: entry.lastErrorAt,
          messageId: MessageId.make(randomUUID()),
          resetEarly: true,
          createdAt,
        });
        yield* Effect.logInfo("thread.continue-at-reset.continued-early", {
          threadId: entry.threadId,
        });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread.continue-at-reset.failed", {
            threadId: entry.threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    /** Whether the account the thread waits on still says it is out of room, read fresh. */
    const readBlock = (entry: ProjectionThreadContinueAtReset) =>
      Effect.gen(function* () {
        const provider = yield* readFreshProvider(entry);
        return provider === undefined
          ? ({ state: "unknown" } as const)
          : readProviderUsageBlock(provider, yield* Clock.currentTimeMillis);
      });

    /**
     * Continues one waiting thread, or moves its wait later when the account
     * says the limit hasn't reset. The decider checks again that the thread
     * still waits for this failure, so a message the user sent meanwhile wins.
     */
    const continueThread = (entry: ProjectionThreadContinueAtReset) =>
      Effect.gen(function* () {
        const block = yield* readBlock(entry);
        const nowMs = yield* Clock.currentTimeMillis;
        const createdAt = new Date(nowMs).toISOString();
        if (block.state === "blocked") {
          const laterReset =
            block.resetsAtMs !== null && block.resetsAtMs > nowMs ? block.resetsAtMs : null;
          const at = new Date(
            laterReset !== null
              ? continueAtResetTimeMs(laterReset)
              : nowMs + RECHECK_WITHOUT_RESET_MS,
          ).toISOString();
          yield* orchestrationEngine.dispatch({
            type: "thread.continue-at-reset.postpone",
            commandId: CommandId.make(
              `server:continue-at-reset-postpone:${entry.threadId}:${entry.lastErrorAt}:${at}`,
            ),
            threadId: entry.threadId,
            lastErrorAt: entry.lastErrorAt,
            ...(laterReset !== null ? { resetsAt: new Date(laterReset).toISOString() } : {}),
            at,
            createdAt,
          });
          yield* Effect.logInfo("thread.continue-at-reset.postponed", {
            threadId: entry.threadId,
            at,
          });
          return false;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.continue-at-reset.fire",
          // One attempt per scheduled time: a repeat of this pass is a no-op.
          commandId: CommandId.make(
            `server:continue-at-reset:${entry.threadId}:${entry.lastErrorAt}:${entry.continueAtReset.at}`,
          ),
          threadId: entry.threadId,
          lastErrorAt: entry.lastErrorAt,
          messageId: MessageId.make(randomUUID()),
          createdAt,
        });
        yield* Effect.logInfo("thread.continue-at-reset.continued", { threadId: entry.threadId });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread.continue-at-reset.failed", {
            threadId: entry.threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    const runSweep = Effect.gen(function* () {
      const waiting = yield* sessions
        .listContinueAtReset()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread.continue-at-reset.list-failed", { cause }).pipe(
              Effect.as([] as ReadonlyArray<ProjectionThreadContinueAtReset>),
            ),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      const due = waiting
        .filter((entry) => Date.parse(entry.continueAtReset.at) <= nowMs)
        .toSorted(
          (left, right) =>
            Date.parse(left.continueAtReset.at) - Date.parse(right.continueAtReset.at),
        );
      const early = new Set(yield* listEarlyResets(waiting, nowMs));
      let continued = 0;
      for (const entry of [...due, ...early]) {
        if (continued > 0) {
          yield* Effect.sleep(options?.continueSpacing ?? CONTINUE_SPACING);
        }
        // A Mac that woke only for upkeep sleeps again within seconds: the
        // rest continue once it's fully awake. Asked before each thread, as
        // the computer can sleep during the spacing.
        if (!(yield* systemWake.fullyAwake)) break;
        if (yield* early.has(entry) ? continueEarly(entry) : continueThread(entry)) continued += 1;
      }
      return continued;
    });

    const sweep = sweepSemaphore.withPermits(1)(runSweep);

    const sweepNow: ContinueAtResetSweeperShape["sweepNow"] = () => sweep;

    const start: ContinueAtResetSweeperShape["start"] = () =>
      Effect.gen(function* () {
        // The first pass runs now: a reset that passed while Threadlines was
        // closed continues as soon as it starts.
        yield* Effect.forkScoped(
          sweep.pipe(Effect.repeat(Schedule.spaced(options?.sweepInterval ?? SWEEP_INTERVAL))),
        );
      });

    return { start, sweepNow } satisfies ContinueAtResetSweeperShape;
  });

export const makeContinueAtResetSweeperLive = (options?: ContinueAtResetSweeperLiveOptions) =>
  Layer.effect(ContinueAtResetSweeper, makeContinueAtResetSweeper(options));

export const ContinueAtResetSweeperLive = makeContinueAtResetSweeperLive();
