/**
 * What the thread list needs to know about computers working together
 * (docs/design/fleet.md, Part 2 "Ask first" and Part 5): what to call each
 * computer, and the threads other computers asked to start that wait for the
 * user's Allow.
 */
import type { ComputerLinkPendingRequest, EnvironmentId } from "@threadlines/contracts";
import { useCallback, useMemo } from "react";

import {
  useComputerLinksStore,
  type ComputerLinksEntry,
} from "../../environments/links/computerLinks";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";

/** Names a computer: `(environmentId, lastKnown) => name`. */
export type ComputerLabelResolver = (environmentId: EnvironmentId, lastKnown: string) => string;

/**
 * Names a computer the way the app knows it: what it calls itself now (this
 * computer's own descriptor, or a saved computer's), else the name it was
 * saved under, else `lastKnown`, the name a link or a parent's record of its
 * child last carried. Never "here": a phone or a browser showing this list
 * isn't a computer.
 */
export function useComputerLabel(): ComputerLabelResolver {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  return useCallback(
    (environmentId, lastKnown) => {
      if (primaryDescriptor?.environmentId === environmentId) return primaryDescriptor.label;
      return (
        runtimeById[environmentId]?.descriptor?.label ??
        savedById[environmentId]?.label ??
        lastKnown
      );
    },
    [primaryDescriptor, runtimeById, savedById],
  );
}

/** A thread another computer asked to start on `environmentId`, waiting for the user. */
export interface PendingLinkRequest {
  /** The computer it would run on, whose Allow it waits for. */
  readonly environmentId: EnvironmentId;
  readonly request: ComputerLinkPendingRequest;
}

/**
 * Every start waiting for the user's Allow, newest first, on the computers
 * this app hears from right now. A computer whose stream is down is left
 * out (Allow and Deny couldn't reach it), and so is a request past its
 * expiry, which that computer drops on its own.
 */
export function listPendingLinkRequests(
  byEnvironmentId: Readonly<Record<string, ComputerLinksEntry>>,
  nowMs: number,
): PendingLinkRequest[] {
  return Object.entries(byEnvironmentId)
    .flatMap(([environmentId, entry]) =>
      entry.live
        ? entry.snapshot.pending
            .filter((request) => Date.parse(request.expiresAt) > nowMs)
            .map((request) => ({ environmentId: environmentId as EnvironmentId, request }))
        : [],
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.request.createdAt) - Date.parse(left.request.createdAt) ||
        left.request.requestId.localeCompare(right.request.requestId),
    );
}

/** A minute is fine-grained enough for a 24-hour expiry. */
const EXPIRY_CLOCK_INTERVAL_MS = 60_000;

/** {@link listPendingLinkRequests}, kept current. */
export function usePendingLinkRequests(): readonly PendingLinkRequest[] {
  const byEnvironmentId = useComputerLinksStore((state) => state.byEnvironmentId);
  const nowMs = useRelativeTimeTick(EXPIRY_CLOCK_INTERVAL_MS);
  return useMemo(() => listPendingLinkRequests(byEnvironmentId, nowMs), [byEnvironmentId, nowMs]);
}
