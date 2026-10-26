import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetModel,
  describeComputerLocation,
  describeFleetSummary,
  describeQuietComputers,
  type FleetComputerInput,
  type FleetThreadInput,
  type LinkedDeviceSession,
  linkedDeviceInputs,
  primaryConnectionFrom,
  resolveConnectionLineState,
  savedComputerInput,
  resolveProviderLineState,
} from "./fleet.logic";

const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const MACBOOK = EnvironmentId.make("env-macbook");
const WINDOWS = EnvironmentId.make("env-windows");
const MAC_MINI = EnvironmentId.make("env-mac-mini");
const CLAUDE = ProviderInstanceId.make("claude");
const CODEX = ProviderInstanceId.make("codex");

function computer(
  overrides: Partial<FleetComputerInput> & Pick<FleetComputerInput, "id" | "label">,
): FleetComputerInput {
  return {
    environmentId: overrides.id as EnvironmentId,
    kind: "computer",
    glyph: "monitor",
    connection: "connected",
    route: "network",
    lastSeenAt: null,
    ...overrides,
  };
}

function thread(
  id: string,
  environmentId: EnvironmentId,
  overrides: Partial<FleetThreadInput> = {},
): FleetThreadInput {
  return {
    threadKey: `${environmentId}:${id}`,
    environmentId,
    threadId: ThreadId.make(id),
    title: id,
    projectLabel: "Orbit",
    status: null,
    attention: null,
    sessionLive: false,
    provider: { instanceId: CLAUDE, driverKind: "claudeAgent" },
    modelSelection: null,
    startedByTitle: null,
    startedByComputer: null,
    ...overrides,
  };
}

describe("buildFleetModel", () => {
  const model = buildFleetModel({
    center: computer({ id: MACBOOK, label: "MacBook Pro", kind: "this", route: null }),
    others: [
      computer({ id: WINDOWS, label: "Windows PC" }),
      computer({
        id: MAC_MINI,
        label: "Mac mini",
        connection: "offline",
        lastSeenAt: "2026-10-20T10:00:00.000Z",
      }),
      computer({
        id: "device:phone",
        environmentId: null,
        kind: "device",
        label: "iPhone",
        glyph: "phone",
        connection: "connected",
        route: "relay",
      }),
    ],
    threads: [
      thread("charges", MACBOOK, { attention: "working", sessionLive: true }),
      thread("guard", MACBOOK, { attention: "working", sessionLive: true }),
      // A warm agent with nothing to do still has its node, with no count.
      thread("usage", MACBOOK, {
        sessionLive: true,
        provider: { instanceId: CODEX, driverKind: "codex" },
      }),
      // A cold, quiet thread puts nothing in the graph.
      thread("old", MACBOOK, { provider: { instanceId: null, driverKind: "cursor" } }),
      thread("tests", WINDOWS, {
        attention: "working",
        sessionLive: true,
        provider: { instanceId: CODEX, driverKind: "codex" },
        startedByTitle: "charges",
      }),
      thread("installer", WINDOWS, { attention: "needs-you", sessionLive: true }),
    ],
  });

  it("counts each computer's work and its agents, needs-you first in its list", () => {
    expect(model.center.work).toBe("working");
    expect(model.center.providers.map((provider) => [provider.key, provider.working])).toEqual([
      ["claude", 2],
      ["codex", 0],
    ]);
    // Others by name, so the graph holds still as computers come and go.
    expect(model.others.map((other) => other.label)).toEqual(["iPhone", "Mac mini", "Windows PC"]);
    const windows = model.others.find((other) => other.id === WINDOWS)!;
    // Needs you outranks working on the node: it is what the user must act on.
    expect(windows.work).toBe("needs-you");
    expect(windows.threads.map((entry) => entry.title)).toEqual(["installer", "tests"]);
    expect({ working: model.working, needsYou: model.needsYou }).toEqual({
      working: 3,
      needsYou: 1,
    });
  });

  it("says it in a line, with the quiet computers summed up apart", () => {
    expect(describeFleetSummary(model)).toBe(
      "3 working and 1 needs you, on 2 computers. Mac mini is offline.",
    );
    expect(describeQuietComputers(model.others, NOW_MS)).toBe(
      "iPhone is idle. Mac mini was last seen 2h ago.",
    );
    const mini = model.others.find((other) => other.id === MAC_MINI)!;
    expect(describeComputerLocation(mini, NOW_MS)).toBe("Offline · 2h ago");
    expect(describeComputerLocation(model.center, NOW_MS)).toBe("This computer");
  });

  it("notes a recent freeze or sleep beside a connected computer, for ten minutes", () => {
    const froze = {
      ...model.center,
      recentStall: {
        stall: { id: "a-1", cause: "busy" as const, durationMs: 7_000, agoMs: 0 },
        endedAtMs: NOW_MS - 3 * 60_000,
      },
    };
    expect(describeComputerLocation(froze, NOW_MS)).toBe("This computer · Froze 3 min ago");
    expect(describeComputerLocation(froze, NOW_MS + 8 * 60_000)).toBe("This computer");
    // Gone again: how long it has been gone says more.
    expect(describeComputerLocation({ ...froze, connection: "offline" }, NOW_MS)).not.toMatch(
      /Froze/,
    );
  });

  it("draws a line by its connection first, then by the work at its end", () => {
    const [phone, mini, windows] = model.others;
    expect(resolveConnectionLineState(windows!)).toBe("working");
    expect(resolveConnectionLineState(mini!)).toBe("offline");
    expect(resolveConnectionLineState(phone!)).toBe("connected");
    const windowsClaude = windows!.providers.find((provider) => provider.key === "claude")!;
    expect(resolveProviderLineState(windows!, windowsClaude)).toBe("needs-you");
    const reconnecting = { ...windows!, connection: "reconnecting" as const };
    expect(resolveConnectionLineState(reconnecting)).toBe("reconnecting");
  });

  it("shows this computer down when the app loses its own link, with no dots to its agents", () => {
    const down = buildFleetModel({
      center: computer({
        id: MACBOOK,
        label: "MacBook Pro",
        kind: "this",
        route: null,
        connection: primaryConnectionFrom("reconnecting"),
      }),
      others: [],
      threads: [thread("charges", MACBOOK, { attention: "working", sessionLive: true })],
    });
    expect(describeComputerLocation(down.center, NOW_MS)).toBe("This computer · Reconnecting");
    expect(resolveProviderLineState(down.center, down.center.providers[0]!)).toBe("offline");
    expect(primaryConnectionFrom("error")).toBe("offline");
  });
});

