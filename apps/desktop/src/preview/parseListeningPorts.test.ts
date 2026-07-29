import { describe, expect, it } from "vite-plus/test";

import { parseListeningPorts } from "./parseListeningPorts.ts";

describe("parseListeningPorts", () => {
  it("pairs each address with the process it was listed under", () => {
    const output = ["p123", "cnode", "n*:5173", "p456", "cPython", "n127.0.0.1:8000"].join("\n");

    // Sorted by port, so the lowest listener is first regardless of lsof order.
    expect(parseListeningPorts(output)).toEqual([
      { port: 5173, processName: "node", pid: 123, probeHost: "127.0.0.1" },
      { port: 8000, processName: "Python", pid: 456, probeHost: "127.0.0.1" },
    ]);
  });

  it("collapses a port listed once per address family, preferring IPv4", () => {
    const output = ["p1", "cnode", "n[::1]:3000", "n*:3000"].join("\n");

    expect(parseListeningPorts(output)).toEqual([
      { port: 3000, processName: "node", pid: 1, probeHost: "127.0.0.1" },
    ]);
  });

  it("keeps the IPv6 loopback for a listener bound only to ::1", () => {
    // Node resolving "localhost" to ::1 produces exactly this: a dev server
    // that refuses 127.0.0.1 but serves [::1] fine.
    const output = ["p1", "cnode", "n[::1]:4321"].join("\n");

    expect(parseListeningPorts(output)).toEqual([
      { port: 4321, processName: "node", pid: 1, probeHost: "::1" },
    ]);
  });

  it("ignores addresses this machine's browser cannot reach", () => {
    const output = ["p1", "cnode", "n192.168.1.50:9999", "n*:3000"].join("\n");

    expect(parseListeningPorts(output).map((entry) => entry.port)).toEqual([3000]);
  });

  it("ignores established connections, which are not listeners", () => {
    const output = ["p1", "cnode", "n127.0.0.1:5173->127.0.0.1:62000"].join("\n");

    expect(parseListeningPorts(output)).toEqual([]);
  });

  it("does not attribute a port to the previous process when the command is missing", () => {
    const output = ["p1", "cnode", "n*:3000", "p2", "n*:4000"].join("\n");

    expect(parseListeningPorts(output)).toEqual([
      { port: 3000, processName: "node", pid: 1, probeHost: "127.0.0.1" },
      { port: 4000, processName: "", pid: 2, probeHost: "127.0.0.1" },
    ]);
  });
});
