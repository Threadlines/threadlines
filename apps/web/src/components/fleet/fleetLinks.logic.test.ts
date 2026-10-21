import {
  AuthSessionId,
  type ComputerLinksSnapshot,
  ComputerLinkId,
  EnvironmentId,
  type InboundComputerLink,
  type OutboundComputerLink,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFleetModel, type FleetComputerInput } from "./fleet.logic";
import {
  buildFleetDirectory,
  buildFleetGraphEdges,
  canOfferLink,
  collectFleetCrossWork,
  type FleetLinkReach,
  type FleetLinksByEnvironment,
  planFleetUnlink,
  resolveFleetPair,
  resolveFleetUnlinkOutcomes,
} from "./fleetLinks.logic";

const MAC = EnvironmentId.make("env-mac");
const WINDOWS = EnvironmentId.make("env-windows");
const MINI = EnvironmentId.make("env-mini");
const LINUX = EnvironmentId.make("env-linux");
const NOW = "2026-10-21T12:00:00.000Z";

function outbound(
  remote: EnvironmentId,
  remoteLabel: string,
  overrides: Partial<OutboundComputerLink> = {},
): OutboundComputerLink {
  return {
    linkId: ComputerLinkId.make(`link-to-${remote}`),
    remoteEnvironmentId: remote,
    remoteLabel,
    remotePlatform: null,
    state: "active",
    connection: "idle",
    route: null,
    createdAt: NOW,
    lastConnectedAt: null,
    lastError: null,
    ...overrides,
  };
}

function inbound(
  from: EnvironmentId | null,
  label: string,
  overrides: Partial<InboundComputerLink> = {},
): InboundComputerLink {
  return {
    deviceId: `device-${from ?? label}`,
    environmentId: from,
    label,
    platform: null,
    sessionId: AuthSessionId.make(`session-${from ?? label}`),
    access: "ask",
    maxRuntimeMode: "auto",
    createdAt: NOW,
    lastUsedAt: null,
    ...overrides,
  };
}

function snapshot(parts: Partial<ComputerLinksSnapshot>): ComputerLinksSnapshot {
  return { outbound: [], inbound: [], pending: [], ...parts };
}

function reach(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<FleetLinkReach> = {},
): FleetLinkReach {
  return {
    environmentId,
    label,
    reachable: true,
    known: true,
    supportsLinks: true,
    links: { snapshot: snapshot({}), live: true },
    ...overrides,
  };
}

describe("buildFleetDirectory", () => {
  it("lists this computer first, saved computers, and linked computers this app doesn't save, once each", () => {
    const links: FleetLinksByEnvironment = {
      [MAC]: {
        live: true,
        snapshot: snapshot({
          // Windows PC is saved: one entry, under its saved name.
          outbound: [outbound(WINDOWS, "DESKTOP-42"), outbound(LINUX, "build box")],
          inbound: [inbound(WINDOWS, "DESKTOP-42"), inbound(null, "Studio")],
        }),
      },
    };
    const directory = buildFleetDirectory({
      primary: { environmentId: MAC, label: "Mac" },
      saved: [{ environmentId: WINDOWS, label: "Windows PC" }],
      links,
    });
    expect(directory.map((entry) => [entry.key, entry.kind, entry.label])).toEqual([
      [MAC, "this", "Mac"],
      [LINUX, "linked", "build box"],
      ["device:device-Studio", "waiting", "Studio"],
      [WINDOWS, "saved", "Windows PC"],
    ]);
    expect(directory.find((entry) => entry.key === LINUX)?.linkedWith).toBe("Mac");
    expect(directory.find((entry) => entry.kind === "waiting")?.holderEnvironmentId).toBe(MAC);
  });

  it("folds a waiting computer into its own entry once it says which computer it is", () => {
    const before = buildFleetDirectory({
      primary: { environmentId: MAC, label: "Mac" },
      saved: [],
      links: { [MAC]: { live: true, snapshot: snapshot({ inbound: [inbound(null, "Studio")] }) } },
    });
    expect(before.map((entry) => entry.key)).toEqual([MAC, "device:device-Studio"]);
    const after = buildFleetDirectory({
      primary: { environmentId: MAC, label: "Mac" },
      saved: [],
      links: {
        [MAC]: {
          live: true,
          snapshot: snapshot({
            inbound: [inbound(MINI, "Studio", { deviceId: "device-Studio" })],
          }),
        },
      },
    });
    expect(after.map((entry) => [entry.key, entry.kind])).toEqual([
      [MAC, "this"],
      [MINI, "linked"],
    ]);
  });
});

