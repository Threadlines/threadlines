import { describe, expect, it } from "vite-plus/test";

import { deviceDisplayName, deviceDisplayNames, type NamedDevice } from "./deviceNames";

const formatPaired = (issuedAt: string, withTime: boolean) =>
  withTime ? issuedAt.slice(5, 16).replace("T", " ") : issuedAt.slice(5, 10);

function device(sessionId: string, issuedAt: string, client: NamedDevice["client"]): NamedDevice {
  return { sessionId, issuedAt, client };
}

describe("deviceDisplayNames", () => {
  it("shows the name the user gave a device over the one it gave itself", () => {
    expect(
      deviceDisplayName({ deviceType: "mobile", label: "iPhone", name: "Will's iPhone" }),
    ).toBe("Will's iPhone");
    expect(deviceDisplayName({ deviceType: "mobile", label: "iPhone" })).toBe("iPhone");
    expect(deviceDisplayName({ deviceType: "desktop", os: "Windows", browser: "Edge" })).toBe(
      "Windows · Edge",
    );
    expect(deviceDisplayName({ deviceType: "tablet" })).toBe("Tablet");
  });

  it("tells apart unnamed devices that would read the same by when they paired", () => {
    const names = deviceDisplayNames(
      [
        device("a", "2026-10-20T09:15:00.000Z", { deviceType: "mobile", label: "iPhone" }),
        device("b", "2026-10-22T18:40:00.000Z", { deviceType: "mobile", label: "iPhone" }),
        device("c", "2026-10-22T19:05:00.000Z", { deviceType: "mobile", label: "iPhone" }),
        device("d", "2026-10-21T08:00:00.000Z", { deviceType: "tablet", label: "iPad" }),
      ],
      formatPaired,
    );
    expect(Object.fromEntries(names)).toEqual({
      a: "iPhone (paired 10-20)",
      // Paired the same day: the time tells them apart.
      b: "iPhone (paired 10-22 18:40)",
      c: "iPhone (paired 10-22 19:05)",
      d: "iPad",
    });
  });

  it("keeps a named device's name, and still tells an unnamed one apart from it", () => {
    const names = deviceDisplayNames(
      [
        device("named", "2026-10-20T09:15:00.000Z", {
          deviceType: "mobile",
          label: "iPhone",
          name: "iPhone",
        }),
        device("unnamed", "2026-10-22T18:40:00.000Z", { deviceType: "mobile", label: "iPhone" }),
        device("work", "2026-10-23T08:00:00.000Z", {
          deviceType: "mobile",
          label: "iPhone",
          name: "Work phone",
        }),
      ],
      formatPaired,
    );
    expect(Object.fromEntries(names)).toEqual({
      named: "iPhone",
      unnamed: "iPhone (paired 10-22)",
      work: "Work phone",
    });
  });
});
