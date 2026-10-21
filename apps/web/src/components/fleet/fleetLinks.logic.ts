/**
 * Fleet's computers and the links between them (docs/design/fleet.md, Rev 4).
 * Pure: the page's hook gathers each connected computer's links snapshot and
 * this decides who is in the list of computers, what each pair of computers
 * says about each direction, what an unlink has to do and where, and which
 * lines the graph draws between computers.
 *
 * A link A → B ("A's agents can start work on B") has two halves: A's own
 * link to B (outbound, on A) and B's setting for it (inbound, on B: access
 * and the most access its threads get). Each half lives on its own computer,
 * so each is read from, and changed through, that computer's snapshot.
 */
import type {
  ComputerLinkAccess,
  ComputerLinkPendingRequest,
  ComputerLinksSnapshot,
  EnvironmentId,
  InboundComputerLink,
  LinksRemoveInput,
  OutboundComputerLink,
} from "@threadlines/contracts";

import type { FleetLineState, FleetModel } from "./fleet.logic";
import { lineWork, resolveConnectionLineState } from "./fleet.logic";

/** One computer's links, as last heard from it. */
export interface FleetLinksEntry {
  readonly snapshot: ComputerLinksSnapshot;
  /** Current; false keeps the last one the app saw while the computer is away. */
  readonly live: boolean;
}

export type FleetLinksByEnvironment = Readonly<Record<string, FleetLinksEntry>>;

/** What a link's access is called wherever the user sees or sets it. */
export const COMPUTER_LINK_ACCESS_LABELS: Record<ComputerLinkAccess, string> = {
  allowed: "Allowed",
  ask: "Ask first",
  off: "Off",
};

// ── The list of computers (R4.1) ────────────────────────────────────

/** Key prefix of a linked computer known only by its device on the computer it linked to. */
export const FLEET_DEVICE_KEY_PREFIX = "device:";

/**
 * Who a list row is: this computer, a computer this app connects to
 * (`saved`), a computer only known through a link (`linked`), or a link
 * known only by its device (keyed by it): one whose computer hasn't said who
 * it is yet (`waiting`), or one whose computer can't be confirmed
 * (`unconfirmed`, see confirmedInboundEnvironment).
 */
export type FleetEntryKind = "this" | "saved" | "linked" | "waiting" | "unconfirmed";

/**
 * The computer an inbound link on `holder` is for, when that is confirmed:
 * its id was pinned by the invite made for it, or that computer vouches for
 * it (its own link to `holder`, as this app hears from it, reports this very
 * device). Only then is the link treated as that computer's (merged with a
 * saved computer, listed in their pair, drawn to it). Any other link stands
 * on its own, under its device: what a computer says about itself could name
 * any other.
 */
export function confirmedInboundEnvironment(
  link: InboundComputerLink,
  holder: string,
  links: FleetLinksByEnvironment,
): EnvironmentId | null {
  if (link.environmentId === null) return null;
  if (link.environmentPinned === true) return link.environmentId;
  const vouched = (links[link.environmentId]?.snapshot.outbound ?? []).some(
    (outbound) =>
      outbound.remoteEnvironmentId === holder && outbound.remoteDeviceId === link.deviceId,
  );
  return vouched ? link.environmentId : null;
}

/**
 * The computer that asked for a thread another computer (`worker`) started,
 * when that can be trusted: the thread says its link was made for that
 * computer, or the link it came over is still listed there and confirmed.
 * Otherwise (a link that only said who it is, or one gone since) nobody.
 */
export function trustedOriginEnvironment(
  origin: {
    readonly linkDeviceId: string;
    readonly environmentId: EnvironmentId;
    readonly environmentPinned?: boolean | undefined;
  },
  worker: string,
  links: FleetLinksByEnvironment,
): EnvironmentId | null {
  if (origin.environmentPinned === true) return origin.environmentId;
  const link = links[worker]?.snapshot.inbound.find(
    (candidate) => candidate.deviceId === origin.linkDeviceId,
  );
  return link === undefined ? null : confirmedInboundEnvironment(link, worker, links);
}