describe("resolveFleetPair", () => {
  it("reads and writes each direction on the computer it runs on", () => {
    const mac = reach(MAC, "Mac", {
      links: {
        live: true,
        snapshot: snapshot({
          outbound: [outbound(WINDOWS, "Windows PC")],
          inbound: [inbound(WINDOWS, "Windows PC", { access: "allowed" })],
        }),
      },
    });
    const windows = reach(WINDOWS, "Windows PC", {
      links: {
        live: true,
        snapshot: snapshot({
          outbound: [outbound(MAC, "Mac")],
          inbound: [inbound(MAC, "Mac", { access: "off", maxRuntimeMode: "full-access" })],
        }),
      },
    });
    const pair = resolveFleetPair(mac, windows);
    // Mac's agents on Windows PC: Windows PC's setting for Mac.
    expect(pair.outward.inbound?.access).toBe("off");
    expect(pair.outward.inbound?.maxRuntimeMode).toBe("full-access");
    expect(pair.outward.worker.environmentId).toBe(WINDOWS);
    // Windows PC's agents on Mac: Mac's setting for Windows PC.
    expect(pair.inward.inbound?.access).toBe("allowed");
    expect(pair.inward.worker.environmentId).toBe(MAC);
    expect(pair.outward.settingsEditable && pair.inward.settingsEditable).toBe(true);
  });

  it("offers Link for the one direction that isn't linked", () => {
    const pair = resolveFleetPair(
      reach(MAC, "Mac", {
        links: { live: true, snapshot: snapshot({ outbound: [outbound(WINDOWS, "Windows PC")] }) },
      }),
      reach(WINDOWS, "Windows PC", {
        links: { live: true, snapshot: snapshot({ inbound: [inbound(MAC, "Mac")] }) },
      }),
    );
    expect(pair.linked).toBe(true);
    expect(pair.outward.status).toBe("linked");
    expect(pair.inward.status).toBe("none");
    expect(canOfferLink(pair.inward)).toBe(true);
    expect(canOfferLink(pair.outward)).toBe(false);
    expect(pair.linkBlockedReason).toBeNull();
  });

  it("keeps an offline computer's last settings, disabled, and an existing link manageable whatever the other reports", () => {
    const mac = reach(MAC, "Mac", {
      supportsLinks: null,
      links: { live: true, snapshot: snapshot({ inbound: [inbound(WINDOWS, "Windows PC")] }) },
    });
    const windows = reach(WINDOWS, "Windows PC", {
      reachable: false,
      links: {
        live: false,
        snapshot: snapshot({ inbound: [inbound(MAC, "Mac", { access: "allowed" })] }),
      },
    });
    const pair = resolveFleetPair(mac, windows);
    expect(pair.outward.inbound?.access).toBe("allowed");
    expect(pair.outward.settingsEditable).toBe(false);
    expect(pair.outward.settingsNote).toBe("Windows PC is offline.");
    // Mac holds Windows PC's setting and is reachable: it stays manageable,
    // though nothing new can be linked until both are there.
    expect(pair.inward.settingsEditable).toBe(true);
    expect(pair.linkBlockedReason).toBe("Connect to Windows PC first.");
  });

  it("says why a link can't be made yet", () => {
    expect(
      resolveFleetPair(reach(MAC, "Mac"), reach(MINI, "Mac mini", { supportsLinks: false }))
        .linkBlockedReason,
    ).toBe("Mac mini needs a newer Threadlines.");
  });
});

