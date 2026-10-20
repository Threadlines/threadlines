import {
  McpAppView,
  ProviderInstanceId,
  RuntimeMcpAppCall,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * An MCP tool call whose tool ships an app, as stored for its card
 * (docs/mcp-apps.md). `call` is capped: `truncated` says its input and the
 * result's content were dropped to fit.
 */
export const McpAppCallRecord = Schema.Struct({
  threadId: ThreadId,
  toolCallId: Schema.String,
  participantId: Schema.NullOr(ThreadParticipantId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerThreadId: Schema.NullOr(Schema.String),
  call: RuntimeMcpAppCall,
  truncated: Schema.Boolean,
  view: Schema.NullOr(McpAppView),
  createdAt: Schema.String,
});
export type McpAppCallRecord = typeof McpAppCallRecord.Type;

export const McpAppCallKey = Schema.Struct({ threadId: ThreadId, toolCallId: Schema.String });
export type McpAppCallKey = typeof McpAppCallKey.Type;

export interface McpAppCallRepositoryShape {
  /** Records a call; recording it again keeps a view already read. */
  readonly upsert: (
    record: Omit<McpAppCallRecord, "view">,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** A recorded call. Its thread may since have been deleted: callers check. */
  readonly get: (
    key: McpAppCallKey,
  ) => Effect.Effect<Option.Option<McpAppCallRecord>, ProjectionRepositoryError>;
  readonly setView: (
    key: McpAppCallKey,
    view: McpAppView,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Forgets a deleted thread's calls. */
  readonly deleteByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class McpAppCallRepository extends Context.Service<
  McpAppCallRepository,
  McpAppCallRepositoryShape
>()("threadlines/persistence/Services/McpAppCalls/McpAppCallRepository") {}
