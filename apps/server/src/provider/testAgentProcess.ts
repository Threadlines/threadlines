// @effect-diagnostics nodeBuiltinImport:off
/**
 * For tests: a stand-in agent process that starts a shell in a process group
 * of its own, the way Grok's background shells (and any `setsid` child) do,
 * so a test can prove a driver's stop notes what its agent started and that
 * `confirmThreadStopped` ends it. POSIX only.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { realProcessProbe } from "./agentProcessLedger.ts";

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

export interface TestAgentProcess {
  readonly pid: number;
  readonly exited: Effect.Effect<void>;
  /** The shell it started, in a process group of its own. */
  readonly shellPid: number;
  /** What a driver's own stop does: signals the agent's process group, not the shell's. */
  readonly stop: Effect.Effect<void>;
}

export const isProcessRunning = (pid: number) => realProcessProbe.exists(pid);

/** Starts one; whatever is left of it is killed when the scope closes. */
export const startTestAgentProcess: Effect.Effect<TestAgentProcess, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.promise(async () => {
      const leader = spawn(process.execPath, ["-e", LEADER], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const exit = once(leader, "exit");
      const [line] = await once(leader.stdout!, "data");
      const pid = leader.pid!;
      return {
        pid,
        exited: Effect.promise(() => exit).pipe(Effect.asVoid),
        shellPid: Number(String(line).trim()),
        stop: Effect.sync(() => realProcessProbe.signal(-pid, "SIGTERM")),
      };
    }),
    (agent) =>
      Effect.sync(() => {
        realProcessProbe.signal(-agent.pid, "SIGKILL");
        realProcessProbe.signal(-agent.shellPid, "SIGKILL");
      }),
  );
