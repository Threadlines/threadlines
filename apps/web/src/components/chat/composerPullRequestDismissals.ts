/**
 * Which pull request rows the user has closed off the composer this session.
 *
 * A dismissal names one pull request in one thread, so the row comes back the
 * moment the thread is working a different pull request. It is not persisted:
 * the row is standing context, and a restart bringing it back is the way back
 * in for someone who closed it by mistake.
 *
 * @module composerPullRequestDismissals
 */
import { create } from "zustand";

const useComposerPullRequestDismissalStore = create<{
  readonly dismissed: ReadonlySet<string>;
  readonly dismiss: (key: string) => void;
}>((set) => ({
  dismissed: new Set(),
  dismiss: (key) =>
    set((current) =>
      current.dismissed.has(key) ? current : { dismissed: new Set(current.dismissed).add(key) },
    ),
}));

/** One pull request in one thread. */
export function composerPullRequestDismissalKey(input: {
  readonly threadKey: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${input.threadKey}|${input.repository.toLowerCase()}#${input.number}`;
}

/** Every row closed so far, for a thread that has more than one to filter. */
export function useDismissedComposerPullRequests(): ReadonlySet<string> {
  return useComposerPullRequestDismissalStore((store) => store.dismissed);
}

export function dismissComposerPullRequest(key: string): void {
  useComposerPullRequestDismissalStore.getState().dismiss(key);
}

export function __resetComposerPullRequestDismissalsForTests(): void {
  useComposerPullRequestDismissalStore.setState({ dismissed: new Set() });
}
