/**
 * What the thread list needs to know about computers working together
 * (docs/design/fleet.md, Part 2 "Ask first" and Part 5): what to call each
 * computer, and the threads other computers asked to start that wait for the
 * user's Allow.
 */
import type { ComputerLinkPendingRequest, EnvironmentId } from "@threadlines/contracts";
import { useCallback, useMemo } from "react";
import { create } from "zustand";

import {
  describeComputerLinkFailure,
  respondToComputerLinkRequest,
  useComputerLinksStore,
  type ComputerLinksEntry,
} from "../../environments/links/computerLinks";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { toastManager } from "../ui/toast";

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

/**
 * Answers on their way to the computer a request would run on, by
 * `environmentId:requestId`. One per request across every place that shows
 * it (the inbox row, the card in the thread that asked), so a second click
 * anywhere can't send a second answer. Kept once it lands: the request is
 * done, and leaves when that computer's next snapshot drops it.
 */
const useLinkRequestAnswersStore = create<{
  readonly byKey: Readonly<Record<string, "allow" | "deny">>;
}>(() => ({ byKey: {} }));

const answerKey = (environmentId: EnvironmentId, requestId: string) =>
  `${environmentId}:${requestId}`;

// An answer is forgotten once its request is gone from every computer's list.
useComputerLinksStore.subscribe((state) => {
  const { byKey } = useLinkRequestAnswersStore.getState();
  const keys = Object.keys(byKey);
  if (keys.length === 0) return;
  const pending = new Set(
    Object.entries(state.byEnvironmentId).flatMap(([environmentId, entry]) =>
      entry.snapshot.pending.map((request) =>
        answerKey(environmentId as EnvironmentId, request.requestId),
      ),
    ),
  );
  if (keys.every((key) => pending.has(key))) return;
  useLinkRequestAnswersStore.setState({
    byKey: Object.fromEntries(Object.entries(byKey).filter(([key]) => pending.has(key))),
  });
});

function setLinkRequestAnswer(key: string, answer: "allow" | "deny" | null) {
  useLinkRequestAnswersStore.setState((state) => {
    const { [key]: _previous, ...rest } = state.byKey;
    return { byKey: answer === null ? rest : { ...rest, [key]: answer } };
  });
}

/**
 * Allow and Deny for a request another computer's agent made: the answer
 * already on its way (null when none), and `respond`, which sends one unless
 * an answer is already out and says so when the computer couldn't take it.
 */
export function useLinkRequestAnswer(
  pending: PendingLinkRequest,
  computerLabel: string,
): {
  readonly answering: "allow" | "deny" | null;
  readonly respond: (allow: boolean) => Promise<void>;
} {
  const { environmentId, request } = pending;
  const key = answerKey(environmentId, request.requestId);
  const answering = useLinkRequestAnswersStore((state) => state.byKey[key] ?? null);
  const respond = useCallback(
    async (allow: boolean) => {
      if (useLinkRequestAnswersStore.getState().byKey[key] !== undefined) return;
      setLinkRequestAnswer(key, allow ? "allow" : "deny");
      try {
        await respondToComputerLinkRequest(
          { environmentId, label: computerLabel },
          { deviceId: request.deviceId, requestId: request.requestId, allow },
        );
      } catch (error) {
        setLinkRequestAnswer(key, null);
        toastManager.add({
          type: "error",
          title: allow ? `Couldn't allow ${request.title}` : `Couldn't deny ${request.title}`,
          description: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
        });
      }
    },
    [computerLabel, environmentId, key, request.deviceId, request.requestId, request.title],
  );
  return { answering, respond };
}
