import { ThreadId } from "@threadlines/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { makeAgentProcessLedger, realProcessProbe } from "./agentProcessLedger.ts";
import { isProcessRunning, startTestAgentProcess } from "./testAgentProcess.ts";

const THREAD = ThreadId.make("thread-ledger");

describe.skipIf(process.platform === "win32")("agent process ledger", () => {
  it.live("ends what an agent left in a process group of its own, then confirms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeAgentProcessLedger({ exitWait: "2 seconds" });
        const agent = yield* startTestAgentProcess;
        yield* ledger.track(THREAD, { pid: agent.pid, exited: agent.exited });

        yield* ledger.beforeStop(THREAD);
        // The stop reaches the agent's own group; the shell lives on in its own.
        yield* agent.stop;
        yield* agent.exited;
        expect(isProcessRunning(agent.shellPid)).toBe(true);

        expect(yield* ledger.confirm(THREAD)).toEqual({ confirmed: true });
        expect(isProcessRunning(agent.shellPid)).toBe(false);
        // Proven once, it is forgotten.
        expect(yield* ledger.confirm(THREAD)).toEqual({ confirmed: true });
      }),
    ),
  );

  it.live("says so when the agent's process can't be ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeAgentProcessLedger({
          exitWait: "50 millis",
          settleWait: "50 millis",
          probe: {
            ...realProcessProbe,
            exists: () => true,
            signal: () => {},
            descendants: () => Effect.succeed([]),
          },
        });
        yield* ledger.track(THREAD, { pid: 424242, exited: Effect.never });
        expect(yield* ledger.confirm(THREAD)).toEqual({
          confirmed: false,
          reason: "its process 424242 didn't exit",
        });
        // Another thread's agents aren't its business.
        expect(yield* ledger.confirm(ThreadId.make("thread-other"))).toEqual({ confirmed: true });
      }),
    ),
  );

  it.live("never reads a process table it couldn't read as nothing started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeAgentProcessLedger({
          settleWait: "50 millis",
          probe: {
            ...realProcessProbe,
            // The agent and its group are gone; what it started can't be known.
            exists: () => false,
            signal: () => {},
            descendants: () => Effect.succeed(null),
          },
        });
        const exited = yield* Deferred.make<void>();
        yield* ledger.track(THREAD, { pid: 424242, exited: Deferred.await(exited) });
        yield* ledger.beforeStop(THREAD);
        yield* Deferred.succeed(exited, undefined);
        yield* Effect.sleep("20 millis");
        expect(yield* ledger.confirm(THREAD)).toEqual({
          confirmed: false,
          reason: "the process list couldn't be read when it stopped",
        });
      }),
    ),
  );
});
