import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerResolveBackgroundRunsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
  ServerStopBackgroundRunInput,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
  readonly status: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly command: string;
}

const PROCESS_QUERY_TIMEOUT_MS = 15_000;
const POSIX_PROCESS_QUERY_COMMAND = "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=";
const PROCESS_QUERY_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ListeningPortRow {
  readonly port: number;
  readonly pid: number;
  readonly command: string;
}

export interface ProcessDiagnosticsShape {
  readonly read: Effect.Effect<ServerProcessDiagnosticsResult>;
  readonly signal: (input: {
    readonly pid: number;
    readonly signal: ServerProcessSignal;
  }) => Effect.Effect<ServerSignalProcessResult>;
  readonly resolveBackgroundRuns: (input: {
    readonly urls: ReadonlyArray<string>;
    readonly commandHints?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ServerResolveBackgroundRunsResult>;
  readonly stopBackgroundRun: (
    input: ServerStopBackgroundRunInput,
  ) => Effect.Effect<ServerSignalProcessResult>;
}

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  ProcessDiagnosticsShape
>()("threadlines/diagnostics/ProcessDiagnostics") {}

class ProcessDiagnosticsError extends Schema.TaggedErrorClass<ProcessDiagnosticsError>()(
  "ProcessDiagnosticsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
const isProcessDiagnosticsError = Schema.is(ProcessDiagnosticsError);

function toProcessDiagnosticsError(message: string, cause?: unknown): ProcessDiagnosticsError {
  return new ProcessDiagnosticsError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePosixProcessRows(output: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  const rowPattern =
    /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+(\d+)\s+(\S+)\s+(.+)$/;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const match = rowPattern.exec(line);
    if (!match) continue;

    const pidText = match[1];
    const ppidText = match[2];
    const pgidText = match[3];
    const status = match[4];
    const cpuText = match[5];
    const rssText = match[6];
    const elapsed = match[7];
    const command = match[8];
    if (
      pidText === undefined ||
      ppidText === undefined ||
      pgidText === undefined ||
      status === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      elapsed === undefined ||
      command === undefined
    ) {
      continue;
    }

    const pid = parsePositiveInt(pidText);
    const ppid = parseNonNegativeInt(ppidText);
    const pgid = Number.parseInt(pgidText, 10);
    const cpuPercent = parseNumber(cpuText);
    const rssKiB = parseNonNegativeInt(rssText);
    if (
      pid === null ||
      ppid === null ||
      !Number.isInteger(pgid) ||
      cpuPercent === null ||
      rssKiB === null ||
      !status ||
      !elapsed ||
      !command
    ) {
      continue;
    }

    rows.push({
      pid,
      ppid,
      pgid,
      status,
      cpuPercent,
      rssBytes: rssKiB * 1024,
      elapsed,
      command,
    });
  }

  return rows;
}

function normalizeWindowsProcessRow(value: unknown): ProcessRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const pid = typeof record.ProcessId === "number" ? record.ProcessId : null;
  const ppid = typeof record.ParentProcessId === "number" ? record.ParentProcessId : null;
  const commandLine =
    typeof record.CommandLine === "string" && record.CommandLine.trim().length > 0
      ? record.CommandLine
      : typeof record.Name === "string"
        ? record.Name
        : null;
  const workingSet =
    typeof record.WorkingSetSize === "number" && Number.isFinite(record.WorkingSetSize)
      ? Math.max(0, Math.round(record.WorkingSetSize))
      : 0;
  const cpuPercent =
    typeof record.PercentProcessorTime === "number" && Number.isFinite(record.PercentProcessorTime)
      ? Math.max(0, record.PercentProcessorTime)
      : 0;

  if (!pid || pid <= 0 || ppid === null || ppid < 0 || !commandLine) return null;
  return {
    pid,
    ppid,
    pgid: null,
    status: typeof record.Status === "string" && record.Status.length > 0 ? record.Status : "Live",
    cpuPercent,
    rssBytes: workingSet,
    elapsed: "",
    command: commandLine,
  };
}

function parseWindowsProcessRows(output: string): ReadonlyArray<ProcessRow> {
  if (output.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      const row = normalizeWindowsProcessRow(record);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

function normalizeListeningPortRow(value: unknown): ListeningPortRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const port = typeof record.LocalPort === "number" ? record.LocalPort : null;
  const pid = typeof record.OwningProcess === "number" ? record.OwningProcess : null;
  const command =
    typeof record.CommandLine === "string" && record.CommandLine.trim().length > 0
      ? record.CommandLine.trim()
      : typeof record.Name === "string" && record.Name.trim().length > 0
        ? record.Name.trim()
        : null;

  if (!port || port <= 0 || !pid || pid <= 0 || !command) return null;
  return { port, pid, command };
}

export function parseWindowsListeningPortRows(output: string): ReadonlyArray<ListeningPortRow> {
  if (output.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      const row = normalizeListeningPortRow(record);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

export function parsePosixLsofListeningPortRows(output: string): ReadonlyArray<ListeningPortRow> {
  const rows: ListeningPortRow[] = [];
  let currentPid: number | null = null;
  let currentCommand: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      currentPid = parsePositiveInt(value);
      currentCommand = null;
      continue;
    }
    if (tag === "c") {
      currentCommand = value.trim() || null;
      continue;
    }
    if (tag !== "n" || currentPid === null || currentCommand === null) {
      continue;
    }
    const portMatch = /:(\d+)(?:\s|$)/.exec(value);
    const port = portMatch?.[1] ? parsePositiveInt(portMatch[1]) : null;
    if (port !== null) {
      rows.push({ port, pid: currentPid, command: currentCommand });
    }
  }

  return rows;
}

export function buildDescendantEntries(
  rows: ReadonlyArray<ProcessRow>,
  serverPid: number,
): ReadonlyArray<ServerProcessDiagnosticsEntry> {
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.pid - right.pid);
  }

  const entries: ServerProcessDiagnosticsEntry[] = [];
  const visited = new Set<number>();
  const rootChildren = childrenByParent.get(serverPid) ?? [];
  const stack = rootChildren.toReversed().map((row) => ({ row, depth: 0 }));

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || visited.has(item.row.pid)) continue;
    visited.add(item.row.pid);

