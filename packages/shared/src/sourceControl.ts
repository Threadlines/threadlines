import type {
  RepositoryIdentity,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@threadlines/contracts";

/** The hosts Threadlines reads change requests from. */
const CHANGE_REQUEST_PROVIDER_KINDS = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
] as const satisfies ReadonlyArray<SourceControlProviderKind>;

type ChangeRequestProviderKind = (typeof CHANGE_REQUEST_PROVIDER_KINDS)[number];

/** A recorded provider, but only as one of the hosts with change requests. */
export function toChangeRequestProviderKind(
  value: string | undefined,
): ChangeRequestProviderKind | null {
  const kinds: ReadonlyArray<string> = CHANGE_REQUEST_PROVIDER_KINDS;
  return kinds.includes(value ?? "") ? (value as ChangeRequestProviderKind) : null;
}

/**
 * How a host names the repository a change request lives in, which is the name
 * the server asks with and the client compares rows against.
 *
 * `displayName` is the whole path below the host, which is what a nested GitLab
 * group needs; `owner/name` is the two-segment fallback for an identity
 * recorded before that field existed. Azure DevOps is the exception:
 * `az repos pr` takes a repository's own name and reads the organisation and
 * project from the checkout it detects, so the recorded `org/project/_git/repo`
 * path is reduced to its last segment.
 *
 * Null for an identity that names no repository, and for a host with no change
 * requests to read.
 */
export function changeRequestRepositoryName(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  const provider = toChangeRequestProviderKind(identity?.provider);
  if (!identity || provider === null) {
    return null;
  }

  const displayName = identity.displayName?.trim() ?? "";
  const owner = identity.owner?.trim() ?? "";
  const name = identity.name?.trim() ?? "";

  if (provider === "azure-devops") {
    if (name.length > 0) {
      return name;
    }
    const segments = displayName.split("/").filter((segment) => segment !== "_git");
    return segments.at(-1)?.trim() || null;
  }
  if (displayName.includes("/")) {
    return displayName;
  }
  return owner.length > 0 && name.length > 0 ? `${owner}/${name}` : null;
}

export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "azure-devops" | "bitbucket" | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GITLAB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitlab",
  providerName: "GitLab",
  shortName: "MR",
  longName: "merge request",
  pluralLongName: "merge requests",
  providerLongName: "GitLab merge request",
  checkoutCommandExample: "glab mr checkout 123",
  urlExample: "https://gitlab.com/group/project/-/merge_requests/42",
};

const AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "azure-devops",
  providerName: "Azure DevOps",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Azure DevOps pull request",
  checkoutCommandExample: "az repos pr checkout --id 123",
  urlExample: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
};

const BITBUCKET_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "bitbucket",
  providerName: "Bitbucket",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Bitbucket pull request",
  urlExample: "https://bitbucket.org/workspace/repo/pull-requests/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    case "gitlab":
      return GITLAB_CHANGE_REQUEST_PRESENTATION;
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "unknown":
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

export function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return `${verb} ${presentation.shortName}`;
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return `create ${presentation.shortName}`;
}

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (!provider) {
    return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  }

  const presentation = resolveChangeRequestPresentation(provider);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    if (separatorIndex <= 0) {
      return null;
    }
    return hostWithPath.slice(0, separatorIndex).toLowerCase();
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
}

function parseHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || host.includes("gitlab");
}

function isAzureDevOpsHost(host: string): boolean {
  return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || host.includes("bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

  if (isGitHubHost(hostname)) {
    return {
      kind: "github",
      name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isGitLabHost(hostname)) {
    return {
      kind: "gitlab",
      name: hostname === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isAzureDevOpsHost(hostname)) {
    return {
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isBitbucketHost(hostname)) {
    return {
      kind: "bitbucket",
      name: hostname === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: "unknown",
    name: host,
    baseUrl: toBaseUrl(host),
  };
}

/** A GitHub pull request's address: `owner/name`, then the number, then anything deeper. */
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/(?<repository>[^/\s]+\/[^/\s]+)\/pull\/(?<number>\d+)(?:[/?#].*)?$/i;

/**
 * The same address inside a run of text, bare or as a markdown link's target.
 * The repository stops at whatever prose or markdown puts around a link.
 */
const GITHUB_PULL_REQUEST_URL_IN_TEXT_PATTERN =
  /https:\/\/github\.com\/([^/\s()[\]<>"'`]+\/[^/\s()[\]<>"'`]+)\/pull\/(\d+)/gi;

/** A GitHub pull request the app can address by itself: its repository and number. */
export interface PullRequestUrlReference {
  /** `owner/name`, in the spelling the link used. */
  readonly repository: string;
  readonly number: number;
}

function toPullRequestUrlReference(
  repository: string | undefined,
  rawNumber: string | undefined,
): PullRequestUrlReference | null {
  const number = Number(rawNumber ?? Number.NaN);
  if (repository === undefined || !Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { repository, number };
}

/**
 * The pull request a web address points at, or null when it points at
 * something else. GitHub only for now: nothing here lists GitLab or Azure
 * DevOps rows by repository yet.
 *
 * A deeper link into the same pull request (its files, one comment) still
 * names it, so it resolves the same way.
 */
export function parsePullRequestUrl(href: string): PullRequestUrlReference | null {
  const match = GITHUB_PULL_REQUEST_URL_PATTERN.exec(href.trim());
  return toPullRequestUrlReference(match?.groups?.["repository"], match?.groups?.["number"]);
}

/**
 * Every GitHub pull request a piece of text links to, each once, in the order
 * it is first mentioned. Casing is the host's to ignore, so the same pull
 * request spelled two ways is still one.
 */
export function findPullRequestUrls(text: string): ReadonlyArray<PullRequestUrlReference> {
  const found = new Map<string, PullRequestUrlReference>();
  for (const match of text.matchAll(GITHUB_PULL_REQUEST_URL_IN_TEXT_PATTERN)) {
    const reference = toPullRequestUrlReference(match[1], match[2]);
    const key = reference ? `${reference.repository.toLowerCase()}#${reference.number}` : null;
    if (reference && key !== null && !found.has(key)) {
      found.set(key, reference);
    }
  }
  return [...found.values()];
}
