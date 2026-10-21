import { EnvironmentId, ProviderInstanceId, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetModel,
  describeComputerLocation,
  describeFleetSummary,
  describeQuietComputers,
  type FleetComputerInput,
  type FleetThreadInput,
  resolveConnectionLineState,
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
});
