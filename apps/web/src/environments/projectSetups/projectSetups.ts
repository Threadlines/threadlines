/**
 * Setting up a project on another computer (docs/design/fleet.md, Part 8),
 * as this app runs it. The app is connected to both computers: it reads what
 * to clone and the ticked ignored files from the one that has the project,
 * then starts one job on the one that gets a copy, which works on its own
 * from there.
 *
 * Every connected computer whose server reports `projectSetup` streams its
 * jobs (`projectSetups.subscribe`), unfinished and recent, kept here per
 * computer. The jobs this app started in this session are remembered too:
 * when one ends, its `onDone` runs if it ended done, and a toast tells of it
 * unless the dialog is showing it (ProjectSetupDialog).
 */
import { isProjectSetupFinished } from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectSetupFile,
  ProjectSetupId,
  ProjectSetupJob,
  ProjectSetupProtocol,
  ProjectSetupSource,
  ProjectSetupSourceRef,
  ProjectSetupsSnapshot,
  ScopedProjectRef,
} from "@threadlines/contracts";
import { create } from "zustand";

import { newProjectSetupId } from "../../lib/utils";
import type { WsRpcClient } from "../../rpc/wsRpcClient";
import { selectProjectByRef, useStore } from "../../store";
import { describeComputerLinkFailure } from "../links/computerLinks";
import {
  readPrimaryEnvironmentDescriptor,
  subscribePrimaryEnvironmentDescriptor,
} from "../primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../runtime";
import { readProjectSetupComputerReady, readProjectSetupTargets } from "./projectSetupTargets";

export type ProjectSetupsClient = WsRpcClient["projectSetups"];

