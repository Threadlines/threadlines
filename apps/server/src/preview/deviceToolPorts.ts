/**
 * Which listeners on this machine belong to device tools, so a preview never
 * reaches one.
 *
 * The device hub (and serve-sim/serve-emu inside it) and the agent-device
 * daemon listen on loopback and accept actions there: touch input, app
 * installs, shell commands. A client must reach them only through the device
 * channel, never through the loopback tunnel (docs/design/devices.md, "The hub
 * is never reachable from a client"). That holds for every copy on this
 * machine, whoever started it -- this server, another Threadlines server, an
 * older release -- so they are found by command line rather than from what
 * this server spawned. Matching by name is for refusing only; nothing here
 * ever signals a process it found this way.
 *
 * A process is a device tool's when its own command line matches, or one of
 * its ancestors' does: an emulator the hub boots is the hub's child and
 * listens on ports of its own.
 */
import { listProcessTreesAsync } from "@threadlines/shared/processTree";
import { execFile } from "node:child_process";

import { parseListenerPortNumbers, readListeningSockets } from "./parseListeningPorts.ts";

const SCAN_TIMEOUT_MS = 5_000;

/**
 * The command lines of device tools, as an extended regular expression for
 * `pgrep -f`: the hub's entry point, the agent-device daemon's, and
 * serve-sim/serve-emu run on their own (their vendored entry points, or a bin
 * by that name) in case a hub version spawns them as helpers.
 */
export const DEVICE_TOOL_COMMAND_PATTERN = [
  "expo-device-hub/dist/server/cli\\.mjs",
  "agent-device/dist/src/internal/daemon\\.js",
  "vendor/serve-(sim|emu)/",
  "(^|[/ ])serve-(sim|emu)( |$)",
].join("|");

/**
 * Pids whose command line matches DEVICE_TOOL_COMMAND_PATTERN. Empty when
 * none does, or when this machine has no `pgrep` (a slim container, where no
 * device tool runs either); null when the search failed or ran out of time.
 */
function matchingProcessIds(): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile(
      "pgrep",
      ["-f", DEVICE_TOOL_COMMAND_PATTERN],
      { encoding: "utf8", timeout: SCAN_TIMEOUT_MS },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error !== null && error.killed !== true && (code === 1 || code === "ENOENT")) {
          // 1: nothing matched.
          resolve([]);
          return;
        }
        if (error !== null) {
          resolve(null);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        );
      },
    );
  });
}

/**
 * Every process that belongs to a device tool: the matches and all their
 * descendants. Null when that can't be known. Empty on Windows, where this
 * check does not run.
 */
export async function findDeviceToolProcessIds(): Promise<ReadonlySet<number> | null> {
  if (process.platform === "win32") return new Set();
  const roots = await matchingProcessIds();
  if (roots === null) return null;
  if (roots.length === 0) return new Set();
  const tree = await listProcessTreesAsync(roots, SCAN_TIMEOUT_MS);
  return tree === null ? null : new Set(tree);
}

/** Every port a device tool listens on, at any address. Null when that can't be known. */
async function scanDeviceToolPorts(): Promise<ReadonlySet<number> | null> {
  const pids = await findDeviceToolProcessIds();
  if (pids === null) return null;
  if (pids.size === 0) return new Set();
  const output = await readListeningSockets({ pids: [...pids] });
  return output === null ? null : new Set(parseListenerPortNumbers(output));
}

/**
 * Runs `scan` for callers that each need an answer from after they asked.
 * A caller arriving mid-scan waits for the next one, which every caller
 * arriving meanwhile shares: a page opening dozens of connections at once
 * costs two scans, not dozens, and none is answered from before it asked.
 */
function freshScans<A>(scan: () => Promise<A>): () => Promise<A> {
  let running: Promise<A> | null = null;
  let queued: Promise<A> | null = null;
  const start = (): Promise<A> => {
    const current: Promise<A> = scan().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  };
  return () => {
    if (running === null) return start();
    if (queued === null) {
      const next = running.then(
        () => undefined,
        () => undefined,
      );
      queued = next.then(() => {
        queued = null;
        return start();
      });
    }
    return queued;
  };
}

/**
 * The ports device tools listen on right now, from a scan begun after the
 * call. Never cached: a port that was a dev server's a moment ago may be the
 * hub's now. Null when that can't be known, which callers treat as a refusal.
 */
export const currentDeviceToolPorts = freshScans(scanDeviceToolPorts);
