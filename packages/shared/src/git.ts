import type {
  GitRemoteAuthFailure,
  VcsRef,
  SourceControlProviderInfo,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@threadlines/contracts";
import { randomUUIDv4 } from "./uuid.ts";
import * as Effect from "effect/Effect";
import { detectSourceControlProviderFromRemoteUrl } from "./sourceControl.ts";

export const WORKTREE_BRANCH_PREFIX = "threadlines";
const LEGACY_WORKTREE_BRANCH_PREFIXES = ["t3code"] as const;
const TEMP_WORKTREE_BRANCH_PATTERNS = [
  WORKTREE_BRANCH_PREFIX,
  ...LEGACY_WORKTREE_BRANCH_PREFIXES,
].map((prefix) => new RegExp(`^${prefix}\\/[0-9a-f]{8}$`));

function trimMatchingCharacters(value: string, shouldTrim: (character: string) => boolean): string {
  let start = 0;
  let end = value.length;
  while (start < end && shouldTrim(value[start] ?? "")) start += 1;
  while (end > start && shouldTrim(value[end - 1] ?? "")) end -= 1;
  return value.slice(start, end);
}

function trimTrailingCharacter(value: string, character: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === character) end -= 1;
  return value.slice(0, end);
}

function stripGitSuffix(value: string): string {
  return value.toLowerCase().endsWith(".git") ? value.slice(0, -4) : value;
}

/**
 * Sanitize an arbitrary string into a valid, lowercase git refName fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const isOuterSeparator = (character: string) =>
    character === "." ||
    character === "/" ||
    character === "_" ||
    character === "-" ||
    /\s/u.test(character);
  const normalized = trimMatchingCharacters(
    [...raw.trim().toLowerCase()]
      .filter((character) => !["'", '"', "`"].includes(character))
      .join(""),
    isOuterSeparator,
  );

  const characters: string[] = [];
  for (const character of normalized) {
    const sanitized = /[a-z0-9/_-]/u.test(character) ? character : "-";
    const previous = characters.at(-1);
    if ((sanitized === "/" || sanitized === "-") && previous === sanitized) continue;
    characters.push(sanitized);
  }
  const branchFragment = trimMatchingCharacters(
    characters.join(""),
    (character) => character === "." || character === "/" || character === "_" || character === "-",
  ).slice(0, 64);
  const boundedFragment = trimMatchingCharacters(
    branchFragment,
    (character) => character === "." || character === "/" || character === "_" || character === "-",
  );

  return boundedFragment.length > 0 ? boundedFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` refName name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` refName name that doesn't collide with
 * any existing refName. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((refName) => refName.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

export function buildTemporaryWorktreeBranchName(): string {
  const token = Effect.runSync(randomUUIDv4).replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function isTemporaryWorktreeBranch(refName: string): boolean {
  const normalizedRefName = refName.trim().toLowerCase();
  return TEMP_WORKTREE_BRANCH_PATTERNS.some((pattern) => pattern.test(normalizedRefName));
}

/**
 * Normalize a git remote URL into a stable comparison key.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = stripGitSuffix(trimTrailingCharacter(value.trim(), "/")).toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/");
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^git@([^:/\s]+)[:/]([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scpStyleHostAndPath?.[1] && scpStyleHostAndPath[2]) {
    return `${scpStyleHostAndPath[1]}/${scpStyleHostAndPath[2]}`;
  }

  return normalized;
}

const HTTPS_REMOTE_IN_MESSAGE = /['"](https?:\/\/[^'"]+)['"]/i;

function extractHttpsHostFromMessage(message: string): string | null {
  const raw = HTTPS_REMOTE_IN_MESSAGE.exec(message)?.[1];
  if (!raw) {
    return null;
  }
  try {
    const hostname = new URL(raw).hostname.trim().toLowerCase();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

function extractSshHostFromMessage(message: string): string | null {
  const userAtHost = /(?:^|[\s(])(?:[a-z0-9._-]+@)([a-z0-9.-]+):\s*permission denied/i.exec(
    message,
  );
  if (userAtHost?.[1]) {
    return userAtHost[1].toLowerCase();
  }
  const connectToHost = /connect to host ([a-z0-9.-]+)/i.exec(message);
  return connectToHost?.[1] ? connectToHost[1].toLowerCase() : null;
}

/**
 * Classify a git failure message as a remote authentication failure.
 * Matches the stderr git emits when credentials are missing (no terminal to
 * prompt on), rejected, or when SSH access is not set up. Returns null for
 * messages that are not auth-related.
 */
