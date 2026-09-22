const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/(?<repository>[^/\s]+\/[^/\s]+)\/pull\/(?<number>\d+)(?:[/?#].*)?$/i;
const GITLAB_MERGE_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]*gitlab[^/\s]*\/.+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;
const AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;
const GITHUB_CLI_PR_CHECKOUT_PATTERN = /^gh\s+pr\s+checkout\s+(.+)$/i;
const GITLAB_CLI_MR_CHECKOUT_PATTERN = /^glab\s+mr\s+checkout\s+(.+)$/i;
const AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;

function parseAzureDevOpsCheckoutReference(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") {
      return parts[index + 1] ?? null;
    }
    if (part.startsWith("--id=")) {
      return part.slice("--id=".length) || null;
    }
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const ghCliCheckoutMatch = GITHUB_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const glabCliCheckoutMatch = GITLAB_CLI_MR_CHECKOUT_PATTERN.exec(trimmed);
  const azureDevOpsCliCheckoutMatch = AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const normalizedInput =
    ghCliCheckoutMatch?.[1]?.trim() ??
    glabCliCheckoutMatch?.[1]?.trim() ??
    (azureDevOpsCliCheckoutMatch?.[1]
      ? parseAzureDevOpsCheckoutReference(azureDevOpsCliCheckoutMatch[1])
      : null) ??
    trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  const urlMatch =
    GITHUB_PULL_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    GITLAB_MERGE_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN.exec(normalizedInput);
  // Every pattern requires a number, so a match is already a whole reference.
  if (urlMatch) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}

/** A GitHub pull request the app can address by itself: its repository and number. */
export interface PullRequestUrlReference {
  /** `owner/name`, in the spelling the link used. */
  readonly repository: string;
  readonly number: number;
}

/**
 * The pull request a web address points at, or null when it points at
 * something else. GitHub only for now: the chip this feeds colours itself from
 * listings the app already holds, and nothing lists GitLab or Azure DevOps
 * rows by repository yet.
 *
 * A deeper link into the same pull request (its files, one comment) still
 * names it, so it resolves the same way. Whether a click opens the app's own
 * tab is the stricter question `isLinkToPullRequest` answers.
 */
export function parsePullRequestUrl(href: string): PullRequestUrlReference | null {
  const match = GITHUB_PULL_REQUEST_URL_PATTERN.exec(href.trim());
  const repository = match?.groups?.["repository"];
  const number = Number(match?.groups?.["number"] ?? Number.NaN);
  if (repository === undefined || !Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { repository, number };
}
