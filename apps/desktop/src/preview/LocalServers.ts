/**
 * Servers currently listening on this machine.
 *
 * Discovered rather than configured: the point is to answer "what is running
 * right now" without the user knowing a port number. Local by design -- the
 * preview is a browser on this machine, so a remote environment's servers
 * would not be reachable from it anyway.
 */

import type { DesktopLocalServer } from "@threadlines/contracts";
import { execFile } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseListeningPorts, type ListeningPort } from "./parseListeningPorts.ts";
import { probeHttpServer } from "./probeHttpServer.ts";

const LSOF_TIMEOUT_MS = 5_000;
/**
 * How long a probe result stands. Long enough that a stable server is not
 * re-fetched on every poll, short enough that restarting one on the same port
 * updates its title within a few seconds.
 */
const PROBE_CACHE_MS = 30_000;

export class LocalServers extends Context.Service<
  LocalServers,
  { readonly scan: () => Effect.Effect<ReadonlyArray<DesktopLocalServer>> }
>()("@threadlines/desktop/preview/LocalServers") {}

export const make = Effect.gen(function* LocalServersMake() {
  // Keyed by port and pid together: a different process on the same port is a
  // different server, and should not inherit the previous one's answer.
  const probeCache = new Map<string, { at: number; result: { title: string | null } | null }>();

  const probeAll = async (ports: ReadonlyArray<ListeningPort>) => {
    const now = Date.now();
    const results = await Promise.all(
      ports.map(async (entry) => {
        const key = `${entry.port}:${entry.pid}`;
        const cached = probeCache.get(key);
        const probe =
          cached !== undefined && now - cached.at < PROBE_CACHE_MS
            ? cached.result
            : await probeHttpServer(entry.port, entry.probeHost);
        probeCache.set(key, { at: now, result: probe });
        return probe === null
          ? null
          : {
              port: entry.port,
              processName: entry.processName,
              pid: entry.pid,
              title: probe.title,
            };
      }),
    );
    for (const [key, value] of probeCache) {
      if (now - value.at >= PROBE_CACHE_MS) {
        probeCache.delete(key);
      }
    }
    return results.filter((entry) => entry !== null);
  };

  return LocalServers.of({
    scan: Effect.fn("LocalServers.scan")(function* () {
      // Never fails the caller: an empty list renders as "nothing running",
      // which is the truth whether lsof is missing or genuinely found nothing.
      return yield* Effect.promise(
        () =>
          new Promise<ReadonlyArray<DesktopLocalServer>>((resolve) => {
            if (process.platform === "win32") {
              resolve([]);
              return;
            }
            execFile(
              "lsof",
              ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
              { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4_000_000 },
              (_error, stdout) => {
                // lsof exits non-zero when some descriptors are unreadable
                // while still printing the ones it could read, so stdout is
                // used even on error rather than discarding a good result.
                void probeAll(parseListeningPorts(stdout ?? "")).then(resolve);
              },
            );
          }),
      );
    }),
  });
}).pipe(Effect.withSpan("LocalServers.make"));

export const layer = Layer.effect(LocalServers, make);
