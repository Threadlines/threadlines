import { describe, expect, it } from "vite-plus/test";

import type { RelaySessionStatusProbe } from "../relaySessionStatus";
import {
  deriveSavedEnvironmentOverlayPhase,
  describeSavedEnvironmentOverlay,
  OVERLAY_INITIAL_GRACE_MS,
  OVERLAY_RECONNECT_GRACE_MS,
  type SavedEnvironmentOverlayInput,
} from "./SavedEnvironmentConnectionOverlay";

function makeInput(
  overrides: Partial<SavedEnvironmentOverlayInput> = {},
): SavedEnvironmentOverlayInput {
  return {
    connectionState: "disconnected",
    authState: "unknown",
    online: true,
    hasConnectedThisLoad: false,
    msSinceDisconnect: 60_000,
    probe: null,
    ...overrides,
  };
}

function statusProbe(
  overrides: Partial<{
    exists: boolean;
    expired: boolean;
    desktopConnected: boolean;
  }> = {},
): RelaySessionStatusProbe {
  return {
    kind: "status",
    status: {
      exists: true,
      expired: false,
      desktopConnected: true,
      ...overrides,
    },
  };
}

describe("deriveSavedEnvironmentOverlayPhase", () => {
  it("stays hidden while connected", () => {
    expect(deriveSavedEnvironmentOverlayPhase(makeInput({ connectionState: "connected" }))).toBe(
      "hidden",
    );
  });

  it("stays hidden during the initial connect grace period", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: OVERLAY_INITIAL_GRACE_MS - 1 }),
      ),
    ).toBe("hidden");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: OVERLAY_INITIAL_GRACE_MS }),
      ),
    ).toBe("connecting");
  });

  it("waits out brief reconnect blips after a live session", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({
          hasConnectedThisLoad: true,
          msSinceDisconnect: OVERLAY_RECONNECT_GRACE_MS - 1,
        }),
      ),
    ).toBe("hidden");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({
          hasConnectedThisLoad: true,
          msSinceDisconnect: OVERLAY_RECONNECT_GRACE_MS,
        }),
      ),
    ).toBe("reconnecting");
  });

  it("reports the desktop as offline when the relay has no desktop peer", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ probe: statusProbe({ desktopConnected: false }) }),
      ),
    ).toBe("desktop-offline");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ probe: statusProbe({ desktopConnected: true }) }),
      ),
    ).toBe("connecting");
  });

  it("treats missing or expired relay sessions as terminal without waiting out the grace period", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: 0, probe: statusProbe({ exists: false }) }),
      ),
    ).toBe("link-expired");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: 0, probe: statusProbe({ expired: true }) }),
      ),
    ).toBe("link-expired");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: 0, probe: { kind: "unauthorized" } }),
      ),
    ).toBe("link-expired");
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ msSinceDisconnect: 0, authState: "requires-auth" }),
      ),
    ).toBe("link-expired");
  });

  it("reports browser offline over relay probe results", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({ online: false, probe: statusProbe({ desktopConnected: false }) }),
      ),
    ).toBe("browser-offline");
  });

  it("ignores unreachable probes and keeps reconnecting", () => {
    expect(
      deriveSavedEnvironmentOverlayPhase(
        makeInput({
          hasConnectedThisLoad: true,
          probe: { kind: "unreachable", message: "fetch failed" },
        }),
      ),
    ).toBe("reconnecting");
  });
});

describe("describeSavedEnvironmentOverlay", () => {
  it("offers re-pair instructions for expired phone links", () => {
    const copy = describeSavedEnvironmentOverlay("link-expired", {
      label: "MacBook",
      isRelay: true,
    });
    expect(copy.title).toBe("Phone link expired");
    expect(copy.showRetry).toBe(false);
    expect(copy.description).toContain("create a new phone link");
  });

  it("offers retry while the desktop is offline", () => {
    const copy = describeSavedEnvironmentOverlay("desktop-offline", {
      label: "MacBook",
      isRelay: true,
    });
    expect(copy.showRetry).toBe(true);
    expect(copy.description).toContain("Open Threadlines on your computer");
  });
});
