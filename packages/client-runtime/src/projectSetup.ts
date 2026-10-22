/**
 * Setting up a project on another computer (docs/design/fleet.md, Part 8):
 * the rules the app decides by, pure so every entry point reads the same
 * ones. Which computers can take a copy, whether files may travel to one,
 * and where the copy goes by default.
 *
 * @module projectSetup
 */
import {
  PROJECT_SETUP_MAX_TOTAL_BYTES,
  type EnvironmentId,
  type ProjectSetupFileCandidate,
  type ProjectSetupRemote,
  type ProjectSetupSource,
  type ProjectSetupStage,
} from "@threadlines/contracts";
import { convertGitRemoteUrl } from "@threadlines/shared/git";
import { isUncPath, isWindowsDrivePath } from "@threadlines/shared/path";

/** A project as "does this computer have it" asks: its repository and its folder in it. */
export interface ProjectSetupProjectKey {
  /** RepositoryIdentity.canonicalKey. */
  readonly repositoryKey: string;
  /** From the repository root, `/`-separated, "" at the root; null when it can't be told. */
  readonly subdirectory: string | null;
}

/** A computer this app knows, as the setup rules see it. */
export interface ProjectSetupComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This app is connected to it right now. */
  readonly connected: boolean;
  /** Its server reports the `projectSetup` capability. */
  readonly supportsProjectSetup: boolean;
  /** This app's connection to it is loopback, TLS or end to end encrypted. */
  readonly protectedConnection: boolean;
  /** Its live projects that have a repository identity. */
  readonly projects: ReadonlyArray<ProjectSetupProjectKey>;
}

/** A computer a project can be set up on. */
export interface ProjectSetupTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /**
   * The computer this app reaches without protection, which keeps the
   * ignored files from being sent; null when both connections are protected.
   */
  readonly unprotected: { readonly environmentId: EnvironmentId; readonly label: string } | null;
}

/**
 * Whether `projects` holds `project`: the same repository and the same folder
 * in it. A side that can't tell its folder (no repository root known) leaves
 * the repository alone to decide, as an older server's projects do.
 */
export function hasProjectSetupProject(
  projects: ReadonlyArray<ProjectSetupProjectKey>,
  project: ProjectSetupProjectKey,
): boolean {
  return projects.some(
    (candidate) =>
      candidate.repositoryKey === project.repositoryKey &&
      (candidate.subdirectory === null ||
        project.subdirectory === null ||
        candidate.subdirectory === project.subdirectory),
  );
}

/**
 * The computers a project on `source` can be set up on: connected to this
 * app, reporting `projectSetup`, and without the project yet. None when the
 * project has no repository (nothing to clone) or its own computer can't
 * describe it (offline, or a server without `projectSetup`). By name.
 */
