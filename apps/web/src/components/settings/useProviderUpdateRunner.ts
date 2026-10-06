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
  providerUpdateGroupKey,
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
  // By update group: a driver's instances share one program and one update;
  // a community agent is its own.
  const [startingGroups, setStartingGroups] = useState<ReadonlySet<string>>(() => new Set());
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
    const group = providerUpdateGroupKey(candidate);
    let started = false;
    setStartingGroups((previous) => {
      if (previous.has(group)) return previous;
      started = true;
      return withMember(previous, group);
    });
    if (!started) return;
    // A community agent is updated to the listing the user was shown, named
    // by its digest; the server refuses if the registry has moved on.
    const recipeDigest = candidate.community?.updateCandidate?.recipeDigest;
    try {
      await ensureLocalApi().server.updateProvider({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
        ...(recipeDigest ? { recipeDigest } : {}),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${candidate.community ? (candidate.displayName ?? "the agent") : (PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)}`,
          description:
            error instanceof Error
              ? error.message
              : "The provider update command could not be started.",
        }),
      );
    } finally {
      setStartingGroups((previous) => withoutMember(previous, group));
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
      const group = providerUpdateGroupKey(candidate);
      const isUpdating =
        startingGroups.has(group) ||
        providers.some(
          (provider) =>
            providerUpdateGroupKey(provider) === group && isProviderUpdateActive(provider),
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
                startingGroups.has(group)
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
      startingGroups,
    ],
  );

  return { controlsFor };
}
