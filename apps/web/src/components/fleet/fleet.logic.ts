/**
 * The Fleet page's model: every computer this app is connected to, the phones
 * and tablets linked to this one, what runs on each and through which agent.
 * Pure: the page's hook gathers the inputs from the stores, this decides what
 * they say.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import type { ThreadAttention, ThreadStatusPill } from "../Sidebar.logic";

/** How this app reaches a computer right now. */
export type FleetConnection = "connected" | "reconnecting" | "offline";

/** What a computer, a provider or a line has going: the strongest wins. */
export type FleetWork = "needs-you" | "working" | "idle";

export type FleetGlyph = "laptop" | "monitor" | "server" | "phone" | "tablet";

/** How a connected computer or device is reached. */
export type FleetRoute = "network" | "relay" | "ssh" | null;

/** One computer or device, before its threads are counted. */
export interface FleetComputerInput {
  /** The environment id, or `device:<session id>` for a linked phone or tablet. */
  readonly id: string;
  /** Null for a linked device: it runs no threads of its own. */
  readonly environmentId: EnvironmentId | null;
  /** This computer (the center), another computer, or a device linked to this one. */
  readonly kind: "this" | "computer" | "device";
  readonly label: string;
  readonly glyph: FleetGlyph;
  readonly connection: FleetConnection;
  readonly route: FleetRoute;
  /** When it was last connected, for "Offline · 2h ago". */
  readonly lastSeenAt: string | null;
}

/** One thread as Fleet reads it. */
export interface FleetThreadInput {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectLabel: string | null;
  readonly status: ThreadStatusPill | null;
  readonly attention: ThreadAttention | null;
  /** The thread's agent session is up (warm, or at work). */
  readonly sessionLive: boolean;
  readonly provider: {
    readonly instanceId: ProviderInstanceId | null;
    readonly driverKind: string;
  } | null;
  readonly modelSelection: ModelSelection | null;
  /** The title of the thread whose agent started this one, on the same computer. */
  readonly startedByTitle: string | null;
}

/** An agent with live threads on one computer. */
export interface FleetProvider {
  readonly key: string;
  /** The computer it runs on: instance ids only mean something there. */
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly driverKind: string;
  readonly working: number;
  readonly needsYou: number;
  readonly work: FleetWork;
}

export interface FleetComputer extends FleetComputerInput {
  readonly working: number;
  readonly needsYou: number;
  readonly work: FleetWork;
  /** One per agent with a live session or live work, in a stable order. */
  readonly providers: readonly FleetProvider[];
  /** The threads that need the user or are working: needs-you first. */
  readonly threads: readonly FleetThreadInput[];
}

export interface FleetModel {
  /** This computer, or on the phone app, the device in hand. */
  readonly center: FleetComputer;
  /** Every other computer and device, by name. */
  readonly others: readonly FleetComputer[];
  readonly working: number;
  readonly needsYou: number;
}

/** The device a session belongs to, as the Fleet page needs it. */
export interface LinkedDeviceSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly current: boolean;
  readonly connected: boolean;
  readonly lastConnectedAt: string | null;
  readonly client: {
    readonly label?: string | undefined;
    readonly deviceType: string;
    readonly os?: string | undefined;
    readonly browser?: string | undefined;
  };
}

function deviceLabel(session: LinkedDeviceSession): string {
  return (
    session.client.label ??
    ([session.client.os, session.client.browser].filter(Boolean).join(" · ") ||
      (session.client.deviceType === "tablet" ? "Tablet" : "Phone"))
  );
}

/**
 * The phones and tablets with access to this computer, a node per session.
 * Sessions carry no device identity, so two sessions are two devices even
 * when they share a name: two unnamed iPhones must not read as one.
 */