/** What a list row known only by its device says where its computer is. */
export const FLEET_DEVICE_ENTRY_STATUS = {
  waiting: "Waiting to hear from it",
  unconfirmed: "Not confirmed",
} as const;

/** A link known only by its device: its computer is new or can't be confirmed. */
export function isFleetDeviceEntry(
  entry: Pick<FleetDirectoryEntry, "kind">,
): entry is FleetDirectoryEntry & { readonly kind: "waiting" | "unconfirmed" } {
  return entry.kind === "waiting" || entry.kind === "unconfirmed";
}

export interface FleetDirectoryEntry {
  /** The environment id, or `device:<deviceId>` for an entry known by its device. */
  readonly key: string;
  readonly kind: FleetEntryKind;
  readonly environmentId: EnvironmentId | null;
  /** Device entries: its device on `holderEnvironmentId` (the computer it linked to). */
  readonly deviceId: string | null;
  readonly holderEnvironmentId: EnvironmentId | null;
  readonly label: string;
  /** Linked entries: a computer it is linked with, for "Linked with Mac". */
  readonly linkedWith: string | null;
}

interface NamedComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function compareByLabel(left: { readonly label: string }, right: { readonly label: string }) {
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

/**
 * Every computer in the fleet, this one first and the rest by name: this
 * computer (when the app has its own server), every saved computer, and
 * every computer any of them is linked with that this app doesn't save. A
 * saved computer and a link to it are one entry under its saved name. An
 * inbound link whose computer isn't confirmed stands as its own entry: one
 * that hasn't introduced itself yet folds into its computer's once it does
 * (its id was pinned when it was made); one made without that never does.
 */
export function buildFleetDirectory(input: {
  readonly primary: NamedComputer | null;
  readonly saved: ReadonlyArray<NamedComputer>;
  readonly links: FleetLinksByEnvironment;
}): FleetDirectoryEntry[] {
  const byKey = new Map<string, FleetDirectoryEntry>();
  const labelOf = new Map<string, string>();
  if (input.primary) labelOf.set(input.primary.environmentId, input.primary.label);
  for (const computer of input.saved) labelOf.set(computer.environmentId, computer.label);

  for (const computer of input.saved) {
    if (computer.environmentId === input.primary?.environmentId) continue;
    byKey.set(computer.environmentId, {
      key: computer.environmentId,
      kind: "saved",
      environmentId: computer.environmentId,
      deviceId: null,
      holderEnvironmentId: null,
      label: computer.label,
      linkedWith: null,
    });
  }

  const holders = Object.entries(input.links).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const linkedLabel = (environmentId: EnvironmentId, label: string, holder: string) => {
    const existing = byKey.get(environmentId);
    if (existing !== undefined || environmentId === input.primary?.environmentId) return;
    byKey.set(environmentId, {
      key: environmentId,
      kind: "linked",
      environmentId,
      deviceId: null,
      holderEnvironmentId: null,
      label,
      linkedWith: labelOf.get(holder) ?? null,
    });
  };
  // Outbound names first: a computer's own report of its name.
  for (const [holder, entry] of holders) {
    for (const link of entry.snapshot.outbound) {
      if (link.remoteEnvironmentId === holder) continue;
      linkedLabel(link.remoteEnvironmentId, link.remoteLabel, holder);
    }
  }
  for (const [holder, entry] of holders) {
    for (const link of entry.snapshot.inbound) {
      const confirmed = confirmedInboundEnvironment(link, holder, input.links);
      if (confirmed === null) {
        const key = `${FLEET_DEVICE_KEY_PREFIX}${link.deviceId}`;
        byKey.set(key, {
          key,
          kind: link.environmentId === null ? "waiting" : "unconfirmed",
          environmentId: null,
          deviceId: link.deviceId,
          holderEnvironmentId: holder as EnvironmentId,
          label: link.label,
          linkedWith: labelOf.get(holder) ?? null,
        });
        continue;
      }
      if (confirmed === holder) continue;
      linkedLabel(confirmed, link.label, holder);
    }
  }

  const rest = [...byKey.values()].toSorted(compareByLabel);
  return input.primary
    ? [
        {
          key: input.primary.environmentId,
          kind: "this",
          environmentId: input.primary.environmentId,
          deviceId: null,
          holderEnvironmentId: null,
          label: input.primary.label,
          linkedWith: null,
        },
        ...rest,
      ]
    : rest;
}

// ── Pairs and directions (R4.2 "Works with other computers") ─────────

/** What this app knows of a computer's link side right now. */
export interface FleetLinkReach {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This app can call it now. */
  readonly reachable: boolean;
  /** This app has a connection saved for it (or it is this computer). */
  readonly known: boolean;
  /** Its server takes link calls; null until the app has heard from it. */
  readonly supportsLinks: boolean | null;
  readonly links: FleetLinksEntry | null;
}

export type FleetDirectionStatus =
  /** Both halves, or the half this app can see: settings show. */
  | "linked"
  /** The asking computer removed it and waits to tell the other one. */
  | "unlinking"
  /** The asking computer's link failed or the other computer removed it. */
  | "broken"
  /** The working computer no longer has it; the asking one hasn't heard yet. */
  | "dangling"
  | "none";

/** One direction: `asker`'s agents can start work on `worker`. */
export interface FleetDirection {
  readonly asker: FleetLinkReach;
  readonly worker: FleetLinkReach;
  /** The asker's own link in use (the newest that still works), from its snapshot. */
  readonly outbound: OutboundComputerLink | null;
  /**
   * The worker's setting for that link: its other half (by the device the
   * asker's link reports), else the newest when the asker's side is unknown.
   */
  readonly inbound: InboundComputerLink | null;
  /**
   * Every half of this direction either computer reports: re-linking can
   * leave an older one behind, and Unlink removes them all.
   */
  readonly allOutbound: ReadonlyArray<OutboundComputerLink>;
  readonly allInbound: ReadonlyArray<InboundComputerLink>;
  readonly status: FleetDirectionStatus;
  /** The settings can be changed now: the worker is reachable and current. */
  readonly settingsEditable: boolean;
  /** Why the settings are read-only, when they show. */
  readonly settingsNote: string | null;
  /** Plain words for a broken, dangling or unlinking direction. */
  readonly note: string | null;
  /** Threads the asker asked to start on the worker, waiting for the worker's user. */
  readonly pending: ReadonlyArray<ComputerLinkPendingRequest>;
}

/** A pair row on a computer's page: that computer and one other, both ways. */
export interface FleetPair {
  readonly self: FleetLinkReach;
  readonly other: FleetLinkReach;
  /** `self`'s agents on `other`. */
  readonly outward: FleetDirection;
  /** `other`'s agents on `self`. */
  readonly inward: FleetDirection;
  /** Why a new link between them can't be made now, or null when it can. */
  readonly linkBlockedReason: string | null;
  /** Any half of either direction exists, so Unlink has something to do. */
  readonly linked: boolean;
}

function unreachableNote(computer: FleetLinkReach): string {
  return computer.known
    ? `${computer.label} is offline.`
    : `Connect to ${computer.label} to change this.`;
}

export function resolveFleetDirection(
  asker: FleetLinkReach,
  worker: FleetLinkReach,
): FleetDirection {
  const newestFirst = <T extends { readonly createdAt: string }>(links: ReadonlyArray<T>) =>
    links.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const allOutbound = newestFirst(
    (asker.links?.snapshot.outbound ?? []).filter(
      (link) => link.remoteEnvironmentId === worker.environmentId,
    ),
  );
  // The asker vouches for its own links' halves here, as far as this app hears from it.
  const vouching: FleetLinksByEnvironment = asker.links
    ? { [asker.environmentId]: asker.links }
    : {};
  const allInbound = newestFirst(
    (worker.links?.snapshot.inbound ?? []).filter(
      (link) =>
        confirmedInboundEnvironment(link, worker.environmentId, vouching) === asker.environmentId,
    ),
  );
  // The link the asker uses is its newest that still works, as its server picks it.
  const outbound =
    allOutbound.find((link) => link.state === "active" || link.state === "failed") ??
    allOutbound[0] ??
    null;
  // The setting in effect is that link's own other half; another half the
  // worker still lists (an older link not ended yet, one being made) isn't.
  const inbound =
    outbound?.remoteDeviceId !== undefined
      ? (allInbound.find((link) => link.deviceId === outbound.remoteDeviceId) ?? null)
      : (allInbound[0] ?? null);
  // Only what the worker says now: Allow and Deny go to it.
  const pending =
    inbound === null || worker.links?.live !== true || !worker.reachable
      ? []
      : worker.links.snapshot.pending.filter((request) => request.deviceId === inbound.deviceId);
  const workerCurrent = worker.reachable && worker.links?.live === true;

  let status: FleetDirectionStatus;
  let note: string | null = null;
  if (outbound?.state === "unlinking") {
    status = "unlinking";
    note = `Unlinking. ${worker.label} finishes when it's back.`;
  } else if (outbound !== null && (outbound.state === "revoked" || outbound.state === "failed")) {
    status = "broken";
    note =
      outbound.lastError ??
      (outbound.state === "revoked"
        ? `${worker.label} removed this link.`
        : `This link stopped working.`);
  } else if (inbound !== null) {
    status = "linked";
  } else if (outbound !== null) {
    if (workerCurrent) {
      // The worker answered and has no setting for it: its half is gone.
      status = "dangling";
      note = asker.reachable
        ? `${worker.label} removed this link.`
        : `Removed on ${worker.label}. ${asker.label} finishes when it's back.`;
    } else {
      status = "linked";
    }
  } else {
    status = "none";
  }

  const settingsEditable = status === "linked" && inbound !== null && workerCurrent;
  const settingsNote =
    status !== "linked" || settingsEditable
      ? null
      : !worker.reachable
        ? unreachableNote(worker)
        : inbound === null
          ? `Loading ${worker.label}'s settings.`
          : null;
  return {
    asker,
    worker,
    outbound,
    inbound,
    allOutbound,
    allInbound,
    status,
    settingsEditable,
    settingsNote,
    note,
    pending,
  };
}

/**
 * Why a new link between two computers can't be made right now: both must be
 * connected to this app and both must take links. Null when it can.
 */
export function linkBlockedReason(left: FleetLinkReach, right: FleetLinkReach): string | null {
  for (const computer of [left, right]) {
    if (!computer.reachable) return `Connect to ${computer.label} first.`;
  }
  for (const computer of [left, right]) {
    if (computer.supportsLinks !== true) return `${computer.label} needs a newer Threadlines.`;
  }
  return null;
}

export function resolveFleetPair(self: FleetLinkReach, other: FleetLinkReach): FleetPair {
  const outward = resolveFleetDirection(self, other);
  const inward = resolveFleetDirection(other, self);
  return {
    self,
    other,
    outward,
    inward,
    linkBlockedReason: linkBlockedReason(self, other),
    linked: [outward, inward].some(
      (direction) => direction.allOutbound.length > 0 || direction.allInbound.length > 0,
    ),
  };
}

/** A direction can be offered Link: nothing of it is left, or what is left is broken. */
export function canOfferLink(direction: FleetDirection): boolean {
  return (
    direction.status === "none" || direction.status === "broken" || direction.status === "dangling"
  );
}

// ── Unlink (R4.2 "Unlink") ───────────────────────────────────────────

/** One half to remove, on the computer that holds it. */
export interface FleetUnlinkStep {
  readonly holder: FleetLinkReach;
  /** Which direction of the pair it belongs to. */
  readonly direction: "outward" | "inward";
  readonly input: LinksRemoveInput;
}

export interface FleetUnlinkPlan {
  /** Inbound halves first, so each outbound half knows whether its other half is gone. */
  readonly steps: ReadonlyArray<FleetUnlinkStep>;
  /**
   * Computers this app can't reach now. Whatever halves they hold (known or
   * not: an offline computer's last word may be missing) wait for them.
   */
  readonly finishLater: ReadonlyArray<FleetLinkReach>;
  /**
   * Those of them nobody will tell: the other computer has no link to them
   * to carry the unlink, so their own side stays listed until an unlink
   * while they're online. (It can't start work anyway: the other computer
   * removes its side now.) The rest finish when they're back.
   */
  readonly keepItsSide: ReadonlyArray<FleetLinkReach>;
  /** No half can be removed now. */
  readonly blocked: boolean;
}

/**
 * Whether an outbound link's other half is gone by the time it is removed,
 * so there's nothing to tell: this unlink removes it first, or the worker
 * (as it says now) has no such half. With an older server that doesn't say
 * which half is its own, any half this unlink removes, or a current word
 * from the worker, counts.
 */
function otherHalfGone(outbound: OutboundComputerLink, direction: FleetDirection): boolean {
  const { worker, allInbound } = direction;
  if (!worker.reachable) return false;
  if (outbound.remoteDeviceId === undefined) {
    return allInbound.length > 0 || worker.links?.live === true;
  }
  if (allInbound.some((link) => link.deviceId === outbound.remoteDeviceId)) return true;
  return (
    worker.links?.live === true &&
    !worker.links.snapshot.inbound.some((link) => link.deviceId === outbound.remoteDeviceId)
  );
}

/**
 * Unlink removes both directions, each half on its own computer, through
 * this app's connection to it. An outbound half whose other half this app
 * removes (or sees gone) is told so, and needn't reach the other computer;
 * otherwise its computer tells the other one, now or when it next can.
 */
export function planFleetUnlink(pair: FleetPair): FleetUnlinkPlan {
  const inboundSteps: FleetUnlinkStep[] = [];
  const outboundSteps: FleetUnlinkStep[] = [];
  const finishLater = new Map<EnvironmentId, FleetLinkReach>();
  /** Computers an outbound removal here goes on to tell, now or when they're back. */
  const toldLater = new Set<EnvironmentId>();
  for (const [name, direction] of [
    ["outward", pair.outward],
    ["inward", pair.inward],
  ] as const) {
    const { asker, worker, allInbound, allOutbound } = direction;
    for (const inbound of allInbound) {
      if (worker.reachable) {
        inboundSteps.push({
          holder: worker,
          direction: name,
          input: { direction: "inbound", deviceId: inbound.deviceId, stopRunning: true },
        });
      } else {
        finishLater.set(worker.environmentId, worker);
      }
    }
    for (const outbound of allOutbound) {
      if (asker.reachable) {
        const otherHalfRemoved = otherHalfGone(outbound, direction);
        // A link the other computer already removed is just forgotten here.
        if (!otherHalfRemoved && outbound.state !== "revoked") toldLater.add(worker.environmentId);
        outboundSteps.push({
          holder: asker,
          direction: name,
          input: {
            direction: "outbound",
            linkId: outbound.linkId,
            ...(otherHalfRemoved ? { otherHalfRemoved: true } : {}),
          },
        });
      } else {
        finishLater.set(asker.environmentId, asker);
      }
    }
  }
  for (const computer of [pair.self, pair.other]) {
    if (!computer.reachable) finishLater.set(computer.environmentId, computer);
  }
  const steps = [...inboundSteps, ...outboundSteps];
  // An offline computer hears the unlink over the other computer's link to
  // it, which that computer keeps trying until it gets through.
  return {
    steps,
    finishLater: [...finishLater.values()],
    keepItsSide: [...finishLater.values()].filter(
      (computer) => !toldLater.has(computer.environmentId),
    ),
    blocked: steps.length === 0,
  };
}

/**
 * How one direction came out of an unlink. `leftover`: unlinked on the
 * working computer, while the asking one (offline, and nobody can tell it)
 * still lists its side until an unlink while it's online.
 */
export type FleetUnlinkOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "pending"; readonly waitingFor: string }
  | { readonly kind: "leftover"; readonly holder: string }
  | { readonly kind: "failed"; readonly detail: string };