describe("planFleetUnlink", () => {
  const linkedPair = (windowsReachable: boolean) =>
    resolveFleetPair(
      reach(MAC, "Mac", {
        links: {
          live: true,
          snapshot: snapshot({
            outbound: [outbound(WINDOWS, "Windows PC")],
            inbound: [inbound(WINDOWS, "Windows PC")],
          }),
        },
      }),
      reach(WINDOWS, "Windows PC", {
        reachable: windowsReachable,
        links: {
          live: windowsReachable,
          snapshot: snapshot({
            outbound: [outbound(MAC, "Mac")],
            inbound: [inbound(MAC, "Mac")],
          }),
        },
      }),
    );

  it("removes each half on its own computer, access first and stopping what the links started", () => {
    const plan = planFleetUnlink(linkedPair(true));
    expect(plan.finishLater).toEqual([]);
    expect(plan.steps.map((step) => [step.holder.environmentId, step.input])).toEqual([
      [WINDOWS, { direction: "inbound", deviceId: `device-${MAC}`, stopRunning: true }],
      [MAC, { direction: "inbound", deviceId: `device-${WINDOWS}`, stopRunning: true }],
      [
        MAC,
        {
          direction: "outbound",
          linkId: ComputerLinkId.make(`link-to-${WINDOWS}`),
          otherHalfRemoved: true,
        },
      ],
      [
        WINDOWS,
        {
          direction: "outbound",
          linkId: ComputerLinkId.make(`link-to-${MAC}`),
          otherHalfRemoved: true,
        },
      ],
    ]);
  });

  it("unlinks on the computer it reaches and leaves the other to finish when it's back", () => {
    const plan = planFleetUnlink(linkedPair(false));
    expect(plan.finishLater.map((computer) => computer.label)).toEqual(["Windows PC"]);
    expect(plan.steps.map((step) => [step.holder.environmentId, step.input.direction])).toEqual([
      [MAC, "inbound"],
      [MAC, "outbound"],
    ]);
    // Mac tells Windows PC itself, now or when it can.
    expect(plan.steps[1]!.input).toEqual({
      direction: "outbound",
      linkId: ComputerLinkId.make(`link-to-${WINDOWS}`),
    });
    expect(plan.blocked).toBe(false);
  });

  it("shows the newest half of a re-linked direction and removes every half", () => {
    const pair = resolveFleetPair(
      reach(MAC, "Mac"),
      reach(WINDOWS, "Windows PC", {
        links: {
          live: true,
          snapshot: snapshot({
            inbound: [
              inbound(MAC, "Mac", { deviceId: "device-old", access: "off" }),
              inbound(MAC, "Mac", {
                deviceId: "device-new",
                access: "allowed",
                createdAt: "2026-10-21T13:00:00.000Z",
              }),
            ],
          }),
        },
      }),
    );
    expect(pair.outward.inbound?.deviceId).toBe("device-new");
    expect(pair.outward.inbound?.access).toBe("allowed");
    expect(
      planFleetUnlink(pair).steps.map((step) =>
        step.input.direction === "inbound" ? step.input.deviceId : null,
      ),
    ).toEqual(["device-new", "device-old"]);
  });

  it("reports a half done only when its computer, or the other one, confirmed it", () => {
    // This app can't reach Windows PC, but Mac can.
    const pair = linkedPair(false);
    const plan = planFleetUnlink(pair);
    const answered = (otherComputer: "confirmed" | "pending") =>
      resolveFleetUnlinkOutcomes(
        pair,
        plan,
        plan.steps.map((step) => ({
          step,
          error: null,
          otherComputer: step.input.direction === "outbound" ? otherComputer : "not_asked",
        })),
      ).map(({ direction, outcome }) => [direction.asker.label, outcome]);
    expect(answered("confirmed")).toEqual([
      ["Mac", { kind: "done" }],
      ["Windows PC", { kind: "done" }],
    ]);
    expect(answered("pending")).toEqual([
      ["Mac", { kind: "pending", waitingFor: "Windows PC" }],
      ["Windows PC", { kind: "pending", waitingFor: "Windows PC" }],
    ]);
    const failed = resolveFleetUnlinkOutcomes(pair, plan, [
      {
        step: plan.steps[0]!,
        error: "Mac couldn't stop everything the link started.",
        otherComputer: null,
      },
    ]);
    expect(failed.find(({ direction }) => direction.asker.label === "Windows PC")?.outcome).toEqual(
      {
        kind: "failed",
        detail: "Mac couldn't stop everything the link started.",
      },
    );
  });
});

