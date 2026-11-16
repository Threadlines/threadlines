/**
 * Throwaway homes for side runtimes: the locked-down runtime a room's side
 * answer or review runs in (docs/design/rooms-slice-2.md). A driver whose CLI
 * keeps its settings, sign-in and hooks in one folder (Codex's `CODEX_HOME`,
 * Grok's `GROK_HOME`) points the side runtime at a fresh one, so nothing the
 * user set up loads there.
 *
 * Every home sits directly in the temp directory under one prefix, so removal
 * can refuse anything else, and a sweep can clear homes a crashed server left.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SIDE_RUNTIME_HOME_PREFIX = "threadlines-side-";

export class SideRuntimeHomeError extends Error {
  override readonly name = "SideRuntimeHomeError";
}

/**
 * Make a fresh, empty home, private to this user. `label` names the driver in
 * the folder name (`threadlines-side-grok-…`); empty keeps Codex's names. The
 * path is resolved, since some CLIs refuse a home reached through a link (the
 * macOS temp directory is one).
 */
export const makeSideRuntimeHome = (label = "") =>
  Effect.tryPromise({
    try: async () => {
      const prefix = `${SIDE_RUNTIME_HOME_PREFIX}${label ? `${label}-` : ""}${randomUUID()}-`;
      const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      return await fs.realpath(created);
    },
    catch: (cause) =>
      new SideRuntimeHomeError(`Could not make a side-answer home: ${String(cause)}`),
  });

/**
 * Delete a side runtime's home. Refuses anything that is not one of ours in
 * the temp directory, so a misrouted path can never reach a real home.
 */
export const removeSideRuntimeHome = (homePath: string) =>
  Effect.promise(async () => {
    const tmp = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir());
    const resolved = await fs.realpath(homePath).catch(() => null);
    if (
      resolved === null ||
      path.dirname(resolved) !== tmp ||
      !path.basename(resolved).startsWith(SIDE_RUNTIME_HOME_PREFIX)
    ) {
      return false;
    }
    await fs.rm(resolved, { recursive: true, force: true });
    return true;
  });

/** Older than any side answer runs: its server crashed or was killed. */
const STALE_SIDE_HOME_AGE_MS = 24 * 60 * 60_000;

/**
 * Remove side runtime homes a crashed server left in the temp directory. Only
 * old ones: servers share the temp directory, and another server's side
 * answer may be running in a newer one.
 */
export const sweepStaleSideRuntimeHomes = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const entries = yield* Effect.promise(() =>
    fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SIDE_RUNTIME_HOME_PREFIX)) continue;
    const homePath = path.join(os.tmpdir(), entry.name);
    const stats = yield* Effect.promise(() => fs.stat(homePath).catch(() => null));
    if (stats !== null && now - stats.birthtimeMs > STALE_SIDE_HOME_AGE_MS) {
      yield* removeSideRuntimeHome(homePath);
    }
  }
});