    const children = childrenByParent.get(item.row.pid) ?? [];
    entries.push({
      pid: item.row.pid,
      ppid: item.row.ppid,
      pgid: Option.fromNullishOr(item.row.pgid),
      status: item.row.status,
      cpuPercent: item.row.cpuPercent,
      rssBytes: item.row.rssBytes,
      elapsed: item.row.elapsed || "n/a",
      command: item.row.command,
      depth: item.depth,
      childPids: children.map((child) => child.pid),
    });

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        stack.push({ row: child, depth: item.depth + 1 });
      }
    }
  }

  return entries;
}

export function isDiagnosticsQueryProcess(row: ProcessRow, serverPid: number): boolean {
  if (row.ppid !== serverPid) return false;

  const command = row.command.trim();
  return (
    /(?:^|[/\\])ps\s+-axo\s+pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=/.test(command) ||
    (/\bpowershell(?:\.exe)?\b/i.test(command) &&
      /\bGet-CimInstance\s+Win32_Process\b/i.test(command))
  );
}

function makeResult(input: {
  readonly serverPid: number;
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly readAt: DateTime.Utc;
  readonly error?: string;
}): ServerProcessDiagnosticsResult {
  const readAt = input.readAt;
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const processes = buildDescendantEntries(rows, input.serverPid);
  const totalRssBytes = processes.reduce((total, process) => total + process.rssBytes, 0);
  const totalCpuPercent = processes.reduce((total, process) => total + process.cpuPercent, 0);

  return {
    serverPid: input.serverPid,
    readAt,
    processCount: processes.length,
    totalRssBytes,
    totalCpuPercent,
    processes,
    error: input.error ? Option.some({ message: input.error }) : Option.none(),
  };
}

interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runProcess = Effect.fn("runProcess")(
  function* (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly errorMessage: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, input.args, {
        cwd: process.cwd(),
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: PROCESS_QUERY_MAX_OUTPUT_BYTES,
          truncatedMarker: "\n\n[truncated]",
        }),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: PROCESS_QUERY_MAX_OUTPUT_BYTES,
          truncatedMarker: "\n\n[truncated]",
        }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
    } satisfies ProcessOutput;
  },
  (effect, input) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(PROCESS_QUERY_TIMEOUT_MS)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () => Effect.fail(toProcessDiagnosticsError(`${input.errorMessage} timed out.`)),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isProcessDiagnosticsError(cause)
          ? cause
          : toProcessDiagnosticsError(input.errorMessage, cause),
      ),
    ),
);

function readPosixProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return runProcess({
    command: "ps",
    args: ["-axo", POSIX_PROCESS_QUERY_COMMAND],
    errorMessage: "Failed to query process diagnostics.",
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(toProcessDiagnosticsError(result.stderr.trim() || "ps failed."))
        : Effect.succeed(parsePosixProcessRows(result.stdout)),
    ),
  );
}

export function buildWindowsProcessQueryCommand(serverPid = process.pid): string {
  const safeServerPid =
    Number.isInteger(serverPid) && serverPid > 0 ? Math.trunc(serverPid) : process.pid;
  return [
    `$serverPid = ${safeServerPid};`,
    "$rowsByPid = @{};",
    "$allRows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,Status,WorkingSetSize -ErrorAction Stop);",
    "$childrenByParent = @{};",
    "foreach ($row in $allRows) {",
    "$parentPid = [int]$row.ParentProcessId;",
    "if (-not $childrenByParent.ContainsKey($parentPid)) { $childrenByParent[$parentPid] = [System.Collections.Generic.List[object]]::new() }",
    "$childrenByParent[$parentPid].Add($row)",
    "}",
    "$root = $allRows | Where-Object { $_.ProcessId -eq $serverPid } | Select-Object -First 1;",
    "if ($root) { $rowsByPid[[int]$root.ProcessId] = $root }",
    "$visitedParents = [System.Collections.Generic.HashSet[int]]::new();",
    "$queue = [System.Collections.Generic.Queue[int]]::new();",
    "$queue.Enqueue($serverPid);",
    "while ($queue.Count -gt 0) {",
    "$parentPid = $queue.Dequeue();",
    "if (-not $visitedParents.Add($parentPid)) { continue }",
    "if (-not $childrenByParent.ContainsKey($parentPid)) { continue }",
    "foreach ($child in $childrenByParent[$parentPid]) {",
    "$childPid = [int]$child.ProcessId;",
    "if (-not $rowsByPid.ContainsKey($childPid)) {",
    "$rowsByPid[$childPid] = $child;",
    "$queue.Enqueue($childPid)",
    "}",
    "}",
    "};",
    "$perfByPid = @{};",
    "$targetPids = [System.Collections.Generic.HashSet[int]]::new();",
    "foreach ($processId in $rowsByPid.Keys) { [void]$targetPids.Add([int]$processId) }",
    "try {",
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime -ErrorAction Stop | ForEach-Object {",
    "$processId = [int]$_.IDProcess;",
    "if ($targetPids.Contains($processId)) { $perfByPid[$processId] = $_.PercentProcessorTime }",
    "}",
    "} catch {",
    "}",
    "@($rowsByPid.Values | ForEach-Object {",
    "$processId = [int]$_.ProcessId;",
    "[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Status = $_.Status; WorkingSetSize = $_.WorkingSetSize; PercentProcessorTime = if ($perfByPid.ContainsKey($processId)) { $perfByPid[$processId] } else { 0 } }",
    "}) | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
}

function readWindowsProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return runProcess({
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", buildWindowsProcessQueryCommand()],
    errorMessage: "Failed to query process diagnostics.",
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            toProcessDiagnosticsError(result.stderr.trim() || "PowerShell process query failed."),
          )
        : Effect.succeed(parseWindowsProcessRows(result.stdout)),
    ),
  );
}

function buildWindowsAllProcessQueryCommand(): string {
  return [
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,Status,WorkingSetSize -ErrorAction Stop | ForEach-Object {",
    "[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Status = $_.Status; WorkingSetSize = $_.WorkingSetSize; PercentProcessorTime = 0 }",
    "} | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
}

function readWindowsAllProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return runProcess({
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", buildWindowsAllProcessQueryCommand()],
    errorMessage: "Failed to query process diagnostics.",
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            toProcessDiagnosticsError(result.stderr.trim() || "PowerShell process query failed."),
          )
        : Effect.succeed(parseWindowsProcessRows(result.stdout)),
    ),
  );
}

function readAllProcessRows(
  platform = process.platform,
): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return platform === "win32" ? readWindowsAllProcessRows() : readPosixProcessRows();
}

function uniquePositivePorts(ports: ReadonlyArray<number>): number[] {
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))]
    .map((port) => Math.trunc(port))
    .sort((left, right) => left - right);
}

