import type { GitActionProgressEvent } from "@t3tools/contracts";

import { toastManager, type ThreadToastData } from "~/components/ui/toast";

export type GitActionToastId = ReturnType<typeof toastManager.add>;

export interface ActiveGitActionProgress {
  readonly toastId?: GitActionToastId;
  readonly toastData: ThreadToastData | undefined;
  readonly actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

export interface GitActionProgressView {
  readonly title: string;
  readonly description: string | undefined;
  readonly hookName: string | null;
}

export function createGitActionProgress(input: {
  readonly toastId?: GitActionToastId;
  readonly toastData: ThreadToastData | undefined;
  readonly actionId: string;
  readonly initialTitle: string;
}): ActiveGitActionProgress {
  return {
    ...(input.toastId !== undefined ? { toastId: input.toastId } : {}),
    toastData: input.toastData,
    actionId: input.actionId,
    title: input.initialTitle,
    phaseStartedAtMs: null,
    hookStartedAtMs: null,
    hookName: null,
    lastOutputLine: null,
    currentPhaseLabel: input.initialTitle,
  };
}

export function formatGitActionElapsedDescription(
  startedAtMs: number | null,
  nowMs = Date.now(),
): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

export function resolveGitActionProgressDescription(
  progress: ActiveGitActionProgress,
  nowMs = Date.now(),
): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatGitActionElapsedDescription(
    progress.hookStartedAtMs ?? progress.phaseStartedAtMs,
    nowMs,
  );
}

export function getGitActionProgressView(progress: ActiveGitActionProgress): GitActionProgressView {
  return {
    title: progress.title,
    description: resolveGitActionProgressDescription(progress),
    hookName: progress.hookName,
  };
}

export function updateGitActionProgressToast(progress: ActiveGitActionProgress): void {
  if (progress.toastId === undefined) {
    return;
  }

  toastManager.update(progress.toastId, {
    type: "loading",
    title: progress.title,
    description: resolveGitActionProgressDescription(progress),
    timeout: 0,
    data: progress.toastData,
  });
}

export function applyGitActionProgressEvent(
  progress: ActiveGitActionProgress,
  event: GitActionProgressEvent,
  options: { readonly cwd?: string | null; readonly nowMs?: number } = {},
): boolean {
  if (options.cwd && event.cwd !== options.cwd) {
    return false;
  }
  if (progress.actionId !== event.actionId) {
    return false;
  }

  const now = options.nowMs ?? Date.now();
  switch (event.kind) {
    case "action_started":
      progress.phaseStartedAtMs = now;
      progress.hookStartedAtMs = null;
      progress.hookName = null;
      progress.lastOutputLine = null;
      return true;
    case "phase_started":
      progress.title = event.label;
      progress.currentPhaseLabel = event.label;
      progress.phaseStartedAtMs = now;
      progress.hookStartedAtMs = null;
      progress.hookName = null;
      progress.lastOutputLine = null;
      return true;
    case "hook_started":
      progress.title = `Running ${event.hookName}...`;
      progress.hookName = event.hookName;
      progress.hookStartedAtMs = now;
      progress.lastOutputLine = null;
      return true;
    case "hook_output":
      progress.lastOutputLine = event.text;
      return true;
    case "hook_finished":
      progress.title = progress.currentPhaseLabel ?? "Committing...";
      progress.hookName = null;
      progress.hookStartedAtMs = null;
      progress.lastOutputLine = null;
      return true;
    case "action_finished":
    case "action_failed":
      return false;
  }
}