/** What a job that ended done became: its project on the computer that got the copy. */
export interface ProjectSetupResult {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** Runs once when a setup this app started ends done. */
export type ProjectSetupOnDone = (result: ProjectSetupResult) => void;

/** One computer's jobs, as last heard from it. */
export interface ProjectSetupJobsEntry {
  readonly jobs: ReadonlyArray<ProjectSetupJob>;
  /** The stream is up, so this is current. False: the last list this app saw. */
  readonly live: boolean;
}

/** A setup this app started in this session. */
interface StartedProjectSetup {
  readonly setupId: ProjectSetupId;
  readonly environmentId: EnvironmentId;
  /** The computer it runs on, as this app named it at the start. */
  readonly label: string;
  readonly onDone: ProjectSetupOnDone | null;
  /** Its end has been told (onDone, toast). */
  readonly settled: boolean;
}

interface ProjectSetupsStoreState {
  readonly byEnvironmentId: Readonly<Record<string, ProjectSetupJobsEntry>>;
  readonly started: Readonly<Record<string, StartedProjectSetup>>;
  /** The job the dialog is showing: its end raises no toast. */
  readonly shownSetupId: ProjectSetupId | null;
}

const INITIAL_STATE: ProjectSetupsStoreState = {
  byEnvironmentId: {},
  started: {},
  shownSetupId: null,
};

export const useProjectSetupsStore = create<ProjectSetupsStoreState>()(() => INITIAL_STATE);

const EMPTY_JOBS: ReadonlyArray<ProjectSetupJob> = [];

function putSnapshot(environmentId: EnvironmentId, snapshot: ProjectSetupsSnapshot): void {
  useProjectSetupsStore.setState((state) => ({
    byEnvironmentId: {
      ...state.byEnvironmentId,
      [environmentId]: { jobs: snapshot.jobs, live: true },
    },
  }));
}

/** Puts a job this app just heard of (a start's answer) ahead of the stream's next list. */
function upsertJob(environmentId: EnvironmentId, job: ProjectSetupJob): void {
  useProjectSetupsStore.setState((state) => {
    const current = state.byEnvironmentId[environmentId];
    const jobs = current?.jobs ?? EMPTY_JOBS;
    const existing = jobs.find((candidate) => candidate.setupId === job.setupId);
    // The stream's copy wins once it has one at least as new.
    if (existing !== undefined && existing.updatedAt >= job.updatedAt) return state;
    return {
      byEnvironmentId: {
        ...state.byEnvironmentId,
        [environmentId]: {
          jobs: existing
            ? jobs.map((candidate) => (candidate.setupId === job.setupId ? job : candidate))
            : [...jobs, job],
          live: current?.live ?? false,
        },
      },
    };
  });
}

function removeJob(environmentId: EnvironmentId, setupId: ProjectSetupId): void {
  useProjectSetupsStore.setState((state) => {
    const current = state.byEnvironmentId[environmentId];
    if (!current?.jobs.some((job) => job.setupId === setupId)) return state;
    return {
      byEnvironmentId: {
        ...state.byEnvironmentId,
        [environmentId]: {
          ...current,
          jobs: current.jobs.filter((job) => job.setupId !== setupId),
        },
      },
    };
  });
}

function markStale(environmentId: EnvironmentId): void {
  useProjectSetupsStore.setState((state) => {
    const current = state.byEnvironmentId[environmentId];
    if (current === undefined || !current.live) return state;
    return {
      byEnvironmentId: { ...state.byEnvironmentId, [environmentId]: { ...current, live: false } },
    };
  });
}

function forget(environmentId: string): void {
  useProjectSetupsStore.setState((state) => {
    if (state.byEnvironmentId[environmentId] === undefined) return state;
    const { [environmentId]: _forgotten, ...rest } = state.byEnvironmentId;
    return { byEnvironmentId: rest };
  });
}

/** A computer's jobs, newest first. */
export function useProjectSetupJobs(environmentId: EnvironmentId): ReadonlyArray<ProjectSetupJob> {
  return useProjectSetupsStore((state) => state.byEnvironmentId[environmentId]?.jobs ?? EMPTY_JOBS);
}

/** One job, as last heard; null when its computer doesn't list it (yet, or any more). */
export function useProjectSetupJob(
  environmentId: EnvironmentId,
  setupId: ProjectSetupId,
): ProjectSetupJob | null {
  return useProjectSetupsStore(
    (state) =>
      state.byEnvironmentId[environmentId]?.jobs.find((job) => job.setupId === setupId) ?? null,
  );
}

/** Says which job the dialog shows (null: none), so its end raises no toast. */
export function setShownProjectSetup(setupId: ProjectSetupId | null): void {
  if (useProjectSetupsStore.getState().shownSetupId === setupId) return;
  useProjectSetupsStore.setState({ shownSetupId: setupId });
}

/** How a setup this app started ended, for the toasts. */
export interface ProjectSetupEnding {
  readonly job: ProjectSetupJob;
  readonly environmentId: EnvironmentId;
  /** The computer it ran on. */
  readonly label: string;
  /** The dialog was showing it when it ended. */
  readonly shown: boolean;
}

const endingListeners = new Set<(ending: ProjectSetupEnding) => void>();

/** Hears each setup this app started as it ends. */
export function onProjectSetupEnded(listener: (ending: ProjectSetupEnding) => void): () => void {
  endingListeners.add(listener);
  return () => {
    endingListeners.delete(listener);
  };
}

/**
 * Tells of each started setup that has ended since the last look, once: its
 * `onDone` for one that ended done, and the listeners for any.
 */
function settleEndedSetups(state: ProjectSetupsStoreState): void {
  const ended: Array<{ started: StartedProjectSetup; job: ProjectSetupJob }> = [];
  for (const started of Object.values(state.started)) {
    if (started.settled) continue;
    const job = state.byEnvironmentId[started.environmentId]?.jobs.find(
      (candidate) => candidate.setupId === started.setupId,
    );
    if (job !== undefined && isProjectSetupFinished(job.stage)) ended.push({ started, job });
  }
  if (ended.length === 0) return;
  useProjectSetupsStore.setState((current) => ({
    started: {
      ...current.started,
      ...Object.fromEntries(
        ended.map(({ started }) => [started.setupId, { ...started, settled: true }]),
      ),
    },
  }));
  for (const { started, job } of ended) {
    if (job.stage === "done" && job.projectId !== null && started.onDone !== null) {
      try {
        started.onDone({ environmentId: started.environmentId, projectId: job.projectId });
      } catch (error) {
        console.error("[PROJECT_SETUPS] onDone failed", error);
      }
    }
    const ending: ProjectSetupEnding = {
      job,
      environmentId: started.environmentId,
      label: started.label,
      shown: state.shownSetupId === started.setupId,
    };
    for (const listener of endingListeners) listener(ending);
  }
}

useProjectSetupsStore.subscribe((state, previous) => {
  if (state.byEnvironmentId !== previous.byEnvironmentId || state.started !== previous.started) {
    settleEndedSetups(state);
  }
});

const clientOverridesForTests = new Map<EnvironmentId, ProjectSetupsClient>();

/** Browser tests stand in for a computer's server: its projectSetups calls go to `client`. */
export function __setProjectSetupsClientForTests(
  environmentId: EnvironmentId,
  client: ProjectSetupsClient,
): void {
  clientOverridesForTests.set(environmentId, client);
}

export function __resetProjectSetupsForTests(): void {
  clientOverridesForTests.clear();
  useProjectSetupsStore.setState(INITIAL_STATE, true);
}

/** The projectSetups calls of this app's connection to a computer, or null without one. */
export function readProjectSetupsClient(environmentId: EnvironmentId): ProjectSetupsClient | null {
  return (
    clientOverridesForTests.get(environmentId) ??
    readEnvironmentConnection(environmentId)?.client.projectSetups ??
    null
  );
}

function requireClient(environmentId: EnvironmentId, label: string): ProjectSetupsClient {
  const client = readProjectSetupsClient(environmentId);
  if (client === null) throw new Error(`This app isn't connected to ${label}.`);
  return client;
}

function isKnownComputer(environmentId: string): boolean {
  return (
    readPrimaryEnvironmentDescriptor()?.environmentId === environmentId ||
    useSavedEnvironmentRegistryStore.getState().byId[environmentId as EnvironmentId] !== undefined
  );
}

function knownComputerIds(): EnvironmentId[] {
  const primary = readPrimaryEnvironmentDescriptor()?.environmentId;
  const saved = Object.keys(useSavedEnvironmentRegistryStore.getState().byId) as EnvironmentId[];
  return primary === undefined ? saved : [primary, ...saved.filter((id) => id !== primary)];
}

/**
 * Keeps a `projectSetups.subscribe` stream open to every connected computer
 * that takes setups, for as long as it stays connected. Started once, with
 * the environment connections.
 */
export function startProjectSetupsSync(): () => void {
  const streams = new Map<EnvironmentId, () => void>();

  const reconcile = () => {
    const wanted = new Set(
      knownComputerIds().filter(
        (environmentId) =>
          readProjectSetupComputerReady(environmentId) &&
          readProjectSetupsClient(environmentId) !== null,
      ),
    );
    for (const [environmentId, stop] of streams) {
      if (wanted.has(environmentId)) continue;
      stop();
      streams.delete(environmentId);
      markStale(environmentId);
    }
    for (const environmentId of wanted) {
      if (streams.has(environmentId)) continue;
      const client = readProjectSetupsClient(environmentId);
      if (client === null) continue;
      streams.set(
        environmentId,
        client.subscribe((snapshot) => putSnapshot(environmentId, snapshot), {
          onResubscribe: () => markStale(environmentId),
        }),
      );
    }
    for (const environmentId of Object.keys(useProjectSetupsStore.getState().byEnvironmentId)) {
      if (!isKnownComputer(environmentId)) forget(environmentId);
    }
  };

  reconcile();
  const unsubscribers = [
    subscribeEnvironmentConnections(reconcile),
    subscribePrimaryEnvironmentDescriptor(reconcile),
    useSavedEnvironmentRuntimeStore.subscribe(reconcile),
    useSavedEnvironmentRegistryStore.subscribe(reconcile),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const stop of streams.values()) stop();
    streams.clear();
  };
}