export function classifyGitRemoteAuthFailure(message: string): GitRemoteAuthFailure | null {
  const normalized = message.toLowerCase();

  if (
    /could not read (?:username|password) for ['"]https?:\/\//.test(normalized) ||
    (normalized.includes("terminal prompts disabled") && normalized.includes("http"))
  ) {
    return {
      kind: "https_credentials_unavailable",
      scheme: "https",
      host: extractHttpsHostFromMessage(message),
    };
  }

  if (/authentication failed for ['"]?https?:\/\//.test(normalized)) {
    return {
      kind: "https_credentials_rejected",
      scheme: "https",
      host: extractHttpsHostFromMessage(message),
    };
  }

  if (normalized.includes("permission denied (publickey")) {
    return {
      kind: "ssh_permission_denied",
      scheme: "ssh",
      host: extractSshHostFromMessage(message),
    };
  }

  if (normalized.includes("host key verification failed")) {
    return {
      kind: "ssh_host_key_verification_failed",
      scheme: "ssh",
      host: extractSshHostFromMessage(message),
    };
  }

  return null;
}

/**
 * Extract a remote auth failure from any error shape: prefers the structured
 * `remoteAuth` field the server attaches to GitCommandError, falling back to
 * classifying the error message text.
 */
export function gitRemoteAuthFailureFromError(error: unknown): GitRemoteAuthFailure | null {
  if (typeof error === "object" && error !== null) {
    const remoteAuth = (error as { remoteAuth?: GitRemoteAuthFailure | undefined }).remoteAuth;
    if (remoteAuth !== undefined) {
      return remoteAuth;
    }
  }
  if (error instanceof Error) {
    return classifyGitRemoteAuthFailure(error.message);
  }
  return typeof error === "string" ? classifyGitRemoteAuthFailure(error) : null;
}

export function describeGitRemoteAuthFailure(failure: GitRemoteAuthFailure): string {
  const host = failure.host ?? "the remote host";
  switch (failure.kind) {
    case "https_credentials_unavailable":
      return `Git needs credentials for ${host}, but none are configured for non-interactive use. The repository is private or requires sign-in over HTTPS.`;
    case "https_credentials_rejected":
      return `${host} rejected the stored HTTPS credentials. They may be expired or lack access to this repository.`;
    case "ssh_permission_denied":
      return `${host} rejected the SSH connection (permission denied). No usable SSH key is configured for it.`;
    case "ssh_host_key_verification_failed":
      return `SSH host key verification failed for ${host}. Connect once from a terminal to trust the host, then retry.`;
  }
}

export interface GitRemoteEndpoint {
  readonly scheme: "https" | "ssh";
  readonly host: string;
  /** Repository path without a leading slash or `.git` suffix, e.g. `owner/repo`. */
  readonly path: string;
}

function parseUrlRemoteEndpoint(url: string, scheme: "https" | "ssh"): GitRemoteEndpoint | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .join("/")
      .replace(/\.git$/i, "");
    const host = parsed.hostname.trim().toLowerCase();
    return host.length > 0 && path.length > 0 ? { scheme, host, path } : null;
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into its transport scheme, host, and repository
 * path. Supports https://, ssh://, and scp-style `user@host:path` remotes;
 * returns null for local paths and other unsupported shapes.
 */
export function parseGitRemoteEndpoint(url: string): GitRemoteEndpoint | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return parseUrlRemoteEndpoint(trimmed, "https");
  }
  if (/^ssh:\/\//i.test(trimmed)) {
    return parseUrlRemoteEndpoint(trimmed, "ssh");
  }
  const scpStyle = /^[a-z0-9._-]+@([a-z0-9.-]+):([^/\s].*)$/i.exec(trimmed);
  if (scpStyle?.[1] && scpStyle[2]) {
    const path = stripGitSuffix(trimTrailingCharacter(scpStyle[2], "/"));
    return path.length > 0 ? { scheme: "ssh", host: scpStyle[1].toLowerCase(), path } : null;
  }
  return null;
}

