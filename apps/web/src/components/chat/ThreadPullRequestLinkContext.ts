import { createContext, useContext } from "react";

/**
 * The pull requests the thread's right panel can show, handed to the
 * transcript so a link to any of them opens the Pull request tab on it instead
 * of the host's page: the one on the thread's own branch, and the ones its
 * agent opened elsewhere. The thread route provides it; anywhere else a
 * transcript renders, it is null and links behave as they always have.
 */
export interface ThreadPullRequestLinks {
  readonly pullRequests: ReadonlyArray<{ readonly number: number; readonly url: string }>;
  /** Shows one of them in the Pull request tab. */
  readonly open: (number: number) => void;
}

export const ThreadPullRequestLinkContext = createContext<ThreadPullRequestLinks | null>(null);

export function useThreadPullRequestLinks(): ThreadPullRequestLinks | null {
  return useContext(ThreadPullRequestLinkContext);
}