/** What one step of an unlink answered. */
export interface FleetUnlinkStepResult {
  readonly step: FleetUnlinkStep;
  /** Null when its computer did its part. */
  readonly error: string | null;
  /** An outbound removal's word on the other computer's half. */
  readonly otherComputer: "confirmed" | "pending" | "not_asked" | null;
}

/**
 * How each direction came out, from what each computer answered. A half is
 * done when its computer removed it, or when the other computer confirmed
 * hearing the unlink (it removes its own halves then: its access setting at
 * once, its link back once refused); it waits for a computer this app
 * couldn't reach otherwise. Never done on a guess.
 */
export function resolveFleetUnlinkOutcomes(
  pair: FleetPair,
  plan: FleetUnlinkPlan,
  results: ReadonlyArray<FleetUnlinkStepResult>,
): Array<{ readonly direction: FleetDirection; readonly outcome: FleetUnlinkOutcome }> {
  const finishLater = new Set(plan.finishLater.map((computer) => computer.environmentId));
  const keepItsSide = new Set(plan.keepItsSide.map((computer) => computer.environmentId));
  const resultsOf = (name: "outward" | "inward") =>
    results.filter((result) => result.step.direction === name);
  /** The direction's asking computer heard from the other one that the unlink is done there. */
  const confirmedBy = (name: "outward" | "inward") =>
    resultsOf(name).some(
      (result) =>
        result.step.input.direction === "outbound" &&
        result.error === null &&
        result.otherComputer === "confirmed" &&
        result.step.input.otherHalfRemoved !== true,
    );
  return (
    [
      ["outward", pair.outward],
      ["inward", pair.inward],
    ] as const
  ).flatMap(
    ([name, direction]): Array<{
      readonly direction: FleetDirection;
      readonly outcome: FleetUnlinkOutcome;
    }> => {
      if (direction.allOutbound.length === 0 && direction.allInbound.length === 0) return [];
      const failed = resultsOf(name).find((result) => result.error !== null);
      if (failed !== undefined) {
        return [{ direction, outcome: { kind: "failed", detail: failed.error! } }];
      }
      const other = name === "outward" ? "inward" : "outward";
      const askerWaits =
        !direction.asker.reachable &&
        finishLater.has(direction.asker.environmentId) &&
        // Its link back goes once the other computer heard the unlink.
        !confirmedBy(other);
      const workerWaits =
        (!direction.worker.reachable &&
          finishLater.has(direction.worker.environmentId) &&
          !confirmedBy(name)) ||
        resultsOf(name).some((result) => result.otherComputer === "pending");
      const waitingFor = askerWaits ? direction.asker : workerWaits ? direction.worker : null;
      return [
        {
          direction,
          outcome:
            waitingFor === null
              ? { kind: "done" }
              : waitingFor === direction.asker && keepItsSide.has(direction.asker.environmentId)
                ? { kind: "leftover", holder: direction.asker.label }
                : { kind: "pending", waitingFor: waitingFor.label },
        },
      ];
    },
  );
}