describe("savedComputerInput", () => {
  function savedComputer(environmentId: EnvironmentId, label: string, connected: boolean) {
    return savedComputerInput(
      {
        environmentId,
        label,
        wsBaseUrl: `wss://${environmentId}.test/ws`,
        httpBaseUrl: `https://${environmentId}.test`,
        createdAt: "2026-10-01T00:00:00.000Z",
        lastConnectedAt: "2026-10-20T10:00:00.000Z",
      },
      {
        connectionState: connected ? "connected" : "disconnected",
        authState: "authenticated",
        lastError: null,
        lastErrorAt: null,
        role: "owner",
        // Both report the same system name.
        descriptor: {
          label: "Denys's MacBook Pro",
          platform: { os: "darwin", arch: "arm64" },
        } as ExecutionEnvironmentDescriptor,
        serverConfig: null,
        connectedAt: null,
        disconnectedAt: connected ? null : "2026-10-20T10:00:00.000Z",
        route: connected ? "direct" : null,
        waitingToReconnect: false,
        disconnectedByUser: false,
      },
    );
  }

  it("names a computer as the user saved it, everywhere the page says it", () => {
    const model = buildFleetModel({
      center: computer({ id: MACBOOK, label: "MacBook Pro", kind: "this", route: null }),
      others: [
        savedComputer(WINDOWS, "Test PC", true),
        savedComputer(MAC_MINI, "Studio Mac", false),
      ],
      threads: [thread("tests", WINDOWS, { attention: "working", sessionLive: true })],
    });
    expect(model.others.map((other) => other.label)).toEqual(["Studio Mac", "Test PC"]);
    expect(describeFleetSummary(model)).toBe("1 working, on 1 computer. Studio Mac is offline.");
    expect(describeQuietComputers(model.others, NOW_MS)).toBe("Studio Mac was last seen 2h ago.");
    // With no name saved, the one it reports stands in.
    expect(savedComputer(WINDOWS, "  ", true).label).toBe("Denys's MacBook Pro");
  });
});

describe("linkedDeviceInputs", () => {
  function session(sessionId: string, overrides: Partial<LinkedDeviceSession> = {}) {
    return {
      sessionId,
      issuedAt: "2026-10-20T10:00:00.000Z",
      subject: "relay-device",
      current: false,
      connected: true,
      lastConnectedAt: null,
      client: { deviceType: "mobile", os: "iOS", browser: "Safari" },
      ...overrides,
    } satisfies LinkedDeviceSession;
  }

  it("draws each phone and tablet session, two with the same name told apart", () => {
    const devices = linkedDeviceInputs(
      [
        session("first-iphone"),
        session("second-iphone", { issuedAt: "2026-10-22T10:00:00.000Z" }),
        // This window, and a desktop browser, are not linked devices.
        session("this-window", { current: true }),
        session("laptop", { client: { deviceType: "desktop" } }),
        session("ipad", {
          subject: "owner",
          connected: false,
          client: { deviceType: "tablet", label: "Studio iPad" },
        }),
      ],
      "relay-device",
    );
    expect(devices.map((device) => [device.id, device.route])).toEqual([
      ["device:first-iphone", "relay"],
      ["device:second-iphone", "relay"],
      ["device:ipad", "network"],
    ]);
    const [first, second, ipad] = devices.map((device) => device.label);
    expect(first).toMatch(/^iOS · Safari \(paired .+\)$/);
    expect(second).toMatch(/^iOS · Safari \(paired .+\)$/);
    expect(first).not.toBe(second);
    expect(ipad).toBe("Studio iPad");
  });
});