export function buildWindowsListeningPortQueryCommand(
  ports: ReadonlyArray<number>,
  options?: { readonly all?: boolean },
): string {
  const safePorts = uniquePositivePorts(ports);
  if (safePorts.length === 0 && options?.all !== true) {
    return "@() | ConvertTo-Json -Compress -Depth 3";
  }
  const connectionQuery =
    safePorts.length > 0
      ? "$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $ports -contains [int]$_.LocalPort });"
      : "$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop);";
  return [
    `$ports = @(${safePorts.join(",")});`,
    connectionQuery,
    "$processIds = [System.Collections.Generic.HashSet[int]]::new();",
    "foreach ($connection in $connections) { [void]$processIds.Add([int]$connection.OwningProcess) }",
    "$processesByPid = @{};",
    "if ($processIds.Count -gt 0) {",
    "Get-CimInstance Win32_Process -Property ProcessId,Name,CommandLine -ErrorAction SilentlyContinue | ForEach-Object {",
    "$processId = [int]$_.ProcessId;",
    "if ($processIds.Contains($processId)) { $processesByPid[$processId] = $_ }",
    "}",
    "}",
    "@($connections | ForEach-Object {",
    "$pid = [int]$_.OwningProcess;",
    "$process = $processesByPid[$pid];",
    "[pscustomobject]@{ LocalPort = [int]$_.LocalPort; OwningProcess = $pid; Name = if ($process) { $process.Name } else { '' }; CommandLine = if ($process -and $process.CommandLine) { $process.CommandLine } elseif ($process) { $process.Name } else { '' } }",
    "}) | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
}

function readWindowsListeningPortRows(
  ports: ReadonlyArray<number>,
  options?: { readonly all?: boolean },
): Effect.Effect<
  ReadonlyArray<ListeningPortRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const safePorts = uniquePositivePorts(ports);
  if (safePorts.length === 0 && options?.all !== true) return Effect.succeed([]);
  return runProcess({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildWindowsListeningPortQueryCommand(safePorts, options),
    ],
    errorMessage: "Failed to query local listening ports.",
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            toProcessDiagnosticsError(result.stderr.trim() || "PowerShell port query failed."),
          )
        : Effect.succeed(parseWindowsListeningPortRows(result.stdout)),
    ),
  );
}

function readPosixListeningPortRows(
  ports: ReadonlyArray<number>,
  options?: { readonly all?: boolean },
): Effect.Effect<
  ReadonlyArray<ListeningPortRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const safePorts = uniquePositivePorts(ports);
  if (safePorts.length === 0 && options?.all !== true) return Effect.succeed([]);
  return runProcess({
    command: "lsof",
    args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
    errorMessage: "Failed to query local listening ports.",
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.succeed([])
        : Effect.succeed(
            options?.all === true
              ? parsePosixLsofListeningPortRows(result.stdout)
              : parsePosixLsofListeningPortRows(result.stdout).filter((row) =>
                  safePorts.includes(row.port),
                ),
          ),
    ),
  );
}

function readListeningPortRows(
  ports: ReadonlyArray<number>,
  options?: { readonly all?: boolean },
  platform = process.platform,
): Effect.Effect<
  ReadonlyArray<ListeningPortRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return platform === "win32"
    ? readWindowsListeningPortRows(ports, options)
    : readPosixListeningPortRows(ports, options);
}

export const readProcessRows = (platform = process.platform) =>
  platform === "win32" ? readWindowsProcessRows() : readPosixProcessRows();

export function aggregateProcessDiagnostics(input: {
  readonly serverPid: number;
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly readAt: DateTime.Utc;
  readonly error?: string;
}): ServerProcessDiagnosticsResult {
  return makeResult(input);
}

function assertDescendantPid(
  pid: number,
): Effect.Effect<void, ProcessDiagnosticsError, ChildProcessSpawner.ChildProcessSpawner> {
  if (pid === process.pid) {
    return Effect.fail(
      toProcessDiagnosticsError("Refusing to signal the Threadlines server process."),
    );
  }

  return readProcessRows().pipe(
    Effect.flatMap((rows) => {
      const filteredRows = rows.filter((row) => !isDiagnosticsQueryProcess(row, process.pid));
      const descendant = buildDescendantEntries(filteredRows, process.pid).some(
        (entry) => entry.pid === pid,
      );
      return descendant
        ? Effect.void
        : Effect.fail(
            toProcessDiagnosticsError(
              `Process ${pid} is not a live descendant of the Threadlines server.`,
            ),
          );
    }),
  );
}

