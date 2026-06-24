import { describe, expect, it } from "vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

const encoder = new TextEncoder();

function itEffect(name: string, effect: () => Effect.Effect<void, unknown, never>): void {
  it(name, async () => {
    await Effect.runPromise(effect());
  });
}

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("ProcessDiagnostics", () => {
  itEffect("parses POSIX ps rows with full commands", () =>
    Effect.sync(() => {
      const rows = ProcessDiagnostics.parsePosixProcessRows(
        [
          "  10     1    10 Ss      0.0   1024   01:02.03 /usr/bin/node server.js",
          "  11    10    10 S+     12.5  20480      00:04 codex app-server --config /tmp/one two",
        ].join("\n"),
      );

      expect(rows).toEqual([
        {
          pid: 10,
          ppid: 1,
          pgid: 10,
          status: "Ss",
          cpuPercent: 0,
          rssBytes: 1024 * 1024,
          elapsed: "01:02.03",
          command: "/usr/bin/node server.js",
        },
        {
          pid: 11,
          ppid: 10,
          pgid: 10,
          status: "S+",
          cpuPercent: 12.5,
          rssBytes: 20480 * 1024,
          elapsed: "00:04",
          command: "codex app-server --config /tmp/one two",
        },
      ]);
    }),
  );

  itEffect("aggregates only descendants of the server process", () =>
    Effect.sync(() => {
      const diagnostics = ProcessDiagnostics.aggregateProcessDiagnostics({
        serverPid: 100,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 1.5,
            rssBytes: 2_000,
            elapsed: "00:20",
            command: "codex app-server",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "R",
            cpuPercent: 3.25,
            rssBytes: 4_000,
            elapsed: "00:05",
            command: "git status",
          },
          {
            pid: 200,
            ppid: 1,
            pgid: 200,
            status: "S",
            cpuPercent: 99,
            rssBytes: 8_000,
            elapsed: "00:01",
            command: "unrelated",
          },
          {
            pid: 201,
            ppid: 100,
            pgid: 100,
            status: "R",
            cpuPercent: 9,
            rssBytes: 9_000,
            elapsed: "00:00",
            command: "ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=",
          },
        ],
      });

      expect(diagnostics.serverPid).toBe(100);
      expect(DateTime.formatIso(diagnostics.readAt)).toBe("2026-05-05T10:00:00.000Z");
      expect(diagnostics.processCount).toBe(2);
      expect(diagnostics.totalRssBytes).toBe(6_000);
      expect(diagnostics.totalCpuPercent).toBe(4.75);
      expect(diagnostics.processes.map((process) => process.pid)).toEqual([101, 102]);
      expect(diagnostics.processes.map((process) => process.depth)).toEqual([0, 1]);
      expect(Option.getOrNull(diagnostics.processes[0]!.pgid)).toBe(100);
      expect(diagnostics.processes[0]?.childPids).toEqual([102]);
    }),
  );

  itEffect("preserves ascending sibling order for nested descendants", () =>
    Effect.sync(() => {
      const diagnostics = ProcessDiagnostics.aggregateProcessDiagnostics({
        serverPid: 100,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        rows: [
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "agent",
          },
          {
            pid: 103,
            ppid: 101,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "child-b",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "child-a",
          },
        ],
      });

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([101, 102, 103]);
    }),
  );

  itEffect("queries processes through the ChildProcessSpawner service", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as {
            readonly command: string;
            readonly args: ReadonlyArray<string>;
          };
          commands.push({ command: childProcess.command, args: childProcess.args });
          if (process.platform === "win32") {
            return Effect.succeed(
              mockHandle({
                stdout: JSON.stringify([
                  {
                    ProcessId: 4242,
                    ParentProcessId: process.pid,
                    Name: "agent.exe",
                    CommandLine: "agent",
                    Status: "Running",
                    WorkingSetSize: 2048 * 1024,
                    PercentProcessorTime: 1.5,
                  },
                ]),
              }),
            );
          }
          return Effect.succeed(
            mockHandle({
              stdout: [
                ` ${process.pid}     1 ${process.pid} Ss 0.0 1024 01:02.03 t3 server`,
                ` 4242 ${process.pid} ${process.pid} S  1.5 2048 00:04 agent`,
              ].join("\n"),
            }),
          );
        }),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(spawnerLayer));

      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((pd) => pd.read),
        Effect.provide(layer),
      );

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([4242]);
      if (process.platform === "win32") {
        expect(commands[0]?.command).toBe("powershell.exe");
        expect(commands[0]?.args.slice(0, 3)).toEqual([
          "-NoProfile",
          "-NonInteractive",
          "-Command",
        ]);
      } else {
        expect(commands).toEqual([
          {
            command: "ps",
            args: ["-axo", "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command="],
          },
        ]);
      }
    }),
  );

  it("builds a batched Windows process-tree query", () => {
    const command = ProcessDiagnostics.buildWindowsProcessQueryCommand(1234);

    expect(command).toContain("$serverPid = 1234");
    expect(command).toContain(
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,Status,WorkingSetSize",
    );
    expect(command).toContain(
      "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess,PercentProcessorTime",
    );
    expect(command).toContain("$childrenByParent.ContainsKey($parentPid)");
    expect(command).toContain("$targetPids.Contains($processId)");
    expect(command).not.toContain('IDProcess = $processId"');
    expect(command).toContain("$perfByPid");
    expect(command).not.toContain('ParentProcessId = $parentPid"');
  });

  it("parses Windows listening port rows", () => {
    const rows = ProcessDiagnostics.parseWindowsListeningPortRows(
      JSON.stringify([
        {
          LocalPort: 5953,
          OwningProcess: 4242,
          Name: "node.exe",
          CommandLine: "node scripts/dev-runner.ts dev",
        },
        {
          LocalPort: 13993,
          OwningProcess: 4343,
          Name: "bun.exe",
          CommandLine: "",
        },
      ]),
    );

    expect(rows).toEqual([
      {
        port: 5953,
        pid: 4242,
        command: "node scripts/dev-runner.ts dev",
      },
      {
        port: 13993,
        pid: 4343,
        command: "bun.exe",
      },
    ]);
  });

  it("resolves mentioned localhost URLs to detected background runs", () => {
    const result = ProcessDiagnostics.resolveBackgroundRunsFromListeningPorts({
      urls: ["http://localhost:5953", "http://127.0.0.1:5953/api", "http://localhost:9999"],
      portRows: [
        {
          port: 5953,
          pid: 4242,
          command: "node scripts/dev-runner.ts dev",
        },
      ],
    });

    expect(result.runs).toEqual([
      {
        id: "detected-localhost:5953:4242",
        url: "http://localhost:5953",
        urls: ["http://localhost:5953", "http://127.0.0.1:5953/api"],
        port: 5953,
        pid: 4242,
        command: "node scripts/dev-runner.ts dev",
        detail: "PID 4242 on localhost:5953 - node scripts/dev-runner.ts dev",
        statusLabel: "Detected",
        canStop: true,
      },
    ]);
  });

  it("uses command hints to resolve descendant-owned preview ports", () => {
    const result = ProcessDiagnostics.resolveBackgroundRunsFromListeningPorts({
      urls: ["http://localhost:6013", "http://localhost:14053"],
      commandHints: [
        "$env:THREADLINES_PORT_OFFSET='280'; node scripts/dev-runner.ts dev --home-dir C:\\Temp\\threadlines-activity-preview-280\\home",
      ],
      processRows: [
        {
          pid: 10,
          ppid: 1,
          pgid: null,
          status: "Live",
          cpuPercent: 0,
          rssBytes: 100,
          elapsed: "",
          command:
            "powershell.exe -Command $env:THREADLINES_PORT_OFFSET='280'; node scripts/dev-runner.ts dev --home-dir C:\\Temp\\threadlines-activity-preview-280\\home",
        },
        {
          pid: 11,
          ppid: 10,
          pgid: null,
          status: "Live",
          cpuPercent: 0,
          rssBytes: 100,
          elapsed: "",
          command:
            "node.exe scripts/dev-runner.ts dev --home-dir C:\\Temp\\threadlines-activity-preview-280\\home",
        },
        {
          pid: 12,
          ppid: 11,
          pgid: null,
          status: "Live",
          cpuPercent: 0,
          rssBytes: 100,
          elapsed: "",
          command: "node vite cli.js dev",
        },
        {
          pid: 13,
          ppid: 11,
          pgid: null,
          status: "Live",
          cpuPercent: 0,
          rssBytes: 100,
          elapsed: "",
          command: "node apps/server/scripts/cli.ts",
        },
      ],
      portRows: [
        {
          port: 6013,
          pid: 12,
          command: "node vite cli.js dev",
        },
        {
          port: 14053,
          pid: 13,
          command: "node server",
        },
      ],
    });

    expect(result.runs.map((run) => `${run.port}:${run.pid}`)).toEqual(["6013:12", "14053:13"]);
  });

  itEffect("does not allow signaling the diagnostics query process", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdout: [
                ` ${process.pid}     1 ${process.pid} Ss 0.0 1024 01:02.03 t3 server`,
                ` 4242 ${process.pid} ${process.pid} R  1.5 2048 00:00 ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=`,
              ].join("\n"),
            }),
          ),
        ),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(spawnerLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((pd) => pd.signal({ pid: 4242, signal: "SIGINT" })),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4242,
        signal: "SIGINT",
        signaled: false,
        message: Option.some("Process 4242 is not a live descendant of the Threadlines server."),
      });
    }),
  );
});
