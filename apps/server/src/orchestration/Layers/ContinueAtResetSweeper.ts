import { randomUUID } from "node:crypto";

import { CommandId, MessageId } from "@threadlines/contracts";
import { continueAtResetTimeMs, readProviderUsageBlock } from "@threadlines/shared/usageLimits";
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

export interface ContinueAtResetSweeperLiveOptions {
  readonly sweepInterval?: Duration.Input;
  readonly continueSpacing?: Duration.Input;
}

const makeContinueAtResetSweeper = (options?: ContinueAtResetSweeperLiveOptions) =>
  Effect.gen(function* () {
    const sessions = yield* ProjectionThreadSessionRepository;
    const providerRegistry = yield* ProviderRegistry;
    const orchestrationEngine = yield* OrchestrationEngineService;
    // The interval and `sweepNow` must not both continue one thread.
    const sweepSemaphore = yield* Semaphore.make(1);

    /** Whether the account the thread waits on still says it is out of room, read fresh. */
    const readBlock = (entry: ProjectionThreadContinueAtReset) =>
      Effect.gen(function* () {
        const instanceId = entry.providerInstanceId;
        if (instanceId === null) return { state: "unknown" } as const;
        const providers = yield* freshOrCurrentSnapshot(
          providerRegistry.refreshInstance(instanceId),
          providerRegistry.getProviders,
        );
        const provider = providers.find((candidate) => candidate.instanceId === instanceId);
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
      let continued = 0;
      for (const entry of due) {
        if (continued > 0) {
          yield* Effect.sleep(options?.continueSpacing ?? CONTINUE_SPACING);
        }
        if (yield* continueThread(entry)) continued += 1;
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
