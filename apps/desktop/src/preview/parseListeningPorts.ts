/**
 * Parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`.
 *
 * `-F` emits one field per line behind a single-character tag, which is the
 * only lsof output worth depending on: the human-readable table changes shape
 * between versions and locales. Tags arrive in sets -- `p` (pid) and `c`
 * (command) describe the process, and every `n` (address) line after them
 * belongs to that process until the next `p`.
 */

export interface ListeningPort {
  port: number;
  processName: string;
  pid: number;
  /**
   * The loopback address the listener actually accepts connections on. A
   * server bound only to ::1 (Node resolves "localhost" that way on some
   * machines) refuses 127.0.0.1, so probing the wrong family reports a live
   * server as absent.
   */
  probeHost: "127.0.0.1" | "::1";
}

/** Maps a bound address to the loopback it is reachable at, or null for none. */
function loopbackProbeHost(address: string): "127.0.0.1" | "::1" | null {
  const host = address.slice(0, address.lastIndexOf(":"));
  switch (host) {
    case "*":
    case "":
    case "0.0.0.0":
    case "127.0.0.1":
    case "localhost":
      return "127.0.0.1";
    case "[::1]":
    case "::1":
    case "[::]":
      return "::1";
    default:
      return null;
  }
}

export function parseListeningPorts(lsofOutput: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  let pid: number | null = null;
  let processName = "";

  for (const line of lsofOutput.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isNaN(parsed) ? null : parsed;
      // A new process clears the previous command: pairing an address with the
      // wrong name is worse than showing none.
      processName = "";
      continue;
    }
    if (tag === "c") {
      processName = value;
      continue;
    }
    if (tag !== "n" || pid === null) {
      continue;
    }
    // IPv6 arrives bracketed, and lsof writes "->" for established
    // connections; a listener has no peer.
    const probeHost = value.includes("->") ? null : loopbackProbeHost(value);
    if (probeHost === null) {
      continue;
    }
    const port = Number.parseInt(value.slice(value.lastIndexOf(":") + 1), 10);
    if (Number.isNaN(port) || port <= 0) {
      continue;
    }
    // The same port often appears twice, once per address family: one entry,
    // probed over IPv4 when either family accepts it.
    const existing = byPort.get(port);
    if (existing === undefined) {
      byPort.set(port, { port, processName, pid, probeHost });
    } else if (probeHost === "127.0.0.1") {
      existing.probeHost = probeHost;
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
