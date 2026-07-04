import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { isProcessAlive, listDescendantProcessIds, signalProcessSilently } from "./processTree.ts";

const spawned: ChildProcess[] = [];

function spawnTree(): ChildProcess {
  // Outer bash → inner bash → sleep: two levels deep, so a passing test
  // proves the walk is transitive, not just direct children.
  const child = spawn("bash", ["-c", 'bash -c "sleep 30 & wait" & wait'], {
    stdio: "ignore",
  });
  spawned.push(child);
  return child;
}

async function waitForDescendants(pid: number, count: number): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const descendants = listDescendantProcessIds(pid);
    if (descendants.length >= count || Date.now() > deadline) {
      return descendants;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterAll(() => {
  for (const child of spawned) {
    if (child.pid === undefined) continue;
    for (const pid of listDescendantProcessIds(child.pid)) {
      signalProcessSilently(pid, "SIGKILL");
    }
    signalProcessSilently(child.pid, "SIGKILL");
  }
});

describe.skipIf(process.platform === "win32")("listDescendantProcessIds", () => {
  it("finds descendants transitively", async () => {
    const root = spawnTree();
    expect(root.pid).toBeDefined();
    if (root.pid === undefined) return;

    const descendants = await waitForDescendants(root.pid, 2);
    expect(descendants.length).toBeGreaterThanOrEqual(2);
    for (const pid of descendants) {
      expect(isProcessAlive(pid)).toBe(true);
    }
  });

  it("returns an empty list for a process without children", () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(child);
    expect(child.pid).toBeDefined();
    if (child.pid === undefined) return;

    expect(listDescendantProcessIds(child.pid)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("signalProcessSilently", () => {
  it("terminates processes and tolerates already-exited pids", async () => {
    const root = spawnTree();
    expect(root.pid).toBeDefined();
    if (root.pid === undefined) return;
    const rootPid = root.pid;

    const descendants = await waitForDescendants(rootPid, 2);
    const exited = new Promise((resolve) => root.once("exit", resolve));
    for (const pid of descendants) {
      signalProcessSilently(pid, "SIGTERM");
    }
    signalProcessSilently(rootPid, "SIGTERM");
    await exited;

    expect(isProcessAlive(rootPid)).toBe(false);
    // Signaling the now-dead tree again must not throw.
    signalProcessSilently(rootPid, "SIGTERM");
  });
});
