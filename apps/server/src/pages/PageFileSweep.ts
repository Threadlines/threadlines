// @effect-diagnostics nodeBuiltinImport:off
/**
 * Removes agent page files nothing shows any more (docs/agent-pages.md).
 *
 * A version file is kept while a page row of a thread that is not deleted
 * names it. Everything else goes: versions a later publish in the same turn
 * replaced, versions of turns a revert took back, every page of a deleted
 * thread, and files whose publish never committed.
 *
 * It decides from committed projection rows only, after the commit that
 * changed them, so it never deletes a file a row will be restored to name;
 * and it is built after the engine has bootstrapped the projections, so it
 * never reads a half-replayed table. Files younger than an hour and versions
 * still being published are left alone, which covers a publish waiting
 * behind a slow command queue. Each run looks at everything again, so a run
 * that fails is simply made up by the next.
 */
import * as NodeFs from "node:fs/promises";
import NodePath from "node:path";

import type { OrchestrationEvent } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionThreadPageRepository } from "../persistence/Services/ProjectionThreadPages.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { AgentPages } from "./AgentPages.ts";
import { isPageFileId } from "./PageStore.ts";

const GRACE_MS = 60 * 60_000;
const INITIAL_DELAY = Duration.minutes(2);
const RUN_INTERVAL = Duration.minutes(30);
/** After a delete or revert, a short wait so a burst of them is one run. */
const SETTLE_DELAY = Duration.seconds(5);

const VERSION_FILE = /^([0-9a-f-]{36})\.(?:html|md)$/i;

/** Events after which page files may have lost their row. */
const isPageRowLoss = (event: OrchestrationEvent) =>
  event.type === "thread.deleted" ||
  event.type === "thread.reverted" ||
  event.type === "thread.page-published";

/**
 * One pass over the pages folder. `keep` holds `<thread segment>/<pageId>/<versionId>`
 * for every live version; `pending` the versions mid-publish.
 */
export async function sweepPageFiles(input: {
  readonly pagesDir: string;
  readonly keep: ReadonlySet<string>;
  readonly pending: ReadonlySet<string>;
  readonly now: number;
  readonly graceMs?: number;
}): Promise<number> {
  const grace = input.graceMs ?? GRACE_MS;
  let removed = 0;
  const entries = (dir: string) => NodeFs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const threadEntry of await entries(input.pagesDir)) {
    if (!threadEntry.isDirectory()) continue;
    const threadDir = NodePath.join(input.pagesDir, threadEntry.name);
    for (const pageEntry of await entries(threadDir)) {
      if (!pageEntry.isDirectory()) continue;
      const pageDir = NodePath.join(threadDir, pageEntry.name);
      for (const fileEntry of await entries(pageDir)) {
        if (!fileEntry.isFile()) continue;
        const match = VERSION_FILE.exec(fileEntry.name);
        const versionId = match?.[1]?.toLowerCase();
        const key = `${threadEntry.name}/${pageEntry.name}/${versionId ?? ""}`;
        if (
          versionId !== undefined &&
          isPageFileId(versionId) &&
          (input.keep.has(key) || input.pending.has(versionId))
        ) {
          continue;
        }
        const filePath = NodePath.join(pageDir, fileEntry.name);
        const info = await NodeFs.lstat(filePath).catch(() => null);
        if (info === null || input.now - info.mtimeMs < grace) continue;
        await NodeFs.rm(filePath, { force: true });
        removed += 1;
      }
      await NodeFs.rmdir(pageDir).catch(() => undefined);
    }
    await NodeFs.rmdir(threadDir).catch(() => undefined);
  }
  return removed;
}

export const PageFileSweepLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const rows = yield* ProjectionThreadPageRepository;
    const pages = yield* AgentPages;
    const engine = yield* OrchestrationEngineService;

    const runOnce = Effect.gen(function* () {
      const live = yield* rows.listLiveVersions();
      const keep = new Set(
        live.flatMap((ref) => {
          const segment = toSafeThreadAttachmentSegment(ref.threadId);
          return segment === null
            ? []
            : [`${segment}/${ref.pageId.toLowerCase()}/${ref.versionId.toLowerCase()}`];
        }),
      );
      const pending = new Set([...(yield* pages.pendingVersionIds)].map((id) => id.toLowerCase()));
      const removed = yield* Effect.tryPromise(() =>
        sweepPageFiles({ pagesDir: config.pagesDir, keep, pending, now: Date.now() }),
      );
      if (removed > 0) {
        yield* Effect.logDebug("removed agent page files nothing shows", { removed });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("agent page file sweep failed", { cause: String(cause) }),
      ),
    );

    yield* Effect.forkScoped(
      Effect.sleep(INITIAL_DELAY).pipe(
        Effect.andThen(Effect.forever(runOnce.pipe(Effect.andThen(Effect.sleep(RUN_INTERVAL))))),
      ),
    );
    // Soon after a change that can orphan files; the grace period still holds.
    yield* Effect.forkScoped(
      engine.streamDomainEvents.pipe(
        Stream.filter(isPageRowLoss),
        Stream.debounce(SETTLE_DELAY),
        Stream.runForEach(() => runOnce),
      ),
    );
  }),
);
