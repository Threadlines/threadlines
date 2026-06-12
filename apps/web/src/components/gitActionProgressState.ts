import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitActionProgressEvent } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  applyGitActionProgressEvent,
  createGitActionProgress,
  getGitActionProgressView,
  type ActiveGitActionProgress,
  type GitActionProgressView,
} from "./gitActionProgressToast";

interface GitActionProgressTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

// Progress for in-flight stacked git actions lives at module level, keyed by
// environment + cwd, so panel hosts can unmount (diff viewer, route swaps)
// while the action runs and still show the live progress when they remount.
const activeGitActionProgressByKey = new Map<string, ActiveGitActionProgress>();
const knownGitActionProgressKeys = new Set<string>();
let progressTickerId: ReturnType<typeof setInterval> | null = null;

const GIT_ACTION_PROGRESS_TICK_MS = 1_000;

const EMPTY_GIT_ACTION_PROGRESS_VIEW_ATOM = Atom.make<GitActionProgressView | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-action-progress:null"),
);

const gitActionProgressViewAtom = Atom.family((key: string) => {
  knownGitActionProgressKeys.add(key);
  return Atom.make<GitActionProgressView | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-action-progress:${key}`),
  );
});

function getGitActionProgressTargetKey(target: GitActionProgressTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

function publishGitActionProgressView(key: string): void {
  const progress = activeGitActionProgressByKey.get(key);
  const next = progress ? getGitActionProgressView(progress) : null;
  const atom = gitActionProgressViewAtom(key);
  const current = appAtomRegistry.get(atom);
  if (
    current === next ||
    (current !== null &&
      next !== null &&
      current.title === next.title &&
      current.description === next.description &&
      current.hookName === next.hookName)
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}

// Elapsed-time descriptions ("Running for 12s") need a clock even when no
// progress events arrive; tick only while an action is active.
function syncGitActionProgressTicker(): void {
  if (activeGitActionProgressByKey.size > 0) {
    progressTickerId ??= setInterval(() => {
      for (const key of activeGitActionProgressByKey.keys()) {
        publishGitActionProgressView(key);
      }
    }, GIT_ACTION_PROGRESS_TICK_MS);
    return;
  }

  if (progressTickerId !== null) {
    clearInterval(progressTickerId);
    progressTickerId = null;
  }
}

export function startGitActionProgress(
  target: GitActionProgressTarget,
  input: { readonly actionId: string; readonly initialTitle: string },
): void {
  const key = getGitActionProgressTargetKey(target);
  if (key === null) {
    return;
  }

  activeGitActionProgressByKey.set(
    key,
    createGitActionProgress({
      toastData: undefined,
      actionId: input.actionId,
      initialTitle: input.initialTitle,
    }),
  );
  publishGitActionProgressView(key);
  syncGitActionProgressTicker();
}

export function dispatchGitActionProgressEvent(
  target: GitActionProgressTarget,
  event: GitActionProgressEvent,
): void {
  const key = getGitActionProgressTargetKey(target);
  if (key === null) {
    return;
  }

  const progress = activeGitActionProgressByKey.get(key);
  if (!progress) {
    return;
  }

  if (applyGitActionProgressEvent(progress, event, { cwd: target.cwd })) {
    publishGitActionProgressView(key);
  }
}

export function finishGitActionProgress(target: GitActionProgressTarget, actionId: string): void {
  const key = getGitActionProgressTargetKey(target);
  if (key === null) {
    return;
  }

  const progress = activeGitActionProgressByKey.get(key);
  if (!progress || progress.actionId !== actionId) {
    return;
  }

  activeGitActionProgressByKey.delete(key);
  publishGitActionProgressView(key);
  syncGitActionProgressTicker();
}

export function getGitActionProgressViewSnapshot(
  target: GitActionProgressTarget,
): GitActionProgressView | null {
  const key = getGitActionProgressTargetKey(target);
  if (key === null) {
    return null;
  }

  return appAtomRegistry.get(gitActionProgressViewAtom(key));
}

export function useGitActionProgressView(
  target: GitActionProgressTarget,
): GitActionProgressView | null {
  const key = getGitActionProgressTargetKey(target);
  const view = useAtomValue(
    key !== null ? gitActionProgressViewAtom(key) : EMPTY_GIT_ACTION_PROGRESS_VIEW_ATOM,
  );
  return key === null ? null : view;
}

export function resetGitActionProgressStateForTests(): void {
  activeGitActionProgressByKey.clear();
  syncGitActionProgressTicker();

  for (const key of knownGitActionProgressKeys) {
    appAtomRegistry.set(gitActionProgressViewAtom(key), null);
  }
  knownGitActionProgressKeys.clear();
}
