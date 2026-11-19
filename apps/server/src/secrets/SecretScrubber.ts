/**
 * Hiding a printed key (docs/design/secret-scrubbing.md): one registry of
 * watched values for this computer, in memory only, and the functions every
 * hook uses. Values enter when the user presses Save (before the file is
 * written) and at startup, read back from their destinations; they stay
 * watched until the server stops, since a model can repeat a key after its
 * file is gone. Built before the provider layer, so no provider event
 * arrives before the read-back is done.
 */
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  OrchestrationSecretRequest,
  ProviderRuntimeEvent,
  ThreadId,
} from "@threadlines/contracts";
import { readEnvValue } from "@threadlines/shared/secretRequests";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadKeyOf } from "./secretDestinations.ts";
import {
  type HeldText,
  type HoldResult,
  makeNoticeMemory,
  makeRuntimeEventScrubber,
  makeSecretScrubberCore,
  type Scrubbed,
} from "./secretScrubberCore.ts";

export interface SecretScrubberShape {
  /**
   * Starts watching a value the user saved under `name`, for `requestId`
   * while its file holds it; false when it can't be hidden safely.
   */
  readonly watch: (name: string, value: string, requestId?: string) => boolean;
  /** A request's file is gone: its value stays watched, and goes first past the limit. */
  readonly gone: (requestId: string) => void;
  /** Hides watched values in a string. */
  readonly scrubText: (text: string) => Scrubbed;
  /**
   * Hides whole watched values in every string and member name; the same
   * value when nothing matched. Never cuts: for text already joined (what
   * ingestion stores), not a snapshot still being written.
   */
  readonly scrubDeep: <A>(value: A) => A;
  /** The names of the watched values a JSON-like value holds, for callers that refuse instead. */
  readonly contains: (value: unknown) => ReadonlyArray<string>;
  /** A provider event in, the events to publish in order out: the event, then any notice. */
  readonly scrubRuntimeEvent: (event: ProviderRuntimeEvent) => ReadonlyArray<ProviderRuntimeEvent>;
  /**
   * A piece ingestion appends to a buffer, with that buffer's held state:
   * what to send now, what to hold next. See secretScrubberCore `holdPiece`.
   */
  readonly holdPiece: (state: HeldText | undefined, piece: string) => HoldResult;
  /** The names not yet noticed in this thread's turn; they count as noticed from now. */
  readonly takeNotices: (
    threadId: string,
    turnId: string | undefined,
    names: Iterable<string>,
  ) => ReadonlyArray<string>;
  /** An answer to a question or approval, with the strings it was shown hidden put back. */
  readonly restoreAnswer: <A>(session: string, requestId: string, answer: A) => A;
}

export class SecretScrubber extends Context.Service<SecretScrubber, SecretScrubberShape>()(
  "threadlines/secrets/SecretScrubber",
) {}

/** A scrubber over a fresh registry, for tests and for the layer. */
export function makeSecretScrubber(): SecretScrubberShape {
  const core = makeSecretScrubberCore();
  const notices = makeNoticeMemory();
  const runtime = makeRuntimeEventScrubber(core, notices);
  return {
    watch: core.watch,
    gone: core.gone,
    scrubText: (text) => core.scrubText(text),
    scrubDeep: <A>(value: A) => core.scrubDeep(value, new Set()) as A,
    contains: core.contains,
    scrubRuntimeEvent: runtime.scrubRuntimeEvent,
    restoreAnswer: runtime.restoreAnswer,
    holdPiece: core.holdPiece,
    takeNotices: (threadId, turnId, names) => notices.take(threadId, turnId, names),
  };
}

const readText = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFs.readFile(path, "utf8"),
    catch: () => "unreadable" as const,
  }).pipe(Effect.option);

/**
 * The value a request saved, read back from where it went: a `commands`
 * key's file while it exists; an env key's `NAME=` line in the file it is
 * bound to. Undefined when it can't be read (gone, renamed, a form the reader
 * doesn't know).
 */
export const readBackSecret = (
  agentSecretsDir: string,
  threadId: ThreadId,
  request: OrchestrationSecretRequest,
) =>
  Effect.gen(function* () {
    if (request.use.kind === "commands") {
      if (request.status !== "saved" || request.removedAt !== undefined) return undefined;
      const file = NodePath.join(
        agentSecretsDir,
        threadKeyOf(threadId),
        request.requestId,
        "value",
      );
      const text = yield* readText(file);
      return text._tag === "Some" ? text.value : undefined;
    }
    // A crash after the rename leaves the value in the file with the request
    // never marked saved: `claimed` before recovery, `uncertain` after.
    if (!["saved", "uncertain", "claimed"].includes(request.status)) return undefined;
    if (request.parent === undefined) return undefined;
    const base = request.use.path.split(/[\\/]/).findLast((segment) => segment.length > 0);
    if (base === undefined) return undefined;
    const text = yield* readText(NodePath.join(request.parent, base));
    return text._tag === "Some" ? readEnvValue(text.value, request.name) : undefined;
  });

/**
 * The registry, filled at startup from every live thread's saved keys before
 * the provider layer takes any event. A failed read is retried a few times
 * right away, then in the background until it works: a key left unwatched
 * is a key printed whole.
 */
export const layer = Layer.effect(
  SecretScrubber,
  Effect.gen(function* () {
    const scrubber = makeSecretScrubber();
    const snapshots = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    const load = Effect.gen(function* () {
      const threads = yield* snapshots.listSecretRequests();
      for (const { threadId, secretRequests } of threads) {
        for (const request of secretRequests) {
          const value = yield* readBackSecret(config.agentSecretsDir, threadId, request);
          if (value === undefined) {
            if (request.status === "saved") {
              yield* Effect.logDebug("a saved key couldn't be read back to watch", {
                threadId,
                requestId: request.requestId,
              });
            }
            continue;
          }
          scrubber.watch(
            request.name,
            value,
            request.status === "saved" ? request.requestId : undefined,
          );
        }
      }
    });
    const loaded = yield* load.pipe(
      Effect.retry({ times: 4, schedule: Schedule.exponential(Duration.millis(100)) }),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logError("couldn't read saved keys to watch; trying again in the background", {
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!loaded) {
      yield* load.pipe(
        Effect.retry(Schedule.spaced(Duration.seconds(30))),
        Effect.ignore,
        Effect.forkScoped,
      );
    }
    return scrubber;
  }),
);

/** An empty registry, for tests that build the provider service without the server's layers. */
export const layerTest = Layer.sync(SecretScrubber, makeSecretScrubber);
