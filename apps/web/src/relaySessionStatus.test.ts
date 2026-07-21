import { describe, expect, it } from "vite-plus/test";

import { assessRelaySessionProbe } from "./relaySessionStatus";

function statusProbe(status: { exists: boolean; expired: boolean; desktopConnected: boolean }) {
  return {
    kind: "status",
    status: { ...status, expiresAt: "2026-07-21T00:00:00.000Z" },
  } as const;
}

describe("assessRelaySessionProbe", () => {
  it("treats deleted, expired, and refused sessions as terminal", () => {
    expect(
      assessRelaySessionProbe(
        statusProbe({ exists: false, expired: false, desktopConnected: false }),
      ),
    ).toBe("link-invalid");
    expect(
      assessRelaySessionProbe(statusProbe({ exists: true, expired: true, desktopConnected: true })),
    ).toBe("link-invalid");
    // Covers both a bad token and an origin the relay rejects (both close the
    // WebSocket invisibly, so the probe is the only signal).
    expect(assessRelaySessionProbe({ kind: "unauthorized" })).toBe("link-invalid");
  });

  it("distinguishes a live session with the desktop away from one that is bridged", () => {
    expect(
      assessRelaySessionProbe(
        statusProbe({ exists: true, expired: false, desktopConnected: false }),
      ),
    ).toBe("desktop-offline");
    expect(
      assessRelaySessionProbe(
        statusProbe({ exists: true, expired: false, desktopConnected: true }),
      ),
    ).toBe("desktop-connected");
  });

  it("stays indeterminate when the relay cannot be reached at all", () => {
    expect(assessRelaySessionProbe(null)).toBe("indeterminate");
    expect(assessRelaySessionProbe({ kind: "unreachable", message: "offline" })).toBe(
      "indeterminate",
    );
  });
});