export function buildSshRemoteUrl(endpoint: Pick<GitRemoteEndpoint, "host" | "path">): string {
  return `git@${endpoint.host}:${endpoint.path}.git`;
}

export function isGitRepositoryMetadataCorruptionErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\bbad object refs\/(?:remotes|heads|tags)\//.test(normalized) ||
    normalized.includes("invalid sha1 pointer") ||
    /\bpack has \d+ unresolved deltas\b/.test(normalized) ||
    /\bmissing (?:blob|commit|tree) [0-9a-f]{7,40}\b/.test(normalized) ||
    (normalized.includes("object file") && normalized.includes(" is empty")) ||
    (normalized.includes("loose object") && normalized.includes(" is corrupt")) ||
    normalized.includes("bad tree object") ||
    normalized.includes("unable to read sha1 file") ||
    normalized.includes("repository is corrupt")
  );
}

export function formatGitErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "An error occurred.";

  const authFailure = classifyGitRemoteAuthFailure(message);
  if (authFailure) {
    return describeGitRemoteAuthFailure(authFailure);
  }

  return message;
}

function getLastRepositoryPathSegment(value: string): string | null {
  let lastSegment: string | null = null;
  for (const segment of value.split(/[\\/]+/)) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      lastSegment = trimmed;
    }
  }
  return lastSegment;
}

function sanitizeRepositoryDirectoryCharacter(character: string): string {
  if (character.charCodeAt(0) < 32 || /[<>:"|?*]/.test(character)) {
    return "-";
  }
  return character;
}

function sanitizeRepositoryDirectoryName(value: string): string | null {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original segment if it is not URI-encoded.
  }

  const characters: string[] = [];
  for (const character of stripGitSuffix(decoded)) {
    const sanitizedCharacter = sanitizeRepositoryDirectoryCharacter(character);
    if (sanitizedCharacter === "/" || sanitizedCharacter === "\\") {
      if (characters.at(-1) !== "-") characters.push("-");
    } else {
      characters.push(sanitizedCharacter);
    }
  }
  const sanitized = trimMatchingCharacters(
    characters.join(""),
    (character) => character === "." || /\s/u.test(character),
  );
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Derive the local clone directory name from an owner/repo value or remote URL.
 */
export function deriveRepositoryDirectoryName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const withoutQueryOrHash = trimmed.split(/[?#]/, 1)[0]?.trim() ?? "";
  let candidate: string | null = null;

  if (/^(?:ssh|https?|git):\/\//i.test(withoutQueryOrHash)) {
    try {
      candidate = getLastRepositoryPathSegment(new URL(withoutQueryOrHash).pathname);
    } catch {
      candidate = null;
    }
  }

  if (!candidate) {
    const scpStylePath = /^[^@\s]+@[^:/\s]+[:/](.+)$/i.exec(withoutQueryOrHash)?.[1];
    candidate = scpStylePath ? getLastRepositoryPathSegment(scpStylePath) : null;
  }

  candidate ??= getLastRepositoryPathSegment(withoutQueryOrHash);
  return candidate ? sanitizeRepositoryDirectoryName(candidate) : null;
}

/**
 * Best-effort parse of a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

/**
 * Best-effort conversion of a git remote URL into the repository's web URL
 * (e.g. `https://github.com/owner/repo`). Returns null for local paths and
 * other shapes without a host and repository path.
 */
export function parseRepositoryWebUrlFromRemoteUrl(url: string | null): string | null {
  const endpoint = url === null ? null : parseGitRemoteEndpoint(url);
  return endpoint ? `https://${endpoint.host}/${endpoint.path}` : null;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local refName already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    refs.filter((refName) => !refName.isRemote).map((refName) => refName.name),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function detectSourceControlProviderFromGitRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  return detectSourceControlProviderFromRemoteUrl(remoteUrl);
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.repositoryRoot === undefined ? {} : { repositoryRoot: status.repositoryRoot }),
    ...(status.repositoryRootRelation === undefined
      ? {}
      : { repositoryRootRelation: status.repositoryRootRelation }),
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    ...(status.remoteWebUrl === undefined ? {} : { remoteWebUrl: status.remoteWebUrl }),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