// ── Work across computers ────────────────────────────────────────────

/** A thread whose agent on another computer started it, or a parent's record of such a child. */
export interface FleetCrossWorkThread {
  readonly askerEnvironmentId: EnvironmentId;
  readonly workerEnvironmentId: EnvironmentId;
  readonly threadId: string;
  readonly attention: "working" | "needs-you" | null;
}

/** Work one computer asked of another, by ordered pair. */
export interface FleetCrossWork {
  readonly askerEnvironmentId: EnvironmentId;
  readonly workerEnvironmentId: EnvironmentId;
  readonly working: number;
  readonly needsYou: number;
}

/**
 * Sums the work each computer asked of each other one. A child seen both as
 * a real thread and in its parent's record counts once: the real thread's
 * status wins (it comes first in `threads`).
 */
export function collectFleetCrossWork(
  threads: ReadonlyArray<FleetCrossWorkThread>,
): FleetCrossWork[] {
  const seen = new Set<string>();
  const byPair = new Map<string, FleetCrossWork>();
  for (const thread of threads) {
    if (thread.askerEnvironmentId === thread.workerEnvironmentId) continue;
    const threadKey = `${thread.workerEnvironmentId}:${thread.threadId}`;
    if (seen.has(threadKey)) continue;
    seen.add(threadKey);
    if (thread.attention === null) continue;
    const pairKey = `${thread.askerEnvironmentId}>${thread.workerEnvironmentId}`;
    const current = byPair.get(pairKey) ?? {
      askerEnvironmentId: thread.askerEnvironmentId,
      workerEnvironmentId: thread.workerEnvironmentId,
      working: 0,
      needsYou: 0,
    };
    byPair.set(pairKey, {
      ...current,
      working: current.working + (thread.attention === "working" ? 1 : 0),
      needsYou: current.needsYou + (thread.attention === "needs-you" ? 1 : 0),
    });
  }
  return [...byPair.values()];
}