/** A computer as a setup names it: where to call, and what to call it in a message. */
export interface ProjectSetupComputerRef {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** What went wrong, in the words the server or the transport gave. */
export function describeProjectSetupFailure(error: unknown, fallback: string): string {
  return describeComputerLinkFailure(error, fallback);
}

/** What the source computer says another computer needs to copy its project. */
export function readProjectSetupSource(
  source: ProjectSetupComputerRef,
  projectId: ProjectId,
): Promise<ProjectSetupSource> {
  return requireClient(source.environmentId, source.label).source({ projectId });
}

/** What a folder on the target computer would mean for the setup. */
export function inspectProjectSetupDestination(
  target: ProjectSetupComputerRef,
  input: Parameters<ProjectSetupsClient["inspectDestination"]>[0],
) {
  return requireClient(target.environmentId, target.label).inspectDestination(input);
}

/** Everything a start needs besides the files, as the dialog (or a retry) chose it. */
export interface ProjectSetupPlan {
  readonly source: ProjectSetupComputerRef & { readonly projectId: ProjectId };
  readonly target: ProjectSetupComputerRef;
  readonly sourceInfo: ProjectSetupSource;
  readonly protocol: ProjectSetupProtocol;
  readonly destinationPath: string;
  /** The ignored files to send: read from the source just before the start. */
  readonly filePaths: ReadonlyArray<string>;
  readonly onDone: ProjectSetupOnDone | null;
}

/**
 * Reads the ticked files from the source, then starts the job on the target
 * under `setupId`. The job is this app's from the moment it is asked for, so
 * an end heard before the answer still counts.
 */
export async function startProjectSetup(
  setupId: ProjectSetupId,
  plan: ProjectSetupPlan,
): Promise<ProjectSetupJob> {
  const sourceClient = requireClient(plan.source.environmentId, plan.source.label);
  const targetClient = requireClient(plan.target.environmentId, plan.target.label);
  const files: ReadonlyArray<ProjectSetupFile> =
    plan.filePaths.length === 0
      ? []
      : (await sourceClient.readFiles({ projectId: plan.source.projectId, paths: plan.filePaths }))
          .files;
  // The files leave only over protected connections, checked again now that
  // they are in hand: a connection may have changed while they were read.
  if (files.length > 0 && !projectSetupFilesAllowed(plan.source, plan.target)) {
    throw new Error(
      `The connection to ${plan.target.label} or ${plan.source.label} isn't encrypted now, so the files weren't sent.`,
    );
  }
  useProjectSetupsStore.setState((state) => ({
    started: {
      ...state.started,
      [setupId]: {
        setupId,
        environmentId: plan.target.environmentId,
        label: plan.target.label,
        onDone: plan.onDone,
        settled: false,
      },
    },
  }));
  const sourceRef: ProjectSetupSourceRef = {
    environmentId: plan.source.environmentId,
    projectId: plan.source.projectId,
    label: plan.source.label,
  };
  const job = await targetClient.start({
    setupId,
    source: sourceRef,
    title: plan.sourceInfo.title,
    repositoryKey: plan.sourceInfo.repositoryKey,
    subdirectory: plan.sourceInfo.subdirectory,
    remotes: plan.sourceInfo.remotes,
    primaryRemoteName: plan.sourceInfo.primaryRemoteName,
    protocol: plan.protocol,
    scripts: plan.sourceInfo.scripts,
    destinationPath: plan.destinationPath,
    files,
    ...(plan.sourceInfo.sizeBytes !== undefined
      ? { expectedBytes: plan.sourceInfo.sizeBytes }
      : {}),
  });
  upsertJob(plan.target.environmentId, job);
  return job;
}

/** Whether files may go from `source`'s project to `target`: both connections protected now. */
function projectSetupFilesAllowed(
  source: ProjectSetupComputerRef & { readonly projectId: ProjectId },
  target: ProjectSetupComputerRef,
): boolean {
  return (
    readProjectSetupTargets({
      environmentId: source.environmentId,
      projectId: source.projectId,
    }).find((candidate) => candidate.environmentId === target.environmentId)?.unprotected === null
  );
}

/**
 * The `onDone` a setup this app started carries, for a retry to pass on: a
 * new job for the same purpose finishes what the first one was for.
 */
function startedOnDone(setupId: ProjectSetupId): ProjectSetupOnDone | null {
  return useProjectSetupsStore.getState().started[setupId]?.onDone ?? null;
}

/** Whether a retry of `job` can run now: its source computer is connected and takes setups. */
export function canRetryProjectSetup(job: ProjectSetupJob): boolean {
  return readProjectSetupComputerReady(job.source.environmentId);
}

/**
 * Starts a failed or cancelled job again as a new one: what to clone and the
 * ticked files read fresh from the source, the same folder and protocol,
 * then the old job dismissed. Answers the new job's id.
 */
export async function retryProjectSetup(
  job: ProjectSetupJob,
  target: ProjectSetupComputerRef,
): Promise<ProjectSetupId> {
  const sourceInfo = await readProjectSetupSource(job.source, job.source.projectId);
  // Files that are gone from the source, or grew too large, stay behind.
  const sendable = new Set(
    sourceInfo.files.filter((file) => !file.tooLarge).map((file) => file.path),
  );
  // Files travel only where both connections are protected, now as at the start.
  const filesAllowed = projectSetupFilesAllowed(job.source, target);
  const setupId = newProjectSetupId();
  // A retry of the job on screen is on screen too: its end raises no toast.
  const shown = useProjectSetupsStore.getState().shownSetupId === job.setupId;
  if (shown) setShownProjectSetup(setupId);
  try {
    await startProjectSetup(setupId, {
      source: job.source,
      target,
      sourceInfo,
      protocol: job.protocol,
      destinationPath: job.destinationPath,
      filePaths: filesAllowed ? job.filePaths.filter((path) => sendable.has(path)) : [],
      onDone: startedOnDone(job.setupId),
    });
  } catch (error) {
    if (shown) setShownProjectSetup(job.setupId);
    throw error;
  }
  void dismissProjectSetup(target, job.setupId).catch(() => undefined);
  return setupId;
}

/** Calls off an unfinished job on its computer. */
export async function cancelProjectSetup(
  target: ProjectSetupComputerRef,
  setupId: ProjectSetupId,
): Promise<void> {
  await requireClient(target.environmentId, target.label).cancel({ setupId });
}

/** Forgets a finished job on its computer. */
export async function dismissProjectSetup(
  target: ProjectSetupComputerRef,
  setupId: ProjectSetupId,
): Promise<void> {
  await requireClient(target.environmentId, target.label).dismiss({ setupId });
  removeJob(target.environmentId, setupId);
}

const PROJECT_ARRIVAL_TIMEOUT_MS = 15_000;

/**
 * Waits for a project a setup made to reach this app's view of its computer
 * (the shell stream says so a moment after the job does). True once it is
 * there; false if it hasn't come in time.
 */
export function waitForSetUpProject(ref: ScopedProjectRef): Promise<boolean> {
  if (selectProjectByRef(useStore.getState(), ref) !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, PROJECT_ARRIVAL_TIMEOUT_MS);
    const unsubscribe = useStore.subscribe((state) => {
      if (selectProjectByRef(state, ref) === undefined) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}
