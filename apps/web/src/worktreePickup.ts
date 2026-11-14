/**
 * Picking up worktrees a repository already had, made outside Threadlines:
 * which ones are on offer, what a thread made for one is called, and what
 * this device remembers about the offer (docs/design/worktree-pickup.md).
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type VcsWorktreeStatus,
} from "@threadlines/contracts";
import {
  areFilesystemPathsEqual,
  isFilesystemPathWithin,
  isWindowsAbsolutePath,
  shortenHomePath,
} from "@threadlines/shared/path";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { ensureEnvironmentApi } from "./environmentApi";
import { resolveStorage } from "./lib/storage";
import { newCommandId, newThreadId } from "./lib/utils";

/**
 * The worktrees a thread could be made for: there on disk, not the one the
 * project's own folder is in, and with no thread working in them yet.
 */
export function pickupCandidates(input: {
  readonly worktrees: ReadonlyArray<VcsWorktreeStatus>;
  readonly projectCwd: string;
  /** Where the computer's threads work, saved and drafted alike. */
  readonly threadWorktreePaths: ReadonlyArray<string>;
}): ReadonlyArray<VcsWorktreeStatus> {
  return input.worktrees.filter(
    (worktree) =>
      !worktree.missing &&
      !worktree.isRoot &&
      !worktree.managed &&
      !isFilesystemPathWithin(input.projectCwd, worktree.path) &&
      !input.threadWorktreePaths.some((path) => areFilesystemPathsEqual(path, worktree.path)),
  );
}

/**
 * Nothing in the worktree is waiting to ship: no uncommitted changes, and its
 * branch adds nothing the default branch lacks. The list starts these
 * unticked.
 */
export function isSettledWorktree(worktree: VcsWorktreeStatus): boolean {
  return !worktree.dirty && (worktree.mergedByContent || worktree.unmergedCommitCount === 0);
}

/**
 * Where a worktree is, as a row says it: beside the project it reads
 * "../shop-checkout-retry", which is what tells two apart; anywhere else it
 * is the whole path, with the home folder as "~".
 */
export function worktreePathLabel(worktreePath: string, projectCwd: string): string {
  const parts = (value: string) => value.split(/[\\/]+/).filter((part) => part.length > 0);
  const worktree = parts(worktreePath);
  const project = parts(projectCwd);
  const same = isWindowsAbsolutePath(worktreePath)
    ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
    : (left: string, right: string) => left === right;
  let shared = 0;
  while (
    shared < worktree.length &&
    shared < project.length &&
    same(worktree[shared]!, project[shared]!)
  ) {
    shared += 1;
  }
  const up = project.length - shared;
  const down = worktree.slice(shared);
  // Beside the project or a little way into it; farther off reads better whole.
  if (shared === 0 || up > 1 || down.length === 0 || down.length > 3) {
    return shortenHomePath(worktreePath);
  }
  return [...Array.from({ length: up }, () => ".."), ...down].join("/");
}

function lastPathSegment(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? value;
}

function sentenceFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words.length === 0 ? "" : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * A thread's title from the branch its worktree is on: "fix/checkout-retry"
 * reads "Checkout retry". A last part that says nothing alone (a version, a
 * number) keeps the parts before it; a detached worktree is named for its
 * folder.
 */
export function threadTitleFromWorktree(worktree: Pick<VcsWorktreeStatus, "refName" | "path">) {
  if (worktree.refName === null) {
    return sentenceFromSlug(lastPathSegment(worktree.path)) || "Worktree";
  }
  const lastPart = lastPathSegment(worktree.refName);
  const title = /[a-z]/i.test(lastPart)
    ? sentenceFromSlug(lastPart)
    : sentenceFromSlug(worktree.refName.replace(/[\\/]+/g, " "));
  return title || worktree.refName;
}

/**
 * Makes a thread for each worktree, a guest there (ThreadWorktreeOrigin
 * `existing`), named for its branch. No turn starts: each waits in the
 * sidebar for its first message. One that fails stops the rest, so the error
 * names what is still to add.
 */
export async function addWorktreeThreads(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktrees: ReadonlyArray<VcsWorktreeStatus>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}): Promise<void> {
  const api = ensureEnvironmentApi(input.environmentId);
  for (const worktree of input.worktrees) {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId: newThreadId(),
      projectId: input.projectId,
      title: threadTitleFromWorktree(worktree),
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: worktree.refName,
      worktreePath: worktree.path,
      worktreeOrigin: { kind: "existing" },
      createdAt: new Date().toISOString(),
    });
  }
}

interface WorktreePickupState {
  /**
   * Projects whose worktrees are laid out for picking: set when a repository
   * is added or the user asks for the list, cleared by an answer either way.
   */
  readonly offeredProjectKeys: Readonly<Record<string, true>>;
  /** Projects whose worktree count the user hid from the new-thread screen. */
  readonly hiddenProjectKeys: Readonly<Record<string, true>>;
  /** Lays the list out again, and brings a hidden count back with it. */
  readonly offer: (projectKey: string) => void;
  readonly closeOffer: (projectKey: string) => void;
  readonly hide: (projectKey: string) => void;
}

function without(keys: Readonly<Record<string, true>>, key: string) {
  if (!(key in keys)) return keys;
  const { [key]: _removed, ...rest } = keys;
  return rest;
}

/** Per device, like the rest of how a screen is arranged. */
export const useWorktreePickupStore = create<WorktreePickupState>()(
  persist(
    (set) => ({
      offeredProjectKeys: {},
      hiddenProjectKeys: {},
      offer: (projectKey) =>
        set((state) => ({
          offeredProjectKeys: { ...state.offeredProjectKeys, [projectKey]: true },
          hiddenProjectKeys: without(state.hiddenProjectKeys, projectKey),
        })),
      closeOffer: (projectKey) =>
        set((state) => ({ offeredProjectKeys: without(state.offeredProjectKeys, projectKey) })),
      hide: (projectKey) =>
        set((state) => ({
          offeredProjectKeys: without(state.offeredProjectKeys, projectKey),
          hiddenProjectKeys: { ...state.hiddenProjectKeys, [projectKey]: true },
        })),
    }),
    {
      name: "threadlines:worktree-pickup:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        offeredProjectKeys: state.offeredProjectKeys,
        hiddenProjectKeys: state.hiddenProjectKeys,
      }),
    },
  ),
);