export function listProjectSetupTargets(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  /** Null: a project with no repository identity. */
  readonly project: ProjectSetupProjectKey | null;
  readonly computers: ReadonlyArray<ProjectSetupComputer>;
}): ProjectSetupTarget[] {
  const { project } = input;
  if (project === null) return [];
  const source = input.computers.find(
    (computer) => computer.environmentId === input.sourceEnvironmentId,
  );
  if (!source?.connected || !source.supportsProjectSetup) return [];
  return input.computers
    .filter(
      (computer) =>
        computer.environmentId !== source.environmentId &&
        computer.connected &&
        computer.supportsProjectSetup &&
        !hasProjectSetupProject(computer.projects, project),
    )
    .map((computer) => {
      const unprotected = !computer.protectedConnection
        ? computer
        : !source.protectedConnection
          ? source
          : null;
      return {
        environmentId: computer.environmentId,
        label: computer.label,
        unprotected:
          unprotected === null
            ? null
            : { environmentId: unprotected.environmentId, label: unprotected.label },
      };
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether a connection made to `url` is protected on the wire: TLS (`wss:`,
 * `https:`) or this machine's own loopback. A plain `ws://` address on a
 * network is not. (End to end encrypted relay connections are protected
 * whatever their URL; the caller knows those.)
 */
export function isProtectedConnectionUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "wss:" || parsed.protocol === "https:") return true;
  return isLoopbackHost(parsed.hostname);
}

function usesWindowsSeparators(path: string): boolean {
  return (
    isWindowsDrivePath(path) || isUncPath(path) || (path.includes("\\") && !path.includes("/"))
  );
}

/** `folder` and `name` joined with the folder's own separator. */
export function joinProjectSetupFolder(folder: string, name: string): string {
  const separator = usesWindowsSeparators(folder) ? "\\" : "/";
  return /[\\/]$/.test(folder) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

/**
 * The folder holding `path`, or null when that would be a filesystem root
 * (`/`, `C:\`): no one keeps their projects loose there.
 */
export function projectSetupParentFolder(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return null;
  const parent = trimmed.slice(0, cut);
  if (/^[a-zA-Z]:$/.test(parent)) return null;
  if (isUncPath(path) && parent.replace(/^[\\/]+/, "").split(/[\\/]/).length < 2) return null;
  return parent;
}

/**
 * Where a copy goes unless the user says otherwise: the target's own copy of
 * the repository when it has one (a monorepo's other app: the project's
 * folder is added from it, nothing cloned); else its own "Add project" base
 * folder when it has one; else the folder most of its projects share; else
 * the same place under its home as on the source; else its home.
 */
export function defaultProjectSetupFolder(input: {
  /** The root of a copy of this repository the target already has, for another of its folders. */
  readonly existingCopyRoot?: string | null;
  /** The target's `addProjectBaseDirectory` setting. */
  readonly baseDirectory: string | null | undefined;
  /** The target's projects' repository roots (or their folders without one). */
  readonly projectRoots: ReadonlyArray<string>;
  /** The source repository's folder name. */
  readonly folderName: string;
  /** The source repository from its computer's home folder; null outside it. */
  readonly homeRelativePath: string | null;
}): string {
  const existingCopyRoot = input.existingCopyRoot?.trim() ?? "";
  if (existingCopyRoot.length > 0) return existingCopyRoot;
  const baseDirectory = input.baseDirectory?.trim() ?? "";
  if (baseDirectory.length > 0) return joinProjectSetupFolder(baseDirectory, input.folderName);

  const counts = new Map<string, number>();
  for (const root of input.projectRoots) {
    const parent = projectSetupParentFolder(root.trim());
    if (parent !== null) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const shared = [...counts].toSorted(
    ([leftFolder, leftCount], [rightFolder, rightCount]) =>
      rightCount - leftCount || leftFolder.localeCompare(rightFolder),
  )[0];
  if (shared !== undefined) return joinProjectSetupFolder(shared[0], input.folderName);

  const homeRelativePath = input.homeRelativePath?.replace(/^[\\/]+|[\\/]+$/g, "") ?? "";
  if (homeRelativePath.length > 0) return `~/${homeRelativePath}`;
  return `~/${input.folderName}`;
}

/** The remote a copy clones from: the one the source's identity comes from. */
export function projectSetupPrimaryRemote(
  source: Pick<ProjectSetupSource, "remotes" | "primaryRemoteName">,
): ProjectSetupRemote | null {
  return (
    source.remotes.find((remote) => remote.name === source.primaryRemoteName) ??
    source.remotes[0] ??
    null
  );
}

/**
 * The URL each way of cloning would use: SSH and HTTPS both when the primary
 * remote converts, else only its own. The first is the primary's own protocol.
 */
export function projectSetupCloneOptions(
  remote: ProjectSetupRemote,
): ReadonlyArray<{ readonly protocol: ProjectSetupRemote["protocol"]; readonly url: string }> {
  if (remote.protocol === "other") return [{ protocol: "other", url: remote.url }];
  const other = remote.protocol === "ssh" ? "https" : "ssh";
  const converted = convertGitRemoteUrl(remote.url, other);
  return converted === null
    ? [{ protocol: remote.protocol, url: remote.url }]
    : [
        { protocol: remote.protocol, url: remote.url },
        { protocol: other, url: converted },
      ];
}

/** The ignored files as the dialog lists them: suggested ones first, each group as the source sent it. */
export function orderProjectSetupFiles(
  files: ReadonlyArray<ProjectSetupFileCandidate>,
): ProjectSetupFileCandidate[] {
  return [...files.filter((file) => file.suggested), ...files.filter((file) => !file.suggested)];
}

/** The files ticked to start with: the suggested ones that can be sent. */
export function initialProjectSetupFileSelection(
  files: ReadonlyArray<ProjectSetupFileCandidate>,
): Set<string> {
  return new Set(files.filter((file) => file.suggested && !file.tooLarge).map((file) => file.path));
}

/** Whether the ticked files fit in one start (8 MiB in all). */
export function projectSetupFilesFit(
  files: ReadonlyArray<ProjectSetupFileCandidate>,
  ticked: ReadonlySet<string>,
): boolean {
  let total = 0;
  for (const file of files) {
    if (ticked.has(file.path)) total += file.size;
  }
  return total <= PROJECT_SETUP_MAX_TOTAL_BYTES;
}

/** A job that ended, one way or another. */
export function isProjectSetupFinished(stage: ProjectSetupStage): boolean {
  return stage === "done" || stage === "failed" || stage === "cancelled";
}

/** A job that can still be called off: until its copy moves into place. */
export function isProjectSetupCancellable(stage: ProjectSetupStage): boolean {
  return stage === "cloning" || stage === "submodules" || stage === "copying";
}
