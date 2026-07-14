/**
 * ThreadSearch - Read-only full-text search over projected thread messages.
 *
 * @module ThreadSearch
 */
import type {
  OrchestrationThreadSearchInput,
  OrchestrationThreadSearchResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ThreadSearchShape {
  readonly search: (
    input: OrchestrationThreadSearchInput,
  ) => Effect.Effect<OrchestrationThreadSearchResult, ProjectionRepositoryError>;
}

export class ThreadSearch extends Context.Service<ThreadSearch, ThreadSearchShape>()(
  "threadlines/orchestration/Services/ThreadSearch",
) {}
