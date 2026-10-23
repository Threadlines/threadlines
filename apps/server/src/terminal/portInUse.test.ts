import { describe, expect, it } from "vite-plus/test";

import type { ProcessRow } from "../diagnostics/ProcessDiagnostics.ts";
import {
  attributePortHolder,
  commandReachesElsewhere,
  findPortsInUse,
  scanPortsInUse,
  shellReachesElsewhere,
  shortCommand,
} from "./portInUse.ts";

describe("findPortsInUse", () => {
  it.each([
    ["Node", "Error: listen EADDRINUSE: address already in use :::3000", 3000],
    ["Node on IPv4", "Error: listen EADDRINUSE: address already in use 127.0.0.1:5173", 5173],
    ["Node on IPv6 loopback", "Error: listen EADDRINUSE: address already in use ::1:3000", 3000],
    ["Vite", "Port 5173 is in use, trying another one...", 5173],
    [
      "Vite with strictPort",
      "error when starting dev server:\nError: Port 5173 is already in use",
      5173,
    ],
    [
      "Next.js",
      " ⚠ Port 3000 is in use by process 39223, using available port 3001 instead.",
      3000,
    ],
    ["Create React App", "Something is already running on port 3000.", 3000],
    ["Gatsby", "Something is already running at port 8000", 8000],
    ["Go", "listen tcp :8080: bind: address already in use", 8080],
    [
      "Go with a log timestamp",
      "2026/10/23 12:01:33 listen tcp 127.0.0.1:8080: bind: address already in use",
      8080,
    ],
    [
      "Puma",
      'Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)',
      3000,
    ],
    [
      "uvicorn",
      "ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 8000): address already in use",
      8000,
    ],
    ["Laravel", "Failed to listen on 127.0.0.1:8000 (reason: Address already in use)", 8000],
    ["Docker", "Bind for 0.0.0.0:5432 failed: port is already allocated", 5432],
    ["Spring Boot", "Web server failed to start. Port 8080 was already in use.", 8080],
    ["Bun", "error: Failed to start server. Is port 3000 in use?", 3000],
    [
      "Storybook",
      "Port 6006 is not available. Would you like to run Storybook on port 6007 instead?",
      6006,
    ],
    ["Postgres", "HINT:  Is another postmaster already running on port 5432?", 5432],
    ["Parcel", 'Error: Port "1234" could not be used', 1234],
    [
      "Wrangler",
      "Address already in use (127.0.0.1:8787). Please check that you are not already running a server on this address.",
      8787,
    ],
    [".NET", "Failed to bind to address http://127.0.0.1:5000: address already in use.", 5000],
    [
      "Phoenix",
      "Running on port 4000 failed for reason :eaddrinuse (address already in use)",
      4000,
    ],
    ["port 80 on every address", "Error: listen EADDRINUSE: address already in use 0.0.0.0:80", 80],
  ])("reads the port from %s", (_tool, line, port) => {
    expect(findPortsInUse(line)).toEqual([port]);
  });

  it.each([
    ["no port named", "OSError: [Errno 48] Address already in use"],
    ["Rust", 'Error: Os { code: 48, kind: AddrInUse, message: "Address already in use" }'],
    ["Django", "Error: That port is already in use."],
    ["a timestamp only", "12:01:33 PM [vite] error: address already in use"],
    ["prose", "This port number is used for the API and the web app."],
    ["a unix socket", "Error: listen EADDRINUSE: address already in use /tmp/app.sock"],
  ])("finds nothing in %s", (_case, line) => {
    expect(findPortsInUse(line)).toEqual([]);
  });
});

