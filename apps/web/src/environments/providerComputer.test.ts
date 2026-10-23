import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { state } = vi.hoisted(() => ({
  state: {
    backend: null as { environmentId: string; client: { providerAuth: unknown } } | null,
    connections: new Map<string, { client: { providerAuth: unknown } }>(),
    desktopOwnServer: false,
  },
}));

vi.mock("./runtime/service", () => ({
  readBackendEnvironmentConnection: () => state.backend,
  readEnvironmentConnection: (environmentId: string) =>
    state.connections.get(environmentId) ?? null,
  subscribeEnvironmentConnections: () => () => undefined,
}));
vi.mock("./primary/target", () => ({
  isPrimaryEnvironmentOnThisComputer: () => state.desktopOwnServer,
}));

import { isProviderComputerThisOne, readProviderAuthClient } from "./providerComputer";

describe("readProviderAuthClient", () => {
  it("asks the computer that runs the agent, and on a phone the computer it's looking at", () => {
    const desktopAuth = { name: "this computer" };
    const macAuth = { name: "Mac mini" };
    const macMini = EnvironmentId.make("mac-mini");
    state.connections.set(macMini, { client: { providerAuth: macAuth } });

    // The desktop app: its own server is the backend.
    state.backend = { environmentId: "this-computer", client: { providerAuth: desktopAuth } };
    state.desktopOwnServer = true;
    expect(readProviderAuthClient(macMini)).toBe(macAuth);
    expect(readProviderAuthClient(null)).toBe(desktopAuth);
    expect(readProviderAuthClient(EnvironmentId.make("this-computer"))).toBe(desktopAuth);
    expect(isProviderComputerThisOne(null)).toBe(true);
    expect(isProviderComputerThisOne(macMini)).toBe(false);
    // Not connected: nothing to call, rather than this computer standing in.
    expect(readProviderAuthClient(EnvironmentId.make("studio"))).toBeNull();

    // A phone has no computer of its own: the one it's on answers, and
    // nothing it signs in runs on the phone.
    state.backend = { environmentId: macMini, client: { providerAuth: macAuth } };
    state.desktopOwnServer = false;
    expect(readProviderAuthClient(null)).toBe(macAuth);
    expect(readProviderAuthClient(macMini)).toBe(macAuth);
    expect(isProviderComputerThisOne(macMini)).toBe(false);
  });
});
