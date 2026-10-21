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

/** Key prefix of a computer that is linked but hasn't introduced itself yet. */
export const FLEET_DEVICE_KEY_PREFIX = "device:";

/**
 * Who a list row is: this computer, a computer this app connects to
 * (`saved`), a computer only known through a link (`linked`), or a linked
 * computer that hasn't said who it is yet (`waiting`, keyed by its device).
 */
export type FleetEntryKind = "this" | "saved" | "linked" | "waiting";

export interface FleetDirectoryEntry {
  /** The environment id, or `device:<deviceId>` for a waiting entry. */
  readonly key: string;
  readonly kind: FleetEntryKind;
  readonly environmentId: EnvironmentId | null;
  /** Waiting entries: its device on `holderEnvironmentId` (the computer it linked to). */
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
 * inbound link whose computer hasn't introduced itself yet stands as its own
 * entry until it does, then folds into that computer's.
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
      if (link.environmentId === null) {
        const key = `${FLEET_DEVICE_KEY_PREFIX}${link.deviceId}`;
        byKey.set(key, {
          key,
          kind: "waiting",
          environmentId: null,
          deviceId: link.deviceId,
          holderEnvironmentId: holder as EnvironmentId,
          label: link.label,
          linkedWith: labelOf.get(holder) ?? null,
        });
        continue;
      }
      if (link.environmentId === holder) continue;
      linkedLabel(link.environmentId, link.label, holder);
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
  /** The asker's own link, from its snapshot. */
  readonly outbound: OutboundComputerLink | null;
  /** The worker's setting for it, from its snapshot. */
  readonly inbound: InboundComputerLink | null;
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
  const outbound =
    asker.links?.snapshot.outbound.find(
      (link) => link.remoteEnvironmentId === worker.environmentId,
    ) ?? null;
  const inbound =
    worker.links?.snapshot.inbound.find((link) => link.environmentId === asker.environmentId) ??
    null;
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
      (direction) => direction.outbound !== null || direction.inbound !== null,
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
  /** Computers holding a half this app can't reach: they finish when they're back. */
  /**
   * Computers this app can't reach now. Whatever halves they hold (known or
   * not: an offline computer's last word may be missing) wait for them, and
   * they finish when they're back.
   */
  readonly finishLater: ReadonlyArray<FleetLinkReach>;
  /** No half can be removed now. */
  readonly blocked: boolean;
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
  for (const [name, direction] of [
    ["outward", pair.outward],
    ["inward", pair.inward],
  ] as const) {
    const { asker, worker, inbound, outbound } = direction;
    if (inbound !== null) {
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
    if (outbound !== null) {
      if (asker.reachable) {
        const otherHalfRemoved =
          worker.reachable && (inbound !== null || worker.links?.live === true);
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
  return { steps, finishLater: [...finishLater.values()], blocked: steps.length === 0 };
}

/** How one direction came out of an unlink. */
export type FleetUnlinkOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "pending"; readonly waitingFor: string }
  | { readonly kind: "failed"; readonly detail: string };

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

function linkConnectionState(links: ReadonlyArray<OutboundComputerLink>): FleetLineState {
  if (links.length === 0) return "connected";
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
  const linkHalves = new Map<string, { a: string; b: string; outbound: OutboundComputerLink[] }>();
  const notePair = (left: string, right: string, outbound: OutboundComputerLink | null) => {
    if (left === right || !idByEnvironment.has(left) || !idByEnvironment.has(right)) return;
    const key = pairKey(left, right);
    const current = linkHalves.get(key) ?? { a: left, b: right, outbound: [] };
    if (outbound !== null) current.outbound.push(outbound);
    linkHalves.set(key, current);
  };
  for (const [holder, entry] of Object.entries(input.links)) {
    for (const link of entry.snapshot.outbound) notePair(holder, link.remoteEnvironmentId, link);
    for (const link of entry.snapshot.inbound) {
      if (link.environmentId !== null) notePair(holder, link.environmentId, null);
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