describe("scanPortsInUse", () => {
  it("reads a message split across chunks, with its colors", () => {
    const state = { tail: "" };
    expect(scanPortsInUse(state, "  \u001b[33mPort \u001b[1m51")).toEqual([]);
    expect(
      scanPortsInUse(state, "73\u001b[22m is in use, trying another one...\u001b[39m\r\n"),
    ).toEqual([{ port: 5173, hostBinding: false }]);
    expect(state.tail).toBe("");
  });

  it("reads a question still waiting for its answer", () => {
    const state = { tail: "" };
    expect(
      scanPortsInUse(
        state,
        "? Port 6006 is not available. Would you like to run Storybook on port 6007 instead? (Y/n) ",
      ),
    ).toEqual([{ port: 6006, hostBinding: false }]);
  });

  it("waits for the rest of a port number at the end of a chunk", () => {
    const state = { tail: "" };
    expect(scanPortsInUse(state, "Error: listen EADDRINUSE: address already in use :::30")).toEqual(
      [],
    );
    expect(scanPortsInUse(state, "00\n")).toEqual([{ port: 3000, hostBinding: false }]);
  });

  it("tells Docker failing to publish a port on this computer apart", () => {
    expect(
      scanPortsInUse(
        { tail: "" },
        "Error response from daemon: driver failed programming external connectivity on endpoint db (4f2a): Bind for 0.0.0.0:5432 failed: port is already allocated\n",
      ),
    ).toEqual([{ port: 5432, hostBinding: true }]);
  });

  it("keeps only the end of a line that never ends", () => {
    const state = { tail: "" };
    scanPortsInUse(state, "#".repeat(10_000));
    expect(state.tail.length).toBe(512);
  });
});

const row = (
  pid: number,
  ppid: number,
  command: string,
  pgid: number | null = pid,
): ProcessRow => ({
  pid,
  ppid,
  pgid,
  status: "S",
  cpuPercent: 0,
  rssBytes: 0,
  elapsed: "00:01",
  command,
});

describe("attributePortHolder", () => {
  const serverPid = 100;
  const processRows = [
    row(100, 1, "node /app/server.js"),
    // Terminal 1: `npm run dev`, a job of its own (group 201).
    row(200, 100, "/bin/zsh -il"),
    row(201, 200, "npm run dev"),
    row(202, 201, "node /repo/node_modules/.bin/vite", 201),
    // An agent's background dev server.
    row(300, 100, "/usr/local/bin/claude --output-format stream-json"),
    row(301, 300, "/bin/zsh -c npm run dev"),
    row(302, 301, "node /repo/node_modules/.bin/next dev", 301),
    row(400, 1, "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"),
    // Terminal 2: a suggested command's wrapper shell, its command in the wrapper's group.
    row(500, 100, "/bin/sh -c __tl_cmd=...", 500),
    row(501, 500, "/bin/sh -c __tl_cmd=...", 500),
    row(502, 501, "node server.js", 500),
    // Terminal 3: a server started with job control off, in the shell's own group.
    row(600, 100, "/bin/bash", 600),
    row(601, 600, "python3 -m http.server 8000", 600),
  ];
  const terminalShells = new Map([
    [200, { threadId: "thread-1", terminalId: "default" }],
    [500, { threadId: "thread-1", terminalId: "run" }],
    [600, { threadId: "thread-2", terminalId: "default" }],
  ]);
  const attribute = (
    listeningRows: Parameters<typeof attributePortHolder>[0]["listeningRows"],
    port: number,
    rows = processRows,
  ) =>
    attributePortHolder({
      port,
      listeningRows,
      processRows: rows,
      terminalShells,
      wrapperShells: new Set([500]),
      serverPid,
    });

  it("names the tab and the job as typed, and lets Stop interrupt that job", () => {
    expect(attribute([{ port: 5173, pid: 202, command: "node" }], 5173)).toEqual({
      holders: [
        {
          kind: "terminal",
          threadId: "thread-1",
          terminalId: "default",
          pid: 202,
          name: "node",
          command: "npm run dev",
        },
      ],
      listenerPids: [202],
      holderShellPids: [200],
      stoppable: { pgid: 201, shellPid: 200 },
    });
  });

  it("stops a suggested command through its wrapper's group, or its own", () => {
    expect(attribute([{ port: 4000, pid: 502, command: "node" }], 4000)?.stoppable).toEqual({
      pgid: 500,
      shellPid: 500,
    });
    // The wrapper's interactive shell gave the command a group of its own.
    const ownGroup = processRows.map((entry) =>
      entry.pid === 502 ? { ...entry, pgid: 502 } : entry,
    );
    expect(
      attribute([{ port: 4000, pid: 502, command: "node" }], 4000, ownGroup)?.stoppable,
    ).toEqual({ pgid: 502, shellPid: 500 });
  });

  it("won't stop a job sharing its shell's group, or one without groups", () => {
    expect(attribute([{ port: 8000, pid: 601, command: "Python" }], 8000)).toMatchObject({
      holders: [{ kind: "terminal", terminalId: "default", threadId: "thread-2" }],
      stoppable: null,
    });
    const windowsRows = processRows.map((entry) => ({ ...entry, pgid: null }));
    expect(
      attribute([{ port: 5173, pid: 202, command: "PID 202" }], 5173, windowsRows),
    ).toMatchObject({
      holders: [{ kind: "terminal", name: "node" }],
      stoppable: null,
    });
  });

  it("names a process an agent started", () => {
    expect(attribute([{ port: 3000, pid: 302, command: "node" }], 3000)?.holders).toEqual([
      { kind: "agent", pid: 302, name: "node", command: "zsh -c npm run dev" },
    ]);
  });

  it("names another program by its file name, and Threadlines as itself", () => {
    expect(attribute([{ port: 5000, pid: 400, command: "ControlCe" }], 5000)?.holders).toEqual([
      { kind: "process", pid: 400, name: "ControlCenter", command: "ControlCenter" },
    ]);
    expect(attribute([{ port: 3773, pid: 100, command: "node" }], 3773)?.holders).toEqual([
      { kind: "threadlines", pid: 100 },
    ]);
  });

  it("lists each holder when the address families differ, and stops neither", () => {
    expect(
      attribute(
        [
          { port: 3000, pid: 400, command: "ControlCe" },
          { port: 3000, pid: 202, command: "node" },
        ],
        3000,
      ),
    ).toMatchObject({
      holders: [
        { kind: "terminal", pid: 202 },
        { kind: "process", pid: 400 },
      ],
      listenerPids: [202, 400],
      stoppable: null,
    });
  });

  it("finds nobody when nothing listens", () => {
    expect(attribute([{ port: 8080, pid: 202, command: "node" }], 3000)).toBeNull();
  });
});

