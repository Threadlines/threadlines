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

import { parseListeningPorts } from "./parseListeningPorts.ts";

const LSOF_TIMEOUT_MS = 5_000;

export class LocalServers extends Context.Service<
  LocalServers,
  { readonly scan: () => Effect.Effect<ReadonlyArray<DesktopLocalServer>> }
>()("@threadlines/desktop/preview/LocalServers") {}

export const make = Effect.gen(function* LocalServersMake() {
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
                resolve(parseListeningPorts(stdout ?? ""));
              },
            );
          }),
      );
    }),
  });
}).pipe(Effect.withSpan("LocalServers.make"));

export const layer = Layer.effect(LocalServers, make);
