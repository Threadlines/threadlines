import { createContext, useContext } from "react";

/**
 * The pull request the thread's right panel can show, handed to the transcript
 * so a link to it opens the Pull request tab instead of the host's page. The
 * thread route provides it; anywhere else a transcript renders, it is null and
 * links behave as they always have.
 */
export interface ThreadPullRequestLink {
  readonly url: string;
  readonly open: () => void;
}

export const ThreadPullRequestLinkContext = createContext<ThreadPullRequestLink | null>(null);

export function useThreadPullRequestLink(): ThreadPullRequestLink | null {
  return useContext(ThreadPullRequestLinkContext);
}
