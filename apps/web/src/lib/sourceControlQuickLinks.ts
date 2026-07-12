import type { SourceControlProviderKind, VcsStatusResult } from "@threadlines/contracts";

export interface SourceControlQuickLinks {
  readonly provider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
  readonly repository: string;
  readonly changeRequests: string | null;
  readonly automation: { readonly label: string; readonly url: string } | null;
  /**
   * Link to the current branch tree; null on the default branch, detached
   * HEAD, or when the branch has never been pushed (the tree page would 404).
   */
  readonly currentBranch: string | null;
  /** The branch's change request when one exists — its direct URL beats the list. */
  readonly changeRequest: {
    readonly number: number;
    readonly state: string;
    readonly url: string;
  } | null;
}

type SourceControlQuickLinksStatusInput = Pick<
  VcsStatusResult,
  | "isRepo"
  | "sourceControlProvider"
  | "remoteWebUrl"
  | "refName"
  | "isDefaultRef"
  | "hasUpstream"
  | "pr"
>;

interface ProviderRoutes {
  readonly changeRequests: (repository: string) => string;
  readonly automation: (repository: string) => SourceControlQuickLinks["automation"];
  readonly branch: (repository: string, branch: string) => string;
}

function appendPath(repository: string, path: string): string {
  return `${repository.replace(/\/$/u, "")}${path}`;
}

function encodePathSegments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function deriveAzurePipelinesUrl(repository: string): string | null {
  try {
    const url = new URL(repository);
    const repositoryMarker = url.pathname.toLowerCase().indexOf("/_git/");
    if (repositoryMarker < 0) return null;
    url.pathname = `${url.pathname.slice(0, repositoryMarker)}/_build`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

const PROVIDER_ROUTES: Partial<Record<SourceControlProviderKind, ProviderRoutes>> = {
  github: {
    changeRequests: (repository) => appendPath(repository, "/pulls"),
    automation: (repository) => ({ label: "Actions", url: appendPath(repository, "/actions") }),
    branch: (repository, branch) => appendPath(repository, `/tree/${encodePathSegments(branch)}`),
  },
  gitlab: {
    changeRequests: (repository) => appendPath(repository, "/-/merge_requests"),
    automation: (repository) => ({
      label: "Pipelines",
      url: appendPath(repository, "/-/pipelines"),
    }),
    branch: (repository, branch) => appendPath(repository, `/-/tree/${encodePathSegments(branch)}`),
  },
  "azure-devops": {
    changeRequests: (repository) => appendPath(repository, "/pullrequests"),
    automation: (repository) => {
      const url = deriveAzurePipelinesUrl(repository);
      return url ? { label: "Pipelines", url } : null;
    },
    branch: (repository, branch) =>
      `${repository.replace(/\/$/u, "")}?version=GB${encodeURIComponent(branch)}`,
  },
  bitbucket: {
    changeRequests: (repository) => appendPath(repository, "/pull-requests"),
    automation: (repository) => ({
      label: "Pipelines",
      url: appendPath(repository, "/pipelines"),
    }),
    branch: (repository, branch) => appendPath(repository, `/src/${encodeURIComponent(branch)}/`),
  },
};

/**
 * Derive provider-specific web UI links from the tracked remote. Unknown
 * providers still get a useful repository menu instead of disappearing.
 */
export function deriveSourceControlQuickLinks(
  status: SourceControlQuickLinksStatusInput | null | undefined,
): SourceControlQuickLinks | null {
  if (!status?.isRepo || !status.sourceControlProvider) return null;
  const repository = status.remoteWebUrl ?? null;
  if (repository === null) return null;

  const provider = status.sourceControlProvider;
  const routes = PROVIDER_ROUTES[provider.kind];
  const branch = status.refName;
  const currentBranch =
    routes && branch !== null && !status.isDefaultRef && status.hasUpstream
      ? routes.branch(repository, branch)
      : null;

  return {
    provider,
    repository,
    changeRequests: routes?.changeRequests(repository) ?? null,
    automation: routes?.automation(repository) ?? null,
    currentBranch,
    changeRequest: status.pr
      ? { number: status.pr.number, state: status.pr.state, url: status.pr.url }
      : null,
  };
}