function localhostPortFromUrl(value: string): number | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "[::1]" &&
      hostname !== "::1"
    ) {
      return null;
    }
    if (url.port.length > 0) {
      return parsePositiveInt(url.port);
    }
    if (url.protocol === "http:") return 80;
    if (url.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

function compactCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function normalizeCommandSearchText(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

function commandHintTokens(hints: ReadonlyArray<string>): string[] {
  const tokens: string[] = [];
  const addToken = (value: string | undefined) => {
    const normalized = value ? normalizeCommandSearchText(value) : "";
    if (normalized.length < 6 || tokens.includes(normalized)) {
      return;
    }
    tokens.push(normalized);
  };

  for (const hint of hints) {
    const normalizedHint = normalizeCommandSearchText(hint);
    const previewMatch = /\bthreadlines-activity-preview-\d+\b/i.exec(hint);
    addToken(previewMatch?.[0]);
    const offsetMatch = /\bthreadlines_port_offset\s*=\s*['"]?(\d+)/i.exec(normalizedHint);
    if (offsetMatch?.[1]) {
      addToken(`threadlines_port_offset='${offsetMatch[1]}`);
      addToken(`threadlines_port_offset=${offsetMatch[1]}`);
    }
    const homeDirMatch = /--home-dir\s+['"]?([^'"\s]+)/i.exec(normalizedHint);
    addToken(homeDirMatch?.[1]);
    if (normalizedHint.includes("scripts/dev-runner.ts")) {
      addToken("scripts/dev-runner.ts");
    }
    if (normalizedHint.includes("start-process")) {
      addToken("start-process");
    }
  }

  return tokens;
}

function descendantPidsForMatches(input: {
  readonly processRows: ReadonlyArray<ProcessRow>;
  readonly commandHints: ReadonlyArray<string>;
}): Set<number> {
  const tokens = commandHintTokens(input.commandHints);
  if (tokens.length === 0) {
    return new Set();
  }

  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of input.processRows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const matchingPids = input.processRows
    .filter((row) => {
      const command = normalizeCommandSearchText(row.command);
      return tokens.some((token) => command.includes(token));
    })
    .map((row) => row.pid);
  const result = new Set<number>();
  const stack = [...matchingPids];

  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || result.has(pid)) {
      continue;
    }
    result.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }

  return result;
}

export function resolveBackgroundRunsFromListeningPorts(input: {
  readonly urls: ReadonlyArray<string>;
  readonly portRows: ReadonlyArray<ListeningPortRow>;
  readonly processRows?: ReadonlyArray<ProcessRow>;
  readonly commandHints?: ReadonlyArray<string>;
}): ServerResolveBackgroundRunsResult {
  const urlsByPort = new Map<number, string[]>();
  for (const url of input.urls) {
    const port = localhostPortFromUrl(url);
    if (port === null) continue;
    const urls = urlsByPort.get(port) ?? [];
    if (!urls.includes(url)) {
      urls.push(url);
    }
    urlsByPort.set(port, urls);
  }

  const hintedPids =
    input.processRows && input.commandHints
      ? descendantPidsForMatches({
          processRows: input.processRows,
          commandHints: input.commandHints,
        })
      : new Set<number>();
  const processCommandByPid = new Map(
    input.processRows?.map((row) => [row.pid, row.command]) ?? [],
  );
  const processElapsedByPid = new Map(
    input.processRows
      ?.filter((row) => row.elapsed.trim().length > 0)
      .map((row) => [row.pid, row.elapsed]) ?? [],
  );
  const rowsByPort = new Map<number, ListeningPortRow>();
  for (const row of input.portRows) {
    const matchesUrl = urlsByPort.has(row.port);
    const matchesHint = hintedPids.has(row.pid);
    if ((!matchesUrl && !matchesHint) || rowsByPort.has(row.port)) continue;
    rowsByPort.set(row.port, row);
  }

  return {
    runs: [...rowsByPort.values()].map((row) => {
      const urls = urlsByPort.get(row.port) ?? [];
      const primaryUrl = urls[0] ?? `http://localhost:${row.port}`;
      const command = compactCommand(processCommandByPid.get(row.pid) ?? row.command);
      const canStop = row.pid !== process.pid;
      return {
        id: `detected-localhost:${row.port}:${row.pid}`,
        url: primaryUrl,
        urls,
        port: row.port,
        pid: row.pid,
        command,
        detail: `PID ${row.pid} on localhost:${row.port} - ${command}`,
        ...(processElapsedByPid.get(row.pid) ? { elapsed: processElapsedByPid.get(row.pid) } : {}),
        statusLabel: canStop ? "Detected" : "Protected",
        canStop,
      };
    }),
  };
}

export const make = Effect.fn("makeProcessDiagnostics")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const read: ProcessDiagnosticsShape["read"] = Effect.gen(function* () {
    const readAt = yield* DateTime.now;
    const rows = yield* readProcessRows().pipe(
      Effect.withTracerEnabled(false),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return makeResult({ serverPid: process.pid, rows, readAt });
  }).pipe(
    Effect.catch((error: ProcessDiagnosticsError) =>
      DateTime.now.pipe(
        Effect.map((readAt) =>
          makeResult({ serverPid: process.pid, rows: [], readAt, error: error.message }),
        ),
      ),
    ),
  );

  const signal: ProcessDiagnosticsShape["signal"] = Effect.fn("ProcessDiagnostics.signal")(
    function* (input) {
      return yield* assertDescendantPid(input.pid).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flatMap(() =>
          Effect.try({
            try: () => {
              process.kill(input.pid, input.signal);
              return {
                pid: input.pid,
                signal: input.signal,
                signaled: true,
                message: Option.none(),
              };
            },
            catch: (cause) =>
              toProcessDiagnosticsError(
                `Failed to signal process ${input.pid} with ${input.signal}.`,
                cause,
              ),
          }),
        ),
        Effect.catch((error: ProcessDiagnosticsError) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some(error.message),
          }),
        ),
      );
    },
  );

  const resolveBackgroundRuns: ProcessDiagnosticsShape["resolveBackgroundRuns"] = Effect.fn(
    "ProcessDiagnostics.resolveBackgroundRuns",
  )(function* (input) {
    const commandHints = input.commandHints ?? [];
    const ports = input.urls.flatMap((url) => {
      const port = localhostPortFromUrl(url);
      return port === null ? [] : [port];
    });
    const queryAllPorts = ports.length === 0 && commandHints.length > 0;
    const [portRows, processRows] = yield* Effect.all(
      [
        readListeningPortRows(ports, { all: queryAllPorts }).pipe(
          Effect.withTracerEnabled(false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.catch(() => Effect.succeed([])),
        ),
        commandHints.length > 0
          ? readAllProcessRows().pipe(
              Effect.withTracerEnabled(false),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.catch(() => Effect.succeed([])),
            )
          : Effect.succeed([]),
      ],
      { concurrency: "unbounded" },
    );
    return resolveBackgroundRunsFromListeningPorts({
      urls: input.urls,
      portRows,
      processRows,
      commandHints,
    });
  });

  const stopBackgroundRun: ProcessDiagnosticsShape["stopBackgroundRun"] = Effect.fn(
    "ProcessDiagnostics.stopBackgroundRun",
  )(function* (input) {
    if (input.pid === process.pid) {
      return {
        pid: input.pid,
        signal: input.signal,
        signaled: false,
        message: Option.some("Refusing to signal the Threadlines server process."),
      };
    }

    const rows = yield* readListeningPortRows([input.port]).pipe(
      Effect.withTracerEnabled(false),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catch((error: ProcessDiagnosticsError) =>
        Effect.succeed<ReadonlyArray<ListeningPortRow>>([]).pipe(
          Effect.tap(() =>
            Effect.logWarning("failed to verify detected background run before stop", {
              pid: input.pid,
              port: input.port,
              error: error.message,
            }),
          ),
        ),
      ),
    );
    const stillOwnsPort = rows.some((row) => row.port === input.port && row.pid === input.pid);
    if (!stillOwnsPort) {
      return {
        pid: input.pid,
        signal: input.signal,
        signaled: false,
        message: Option.some(`Process ${input.pid} no longer owns localhost:${input.port}.`),
      };
    }

    return yield* Effect.try({
      try: () => {
        process.kill(input.pid, input.signal);
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: true,
          message: Option.none(),
        };
      },
      catch: (cause) =>
        toProcessDiagnosticsError(
          `Failed to signal process ${input.pid} with ${input.signal}.`,
          cause,
        ),
    }).pipe(
      Effect.catch((error: ProcessDiagnosticsError) =>
        Effect.succeed({
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(error.message),
        }),
      ),
    );
  });

  return ProcessDiagnostics.of({ read, signal, resolveBackgroundRuns, stopBackgroundRun });
});

export const layer = Layer.effect(ProcessDiagnostics, make());
