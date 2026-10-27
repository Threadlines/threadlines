import type { EnvironmentId } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";

import { FILE_NAME_SEARCH_LIMIT, findFileNamed } from "../fileViewerStore";
import { projectSearchEntriesQueryOptions } from "../lib/projectReactQuery";

export type FileNamedInProject =
  /** Not looked up yet: the caller holds the search until it is wanted. */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "found"; readonly relativePath: string }
  /** The search ran and the project has no file with exactly this name. */
  | { readonly status: "none" }
  /** No workspace to search, or the search failed: the folder is unknown. */
  | { readonly status: "unavailable" };

const IDLE: FileNamedInProject = { status: "idle" };
const LOADING: FileNamedInProject = { status: "loading" };
const NONE: FileNamedInProject = { status: "none" };
const UNAVAILABLE: FileNamedInProject = { status: "unavailable" };

/**
 * Where in the project the file a bare name (`home.png`) refers to lives, found
 * by the same exact-name workspace search a click on its chip runs.
 *
 * `lookup: false` holds the search back (a chip waits for a hover) but still
 * answers from an earlier search of the same name, so one look places every
 * chip that cites it.
 */
export function useFileNamedInProject(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  readonly name: string;
  readonly lookup?: boolean | undefined;
}): FileNamedInProject {
  const searchable = Boolean(input.environmentId && input.cwd && input.name);
  const lookup = input.lookup ?? true;
  const query = useQuery({
    ...projectSearchEntriesQueryOptions({
      environmentId: input.environmentId ?? null,
      cwd: input.cwd ?? null,
      query: input.name,
      limit: FILE_NAME_SEARCH_LIMIT,
      enabled: searchable && lookup,
    }),
    // The search answers the same way every time; a transcript citing a name
    // the project lacks should not ask three more times.
    retry: false,
  });

  if (!searchable || query.isError) {
    return UNAVAILABLE;
  }
  // The shared search options show an empty result while a query is in flight,
  // and while one that has not been asked for waits.
  if (query.isPending || query.isPlaceholderData) {
    return lookup ? LOADING : IDLE;
  }
  const match = findFileNamed(query.data.entries, input.name);
  return match ? { status: "found", relativePath: match.path } : NONE;
}
