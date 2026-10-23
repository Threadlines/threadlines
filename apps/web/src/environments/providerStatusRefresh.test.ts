import { EnvironmentId, ProviderInstanceId } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { backendRefresh, remoteRefresh, applyProvidersUpdated, connections } = vi.hoisted(() => ({
  backendRefresh: vi.fn(async () => ({ providers: [] })),
  remoteRefresh: vi.fn(async () => ({ providers: [] })),
  applyProvidersUpdated: vi.fn(),
  connections: new Map<string, unknown>(),
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ server: { refreshProviders: backendRefresh } }),
}));
vi.mock("../rpc/serverState", () => ({ applyProvidersUpdated }));
vi.mock("./runtime/service", () => ({
  readBackendEnvironmentConnection: () => ({ environmentId: "this-computer" }),
  readEnvironmentConnection: (environmentId: string) => connections.get(environmentId) ?? null,
}));

import { refreshProviderStatus } from "./providerStatusRefresh";

describe("refreshProviderStatus", () => {
  it("asks the computer the thread runs on, not always the app's own", async () => {
    const instanceId = ProviderInstanceId.make("codex");
    const macMini = EnvironmentId.make("mac-mini");
    connections.set(macMini, { client: { server: { refreshProviders: remoteRefresh } } });

    await refreshProviderStatus({ environmentId: macMini, instanceId });
    expect(remoteRefresh).toHaveBeenCalledWith({ instanceId });
    expect(backendRefresh).not.toHaveBeenCalled();
    // Mac mini's own config stream brings its answer; the app's stays as is.
    expect(applyProvidersUpdated).not.toHaveBeenCalled();

    await refreshProviderStatus({ environmentId: EnvironmentId.make("this-computer"), instanceId });
    expect(backendRefresh).toHaveBeenCalledWith({ instanceId });
    expect(applyProvidersUpdated).toHaveBeenCalledTimes(1);

    await expect(
      refreshProviderStatus({ environmentId: EnvironmentId.make("studio"), instanceId }),
    ).rejects.toThrow("The computer this thread runs on isn't connected right now.");
  });
});
