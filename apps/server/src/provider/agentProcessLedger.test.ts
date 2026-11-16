import { spawn } from "node:child_process";
import { once } from "node:events";

import { ThreadId } from "@threadlines/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { makeAgentProcessLedger, realProcessProbe } from "./agentProcessLedger.ts";

const THREAD = ThreadId.make("thread-ledger");

// Starts a shell of its own (a process group it leads), prints its pid, and waits.
const LEADER = `
const { spawn } = require("node:child_process");
const shell = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
shell.unref();
process.stdout.write(String(shell.pid) + "\\n");
setInterval(() => {}, 1000);
`;

const isRunning = (pid: number) => realProcessProbe.exists(pid);

describe.skipIf(process.platform === "win32")("agent process ledger", () => {
  it.live("ends what an agent left in a process group of its own, then confirms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeAgentProcessLedger({ exitWait: "2 seconds" });
        const leader = spawn(process.execPath, ["-e", LEADER], {
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const exit = once(leader, "exit");
        const [line] = yield* Effect.promise(() => once(leader.stdout!, "data"));
        const shellPid = Number(String(line).trim());
        yield* ledger.track(THREAD, {
          pid: leader.pid!,
          exited: Effect.promise(() => exit).pipe(Effect.asVoid),
        });

        yield* ledger.beforeStop(THREAD);
        // The stop reaches the agent's own group; the shell lives on in its own.
        process.kill(-leader.pid!, "SIGTERM");
        yield* Effect.promise(() => exit);
        expect(isRunning(shellPid)).toBe(true);

        expect(yield* ledger.confirm(THREAD)).toEqual({ confirmed: true });
        expect(isRunning(shellPid)).toBe(false);
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
            descendants: () => [],
          },
        });
        yield* ledger.track(THREAD, { pid: 424242, exited: Effect.never });
        const confirmation = yield* ledger.confirm(THREAD);
        expect(confirmation).toEqual({
          confirmed: false,
          reason: "its process 424242 didn't exit",
        });
        // Another thread's agents aren't its business.
        expect(yield* ledger.confirm(ThreadId.make("thread-other"))).toEqual({ confirmed: true });
      }),
    ),
  );
});
