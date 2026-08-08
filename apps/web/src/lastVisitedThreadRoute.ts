/**
 * "Come back where I was" for the chat shell.
 *
 * Closing and reopening the desktop app used to drop the user on the empty
 * root shell: the only thing that ever navigated away from `/` was the `npx`
 * launch bootstrap (`bootstrapThreadId` on the welcome payload), and a warm
 * relaunch has no bootstrap to replay. Nothing recorded where the user
 * actually was, so nothing could restore it.
 *
 * This module records the chat route the user is on and hands it back on the
 * next load. It is deliberately small: one entry per environment, validated on
 * read, and always checked against live state before it is used, so a thread
 * deleted from another device falls back to the old behaviour instead of
 * routing into a dead page.
 *
 * @module lastVisitedThreadRoute
 */
import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import * as Schema from "effect/Schema";

import type { DraftId } from "./composerDraftStore";
import { getLocalStorageItemWithLegacyKeys, setLocalStorageItem } from "./hooks/useLocalStorage";
import type { ThreadRouteTarget } from "./threadRoutes";

export const LAST_VISITED_THREAD_ROUTE_STORAGE_KEY = "threadlines:last-visited-thread-route:v1";
/** Minted after the t3code rename, so nothing predates it. */
const LEGACY_LAST_VISITED_THREAD_ROUTE_STORAGE_KEYS: readonly string[] = [];

const LastVisitedThreadRouteEntrySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("server"), threadId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("draft"), draftId: Schema.String }),
]);

/** What was open, minus the environment (which is the record's key). */
export type LastVisitedThreadRouteEntry = typeof LastVisitedThreadRouteEntrySchema.Type;

const LastVisitedThreadRoutesSchema = Schema.Struct({
  byEnvironmentId: Schema.Record(Schema.String, LastVisitedThreadRouteEntrySchema),
});

type LastVisitedThreadRoutes = typeof LastVisitedThreadRoutesSchema.Type;

const EMPTY_RECORD: LastVisitedThreadRoutes = { byEnvironmentId: {} };

function readRecord(): LastVisitedThreadRoutes {
  try {
    return (
      getLocalStorageItemWithLegacyKeys(
        LAST_VISITED_THREAD_ROUTE_STORAGE_KEY,
        LEGACY_LAST_VISITED_THREAD_ROUTE_STORAGE_KEYS,
        LastVisitedThreadRoutesSchema,
      ) ?? EMPTY_RECORD
    );
  } catch {
    return EMPTY_RECORD;
  }
}

/** What this environment had open last, or null if it was never recorded. */
export function readLastVisitedThreadRoute(
  environmentId: EnvironmentId | null | undefined,
): LastVisitedThreadRouteEntry | null {
  if (!environmentId) {
    return null;
  }
  return readRecord().byEnvironmentId[String(environmentId)] ?? null;
}

function sameEntry(
  left: LastVisitedThreadRouteEntry | undefined,
  right: LastVisitedThreadRouteEntry,
): boolean {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  return left.kind === "server" && right.kind === "server"
    ? left.threadId === right.threadId
    : left.kind === "draft" && right.kind === "draft"
      ? left.draftId === right.draftId
      : false;
}

export function recordLastVisitedThreadRoute(
  environmentId: EnvironmentId | null | undefined,
  target: ThreadRouteTarget | null,
): void {
  if (!environmentId || target === null) {
    return;
  }
  const entry: LastVisitedThreadRouteEntry =
    target.kind === "server"
      ? { kind: "server", threadId: String(target.threadRef.threadId) }
      : { kind: "draft", draftId: String(target.draftId) };
  const current = readRecord();
  if (sameEntry(current.byEnvironmentId[String(environmentId)], entry)) {
    return;
  }

  try {
    setLocalStorageItem(
      LAST_VISITED_THREAD_ROUTE_STORAGE_KEY,
      {
        byEnvironmentId: { ...current.byEnvironmentId, [String(environmentId)]: entry },
      },
      LastVisitedThreadRoutesSchema,
    );
  } catch {
    // Best-effort convenience state; a storage failure must not break routing.
  }
}

/**
 * The route to restore on load, or null to keep the previous behaviour
 * (start a draft in the default project, or show the no-thread shell).
 *
 * Existence is decided by the caller against live state rather than in here:
 * a thread archived or deleted since the last session must not be restored,
 * and the same goes for a draft that never made it back out of storage.
 */
export function resolveRestorableThreadRoute(input: {
  readonly entry: LastVisitedThreadRouteEntry | null;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly serverThreadExists: boolean;
  readonly draftThreadExists: boolean;
}): ThreadRouteTarget | null {
  if (!input.entry || !input.environmentId) {
    return null;
  }

  if (input.entry.kind === "server") {
    return input.serverThreadExists
      ? {
          kind: "server",
          threadRef: scopeThreadRef(input.environmentId, input.entry.threadId as ThreadId),
        }
      : null;
  }

  return input.draftThreadExists
    ? { kind: "draft", draftId: input.entry.draftId as DraftId }
    : null;
}
