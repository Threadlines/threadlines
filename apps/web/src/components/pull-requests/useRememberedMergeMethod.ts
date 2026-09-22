import {
  PullRequestMergeMethod as PullRequestMergeMethodSchema,
  type SourceControlProviderKind,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/** Remembered per repository: the merge method last run on it becomes the
 *  Merge button's own, as the host's site does. */
const MERGE_METHOD_STORAGE_PREFIX = "threadlines:pull-requests:merge-method:v1";
const REMEMBERED_MERGE_METHOD_SCHEMA = Schema.NullOr(PullRequestMergeMethodSchema);

/**
 * The merge method last used on a repository, and the setter that remembers a
 * new one. Shared by the Merge button and every switch that merges later, so
 * a merge nobody is watching lands the way the last one did.
 */
export function useRememberedMergeMethod(provider: SourceControlProviderKind, repository: string) {
  return useLocalStorage(
    `${MERGE_METHOD_STORAGE_PREFIX}:${provider}:${repository}`,
    null,
    REMEMBERED_MERGE_METHOD_SCHEMA,
  );
}
