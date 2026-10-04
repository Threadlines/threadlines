/**
 * One-click provider updates, for every surface that offers Update next to an
 * agent: the Providers settings page and the setup screen.
 *
 * Starting an update is one RPC; progress then arrives on the provider
 * snapshot's `updateState`, so this hook only tracks the gap between the click
 * and the server's first word, plus the Windows "Claude is still running"
 * recovery that stops the processes holding the binary.
 *
 * @module useProviderUpdateRunner
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { useCallback, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

function withMember<T>(set: ReadonlySet<T>, member: T): ReadonlySet<T> {
  return set.has(member) ? set : new Set(set).add(member);
}

function withoutMember<T>(set: ReadonlySet<T>, member: T): ReadonlySet<T> {
  if (!set.has(member)) return set;
  const next = new Set(set);
  next.delete(member);
  return next;
}

/** What one agent row needs to draw and run its Update control. */
export interface ProviderUpdateControls {
  /** Present when the server reports a newer version for this instance. */
  readonly candidate: ProviderUpdateCandidate | undefined;
  /** True when Threadlines can run the update itself (otherwise: copy the command). */
  readonly oneClick: boolean;
  readonly isUpdating: boolean;
  readonly isResolvingBlockers: boolean;
  readonly runUpdate: (() => void) | undefined;
  readonly resolveBlockers: (() => void) | undefined;
}

export interface ProviderUpdateRunner {
  readonly controlsFor: (liveProvider: ServerProvider | undefined) => ProviderUpdateControls;
}

export function useProviderUpdateRunner(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateRunner {
  const [startingDrivers, setStartingDrivers] = useState<ReadonlySet<ProviderDriverKind>>(
    () => new Set(),
  );
  const [resolvingInstances, setResolvingInstances] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );

  const candidateByInstanceId = useMemo(
    () =>
      new Map(
        collectProviderUpdateCandidates(providers).map((candidate) => [
          candidate.instanceId,
          candidate,
        ]),
      ),
    [providers],
  );

  const runUpdate = useCallback(async (candidate: ProviderUpdateCandidate) => {
    let started = false;
    setStartingDrivers((previous) => {
      if (previous.has(candidate.driver)) return previous;
      started = true;
      return withMember(previous, candidate.driver);
    });
    if (!started) return;
    try {
      await ensureLocalApi().server.updateProvider({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
          description:
            error instanceof Error
              ? error.message
              : "The provider update command could not be started.",
        }),
      );
    } finally {
      setStartingDrivers((previous) => withoutMember(previous, candidate.driver));
    }
  }, []);

  const resolveBlockers = useCallback(async (candidate: ProviderUpdateCandidate) => {
    let started = false;
    setResolvingInstances((previous) => {
      if (previous.has(candidate.instanceId)) return previous;
      started = true;
      return withMember(previous, candidate.instanceId);
    });
    if (!started) return;
    try {
      const result = await ensureLocalApi().server.resolveProviderUpdateBlockers({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
      });
      toastManager.add({
        type: result.remainingProcessCount > 0 ? "warning" : "success",
        title:
          result.remainingProcessCount > 0 ? "Claude is still running" : "Claude processes stopped",
        description: result.message,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop Claude processes",
          description:
            error instanceof Error
              ? error.message
              : "Threadlines could not stop the processes blocking this update.",
        }),
      );
    } finally {
      setResolvingInstances((previous) => withoutMember(previous, candidate.instanceId));
    }
  }, []);

  const controlsFor = useCallback(
    (liveProvider: ServerProvider | undefined): ProviderUpdateControls => {
      const candidate = liveProvider
        ? candidateByInstanceId.get(liveProvider.instanceId)
        : undefined;
      if (!candidate) {
        return {
          candidate: undefined,
          oneClick: false,
          isUpdating: false,
          isResolvingBlockers: false,
          runUpdate: undefined,
          resolveBlockers: undefined,
        };
      }
      const oneClick = hasOneClickUpdateProviderCandidate(candidate, providers);
      const isUpdating =
        startingDrivers.has(candidate.driver) ||
        providers.some(
          (provider) => provider.driver === candidate.driver && isProviderUpdateActive(provider),
        );
      const isResolvingBlockers = resolvingInstances.has(candidate.instanceId);
      return {
        candidate,
        oneClick,
        isUpdating,
        isResolvingBlockers,
        runUpdate: oneClick
          ? () => {
              if (
                !canOneClickUpdateProviderCandidate(candidate, providers) ||
                startingDrivers.has(candidate.driver)
              ) {
                return;
              }
              void runUpdate(candidate);
            }
          : undefined,
        resolveBlockers: oneClick
          ? () => {
              if (isResolvingBlockers) return;
              void resolveBlockers(candidate);
            }
          : undefined,
      };
    },
    [
      candidateByInstanceId,
      providers,
      resolveBlockers,
      resolvingInstances,
      runUpdate,
      startingDrivers,
    ],
  );

  return { controlsFor };
}
