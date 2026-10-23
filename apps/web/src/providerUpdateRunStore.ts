/**
 * The agent update run in progress on the computer whose agents this window
 * shows, shared by everything that starts updates (the launch notice,
 * Settings, setup) and the progress notice that reports on them.
 *
 * `ProviderUpdateProgress` keeps it in step with the server; callers that ask
 * for an update say so first with `trackProviderUpdates`, so a run they start
 * is followed even if it finishes between two server snapshots.
 *
 * @module providerUpdateRunStore
 */
import type { ServerProvider } from "@threadlines/contracts";
import { create } from "zustand";

import {
  advanceProviderUpdateRun,
  failProviderUpdateRunStart,
  joinProviderUpdateRun,
  type ProviderUpdateRun,
} from "./components/ProviderUpdateLaunchNotification.logic";
import { getServerConfig } from "./rpc/serverState";
import { describeUnknownError, isRetryableRequestFailure } from "./rpc/transportError";

interface ProviderUpdateRunState {
  readonly run: ProviderUpdateRun | null;
  /** A notice already on screen (the launch prompt) for the run's progress to take over. */
  readonly adoptNoticeId: string | null;
}

export const useProviderUpdateRunStore = create<ProviderUpdateRunState>(() => ({
  run: null,
  adoptNoticeId: null,
}));

/** Brings the run up to date with a provider snapshot from `environmentId`, and returns it. */
export function syncProviderUpdateRun(
  environmentId: string,
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateRun | null {
  const { run } = useProviderUpdateRunStore.getState();
  const next = advanceProviderUpdateRun(run, environmentId, providers);
  if (next !== run) useProviderUpdateRunStore.setState({ run: next });
  return next;
}

/** What a caller that started updates reports back with. */
export interface ProviderUpdateTracking {
  /** The request for `key` failed; `error` says whether it surely never arrived. */
  readonly reportStartFailure: (key: string, error: unknown) => void;
}

/**
 * Call just before asking the server to update agents (by update group key).
 * `noticeId` hands over a notice already on screen to show the progress.
 */
export function trackProviderUpdates(
  keys: ReadonlyArray<string>,
  options?: { readonly noticeId?: string },
): ProviderUpdateTracking {
  const config = getServerConfig();
  if (!config) return { reportStartFailure: () => undefined };
  const environmentId = config.environment.environmentId;
  const run = joinProviderUpdateRun(
    useProviderUpdateRunStore.getState().run,
    environmentId,
    config.providers,
    keys,
  );
  useProviderUpdateRunStore.setState(({ adoptNoticeId }) => ({
    run,
    adoptNoticeId: options?.noticeId ?? adoptNoticeId,
  }));
  const attempts = new Map(run.members.map((member) => [member.key, member.attempt]));
  return {
    reportStartFailure: (key, error) => {
      const attempt = attempts.get(key);
      if (attempt === undefined) return;
      const message = describeUnknownError(error) || "The update couldn't start.";
      useProviderUpdateRunStore.setState((state) => ({
        run: failProviderUpdateRunStart(state.run, {
          environmentId,
          key,
          attempt,
          message,
          // A dropped connection or a timeout says nothing about whether the
          // server got the request; only a rejection does.
          uncertain: isRetryableRequestFailure(error),
        }),
      }));
    },
  };
}

/** Takes the notice handed over for the run's progress, if there is one. */
export function takeProviderUpdateNotice(): string | null {
  const { adoptNoticeId } = useProviderUpdateRunStore.getState();
  if (adoptNoticeId !== null) useProviderUpdateRunStore.setState({ adoptNoticeId: null });
  return adoptNoticeId;
}

/** Ends the run once its result has been shown. */
export function endProviderUpdateRun(): void {
  useProviderUpdateRunStore.setState({ run: null, adoptNoticeId: null });
}
