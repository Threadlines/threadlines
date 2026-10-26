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
import { failureNotice, toastManager } from "../ui/toast";

/** Names a computer: `(environmentId, lastKnown) => name`. */
export type ComputerLabelResolver = (environmentId: EnvironmentId, lastKnown: string) => string;

/**
 * Names a computer the way the app knows it, newest first: what it calls
 * itself now (this computer's own descriptor, or a connected computer's),
 * else what a connected computer's live link to it says (it said so when it
 * last called, so this follows a rename while this app can't reach it), else
 * the name this app last had for it (its last descriptor, its saved record, a
 * link only remembered), else `lastKnown`, the name a parent's record of its
 * child last carried. Never "here": a phone or a browser showing this list
 * isn't a computer.
 */
export function useComputerLabel(): ComputerLabelResolver {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const linksByEnvironmentId = useComputerLinksStore((state) => state.byEnvironmentId);
  const linked = useMemo(() => linkedComputerLabels(linksByEnvironmentId), [linksByEnvironmentId]);
  return useCallback(
    (environmentId, lastKnown) => {
      if (primaryDescriptor?.environmentId === environmentId) return primaryDescriptor.label;
      const runtime = runtimeById[environmentId];
      if (runtime?.connectionState === "connected" && runtime.descriptor) {
        return runtime.descriptor.label;
      }
      return (
        linked.live.get(environmentId) ??
        runtime?.descriptor?.label ??
        savedById[environmentId]?.label ??
        linked.remembered.get(environmentId) ??
        lastKnown
      );
    },
    [primaryDescriptor, runtimeById, savedById, linked],
  );
}

/**
 * What connected computers' links call each computer they link with: from
 * links whose computer is connected now (`live`), and from the snapshots kept
 * after a computer went away (`remembered`). Both halves a computer holds for
 * another carry the same name: the one that computer gave itself.
 */
function linkedComputerLabels(byEnvironmentId: Readonly<Record<string, ComputerLinksEntry>>): {
  readonly live: ReadonlyMap<string, string>;
  readonly remembered: ReadonlyMap<string, string>;
} {
  const live = new Map<string, string>();
  const remembered = new Map<string, string>();
  for (const entry of Object.values(byEnvironmentId)) {
    const labels = entry.live ? live : remembered;
    // A link being removed, or removed, keeps whatever name it last had.
    for (const link of entry.snapshot.outbound) {
      if (link.state === "active" || link.state === "failed") {
        labels.set(link.remoteEnvironmentId, link.remoteLabel);
      }
    }
    // An unconfirmed inbound link could claim another computer's id.
    for (const link of entry.snapshot.inbound) {
      if (link.environmentId !== null && link.environmentPinned === true) {
        labels.set(link.environmentId, link.label);
      }
    }
  }
  return { live, remembered };
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

/** One answer sent for a request; `attempt` tells it from a later one. */
interface LinkRequestAnswer {
  readonly answer: "allow" | "deny";
  readonly attempt: number;
  /** The computer took it. Until then it is on its way. */
  readonly landed: boolean;
}

/**
 * Answers sent to the computer a request would run on, by
 * `environmentId:requestId`. One per request across every place that shows
 * it (the inbox row, the card in the thread that asked), so a second click
 * anywhere can't send a second answer. An answer on its way stays whatever
 * the snapshots say; one that landed stays until its request is gone from
 * every computer's list, and is forgotten then.
 */
const useLinkRequestAnswersStore = create<{
  readonly byKey: Readonly<Record<string, LinkRequestAnswer>>;
}>(() => ({ byKey: {} }));

let nextAnswerAttempt = 0;

const answerKey = (environmentId: EnvironmentId, requestId: string) =>
  `${environmentId}:${requestId}`;

useComputerLinksStore.subscribe((state) => {
  const { byKey } = useLinkRequestAnswersStore.getState();
  const landed = Object.entries(byKey).filter(([, entry]) => entry.landed);
  if (landed.length === 0) return;
  const pending = new Set(
    Object.entries(state.byEnvironmentId).flatMap(([environmentId, entry]) =>
      entry.snapshot.pending.map((request) =>
        answerKey(environmentId as EnvironmentId, request.requestId),
      ),
    ),
  );
  const gone = landed.filter(([key]) => !pending.has(key)).map(([key]) => key);
  if (gone.length === 0) return;
  useLinkRequestAnswersStore.setState({
    byKey: Object.fromEntries(Object.entries(byKey).filter(([key]) => !gone.includes(key))),
  });
});

/** Changes the answer for `key` only while it is still `attempt`'s. */
function updateLinkRequestAnswer(
  key: string,
  attempt: number,
  next: (entry: LinkRequestAnswer) => LinkRequestAnswer | null,
) {
  useLinkRequestAnswersStore.setState((state) => {
    const entry = state.byKey[key];
    if (entry?.attempt !== attempt) return state;
    const { [key]: _previous, ...rest } = state.byKey;
    const updated = next(entry);
    return { byKey: updated === null ? rest : { ...rest, [key]: updated } };
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
  const answering = useLinkRequestAnswersStore((state) => state.byKey[key]?.answer ?? null);
  const respond = useCallback(
    async (allow: boolean) => {
      if (useLinkRequestAnswersStore.getState().byKey[key] !== undefined) return;
      const attempt = ++nextAnswerAttempt;
      useLinkRequestAnswersStore.setState((state) => ({
        byKey: {
          ...state.byKey,
          [key]: { answer: allow ? "allow" : "deny", attempt, landed: false },
        },
      }));
      try {
        await respondToComputerLinkRequest(
          { environmentId, label: computerLabel },
          { deviceId: request.deviceId, requestId: request.requestId, allow },
        );
        updateLinkRequestAnswer(key, attempt, (entry) => ({ ...entry, landed: true }));
      } catch (error) {
        updateLinkRequestAnswer(key, attempt, () => null);
        toastManager.add(
          failureNotice({
            title: allow ? `Couldn't allow ${request.title}` : `Couldn't deny ${request.title}`,
            reason: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
          }),
        );
      }
    },
    [computerLabel, environmentId, key, request.deviceId, request.requestId, request.title],
  );
  return { answering, respond };
}