describe("cross-computer work in the graph", () => {
  const computer = (
    id: EnvironmentId,
    label: string,
    overrides: Partial<FleetComputerInput> = {},
  ): FleetComputerInput => ({
    id,
    environmentId: id,
    kind: "computer",
    label,
    glyph: "monitor",
    connection: "connected",
    route: "network",
    lastSeenAt: null,
    ...overrides,
  });
  const model = buildFleetModel({
    center: computer(MAC, "Mac", { kind: "this", route: null }),
    others: [computer(WINDOWS, "Windows PC"), computer(LINUX, "build box")],
    threads: [],
  });

  it("counts each child once, its real thread first", () => {
    expect(
      collectFleetCrossWork([
        {
          askerEnvironmentId: WINDOWS,
          workerEnvironmentId: LINUX,
          threadId: "t1",
          attention: "working",
        },
        {
          askerEnvironmentId: WINDOWS,
          workerEnvironmentId: LINUX,
          threadId: "t1",
          attention: null,
        },
        {
          askerEnvironmentId: WINDOWS,
          workerEnvironmentId: LINUX,
          threadId: "t2",
          attention: "needs-you",
        },
      ]),
    ).toEqual([
      { askerEnvironmentId: WINDOWS, workerEnvironmentId: LINUX, working: 1, needsYou: 1 },
    ]);
  });

  it("draws a link between two other computers, working with dots from the asking one", () => {
    const links: FleetLinksByEnvironment = {
      [WINDOWS]: {
        live: true,
        snapshot: snapshot({
          outbound: [outbound(LINUX, "build box", { connection: "connected" })],
        }),
      },
    };
    const quiet = buildFleetGraphEdges({ model, links, crossWork: [] });
    expect(quiet.find((edge) => edge.key.startsWith("link:"))).toMatchObject({
      state: "connected",
    });
    // What Windows PC said before it went away is no connection now.
    const stale = buildFleetGraphEdges({
      model,
      links: { [WINDOWS]: { ...links[WINDOWS]!, live: false } },
      crossWork: [],
    });
    expect(stale.find((edge) => edge.key.startsWith("link:"))).toMatchObject({
      state: "offline",
    });
    const working = buildFleetGraphEdges({
      model,
      links,
      crossWork: [
        { askerEnvironmentId: LINUX, workerEnvironmentId: WINDOWS, working: 1, needsYou: 0 },
      ],
    });
    expect(working.find((edge) => edge.key.startsWith("link:"))).toMatchObject({
      fromId: LINUX,
      toId: WINDOWS,
      state: "working",
    });
  });

  it("turns this computer's line working, dots from the other computer, when the work runs here", () => {
    const edges = buildFleetGraphEdges({
      model,
      links: {},
      crossWork: [
        { askerEnvironmentId: WINDOWS, workerEnvironmentId: MAC, working: 1, needsYou: 0 },
      ],
    });
    expect(edges.find((edge) => edge.key === `connection:${WINDOWS}`)).toMatchObject({
      fromId: WINDOWS,
      toId: MAC,
      state: "working",
    });
  });
});
