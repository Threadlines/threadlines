import { RELAY_DEVICE_SESSION_SUBJECT } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_BOOTSTRAP_SUBJECT } from "../auth/utils.ts";
import { sessionDevicePlace } from "./messageSentFrom.ts";

describe("sessionDevicePlace", () => {
  const ownAddresses = () => new Set(["192.168.1.20", "100.64.0.7"]);
  const signedIn = (subject: string, ipAddress?: string) => ({
    subject,
    client: { deviceType: "desktop" as const, ...(ipAddress ? { ipAddress } : {}) },
  });

  it("places only the app's own window here, and never a proxy's connection", () => {
    const places = [
      sessionDevicePlace(signedIn(DESKTOP_BOOTSTRAP_SUBJECT, "127.0.0.1"), ownAddresses),
      sessionDevicePlace(signedIn(RELAY_DEVICE_SESSION_SUBJECT), ownAddresses),
      sessionDevicePlace(signedIn("paired", "192.168.1.31"), ownAddresses),
      // Tailscale Serve or an SSH tunnel hands another computer on from here.
      sessionDevicePlace(signedIn("paired", "127.0.0.1"), ownAddresses),
      sessionDevicePlace(signedIn("paired", "::1"), ownAddresses),
      sessionDevicePlace(signedIn("paired", "100.64.0.7"), ownAddresses),
      sessionDevicePlace(signedIn("paired"), ownAddresses),
    ];
    expect(places).toEqual([
      "here",
      "elsewhere",
      "elsewhere",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
