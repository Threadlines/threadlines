import type { VcsStatusResult } from "@threadlines/contracts";

export interface GitHubQuickLinks {
  readonly repository: string;
  readonly pullRequests: string;
  readonly actions: string;
  /**
   * Link to the current branch tree; null on the default branch, detached
   * HEAD, or when the branch has never been pushed (the tree page would 404).
   */
  readonly currentBranch: string | null;
  /** The branch's PR when one exists — deep-link target that beats the pulls list. */
  readonly pr: { readonly number: number; readonly state: string; readonly url: string } | null;
}

type GitHubQuickLinksStatusInput = Pick<
  VcsStatusResult,
  | "isRepo"
  | "sourceControlProvider"
  | "remoteWebUrl"
  | "refName"
  | "isDefaultRef"
  | "hasUpstream"
  | "pr"
>;

/**
 * Derive quick links into the GitHub web UI from the thread's git status.
 * Returns null unless the tracked remote is GitHub-shaped, so other providers
 * (GitLab, Bitbucket, local-only repos) never render a dead menu section.
 */
export function deriveGitHubQuickLinks(
  status: GitHubQuickLinksStatusInput | null | undefined,
): GitHubQuickLinks | null {
  if (!status?.isRepo) return null;
  if (status.sourceControlProvider?.kind !== "github") return null;
  const repository = status.remoteWebUrl ?? null;
  if (repository === null) return null;

  const branch = status.refName;
  const currentBranch =
    branch !== null && !status.isDefaultRef && status.hasUpstream
      ? `${repository}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`
      : null;

  return {
    repository,
    pullRequests: `${repository}/pulls`,
    actions: `${repository}/actions`,
    currentBranch,
    pr: status.pr ? { number: status.pr.number, state: status.pr.state, url: status.pr.url } : null,
  };
}