describe("shortCommand", () => {
  it.each([
    ["node /repo/node_modules/.bin/vite", "vite"],
    ["node /Users/me/Library/pnpm/pnpm dev", "pnpm dev"],
    ["npm run dev", "npm run dev"],
    ["python3 manage.py runserver", "python3 manage.py runserver"],
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\server.js', "server.js"],
    ["C:\\Program Files\\nodejs\\node.exe C:\\repo\\server.js", "server.js"],
    ["/usr/local/bin/ruby bin/rails server", "rails server"],
  ])("shortens %s", (command, short) => {
    expect(shortCommand(command)).toBe(short);
  });
});

describe("commandReachesElsewhere", () => {
  it("knows a typed remote or container command that may already have ended", () => {
    expect(commandReachesElsewhere("ssh deploy@web-1 npm start")).toBe("remote");
    expect(commandReachesElsewhere("sudo docker run -p 3000:3000 app")).toBe("container");
    expect(commandReachesElsewhere("FOO=1 kubectl port-forward svc/api 8080:80")).toBeNull();
    expect(commandReachesElsewhere("npm run dev")).toBeNull();
  });
});

describe("shellReachesElsewhere", () => {
  it("knows ssh and container clients, but not kubectl port-forward", () => {
    const shell = row(10, 1, "/bin/zsh");
    expect(shellReachesElsewhere([shell, row(11, 10, "ssh deploy@web-1")], 10)).toBe("remote");
    expect(shellReachesElsewhere([shell, row(11, 10, "docker compose up")], 10)).toBe("container");
    expect(
      shellReachesElsewhere([shell, row(11, 10, "kubectl port-forward svc/api 8080:80")], 10),
    ).toBeNull();
    expect(shellReachesElsewhere([shell, row(11, 10, "npm run dev")], 10)).toBeNull();
  });
});
