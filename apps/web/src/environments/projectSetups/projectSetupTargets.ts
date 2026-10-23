/**
 * The computers a project can be set up on (docs/design/fleet.md, Part 8),
 * read from what this app knows of each: its connection, its descriptor, its
 * projects and its settings. The rules themselves are client-runtime's
 * (`listProjectSetupTargets`); this module feeds them, read now for menus
 * built on a click and kept current for the surfaces that stay on screen.
 */
import {
  defaultProjectSetupFolder,
  isProtectedConnectionUrl,
  listProjectSetupTargets,
  type ProjectSetupComputer,
  type ProjectSetupProjectKey,
  type ProjectSetupTarget,
} from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectSetupSource,
  ScopedProjectRef,
} from "@threadlines/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { deriveRepositoryRelativeProjectPath } from "../../logicalProject";
import { readConnectedComputerCapability } from "../computerCapabilities";
import { getServerConfig } from "../../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import type { Project } from "../../types";
import {
  getPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentDescriptor,
} from "../primary";
import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";

/** A project as the setup rules key it; null for one with nothing to clone (no repository). */
export function projectSetupKeyOf(
  project: Pick<Project, "kind" | "cwd" | "repositoryIdentity">,
): ProjectSetupProjectKey | null {
  if (project.kind === "general-chat") return null;
  const repositoryKey = project.repositoryIdentity?.canonicalKey;
  if (!repositoryKey) return null;
  return { repositoryKey, subdirectory: deriveRepositoryRelativeProjectPath(project) };
}

/**
 * Whether this app's connection to its own server is protected on the wire:
 * the address it reaches it by (the desktop app's loopback, a TLS address),
 * resolved against the page for a same-origin server.
 */
function isPrimaryConnectionProtected(): boolean {
  try {
    const wsBaseUrl = getPrimaryKnownEnvironment()?.target.wsBaseUrl;
    if (!wsBaseUrl) return false;
    return isProtectedConnectionUrl(new URL(wsBaseUrl, window.location.origin).toString());
  } catch {
    // An address it can't tell is not one to send secrets over.
    return false;
  }
}

/**
 * Whether this app's connection to a saved computer is protected: a "Connect
 * a device" computer's end to end encrypted connection (relay v2, over the
 * relay or a direct route), an SSH tunnel, or a TLS or loopback address. An
 * old phone link (relay v1) is readable at the relay, so it is not.
 */
function isSavedConnectionProtected(record: SavedEnvironmentRecord): boolean {
  if (record.relay) return "version" in record.relay && record.relay.version === 2;
  if (record.desktopSsh) return true;
  return isProtectedConnectionUrl(record.wsBaseUrl);
}

interface ComputersInput {
  readonly primary: ExecutionEnvironmentDescriptor | null;
  readonly savedById: Readonly<Record<string, SavedEnvironmentRecord>>;
  readonly runtimeById: Readonly<Record<string, SavedEnvironmentRuntimeState>>;
  readonly projects: ReadonlyArray<Project>;
}

function projectKeysOn(
  projects: ReadonlyArray<Project>,
  environmentId: EnvironmentId,
): ProjectSetupProjectKey[] {
  return projects.flatMap((project) => {
    if (project.environmentId !== environmentId) return [];
    const key = projectSetupKeyOf(project);
    return key === null ? [] : [key];
  });
}

function describeComputers(input: ComputersInput): ProjectSetupComputer[] {
  const computers: ProjectSetupComputer[] = [];
  if (input.primary !== null) {
    computers.push({
      environmentId: input.primary.environmentId,
      label: input.primary.label,
      connected: true,
      supportsProjectSetup: input.primary.capabilities.projectSetup === true,
      protectedConnection: isPrimaryConnectionProtected(),
      projects: projectKeysOn(input.projects, input.primary.environmentId),
    });
  }
  for (const record of Object.values(input.savedById)) {
    if (record.environmentId === input.primary?.environmentId) continue;
    const runtime = input.runtimeById[record.environmentId];
    computers.push({
      environmentId: record.environmentId,
      label: runtime?.descriptor?.label ?? record.label,
      connected: runtime?.connectionState === "connected",
      supportsProjectSetup: runtime?.descriptor?.capabilities.projectSetup === true,
      protectedConnection: isSavedConnectionProtected(record),
      projects: projectKeysOn(input.projects, record.environmentId),
    });
  }
  return computers;
}

function readComputersInput(): ComputersInput {
  return {
    primary: readPrimaryEnvironmentDescriptor(),
    savedById: useSavedEnvironmentRegistryStore.getState().byId,
    runtimeById: useSavedEnvironmentRuntimeStore.getState().byId,
    projects: selectProjectsAcrossEnvironments(useStore.getState()),
  };
}

