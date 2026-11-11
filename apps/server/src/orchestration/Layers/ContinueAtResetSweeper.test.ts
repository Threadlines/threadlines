import {
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadContinueAtReset,
} from "../../persistence/Services/ProjectionThreadSessions.ts";
import { SystemWake } from "../../power/Services/SystemWake.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { ContinueAtResetSweeper } from "../Services/ContinueAtResetSweeper.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makeContinueAtResetSweeperLive } from "./ContinueAtResetSweeper.ts";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const THREAD_ID = ThreadId.make("thread-waiting");
const HOUR_MS = 60 * 60 * 1_000;
const NOW_MS = Date.now();
/** When the weekly limit the thread waits on resets. */
const WEEKLY_RESET_MS = NOW_MS + 40 * HOUR_MS;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Claude as a usage reading taken `readAgoMs` ago shows it: the plan's
 * session and weekly windows, and one model's own weekly window.
 */
function claude(input: {
  readonly sessionUsedPercent?: number;
  /** Null: the reading leaves the model's window out. */
  readonly modelUsedPercent: number | null;
  readonly readAgoMs: number;
}) {
  const window = (usedPercent: number, resetsAtMs: number, windowDurationMins: number) => ({
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Math.round(resetsAtMs / 1_000),
    windowDurationMins,
    checkedAt: isoAt(NOW_MS - input.readAgoMs),
  });
  return {
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [],
    accountUsage: {
      source: "claude-oauth-usage",
      checkedAt: isoAt(NOW_MS - input.readAgoMs),
      limits: [
        {
          limitId: "claude",
          primary: window(input.sessionUsedPercent ?? 20, NOW_MS + 2 * HOUR_MS, 5 * 60),
          secondary: window(56, WEEKLY_RESET_MS, 7 * 24 * 60),
          scoped:
            input.modelUsedPercent === null
              ? []
              : [
                  {
                    scopeLabel: "Fable",
                    ...window(input.modelUsedPercent, WEEKLY_RESET_MS, 7 * 24 * 60),
                  },
                ],
        },
      ],
    },
  } as unknown as ServerProvider;
}

describe("ContinueAtResetSweeper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ContinueAtResetSweeper, unknown> | null = null;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  /**
   * One thread waiting on the weekly limit, 40 hours from its reset. `held`
   * is the reading the server has; `fresh` is what a check made now returns.
   */
  async function createHarness(
    initial: ServerProvider,
    options?: { readonly continueFails?: boolean },
  ) {
    const readings = { held: initial, fresh: initial };
    const waiting: Array<ProjectionThreadContinueAtReset> = [
      {
        threadId: THREAD_ID,
        lastErrorAt: isoAt(NOW_MS - HOUR_MS),
        providerInstanceId: INSTANCE_ID,
        continueAtReset: { resetsAt: isoAt(WEEKLY_RESET_MS), at: isoAt(WEEKLY_RESET_MS + 60_000) },
      },
    ];
    const dispatched: Array<OrchestrationCommand> = [];
    const layer = makeContinueAtResetSweeperLive({ continueSpacing: 0 }).pipe(
      Layer.provide(
        Layer.mock(ProjectionThreadSessionRepository)({
          listContinueAtReset: () => Effect.sync(() => [...waiting]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.sync(() => [readings.held]),
          refreshInstance: () =>
            Effect.sync(() => {
              readings.held = readings.fresh;
              return [readings.held];
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.suspend(() => {
              dispatched.push(command);
              if (options?.continueFails === true) {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "test dispatch failure",
                  }),
                );
              }
              // A continue ends the wait, as the decider has it.
              if (command.type === "thread.continue-at-reset.fire") waiting.length = 0;
              return Effect.succeed({ sequence: dispatched.length });
            }),
        }),
      ),
      Layer.provide(Layer.succeed(SystemWake, SystemWake.of({ fullyAwake: Effect.succeed(true) }))),
    );
    runtime = ManagedRuntime.make(layer);
    const sweeper = await runtime.runPromise(Effect.service(ContinueAtResetSweeper));
    const sweep = () => runtime!.runPromise(sweeper.sweepNow());
    /** A new reading arrives, as the periodic check brings one. */
    const read = (provider: ServerProvider) => {
      readings.held = provider;
      readings.fresh = provider;
    };
    return { readings, dispatched, sweep, read };
  }

  it("continues a waiting thread once its spent limit shows room again before the reset time", async () => {
    // The model's own weekly limit stopped the thread; the plan still has room.
    const { dispatched, sweep, read } = await createHarness(
      claude({ modelUsedPercent: 100, readAgoMs: HOUR_MS }),
    );

    // Still spent, and the reset is 40 hours off: nothing to do yet.
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);

    // The user spent a limit reset; the next usage reading shows room.
    read(claude({ modelUsedPercent: 3, readAgoMs: 0 }));
    expect(await sweep()).toBe(1);
    expect(dispatched).toMatchObject([
      { type: "thread.continue-at-reset.fire", threadId: THREAD_ID, resetEarly: true },
    ]);

    expect(await sweep()).toBe(0);
    expect(dispatched).toHaveLength(1);
  });

  it("goes by a fresh reading before continuing early", async () => {
    const { readings, dispatched, sweep } = await createHarness(
      claude({ modelUsedPercent: 100, readAgoMs: HOUR_MS }),
    );
    expect(await sweep()).toBe(0);

    // The reading the server holds shows room, but a check made now does not.
    readings.held = claude({ modelUsedPercent: 3, readAgoMs: 60_000 });
    readings.fresh = claude({ modelUsedPercent: 100, readAgoMs: 0 });
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("tries an early continue once, and leaves a failed one to the reset time", async () => {
    const { dispatched, sweep, read } = await createHarness(
      claude({ modelUsedPercent: 100, readAgoMs: HOUR_MS }),
      { continueFails: true },
    );
    expect(await sweep()).toBe(0);
    read(claude({ modelUsedPercent: 3, readAgoMs: 0 }));
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(dispatched).toHaveLength(1);
  });

  it("needs the spent window read again, and lately, before it counts as reset", async () => {
    const { dispatched, sweep, read } = await createHarness(
      claude({ modelUsedPercent: 100, readAgoMs: HOUR_MS }),
    );
    expect(await sweep()).toBe(0);

    // A reading without the model's window says nothing about its limit.
    read(claude({ modelUsedPercent: null, readAgoMs: 0 }));
    expect(await sweep()).toBe(0);
    // Nor does one from a while ago that the server still holds.
    read(claude({ modelUsedPercent: 3, readAgoMs: HOUR_MS / 2 }));
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("waits for the reset time when another limit is the one that cleared", async () => {
    // The reading never showed the weekly limit the thread waits on, only a
    // spent session window: that one clearing says nothing about the wait.
    const { dispatched, sweep, read } = await createHarness(
      claude({ sessionUsedPercent: 100, modelUsedPercent: 40, readAgoMs: HOUR_MS }),
    );
    expect(await sweep()).toBe(0);
    read(claude({ sessionUsedPercent: 2, modelUsedPercent: 41, readAgoMs: 0 }));
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);
  });
});
