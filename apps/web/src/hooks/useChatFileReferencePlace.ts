import type { EnvironmentId } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import {
  parseChatFileReference,
  placeChatFileReference,
  projectRootBehind,
  type ResolvedChatFileReference,
  subscribeActiveFileViewerContext,
} from "../fileViewerStore";
import { projectQueryKeys } from "../lib/projectReactQuery";

export type ChatFileReferenceLookup =
  /** Not looked up yet: the caller holds the search until it is wanted. */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  /** Where the file is. Its `line` is unset: chips citing other lines share the lookup. */
  | { readonly status: "found"; readonly file: ResolvedChatFileReference }
  /** More than one file ends in the cited path, and nothing says which. */
  | { readonly status: "ambiguous" }
  /** The search ran and neither the thread's folder nor the project folder has the file. */
  | { readonly status: "none" }
  /** No workspace to search, or the search failed: the folder is unknown. */
  | { readonly status: "unavailable" };

const IDLE: ChatFileReferenceLookup = { status: "idle" };
const LOADING: ChatFileReferenceLookup = { status: "loading" };
const UNAVAILABLE: ChatFileReferenceLookup = { status: "unavailable" };

/**
 * Where the file an inline-code reference (`home.png`, `Model/ReturnForm.php`)
 * names lives, found by the same lookup a click on its chip runs: in the
 * chat's folder, then in the project folder behind it when that is a worktree.
 *
 * `lookup: false` holds the search back (a chip waits for a hover) but still
 * answers from an earlier search of the same reference, so one look places
 * every chip that cites it.
 */
export function useChatFileReferencePlace(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  /** The inline code as written: a file name or path, with or without a line. */
  readonly reference: string;
  readonly lookup?: boolean | undefined;
}): ChatFileReferenceLookup {
  const path = parseChatFileReference(input.reference)?.path ?? null;
  const { environmentId, cwd } = input;
  const projectRoot = useSyncExternalStore(subscribeActiveFileViewerContext, () =>
    projectRootBehind(cwd),
  );
  const lookup = input.lookup ?? true;
  const query = useQuery({
    queryKey: projectQueryKeys.chatFileReference(
      environmentId ?? null,
      cwd ?? null,
      projectRoot,
      path ?? "",
    ),
    queryFn: () => {
      if (!environmentId || !cwd || !path) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return placeChatFileReference({
        environmentId,
        cwd,
        projectRoot,
        reference: { path, line: undefined },
      });
    },
    enabled: Boolean(environmentId && cwd && path) && lookup,
    staleTime: 15_000,
    // The lookup answers the same way every time; a transcript citing a file
    // the project lacks should not ask three more times.
    retry: false,
  });

  if (!environmentId || !cwd || !path || query.isError) {
    return UNAVAILABLE;
  }
  if (query.isPending) {
    return lookup ? LOADING : IDLE;
  }
  return query.data;
}
