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
}

/** Addresses that a browser on this machine can actually reach. */
function isLocallyReachable(address: string): boolean {
  const host = address.slice(0, address.lastIndexOf(":"));
  return (
    host === "*" ||
    host === "" ||
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "[::]"
  );
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
    if (value.includes("->") || !isLocallyReachable(value)) {
      continue;
    }
    const port = Number.parseInt(value.slice(value.lastIndexOf(":") + 1), 10);
    if (Number.isNaN(port) || port <= 0) {
      continue;
    }
    // The same port often appears twice, once per address family. One entry.
    if (!byPort.has(port)) {
      byPort.set(port, { port, processName, pid });
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