export function linkedDeviceInputs(
  sessions: ReadonlyArray<LinkedDeviceSession>,
  relaySubject: string,
): FleetComputerInput[] {
  return sessions.flatMap((session): FleetComputerInput[] => {
    if (session.current) return [];
    if (session.client.deviceType !== "mobile" && session.client.deviceType !== "tablet") {
      return [];
    }
    return [
      {
        id: `device:${session.sessionId}`,
        environmentId: null,
        kind: "device",
        label: deviceLabel(session),
        glyph: session.client.deviceType === "tablet" ? "tablet" : "phone",
        connection: session.connected ? "connected" : "offline",
        route: session.subject === relaySubject ? "relay" : "network",
        lastSeenAt: session.lastConnectedAt,
      },
    ];
  });
}

/**
 * This computer's connection, from the app's link to its own server (the
 * state the connection banner shows). Never connected yet reads as
 * reconnecting: the app is still trying.
 */
export function primaryConnectionFrom(
  linkState: "connected" | "connecting" | "error" | "offline" | "reconnecting",
): FleetConnection {
  switch (linkState) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "reconnecting";
    case "error":
    case "offline":
      return "offline";
  }
}

function workOf(counts: { readonly working: number; readonly needsYou: number }): FleetWork {
  return counts.needsYou > 0 ? "needs-you" : counts.working > 0 ? "working" : "idle";
}

