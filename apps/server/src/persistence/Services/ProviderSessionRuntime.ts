/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */
import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  /**
   * User-defined routing key for the configured provider instance that
   * owns this session. Nullable only at the storage/migration boundary:
   * rows persisted before the driver/instance split carry only
   * `providerName`. Repository consumers must materialize a concrete
   * instance id before routing.
   */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });

/** See ProviderSessionRuntimeRepositoryShape.patchIfSession. */
export interface PatchProviderSessionRuntimeIfSessionInput {
  readonly threadId: ThreadId;
  /** The runtime the row must still name (its `sessionCreatedAt` payload field). */
  readonly sessionCreatedAt: string;
  /** Flat fields merged into the payload; a null removes the field. */
  readonly runtimePayload: Readonly<Record<string, string | number | boolean | null>>;
  /** Clears the resume cursor too. */
  readonly clearResumeCursor?: boolean;
  readonly lastSeenAt: string;
}
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

/**
 * ProviderSessionRuntimeRepositoryShape - Service API for provider runtime records.
 */
export interface ProviderSessionRuntimeRepositoryShape {
  /**
   * Insert or replace a provider runtime row.
   *
   * Upserts by canonical `threadId`, including JSON payload/cursor fields.
   */
  readonly upsert: (
    runtime: ProviderSessionRuntime,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  /**
   * Read provider runtime state by canonical thread id.
   */
  readonly getByThreadId: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<Option.Option<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>;

  /**
   * List all provider runtime rows.
   *
   * Returned in ascending last-seen order.
   */
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderSessionRuntime>,
    ProviderSessionRuntimeRepositoryError
  >;

  /**
   * List all persisted canonical thread ids without reading JSON payload blobs.
   */
  readonly listThreadIds?: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionRuntimeRepositoryError
  >;

  /**
   * List persisted session keys for one thread (its primary key plus room
   * participant keys) using the primary-key index.
   */
  readonly listThreadIdsForThread?: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProviderSessionRuntimeRepositoryError>;

  /**
   * Read provider runtime rows for a batch of canonical thread ids in one query.
   */
  readonly getByThreadIds?: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>;

  /**
   * Merges flat fields into a row's payload, in one statement, only while
   * the row still names runtime `sessionCreatedAt`: a write that names an
   * older runtime never lands on its replacement. True when it was written.
   */
  readonly patchIfSession: (
    input: PatchProviderSessionRuntimeIfSessionInput,
  ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

  /**
   * Delete provider runtime state by canonical thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProviderSessionRuntimeInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  ProviderSessionRuntimeRepositoryShape
>()("threadlines/persistence/Services/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}