/** How a parent's record of a child on another computer reads as attention. */
export function crossWorkAttentionOf(cachedStatus: string): "working" | "needs-you" | null {
  switch (cachedStatus) {
    case "working":
    case "waiting":
      return "working";
    case "needs the user":
      return "needs-you";
    default:
      return null;
  }
}

// ── Graph lines between computers (Part 4, "Line meaning") ──────────

/** A line between two computers in the graph; dots travel from `fromId` to `toId`. */
export interface FleetGraphEdge {
  readonly key: string;
  readonly fromId: string;
  readonly toId: string;
  readonly state: FleetLineState;
}

/** A link line's state from what its asking computers report now; none known reads offline. */
function linkConnectionState(links: ReadonlyArray<OutboundComputerLink>): FleetLineState {
  if (links.length === 0) return "offline";
  if (links.some((link) => link.state === "active" && link.connection === "connected")) {
    return "connected";
  }
  if (
    links.some(
      (link) =>
        link.state === "active" &&
        (link.connection === "connecting" || link.connection === "reconnecting"),
    )
  ) {
    return "reconnecting";
  }
  if (links.some((link) => link.state === "active" && link.connection === "idle")) {
    return "connected";
  }
  return "offline";
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * The lines between computers. From this computer, to each computer this app
 * connects to and each phone: this app's connection, working while that
 * computer runs anything. Between any other two computers that are linked,
 * and from this computer to a linked computer this app doesn't connect to:
 * the link. Work one computer asked of another makes their line working (or
 * waiting on the user), with dots from the asking computer to the working one.
 */
export function buildFleetGraphEdges(input: {
  readonly model: FleetModel;
  readonly links: FleetLinksByEnvironment;
  readonly crossWork: ReadonlyArray<FleetCrossWork>;
}): FleetGraphEdge[] {
  const { model } = input;
  const computers = [model.center, ...model.others];
  const idByEnvironment = new Map<string, string>();
  for (const computer of computers) {
    if (computer.environmentId !== null) idByEnvironment.set(computer.environmentId, computer.id);
  }
  const centerEnvironmentId = model.center.environmentId;

  // Links between drawn computers, with what their asking sides report.
  // Only what the asking computers say now: a stale snapshot is no connection.
  const linkHalves = new Map<string, { a: string; b: string; outbound: OutboundComputerLink[] }>();
  const notePair = (left: string, right: string, outbound: OutboundComputerLink | null) => {
    if (left === right || !idByEnvironment.has(left) || !idByEnvironment.has(right)) return;
    const key = pairKey(left, right);
    const current = linkHalves.get(key) ?? { a: left, b: right, outbound: [] };
    if (outbound !== null) current.outbound.push(outbound);
    linkHalves.set(key, current);
  };
  for (const [holder, entry] of Object.entries(input.links)) {
    for (const link of entry.snapshot.outbound) {
      notePair(holder, link.remoteEnvironmentId, entry.live ? link : null);
    }
    for (const link of entry.snapshot.inbound) {
      const confirmed = confirmedInboundEnvironment(link, holder, input.links);
      if (confirmed !== null) notePair(holder, confirmed, null);
    }
  }

  // Work between drawn computers, both ways.
  const workByPair = new Map<string, FleetCrossWork[]>();
  for (const work of input.crossWork) {
    if (!idByEnvironment.has(work.askerEnvironmentId)) continue;
    if (!idByEnvironment.has(work.workerEnvironmentId)) continue;
    const key = pairKey(work.askerEnvironmentId, work.workerEnvironmentId);
    workByPair.set(key, [...(workByPair.get(key) ?? []), work]);
  }
  /** The busiest way the work goes, and how the line reads with it. */
  const workOn = (key: string) => {
    const works = workByPair.get(key) ?? [];
    const working = works.reduce((sum, work) => sum + work.working, 0);
    const needsYou = works.reduce((sum, work) => sum + work.needsYou, 0);
    const lead =
      works.toSorted(
        (left, right) => right.working - left.working || right.needsYou - left.needsYou,
      )[0] ?? null;
    return { state: working + needsYou > 0 ? lineWork({ working, needsYou }) : null, lead };
  };

  const edges: FleetGraphEdge[] = [];
  const drawn = new Set<string>();
  for (const computer of model.others) {
    if (computer.kind === "linked") continue;
    // This app's connection to it.
    const key =
      centerEnvironmentId !== null && computer.environmentId !== null
        ? pairKey(centerEnvironmentId, computer.environmentId)
        : null;
    const work = key === null ? { state: null, lead: null } : workOn(key);
    if (key !== null) drawn.add(key);
    const base = resolveConnectionLineState(computer);
    const state =
      computer.connection !== "connected"
        ? base
        : work.state === "working" || base === "working"
          ? "working"
          : (work.state ?? base);
    // Dots run from this computer, unless the only work on the line is the
    // other computer's work here.
    const reverse =
      work.lead !== null &&
      work.lead.workerEnvironmentId === centerEnvironmentId &&
      computer.working === 0;
    edges.push({
      key: `connection:${computer.id}`,
      fromId: reverse ? computer.id : model.center.id,
      toId: reverse ? model.center.id : computer.id,
      state,
    });
  }

  const pairs = new Set([...linkHalves.keys(), ...workByPair.keys()]);
  for (const key of [...pairs].toSorted()) {
    if (drawn.has(key)) continue;
    const [left, right] = key.split("|") as [string, string];
    const halves = linkHalves.get(key);
    const work = workOn(key);
    const state = work.state ?? linkConnectionState(halves?.outbound ?? []);
    const askerEnvironmentId = work.lead?.askerEnvironmentId ?? left;
    const workerEnvironmentId = askerEnvironmentId === left ? right : left;
    edges.push({
      key: `link:${key}`,
      fromId: idByEnvironment.get(askerEnvironmentId)!,
      toId: idByEnvironment.get(workerEnvironmentId)!,
      state,
    });
  }
  return edges;
}