function compareLabels(left: { readonly label: string }, right: { readonly label: string }) {
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

function buildComputer(
  input: FleetComputerInput,
  threads: readonly FleetThreadInput[],
): FleetComputer {
  const own =
    input.environmentId === null
      ? []
      : threads.filter((thread) => thread.environmentId === input.environmentId);
  const live = own
    .filter((thread) => thread.attention !== null)
    .toSorted(
      (left, right) =>
        Number(right.attention === "needs-you") - Number(left.attention === "needs-you"),
    );
  const providersByKey = new Map<string, FleetProvider>();
  for (const thread of own) {
    if (thread.provider === null || (thread.attention === null && !thread.sessionLive)) continue;
    const key = thread.provider.instanceId ?? thread.provider.driverKind;
    const current = providersByKey.get(key) ?? {
      key,
      environmentId: input.environmentId,
      instanceId: thread.provider.instanceId,
      driverKind: thread.provider.driverKind,
      working: 0,
      needsYou: 0,
      work: "idle" as const,
    };
    const working = current.working + (thread.attention === "working" ? 1 : 0);
    const needsYou = current.needsYou + (thread.attention === "needs-you" ? 1 : 0);
    providersByKey.set(key, { ...current, working, needsYou, work: workOf({ working, needsYou }) });
  }
  const working = live.filter((thread) => thread.attention === "working").length;
  const needsYou = live.length - working;
  return {
    ...input,
    working,
    needsYou,
    work: workOf({ working, needsYou }),
    providers: [...providersByKey.values()].toSorted((left, right) =>
      left.key.localeCompare(right.key),
    ),
    threads: live,
  };
}

/** Counts every computer's threads; the others are ordered by name, so the graph holds still. */
export function buildFleetModel(input: {
  readonly center: FleetComputerInput;
  readonly others: readonly FleetComputerInput[];
  readonly threads: readonly FleetThreadInput[];
}): FleetModel {
  const center = buildComputer(input.center, input.threads);
  const others = input.others
    .map((computer) => buildComputer(computer, input.threads))
    .toSorted(compareLabels);
  const all = [center, ...others];
  return {
    center,
    others,
    working: all.reduce((sum, computer) => sum + computer.working, 0),
    needsYou: all.reduce((sum, computer) => sum + computer.needsYou, 0),
  };
}

function lastSeenPhrase(lastSeenAt: string, nowMs: number): string {
  const elapsed = formatElapsedDurationLabel(lastSeenAt, nowMs);
  return elapsed === "just now" ? "just now" : `${elapsed} ago`;
}

/** The mono line under a computer's name: where it is, or how long it has been gone. */
export function describeComputerLocation(computer: FleetComputerInput, nowMs: number): string {
  if (computer.kind === "this") {
    // The phone app's center is the device in hand, whose name says so already.
    if (computer.environmentId === null) return "";
    return computer.connection === "connected"
      ? "This computer"
      : computer.connection === "reconnecting"
        ? "This computer · Reconnecting"
        : "This computer · Offline";
  }
  switch (computer.connection) {
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return computer.lastSeenAt === null
        ? "Offline"
        : `Offline · ${lastSeenPhrase(computer.lastSeenAt, nowMs)}`;
    case "connected":
      switch (computer.route) {
        case "network":
          return "On your network";
        case "relay":
          return "Through the relay";
        case "ssh":
          return "Over SSH";
        case null:
          return "Connected";
      }
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "3 working and 1 needs you, on 2 computers. Mac mini is offline." */
export function describeFleetSummary(model: FleetModel): string {
  const busy = [model.center, ...model.others].filter((computer) => computer.work !== "idle");
  const parts = [
    model.working > 0 ? `${model.working} working` : null,
    model.needsYou > 0 ? `${model.needsYou} ${model.needsYou === 1 ? "needs" : "need"} you` : null,
  ].filter((part): part is string => part !== null);
  const work =
    parts.length === 0
      ? "Nothing is running right now."
      : `${parts.join(" and ")}, on ${busy.length === 1 ? "1 computer" : `${busy.length} computers`}.`;
  const offline = model.others
    .filter((computer) => computer.kind === "computer" && computer.connection === "offline")
    .map((computer) => computer.label);
  if (offline.length === 0) return work;
  return `${work} ${joinNames(offline)} ${offline.length === 1 ? "is" : "are"} offline.`;
}

/**
 * The muted line under the threads: the computers and devices with nothing
 * running, said once ("iPhone is reconnecting. Mac mini was last seen 2h
 * ago."), or null when every one of them is busy.
 */
export function describeQuietComputers(
  computers: readonly FleetComputer[],
  nowMs: number,
): string | null {
  const quiet = computers.filter((computer) => computer.threads.length === 0);
  const idle = quiet
    .filter((computer) => computer.connection === "connected")
    .map((computer) => computer.label);
  const reconnecting = quiet
    .filter((computer) => computer.connection === "reconnecting")
    .map((computer) => computer.label);
  const sentences = [
    idle.length > 0 ? `${joinNames(idle)} ${idle.length === 1 ? "is" : "are"} idle.` : null,
    reconnecting.length > 0
      ? `${joinNames(reconnecting)} ${reconnecting.length === 1 ? "is" : "are"} reconnecting.`
      : null,
    ...quiet
      .filter((computer) => computer.connection === "offline")
      .map((computer) =>
        computer.lastSeenAt === null
          ? `${computer.label} is offline.`
          : `${computer.label} was last seen ${lastSeenPhrase(computer.lastSeenAt, nowMs)}.`,
      ),
  ].filter((sentence): sentence is string => sentence !== null);
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/** How a line in the graph is drawn. */
export type FleetLineState = "working" | "needs-you" | "connected" | "reconnecting" | "offline";

/**
 * A line carries motion while anything at its end runs, even when something
 * else there waits on the user: the node's ring and badge say that part.
 */
function lineWork(counts: { readonly working: number; readonly needsYou: number }): FleetLineState {
  return counts.working > 0 ? "working" : counts.needsYou > 0 ? "needs-you" : "connected";
}

/**
 * The line from this computer to another: this app's connection to it. Its
 * connection state speaks first; while connected it carries the computer's
 * work.
 */
export function resolveConnectionLineState(computer: FleetComputer): FleetLineState {
  if (computer.connection !== "connected") return computer.connection;
  return lineWork(computer);
}

/** The line from a computer to one of its agents. */
export function resolveProviderLineState(
  computer: FleetComputer,
  provider: FleetProvider,
): FleetLineState {
  if (computer.connection !== "connected") return "offline";
  return lineWork(provider);
}