function targetsFor(
  input: ComputersInput,
  projectRef: ScopedProjectRef | null,
): ProjectSetupTarget[] {
  if (projectRef === null) return [];
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === projectRef.environmentId && candidate.id === projectRef.projectId,
  );
  const key = project ? projectSetupKeyOf(project) : null;
  // Nothing to clone: no need to look at the computers at all.
  if (key === null) return [];
  return listProjectSetupTargets({
    sourceEnvironmentId: projectRef.environmentId,
    project: key,
    computers: describeComputers(input),
  });
}

/** The computers a project could be set up on, read now: for menus built on a click. */
export function readProjectSetupTargets(projectRef: ScopedProjectRef | null): ProjectSetupTarget[] {
  return targetsFor(readComputersInput(), projectRef);
}

/** The computers a project could be set up on, kept current. */
export function useProjectSetupTargets(
  projectRef: ScopedProjectRef | null,
): ReadonlyArray<ProjectSetupTarget> {
  const primary = usePrimaryEnvironmentDescriptor();
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentId = projectRef?.environmentId ?? null;
  const projectId = projectRef?.projectId ?? null;
  return useMemo(
    () =>
      targetsFor(
        { primary, savedById, runtimeById, projects },
        environmentId !== null && projectId !== null ? { environmentId, projectId } : null,
      ),
    [environmentId, primary, projectId, projects, runtimeById, savedById],
  );
}

/**
 * Whether this app is connected to a computer right now and its server
 * takes setups: the computers whose setups this app can watch and act on.
 */
export function readProjectSetupComputerReady(environmentId: EnvironmentId): boolean {
  return readConnectedComputerCapability(environmentId, "projectSetup");
}

/** Whether a computer is connected to this app now and takes setups, kept current. */
export function useProjectSetupComputerReady(environmentId: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId] ?? null),
  );
  if (environmentId === null) return false;
  if (primary?.environmentId === environmentId) {
    return primary.capabilities.projectSetup === true;
  }
  return (
    runtime?.connectionState === "connected" &&
    runtime.descriptor?.capabilities.projectSetup === true
  );
}

/**
 * Where a copy of `source` goes on `environmentId` unless the user says
 * otherwise, from that computer's own copy of the repository (another
 * folder of it is a project there), its setting and its projects.
 */
/**
 * The root of the copy of this repository a computer already has (for
 * another of its folders), or null: a setup there adds the project from it.
 */
export function readExistingProjectSetupCopy(
  environmentId: EnvironmentId,
  repositoryKey: string,
): string | null {
  const existing = selectProjectsAcrossEnvironments(useStore.getState()).find(
    (project) =>
      project.environmentId === environmentId &&
      project.kind !== "general-chat" &&
      project.repositoryIdentity?.canonicalKey === repositoryKey &&
      project.repositoryIdentity.rootPath !== undefined,
  );
  return existing?.repositoryIdentity?.rootPath ?? null;
}

export function readDefaultProjectSetupFolder(
  environmentId: EnvironmentId,
  source: Pick<ProjectSetupSource, "folderName" | "homeRelativePath" | "repositoryKey">,
): string {
  const primary = readPrimaryEnvironmentDescriptor();
  const settings =
    primary?.environmentId === environmentId
      ? getServerConfig()?.settings
      : useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig?.settings;
  const projects = selectProjectsAcrossEnvironments(useStore.getState()).filter(
    (project) => project.environmentId === environmentId && project.kind !== "general-chat",
  );
  const projectRoots = projects.map(
    (project) => project.repositoryIdentity?.rootPath ?? project.cwd,
  );
  return defaultProjectSetupFolder({
    existingCopyRoot: readExistingProjectSetupCopy(environmentId, source.repositoryKey),
    baseDirectory: settings?.addProjectBaseDirectory,
    projectRoots,
    folderName: source.folderName,
    homeRelativePath: source.homeRelativePath,
  });
}

/**
 * Which copy of a project (one row may hold its copies on several computers)
 * a setup copies from: one on a computer that can offer targets, this app's
 * own computer first. Null when no copy can be set up anywhere else.
 */
export function readProjectSetupSourceAmong(
  members: ReadonlyArray<Pick<Project, "environmentId" | "id">>,
): ScopedProjectRef | null {
  const primaryId = readPrimaryEnvironmentDescriptor()?.environmentId;
  const ordered = members.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryId) - Number(left.environmentId === primaryId),
  );
  for (const member of ordered) {
    const ref = { environmentId: member.environmentId, projectId: member.id };
    if (readProjectSetupTargets(ref).length > 0) return ref;
  }
  return null;
}
