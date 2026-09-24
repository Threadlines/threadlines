import type { EnvironmentId } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";

import { FILE_NAME_SEARCH_LIMIT, findFileNamed } from "../fileViewerStore";
import { projectSearchEntriesQueryOptions } from "../lib/projectReactQuery";

export type FileNamedInProject =
  | { readonly status: "loading" }
  | { readonly status: "found"; readonly relativePath: string }
  | { readonly status: "none" };

const LOADING: FileNamedInProject = { status: "loading" };
const NONE: FileNamedInProject = { status: "none" };

/**
 * Where in the project the file a bare name (`home.png`) refers to lives, found
 * by the same exact-name workspace search a click on its chip runs. `none`
 * covers a search that found no such file, one that failed, and a document with
 * no workspace to search: in each case the name has no known folder.
 */
export function useFileNamedInProject(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  readonly name: string;
}): FileNamedInProject {
  const enabled = Boolean(input.environmentId && input.cwd && input.name);
  const query = useQuery({
    ...projectSearchEntriesQueryOptions({
      environmentId: input.environmentId ?? null,
      cwd: input.cwd ?? null,
      query: input.name,
      limit: FILE_NAME_SEARCH_LIMIT,
      enabled,
    }),
    // The search answers the same way every time; a transcript citing a name
    // the project lacks should not ask three more times.
    retry: false,
  });

  if (!enabled || query.isError) {
    return NONE;
  }
  // The shared search options show an empty result while a query is in flight.
  if (query.isPending || query.isPlaceholderData) {
    return LOADING;
  }
  const match = findFileNamed(query.data.entries, input.name);
  return match ? { status: "found", relativePath: match.path } : NONE;
}
