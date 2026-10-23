/**
 * A command in a terminal said the port it wanted is taken: which port, and
 * who holds it (docs/terminal.md, "When a port is taken"). Pure parts only;
 * portNotices.ts looks things up and keeps the notice.
 *
 * Messages are read line by line from what a tab prints. Only a line that
 * names its port counts ("Port 5173 is in use", "listen EADDRINUSE :::3000",
 * "listen tcp :8080: bind: address already in use"); one that doesn't
 * (Python's "[Errno 48] Address already in use") can't say which. A port
 * found is only shown once something really listens on it, so a log that
 * merely mentions an old conflict shows nothing.
 */
import type { TerminalPortHolder } from "@threadlines/contracts";

import {
  providerSessionShieldedPids,
  type ListeningPortRow,
  type ProcessRow,
} from "../diagnostics/ProcessDiagnostics.ts";

/** Cheap first look at output: every message below contains one of these. */
const PORT_IN_USE_HINT =
  /in use|eaddrinuse|already allocated|not available|already running|being used|could not be used/i;

/** "Port 5173 is in use", "Port 8080 was already in use", "Port 6006 is not available". */
const PORT_FIRST_PATTERN =
  /\bport\s+["']?(\d{1,5})["']?\s+(?:is|was)\s+(?:already\s+)?(?:in\s+use|being\s+used|taken|occupied|not\s+available)/gi;
/** "Something is already running on port 3000", Postgres' "already running on port 5432?". */
const RUNNING_ON_PORT_PATTERN = /already\s+running\s+(?:on|at)\s+port\s+(\d{1,5})\b/gi;
/** Bun: "Is port 3000 in use?". Parcel: `Port "1234" could not be used`. */
const QUESTION_PATTERN =
  /\bis\s+port\s+(\d{1,5})\s+in\s+use|\bport\s+["']?(\d{1,5})["']?\s+could\s+not\s+be\s+used/gi;
/** A line about a bind that failed; its port is somewhere else on the line. */
const BIND_FAILURE_PATTERN =
  /eaddrinuse|address\s+(?:already\s+)?in\s+use|port is already allocated/i;
/**
 * Docker failing to publish a container's port on this computer: unlike an
 * error printed inside a container, the port it names is this computer's.
 */
const HOST_BINDING_PATTERN = /port is already allocated|userland proxy/i;
/**
 * Where a port appears on a bind failure line: the end of an address
 * (`127.0.0.1:5173`, `:::3000`, `[::1]:3000`, `localhost:8000`), `port 3000`,
 * or Python's `('127.0.0.1', 8000)`.
 */
const PORT_MENTION_PATTERN =
  /(?:[\w.\-[\]]*:)+(\d{1,5})\b|\bport\s+(\d{1,5})\b|\(\s*['"][^'"]*['"]\s*,\s*(\d{1,5})\s*\)/gi;
/**
 * Clock times ("12:01:33", "2026-10-23T12:01:33.120Z") look like addresses.
 * Not one right after a dot or colon: `0.0.0.0:80` is an address.
 */
const TIME_PATTERN = /(?<![\d.:])\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?Z?(?![\d:])/g;
// Escape sequences: CSI (colors, cursor moves), OSC (titles, links), and the
// two-character ones.
const ANSI_PATTERN = new RegExp(
  String.raw`\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]`,
  "g",
);

/** The longest unfinished line kept between chunks; a message is shorter. */
const MAX_TAIL_CHARS = 512;

function toPort(text: string | undefined): number | null {
  if (text === undefined) return null;
  const port = Number.parseInt(text, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function mentionedPorts(text: string): number[] {
  const ports: number[] = [];
  for (const match of text.matchAll(PORT_MENTION_PATTERN)) {
    const port = toPort(match[1] ?? match[2] ?? match[3]);
    if (port !== null) ports.push(port);
  }
  return ports;
}

/** The ports one line of plain text (no escape sequences) says are taken. */
export function findPortsInUse(line: string): number[] {
  const found = new Set<number>();
  for (const pattern of [PORT_FIRST_PATTERN, RUNNING_ON_PORT_PATTERN, QUESTION_PATTERN]) {
    for (const match of line.matchAll(pattern)) {
      const port = toPort(match[1] ?? match[2]);
      if (port !== null) found.add(port);
    }
  }
  if (found.size > 0) return [...found];
  const text = line.replace(TIME_PATTERN, " ");
  const failure = BIND_FAILURE_PATTERN.exec(text);
  if (failure === null) return [];
  // The address usually follows the error ("EADDRINUSE: ... :::3000"); Go
  // and PHP put it first ("listen tcp :8080: bind: address already in use").
  const port =
    mentionedPorts(text.slice(failure.index))[0] ??
    mentionedPorts(text.slice(0, failure.index)).at(-1);
  return port === undefined ? [] : [port];
}

/** A port a line said is taken. `hostBinding`: Docker publishing on this computer. */
export interface PortInUseMention {
  readonly port: number;
  readonly hostBinding: boolean;
}

/**
 * Reads a tab's output as it comes, a chunk at a time (`text` may still hold
 * colors): the ports it says are taken, from finished lines and from the
 * line still being written, since a question waiting for an answer has no
 * newline yet. Digits at the very end of that line may go on in the next
 * chunk, so they wait. Keeps the unfinished line in `state.tail`. The same
 * port can come back while its line grows; callers keep what they handled.
 */
export function scanPortsInUse(state: { tail: string }, text: string): PortInUseMention[] {
  const combined = `${state.tail}${text}`;
  const lines = combined.split(/\r\n|\n|\r/);
  const last = lines.at(-1) ?? "";
  state.tail = last.length > MAX_TAIL_CHARS ? last.slice(-MAX_TAIL_CHARS) : last;
  if (!PORT_IN_USE_HINT.test(combined)) return [];
  const found = new Map<number, PortInUseMention>();
  lines.forEach((line, index) => {
    if (!PORT_IN_USE_HINT.test(line)) return;
    let plain = line.replace(ANSI_PATTERN, "");
    if (index === lines.length - 1) plain = plain.replace(/\d+$/, "");
    const hostBinding = HOST_BINDING_PATTERN.test(plain);
    for (const port of findPortsInUse(plain)) found.set(port, { port, hostBinding });
  });
  return [...found.values()];
}

const RUNTIME_PROGRAMS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby"]);
const pathTail = (token: string) => token.split(/[\\/]/).at(-1) ?? token;

/** The head of a command line: a quoted path, a Windows one with spaces, or the first word. */
function commandHead(command: string): { readonly head: string; readonly rest: string } {
  const trimmed = command.trim();
  const quoted = /^["']([^"']+)["']\s*/.exec(trimmed);
  if (quoted) return { head: quoted[1]!, rest: trimmed.slice(quoted[0].length) };
  const exe = /^(.*?\.exe)(?:\s+|$)/i.exec(trimmed);
  if (exe) return { head: exe[1]!, rest: trimmed.slice(exe[0].length) };
  const [head = "", ...rest] = trimmed.split(/\s+/);
  return { head, rest: rest.join(" ") };
}

/** A process's name: its program's file name, from its command line. */
export function programName(command: string): string | null {
  const name = pathTail(commandHead(command).head).trim();
  return name.length > 0 ? name : null;
}

/**
 * A command line as a person would have typed it: paths cut to their last
 * part, and a runtime in front of a script left out (`node
 * /repo/node_modules/.bin/vite` is `vite`).
 */
export function shortCommand(command: string): string | null {
  const { head, rest } = commandHead(command);
  const words = rest.length > 0 ? rest.split(/\s+/) : [];
  const program = pathTail(head);
  const script = words[0];
  const parts =
    script !== undefined &&
    /[\\/]/.test(script) &&
    RUNTIME_PROGRAMS.has(program.toLowerCase().replace(/\.exe$/, ""))
      ? words
      : [program, ...words];
  const text = parts
    .map((word, index) => (index === 0 || /^[./~]|^[A-Za-z]:\\/.test(word) ? pathTail(word) : word))
    .join(" ")
    .trim();
  if (text.length === 0) return null;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The processes listening on a port, in a stable order. */
export function listenerPidsOf(rows: ReadonlyArray<ListeningPortRow>, port: number): number[] {
  return [...new Set(rows.filter((row) => row.port === port).map((row) => row.pid))].sort(
    (left, right) => left - right,
  );
}

/** A terminal tab of this server, by the pid of its shell. */
export interface TerminalShell {
  readonly threadId: string;
  readonly terminalId: string;
}

/** Who holds a port, as seen once. */
export interface PortHolding {
  /** Everyone listening on it, a terminal tab first; one each. */
  readonly holders: ReadonlyArray<TerminalPortHolder>;
  /** The processes listening then, to tell when that changes. */
  readonly listenerPids: ReadonlyArray<number>;
  /** The shell pid behind each terminal holder, to tell when the tab restarts. */
  readonly holderShellPids: ReadonlyArray<number>;
  /**
   * When one job of one tab holds it all: that job's process group (a group
   * of its own, never the shell's), which Stop interrupts as Ctrl+C would.
   * Null where processes have no groups (Windows) or anything else is unsure.
   */
  readonly stoppable: { readonly pgid: number; readonly shellPid: number } | null;
}

function holderKey(holder: TerminalPortHolder): string {
  return holder.kind === "terminal"
    ? `terminal:${holder.threadId}:${holder.terminalId}`
    : `${holder.kind}:${holder.pid}`;
}

/** Whether two holdings name the same holders and can be stopped the same way. */
export function sameHolding(left: PortHolding, right: PortHolding): boolean {
  return (
    left.holders.length === right.holders.length &&
    left.holders.every((holder, index) => {
      const other = right.holders[index];
      return (
        other !== undefined &&
        holderKey(holder) === holderKey(other) &&
        JSON.stringify(holder) === JSON.stringify(other)
      );
    }) &&
    left.stoppable?.pgid === right.stoppable?.pgid &&
    left.stoppable?.shellPid === right.stoppable?.shellPid
  );
}

const HOLDER_ORDER: Record<TerminalPortHolder["kind"], number> = {
  terminal: 0,
  agent: 1,
  threadlines: 2,
  process: 3,
};

/**
 * Who listens on `port`. A listener running under one of the tab shells
 * (`terminalShells`, keyed by the shell's pid) belongs to that tab; else to
 * an agent when it runs under a provider session of this server; else it is
 * named as the program it is. A port can have a listener per address family,
 * each its own holder. `command` is the listener's job as typed: the command
 * line of its process group's first process. Null when nothing listens.
 *
 * `wrapperShells` are tab shells running a suggested command
 * (commandRunShell.ts). Its command may get a group of its own or share the
 * wrapper's; the wrapper ignores Ctrl+C itself, so interrupting the shared
 * group stops only the command too.
 */
export function attributePortHolder(input: {
  readonly port: number;
  readonly listeningRows: ReadonlyArray<ListeningPortRow>;
  readonly processRows: ReadonlyArray<ProcessRow>;
  readonly terminalShells: ReadonlyMap<number, TerminalShell>;
  readonly wrapperShells?: ReadonlySet<number>;
  readonly serverPid: number;
}): PortHolding | null {
  const listenerPids = listenerPidsOf(input.listeningRows, input.port);
  if (listenerPids.length === 0) return null;
  const rowByPid = new Map(input.processRows.map((row) => [row.pid, row]));
  const nameOf = (pid: number): string | null => {
    const row = rowByPid.get(pid);
    const fromTable = row ? programName(row.command) : null;
    if (fromTable !== null) return fromTable;
    // netstat names no process, only `PID <n>`.
    const listed = input.listeningRows.find((entry) => entry.pid === pid)?.command ?? "";
    return listed.length > 0 && !/^PID \d+$/.test(listed) ? listed : null;
  };
  const jobOf = (pid: number, shellPid: number | null): string | null => {
    const row = rowByPid.get(pid);
    const pgid = row?.pgid ?? null;
    const leader = pgid !== null && pgid !== shellPid ? rowByPid.get(pgid) : undefined;
    const command = leader?.command ?? row?.command;
    return command === undefined ? null : shortCommand(command);
  };
  const shellAbove = (pid: number): number | null => {
    const seen = new Set<number>();
    for (let current: number | undefined = pid; current !== undefined && current > 1;) {
      if (seen.has(current)) return null;
      seen.add(current);
      if (input.terminalShells.has(current)) return current;
      if (current === input.serverPid) return null;
      current = rowByPid.get(current)?.ppid;
    }
    return null;
  };
  const agentPids = providerSessionShieldedPids(input.processRows, input.serverPid);

  const holders = new Map<string, TerminalPortHolder>();
  const holderShellPids = new Set<number>();
  const terminalListeners: Array<{ readonly pid: number; readonly shellPid: number }> = [];
  for (const pid of listenerPids) {
    const shellPid = shellAbove(pid);
    let holder: TerminalPortHolder;
    if (shellPid !== null) {
      const shell = input.terminalShells.get(shellPid)!;
      holder = {
        kind: "terminal",
        threadId: shell.threadId,
        terminalId: shell.terminalId,
        pid,
        name: nameOf(pid),
        command: jobOf(pid, shellPid),
      };
      holderShellPids.add(shellPid);
      terminalListeners.push({ pid, shellPid });
    } else if (pid === input.serverPid) {
      holder = { kind: "threadlines", pid };
    } else if (agentPids.has(pid)) {
      holder = { kind: "agent", pid, name: nameOf(pid), command: jobOf(pid, null) };
    } else {
      holder = { kind: "process", pid, name: nameOf(pid), command: jobOf(pid, null) };
    }
    const key = holderKey(holder);
    if (!holders.has(key)) holders.set(key, holder);
  }

  const ordered = [...holders.values()].sort(
    (left, right) => HOLDER_ORDER[left.kind] - HOLDER_ORDER[right.kind],
  );
  // Stop interrupts one job: only when that job is all that holds the port.
  const groups = new Set(terminalListeners.map(({ pid }) => rowByPid.get(pid)?.pgid ?? null));
  const [pgid] = groups;
  const shellPid = terminalListeners[0]?.shellPid ?? null;
  const shellGroup = shellPid === null ? null : (rowByPid.get(shellPid)?.pgid ?? shellPid);
  const ownGroup =
    pgid !== undefined &&
    pgid !== null &&
    pgid > 1 &&
    shellPid !== null &&
    ((pgid !== shellPid && pgid !== shellGroup) ||
      (input.wrapperShells?.has(shellPid) === true && pgid === shellGroup));
  const stoppable =
    ordered.length === 1 && ordered[0]!.kind === "terminal" && groups.size === 1 && ownGroup
      ? { pgid: pgid!, shellPid: shellPid! }
      : null;
  return { holders: ordered, listenerPids, holderShellPids: [...holderShellPids], stoppable };
}

const REMOTE_PROGRAMS = new Set([
  "ssh",
  "autossh",
  "mosh",
  "mosh-client",
  "et",
  "telnet",
  "wsl",
  "vagrant",
]);
const CONTAINER_PROGRAMS = new Set(["docker", "podman", "nerdctl", "kubectl", "oc", "lima"]);

/** The program a typed command line runs, past `sudo`, `env` and `VAR=value` words. */
function typedProgram(command: string): string | null {
  for (const word of command.trim().split(/\s+/)) {
    if (word === "sudo" || word === "env" || word === "exec" || /^\w+=/.test(word)) continue;
    return (programName(word) ?? "").toLowerCase().replace(/\.exe$/, "");
  }
  return null;
}

/**
 * Whether a typed command line talks to another computer or into a
 * container (see shellReachesElsewhere), for a command that may already
 * have ended by the time the process table is read.
 */
export function commandReachesElsewhere(command: string): "remote" | "container" | null {
  const program = typedProgram(command);
  if (program === null) return null;
  if (REMOTE_PROGRAMS.has(program)) return "remote";
  if (CONTAINER_PROGRAMS.has(program) && !/\sport-forward(?:\s|$)/.test(command)) {
    return "container";
  }
  return null;
}

/**
 * Whether what a tab prints may come from somewhere else: a program under
 * its shell talks to another computer (ssh) or into a container, whose ports
 * aren't this computer's. `kubectl port-forward` listens here, so it doesn't
 * count.
 */
export function shellReachesElsewhere(
  rows: ReadonlyArray<ProcessRow>,
  shellPid: number,
): "remote" | "container" | null {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  let found: "remote" | "container" | null = null;
  const stack = [...(children.get(shellPid) ?? [])];
  const seen = new Set<number>([shellPid]);
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    const program = (programName(row.command) ?? "").toLowerCase().replace(/\.exe$/, "");
    if (REMOTE_PROGRAMS.has(program)) return "remote";
    if (CONTAINER_PROGRAMS.has(program) && !/\sport-forward(?:\s|$)/.test(row.command)) {
      found = "container";
    }
    stack.push(...(children.get(row.pid) ?? []));
  }
  return found;
}
