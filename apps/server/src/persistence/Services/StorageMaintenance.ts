/**
 * StorageMaintenance - Retention for the append-only orchestration store.
 *
 * The event log, command receipts, and checkpoint diff blobs grow without
 * bound during normal use (a delta-flush command lands roughly every 50ms
 * per streaming session). This service prunes the categories that are safe
 * to forget:
 *
 * - Command receipts older than the idempotency window.
 * - Events of deleted threads (their projections are already gone).
 * - `thread.activity-appended` events beyond the per-thread projection cap
 *   (`MAX_THREAD_ACTIVITIES`) — projections never surface more than the cap,
 *   so older activity events cannot influence a rebuild.
 *
 * Event pruning never crosses the minimum projector checkpoint, so a
 * lagging or newly added projector can still replay everything it has not
 * applied yet.
 *
 * @module StorageMaintenance
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface StorageMaintenanceReport {
  /** Command receipts removed by TTL. */
  readonly deletedReceipts: number;
  /** Events removed for threads whose `thread.deleted` event is fully projected. */
  readonly deletedThreadEvents: number;
  /** Activity events removed beyond the per-thread projection cap. */
  readonly deletedActivityEvents: number;
  /** Checkpoint diff blobs removed for deleted threads. */
  readonly deletedDiffBlobs: number;
  /** SQLite freelist page count after the run (space reusable in-place). */
  readonly freePages: number;
  /** SQLite total page count after the run. */
  readonly totalPages: number;
  readonly durationMillis: number;
}

export interface StorageMaintenanceShape {
  /** Run one full maintenance pass and report what was pruned. */
  readonly runOnce: Effect.Effect<StorageMaintenanceReport, ProjectionRepositoryError>;
}

export class StorageMaintenance extends Context.Service<
  StorageMaintenance,
  StorageMaintenanceShape
>()("threadlines/persistence/Services/StorageMaintenance") {}
