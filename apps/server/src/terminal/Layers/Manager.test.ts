import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalStreamEvent,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import type { ListeningPortRow, ProcessRow } from "../../diagnostics/ProcessDiagnostics.ts";
import type {
  TerminalCommandRunInput,
  TerminalCommandRunUpdate,
  TerminalManagerShape,
} from "../Services/Manager.ts";
import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY.ts";
import { makeTerminalManagerWithOptions, type TerminalProcessTreeControl } from "./Manager.ts";
import {
  SERVER_ADDED_VARIABLE,
  WORKING_FOLDER_LOOKUP_VARIABLE,
} from "@threadlines/shared/windowsCommandLookup";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  onWrite: ((data: string) => void) | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function posixLocalNodeModulesBinPath(root: string): string {
  return `${root.trim().replace(/\/+$/g, "")}/node_modules/.bin`;
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Base64Url.encode(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Base64Url.encode(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Base64Url.encode(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  subprocessChecker?: (terminalPid: number) => Effect.Effect<boolean>;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  ptyAdapter?: FakePtyAdapter;
  processTree?: TerminalProcessTreeControl;
  historyCharLimit?: number;
  persistDebounceMs?: number;
  /** Histories go here instead of a folder that goes with the manager's scope. */
  logsDir?: string;
  listeningPortReader?: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<ListeningPortRow>, Error>;
  freshProcessRowsReader?: () => Effect.Effect<ReadonlyArray<ProcessRow>, Error>;
}

// Fake pids must never reach the real process table — the default control
// reports no descendants and swallows signals.
const noopProcessTree: TerminalProcessTreeControl = {
  listDescendants: () => [],
  listTerminalProcesses: () => [],
  signal: () => {},
  interruptGroup: () => {},
  isAlive: () => false,
};

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManagerShape;
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "threadlines-terminal-" });
      const logsDir = options.logsDir ?? join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* makeTerminalManagerWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessChecker !== undefined
          ? { subprocessChecker: options.subprocessChecker }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        persistDebounceMs: options.persistDebounceMs ?? 5,
        ...(options.historyCharLimit !== undefined
          ? { historyCharLimit: options.historyCharLimit }
          : {}),
        processTree: options.processTree ?? noopProcessTree,
        // Fake pids must never reach the real port or process tables either.
        listeningPortReader: options.listeningPortReader ?? (() => Effect.succeed([])),
        freshProcessRowsReader: options.freshProcessRowsReader ?? (() => Effect.succeed([])),
        serverPid: 100,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const scope = yield* Effect.scope;
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

/** What a POSIX shell's line editor prints when it shows a prompt and reads a line. */
const PROMPT_READY = "$ \u001b[?2004h";

/** Has the fake shell show its prompt, and waits until the manager has seen it. */
const showPrompt = (
  manager: TerminalManagerShape,
  process: FakePtyProcess,
  input: TerminalOpenInput = openInput(),
) =>
  Effect.gen(function* () {
    process.emitData(PROMPT_READY);
    yield* waitFor(
      Effect.map(manager.open(input), (snapshot) => snapshot.history.includes("\u001b[?2004h")),
    );
  });

/** Whether an activity event matching `later` follows one matching `first`. */
const activityAfter = (
  events: ReadonlyArray<TerminalEvent>,
  first: (event: Extract<TerminalEvent, { type: "activity" }>) => boolean,
  later: (event: Extract<TerminalEvent, { type: "activity" }>) => boolean,
) => {
  const index = events.findIndex((event) => event.type === "activity" && first(event));
  return (
    index >= 0 && events.slice(index + 1).some((event) => event.type === "activity" && later(event))
  );
};

const processRow = (pid: number, ppid: number, command: string, pgid = pid): ProcessRow => ({
  pid,
  ppid,
  pgid,
  status: "S",
  cpuPercent: 0,
  rssBytes: 0,
  elapsed: "00:01",
  command,
});

// Tab "server" (shell 9000, spawned first) runs `npm run dev`, a job of its
// own whose node listens on port 3000; the default tab (shell 9001) is free.
const PORT_HOLDER_ROWS = [
  processRow(100, 1, "node threadlines"),
  processRow(9000, 100, "/bin/zsh -il"),
  processRow(7001, 9000, "npm run dev"),
  processRow(7002, 7001, "node /repo/node_modules/.bin/vite", 7001),
  processRow(9001, 100, "/bin/zsh -il"),
];
const HOLDER_LISTENING: ListeningPortRow = { port: 3000, pid: 7002, command: "node" };
const PORT_TAKEN = "Error: listen EADDRINUSE: address already in use :::3000\n";

/** Both tabs open, and the default tab's port notice as every device last heard it. */
const setUpPortTaken = (options: CreateManagerOptions = {}) =>
  Effect.gen(function* () {
    const fixture = yield* createManager(5, {
      listeningPortReader: () => Effect.succeed([HOLDER_LISTENING]),
      freshProcessRowsReader: () => Effect.succeed(PORT_HOLDER_ROWS),
      ...options,
    });
    const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
    const unsubscribe = yield* fixture.manager.subscribeMetadata((event) =>
      Ref.update(streamed, (events) => [...events, event]),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* fixture.manager.open(openInput({ terminalId: "server" }));
    yield* fixture.manager.open(openInput());
    const notice = Ref.get(streamed).pipe(
      Effect.map((events) => {
        const last = events.findLast(
          (event): event is Extract<TerminalStreamEvent, { type: "tabs" }> => event.type === "tabs",
        );
        return last?.tabs.find((tab) => tab.terminalId === DEFAULT_TERMINAL_ID)?.portInUse ?? null;
      }),
    );
    return { ...fixture, notice };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  const itEffectSkipOnWindows = process.platform === "win32" ? it.effect.skip : it.effect;

  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, "default");
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  itEffectSkipOnWindows("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdError",
        cwd: blockedCwd,
        reason: "statFailed",
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === "default",
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts a terminal below its earlier output and respawns the pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "before restart\n");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      ptyAdapter.processes[1]?.emitData("after restart\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === "before restart\nafter restart\n"),
        ),
      );
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("closes a tab whose shell exits cleanly, everywhere and with its history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(streamed, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
          Effect.map((exists) => !exists),
        ),
      );
      // Every device hears the tab is gone.
      yield* waitFor(
        Effect.map(Ref.get(streamed), (events) => {
          const last = events.findLast((event) => event.type === "tabs");
          return last?.type === "tabs" && last.tabs.length === 0;
        }),
      );
      // Gone for a client that only attaches; a new one starts empty.
      const attached = yield* Effect.exit(manager.open(openInput({ attach: true })));
      assert.isTrue(Exit.isFailure(attached));
      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("keeps a tab whose shell failed, with its output, until it is restarted", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("segfault\n");
      process.emitExit({ exitCode: 139, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      // Attaching shows how it ended instead of starting another shell.
      const attached = yield* manager.open(openInput({ attach: true }));
      assert.equal(attached.status, "exited");
      assert.equal(attached.exitCode, 139);
      assert.equal(attached.history, "segfault\n");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      const restarted = yield* manager.restart(restartInput());
      assert.equal(restarted.status, "running");
      assert.equal(restarted.history, "segfault\n");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let hasRunningSubprocess = false;
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        // Pin a non-Windows platform: this covers the poll-only path, and the
        // default platform would enable PowerShell prompt markers on a
        // Windows development machine.
        platform: "linux",
        subprocessChecker: () => Effect.succeed(hasRunningSubprocess),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      yield* showPrompt(manager, shell);
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "vp run dev:desktop\r",
      });

      hasRunningSubprocess = true;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.command === "vp run dev:desktop",
          ),
        ),
        "1200 millis",
      );

      hasRunningSubprocess = false;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          activityAfter(
            events,
            (event) => event.hasRunningSubprocess,
            (event) => !event.hasRunningSubprocess && event.command === null,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("tracks PowerShell commands until its prompt reports completion", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter, logsDir } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const startedProcess = ptyAdapter.processes[0];
      assert.isDefined(startedProcess);
      startedProcess.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "1..24 | ForEach-Object { Start-Sleep -Seconds 5 }\r",
      });

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.command === "1..24 | ForEach-Object { Start-Sleep -Seconds 5 }",
          ),
        ),
      );

      // Kept with the tab list while it runs, so a restart can offer it again.
      const fileSystem = yield* FileSystem.FileSystem;
      const savedCatalog = fileSystem
        .readFileString(`${logsDir}/terminal_${Base64Url.encode("thread-1")}.tabs.json`)
        .pipe(Effect.orElseSucceed(() => ""));
      yield* waitFor(Effect.map(savedCatalog, (text) => text.includes("Start-Sleep")));

      yield* Effect.sleep("100 millis");
      expect(
        (yield* getEvents).some(
          (event) => event.type === "activity" && event.hasRunningSubprocess === false,
        ),
      ).toBe(false);

      const process = ptyAdapter.processes[0];
      assert.isDefined(process);
      process.emitData("\u001b]633;");
      process.emitData("D\u0007PS C:\\repo> ");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
      );

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).not.toContain("633;D");
      // Ended by itself: nothing a later restart could cut off.
      yield* waitFor(Effect.map(savedCatalog, (text) => !text.includes("Start-Sleep")));
    }),
  );

  it.effect("ignores a PowerShell completion marker queued before command submission", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      assert.isDefined(process);

      const drainBlocked = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.data === "prompt output"
          ? Deferred.succeed(drainBlocked, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDrain)),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      process.emitData("prompt output");
      yield* Deferred.await(drainBlocked);
      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "Start-Sleep -Seconds 30\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
      );

      yield* Deferred.succeed(releaseDrain, undefined);
      yield* Effect.sleep("60 millis");
      expect((yield* getEvents).filter((event) => event.type === "activity")).toEqual([
        expect.objectContaining({
          type: "activity",
          hasRunningSubprocess: true,
          command: "Start-Sleep -Seconds 30",
        }),
      ]);

      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && !event.hasRunningSubprocess),
        ),
      );
    }),
  );

  it.effect("ignores an in-flight subprocess result after PowerShell reports completion", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const checkResult = yield* Deferred.make<boolean>();
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () =>
          Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(checkResult)),
          ),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      assert.isDefined(process);
      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        // Recalled from history: the server polls to name it.
        data: "\u001b[A\r",
      });
      yield* Deferred.await(checkStarted);

      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
      );

      yield* Deferred.succeed(checkResult, true);
      yield* Effect.sleep("60 millis");

      const activityStates = (yield* getEvents)
        .filter((event) => event.type === "activity")
        .map((event) => event.hasRunningSubprocess);
      expect(activityStates).toEqual([true, false]);
    }),
  );

  // The prompt marker ends a PowerShell command, so reading the process
  // table (a PowerShell process of its own on Windows) can only name one.
  it.effect("reads no process table for a PowerShell command it can name", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () =>
          Effect.sync(() => {
            checks += 1;
            return true;
          }),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      assert.isDefined(process);
      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "npm run dev\r",
      });
      yield* Effect.sleep("200 millis");
      assert.equal(checks, 0);

      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
      );
    }),
  );

  it.effect("stops looking for a recalled PowerShell command's name after a few polls", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        // A cmdlet runs inside the shell: there is no process to find.
        subprocessChecker: () =>
          Effect.sync(() => {
            checks += 1;
            return false;
          }),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\u001b[A\r",
      });
      yield* Effect.sleep("400 millis");
      assert.equal(checks, 3);
    }),
  );

  it.effect("installs PowerShell activity before an immediate prompt marker can arrive", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      assert.isDefined(process);
      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      process.onWrite = () => process.emitData("\u001b]633;D\u0007PS C:\\repo> ");

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "Write-Output fast\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
      );

      const activityStates = (yield* getEvents)
        .filter((event) => event.type === "activity")
        .map((event) => event.hasRunningSubprocess);
      expect(activityStates).toEqual([true, false]);
    }),
  );

  it.effect("keeps a command submitted before the first prompt alive past the startup marker", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        shellResolver: () => "powershell.exe",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });

      // The run-script flow writes the command right after open, while a real
      // PowerShell is still booting, so the shell's first prompt marker
      // arrives after the submission and carries its generation.
      yield* manager.open(openInput());
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "vp run dev:desktop\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
      );

      const process = ptyAdapter.processes[0];
      assert.isDefined(process);
      process.emitData("\u001b]633;D\u0007PS C:\\repo> vp run dev:desktop\r\n");

      yield* Effect.sleep("100 millis");
      expect(
        (yield* getEvents).some(
          (event) => event.type === "activity" && event.hasRunningSubprocess === false,
        ),
      ).toBe(false);

      process.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && !event.hasRunningSubprocess),
        ),
      );
    }),
  );

  it.effect("replays current subprocess activity to a new subscriber", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        subprocessChecker: () => Effect.succeed(true),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      yield* showPrompt(manager, shell);
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "vp run dev:desktop\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );

      const liveActivity = (yield* getEvents).find(
        (event) => event.type === "activity" && event.hasRunningSubprocess,
      );
      const startedAt = liveActivity?.type === "activity" ? liveActivity.startedAt : undefined;
      assert.isString(startedAt);

      const replayedEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(replayedEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      // A client that subscribes later learns when the command started, not
      // when the terminal last printed something.
      expect(yield* Ref.get(replayedEvents)).toContainEqual(
        expect.objectContaining({
          type: "activity",
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          hasRunningSubprocess: true,
          command: "vp run dev:desktop",
          startedAt,
        }),
      );
    }),
  );

  it.effect("keeps polling after a submitted command survives an initial false sample", () =>
    Effect.gen(function* () {
      let checks = 0;
      let hasRunningSubprocess = false;
      const { manager, getEvents } = yield* createManager(5, {
        // Poll-only path; see the platform note in the activity test above.
        platform: "linux",
        subprocessChecker: () => {
          checks += 1;
          return Effect.succeed(hasRunningSubprocess);
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        // Shell history recalls command text inside the PTY, so the server can
        // observe the submission but cannot reconstruct its label.
        data: "\u001b[A\r",
      });
      yield* waitFor(
        Effect.sync(() => checks >= 2),
        "1200 millis",
      );

      hasRunningSubprocess = true;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      hasRunningSubprocess = false;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          activityAfter(
            events,
            (event) => event.hasRunningSubprocess,
            (event) => !event.hasRunningSubprocess,
          ),
        ),
        "1200 millis",
      );
      const checksAfterConfirmedIdle = checks;
      yield* Effect.sleep("80 millis");
      assert.equal(checks, checksAfterConfirmedIdle);
    }),
  );

  it.effect("checks a long-running command less often until the terminal is used", () =>
    Effect.gen(function* () {
      let checks = 0;
      let hasRunningSubprocess = true;
      const { manager, getEvents } = yield* createManager(5, {
        // Poll-only path; see the platform note in the activity test above.
        platform: "linux",
        subprocessChecker: () =>
          Effect.sync(() => {
            checks += 1;
            return hasRunningSubprocess;
          }),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "vp run dev\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
      );

      // Every 20 ms this window would hold about 30 checks; backing off to
      // 300 ms apart leaves a handful.
      const checksBeforeWindow = checks;
      yield* Effect.sleep("600 millis");
      expect(checks - checksBeforeWindow).toBeLessThan(10);

      // Ctrl+C: the next tick looks again, and the exit shows quickly.
      hasRunningSubprocess = false;
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\u0003",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && !event.hasRunningSubprocess),
        ),
        "250 millis",
      );
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        processKillGraceMs: 10,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("signals the shell's descendant processes when stopping a terminal", () =>
    Effect.gen(function* () {
      // 4242/4243 ignore SIGTERM (stay alive) and must be force-killed after
      // the grace period; 4244 exits on SIGTERM and must not be SIGKILLed.
      const signals: Array<{ pid: number; signal: string }> = [];
      const alive = new Set([4242, 4243]);
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        processKillGraceMs: 10,
        processTree: {
          listDescendants: () => [4242, 4243, 4244],
          listTerminalProcesses: () => null,
          signal: (pid, signal) => {
            signals.push({ pid, signal });
            if (signal === "SIGKILL") alive.delete(pid);
          },
          interruptGroup: () => {},
          isAlive: (pid) => alive.has(pid),
        },
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({ threadId: "thread-1" });
      yield* waitFor(
        Effect.sync(() => signals.filter((entry) => entry.signal === "SIGKILL").length >= 2),
      );

      const terms = signals.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid);
      const kills = signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid);
      assert.deepEqual(terms, [4242, 4243, 4244]);
      assert.deepEqual(kills, [4242, 4243]);
      assert.equal(process.killSignals[0], "SIGTERM");
    }),
  );

  it.effect("kills the terminal without a signal on Windows", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        subprocessChecker: () => Effect.succeed(false),
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({ threadId: "thread-1" });
      yield* waitFor(Effect.sync(() => process.killed));

      expect(process.killSignals).toEqual([undefined]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      // Failed shells stay (a clean exit closes the tab).
      first.emitExit({ exitCode: 1, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 1, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      // The evicted one is let go but not forgotten: it comes back from its
      // saved history as it ended, and no shell starts.
      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2", attach: true }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1", attach: true }));

      assert.equal(reopenedSecond.status, "exited");
      assert.equal(reopenedFirst.status, "exited");
      assert.equal(reopenedFirst.exitCode, 1);
      assert.equal(reopenedFirst.history, "first-history\n");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const missingShell =
        process.platform === "win32"
          ? "C:\\definitely\\missing-shell.exe"
          : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        process.platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (process.platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      });

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: expect.arrayContaining(["-NoLogo", "-NoExit", "-Command"]),
        }),
      );
      expect(ptyAdapter.spawnInputs[0]?.args?.at(-1)).toContain("633;D");
      expect(ptyAdapter.spawnInputs[0]?.args?.at(-1)).toContain("PowerShell.OnIdle");
      expect(ptyAdapter.spawnInputs[0]?.args?.at(-1)).toContain("__threadlinesPromptWrapper");
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
        shellResolver: () => "C:\\missing\\custom-shell.exe",
      });
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(
        expect.arrayContaining(["-NoLogo", "-NoExit", "-Command"]),
      );
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(
        expect.arrayContaining(["-NoLogo", "-NoExit", "-Command"]),
      );
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const originalValues = new Map<string, string | undefined>();
      const setEnv = (key: string, value: string | undefined) => {
        if (!originalValues.has(key)) {
          originalValues.set(key, process.env[key]);
        }
        if (value === undefined) {
          delete process.env[key];
          return;
        }
        process.env[key] = value;
      };
      const restoreEnv = () => {
        for (const [key, value] of originalValues) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };

      setEnv("PORT", "5173");
      setEnv("THREADLINES_PORT", "3773");
      setEnv("BADCODE_PORT", "3773");
      setEnv("T3CODE_PORT", "3773");
      setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
      setEnv("TEST_TERMINAL_KEEP", "keep-me");
      // What the server sets on itself on Windows: terminals get the user's lookup back.
      setEnv(WORKING_FOLDER_LOOKUP_VARIABLE, "1");
      setEnv(SERVER_ADDED_VARIABLE, "1");

      try {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const spawnInput = ptyAdapter.spawnInputs[0];
        expect(spawnInput).toBeDefined();
        if (!spawnInput) return;

        expect(spawnInput.env.PORT).toBeUndefined();
        expect(spawnInput.env.THREADLINES_PORT).toBeUndefined();
        expect(spawnInput.env.BADCODE_PORT).toBeUndefined();
        expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
        expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
        expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
        expect(spawnInput.env[WORKING_FOLDER_LOOKUP_VARIABLE]).toBeUndefined();
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            THREADLINES_PROJECT_ROOT: "/repo",
            THREADLINES_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.THREADLINES_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.THREADLINES_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("prepends local project binaries to spawned terminal PATH", () =>
    Effect.gen(function* () {
      const projectRoot = process.cwd();
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
      });
      yield* manager.open(
        openInput({
          cwd: projectRoot,
          env: {
            THREADLINES_PROJECT_ROOT: projectRoot,
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(
        spawnInput.env.PATH?.startsWith(`${posixLocalNodeModulesBinPath(projectRoot)}:/usr/bin`),
      ).toBe(true);
    }),
  );

  it.effect("prefers worktree binaries before project root binaries in spawned PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
      });
      const worktreePath = path.join(baseDir, "worktree-a");
      yield* fs.makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
          env: {
            THREADLINES_PROJECT_ROOT: baseDir,
            THREADLINES_WORKTREE_PATH: worktreePath,
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(
        spawnInput.env.PATH?.startsWith(
          `${posixLocalNodeModulesBinPath(worktreePath)}:${posixLocalNodeModulesBinPath(baseDir)}:/usr/bin`,
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps runtime PATH entries ahead of inherited PATH entries", () =>
    Effect.gen(function* () {
      const projectRoot = process.cwd();
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
      });
      yield* manager.open(
        openInput({
          cwd: projectRoot,
          env: {
            THREADLINES_PROJECT_ROOT: projectRoot,
            PATH: "/custom/bin",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(
        spawnInput.env.PATH?.startsWith(
          `${posixLocalNodeModulesBinPath(projectRoot)}:/custom/bin:/usr/bin`,
        ),
      ).toBe(true);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const scope = yield* Effect.scope;
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n" }),
        expect.objectContaining({ type: "output", data: "second\n" }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0 }),
      ]);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("offers to run again the command a server stop cut off, until it is used", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logsDir = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-terminal-" }),
        "terminals",
      );
      let running = false;
      const firstRun = yield* Scope.make("sequential");
      const first = yield* createManager(5, {
        logsDir,
        platform: "linux",
        subprocessChecker: () => Effect.sync(() => running),
        subprocessPollIntervalMs: 20,
      }).pipe(Effect.provideService(Scope.Scope, firstRun));
      yield* first.manager.open(openInput());
      const shell = first.ptyAdapter.processes[0];
      if (!shell) return;
      const target = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };
      const catalogFile = path.join(logsDir, `terminal_${Base64Url.encode("thread-1")}.tabs.json`);
      const savedCatalog = fileSystem
        .readFileString(catalogFile)
        .pipe(Effect.orElseSucceed(() => ""));
      yield* showPrompt(first.manager, shell);

      // A command that ends by itself is nothing to offer later.
      running = true;
      yield* first.manager.write({ ...target, data: "make build\r" });
      yield* waitFor(
        Effect.map(savedCatalog, (text) => text.includes("make build")),
        "2 seconds",
      );
      running = false;
      yield* waitFor(
        Effect.map(savedCatalog, (text) => !text.includes("make build")),
        "2 seconds",
      );

      running = true;
      yield* first.manager.write({ ...target, data: "npm run dev\r" });
      yield* waitFor(
        Effect.map(savedCatalog, (text) => text.includes("npm run dev")),
        "2 seconds",
      );
      yield* Scope.close(firstRun, Exit.void);

      const secondRun = yield* Scope.make("sequential");
      const second = yield* createManager(5, { logsDir, platform: "linux" }).pipe(
        Effect.provideService(Scope.Scope, secondRun),
      );
      const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
      const unsubscribe = yield* second.manager.subscribeMetadata((event) =>
        Ref.update(streamed, (events) => [...events, event]),
      );
      const offered = Effect.map(
        Ref.get(streamed),
        (events) =>
          events
            .flatMap((event) =>
              event.type === "catalog"
                ? event.threads.flatMap((thread) => thread.tabs)
                : event.type === "tabs"
                  ? event.tabs
                  : [],
            )
            .at(-1)?.interruptedCommand,
      );
      expect(yield* offered).toBe("npm run dev");

      const restarted = yield* second.manager.open(openInput({ attach: true }));
      expect(restarted.status).toBe("running");
      const newShell = second.ptyAdapter.processes[0];
      if (!newShell) return;
      yield* showPrompt(second.manager, newShell);
      // Typed after what's on the line, it would run something else.
      yield* second.manager.write({ ...target, data: "echo " });
      const refused = yield* Effect.flip(
        second.manager.resolveInterrupted({ ...target, run: true }),
      );
      expect(refused._tag).toBe("TerminalLineBusyError");
      expect(yield* offered).toBe("npm run dev");

      // On an empty line it runs as if typed, and the offer goes on every device.
      yield* second.manager.write({ ...target, data: "\u0015" });
      yield* second.manager.resolveInterrupted({ ...target, run: true });
      expect(newShell.writes.at(-1)).toBe("npm run dev\r");
      yield* waitFor(Effect.map(offered, (command) => command === null));
      yield* waitFor(
        Effect.map(savedCatalog, (text) => !text.includes('"interruptedCommand":"npm run dev"')),
      );
      unsubscribe();
      yield* Scope.close(secondRun, Exit.void);
    }),
  );

  it.effect("saves output still waiting to be saved when the server shuts down", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logsDir = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-terminal-" }),
        "terminals",
      );
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        persistDebounceMs: 60_000,
        logsDir,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      if (!process) return;
      process.emitData("last words\n");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (snapshot) => snapshot.history === "last words\n"),
      );

      yield* Scope.close(scope, Exit.void);

      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("last words\n");
    }),
  );

  const commandRunInput = (
    overrides: Partial<TerminalCommandRunInput> = {},
  ): TerminalCommandRunInput => ({
    threadId: "thread-1",
    terminalId: "terminal-run",
    runId: "run-1",
    mode: "run",
    dialect: "posix",
    command: "pnpm install",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  });

  const collectRunUpdates = (manager: TerminalManagerShape) =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<TerminalCommandRunUpdate>>([]);
      yield* manager.subscribeCommandRuns((update) =>
        Ref.update(updates, (current) => [...current, update]),
      );
      return updates;
    });

  it.effect("runs a command in its own tab and ends at the wrapper's marker", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      const updates = yield* collectRunUpdates(manager);
      yield* manager.startCommandRun(commandRunInput());

      const spawn = ptyAdapter.spawnInputs[0];
      expect(spawn?.shell).toBe("/bin/zsh");
      expect(spawn?.args?.slice(0, 4)).toEqual(["-o", "nopromptsp", "-i", "-c"]);
      expect(spawn?.args?.[4]).toContain(`exec "$__tl_sh" '-o' 'nopromptsp'`);
      expect(spawn?.env).toMatchObject({
        THREADLINES_RUN_COMMAND: "pnpm install",
        THREADLINES_RUN_ID: "run-1",
        THREADLINES_RUN_SHELL: "/bin/zsh",
      });

      // Opening the tab with another environment attaches; it must not respawn.
      yield* manager.open(
        openInput({ terminalId: "terminal-run", env: { THREADLINES_OTHER: "1" } }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      const pty = ptyAdapter.processes[0]!;
      // Startup-file noise and the echoed command line come before the output.
      pty.emitData("Last login: today\r\n\u001b[2m$ pnpm install\u001b[22m\r\n");
      yield* waitFor(
        manager
          .open(openInput({ terminalId: "terminal-run" }))
          .pipe(Effect.map((snapshot) => snapshot.history.includes("$ pnpm install"))),
      );
      expect(yield* manager.readCommandRunOutput("run-1")).toBe("");
      pty.emitData("\u001b]6973;run-1;start\u0007Progress 1/3\rProgress 3/3\r\ndone\r\n");
      pty.emitData("\u001b]6973;run-1;0\u0007prompt % \u001b[?2004h");
      yield* waitFor(
        Ref.get(updates).pipe(Effect.map((list) => list.some((u) => u.type === "finished"))),
      );
      expect(yield* Ref.get(updates)).toEqual([
        expect.objectContaining({ type: "running", runId: "run-1" }),
        expect.objectContaining({
          type: "finished",
          runId: "run-1",
          exitCode: 0,
          output: "Progress 3/3\ndone",
        }),
      ]);
      // The marker never reaches the terminal's history.
      const snapshot = yield* manager.open(openInput({ terminalId: "terminal-run" }));
      expect(snapshot.history).not.toContain("6973");
    }),
  );

  it.effect("shows a running command as its tab's activity, also to a late subscriber", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.startCommandRun(commandRunInput({ command: "npm run dev" }));
      const seen = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      yield* manager.subscribe((event) => Ref.update(seen, (events) => [...events, event]));
      const activity = (yield* Ref.get(seen)).find(
        (event) => event.type === "activity" && event.terminalId === "terminal-run",
      );
      expect(activity).toMatchObject({
        hasRunningSubprocess: true,
        command: "npm run dev",
        startedAt: expect.any(String),
      });
    }),
  );

  it.effect("never has a client replay output its snapshot already holds", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.startCommandRun(commandRunInput({ command: "npm run dev" }));
      const pty = ptyAdapter.processes[0]!;
      for (const chunk of ["one\r\n", "two\r\n", "three\r\n"]) pty.emitData(chunk);
      yield* waitFor(
        getEvents.pipe(
          Effect.map((events) => events.filter((event) => event.type === "output").length === 3),
        ),
      );
      // A client opening the tab now writes the snapshot, then replays the
      // events newer than it (ThreadTerminalDrawer).
      const snapshot = yield* manager.open(openInput({ terminalId: "terminal-run" }));
      const events = yield* getEvents;
      expect(
        events.filter(
          (event) =>
            (event.type === "output" || event.type === "started") &&
            event.terminalId === "terminal-run" &&
            event.createdAt > snapshot.updatedAt,
        ),
      ).toEqual([]);
    }),
  );

  it.effect("ends a run as interrupted when its tab is closed", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      const updates = yield* collectRunUpdates(manager);
      yield* manager.startCommandRun(commandRunInput({ command: "npm run dev" }));
      ptyAdapter.processes[0]!.emitData("\u001b]6973;run-1;start\u0007ready on :3000\r\n");
      yield* waitFor(
        manager.readCommandRunOutput("run-1").pipe(Effect.map((out) => out === "ready on :3000")),
      );
      yield* manager.close({ threadId: "thread-1", terminalId: "terminal-run" });
      yield* waitFor(
        Ref.get(updates).pipe(Effect.map((list) => list.some((u) => u.type === "interrupted"))),
      );
      expect((yield* Ref.get(updates)).at(-1)).toMatchObject({
        type: "interrupted",
        output: "ready on :3000",
      });
    }),
  );

  it.effect("refuses to run a POSIX command where only PowerShell can run it", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager(50, {
        platform: "win32",
        shellResolver: () => "pwsh.exe",
      });
      const exit = yield* Effect.exit(manager.startCommandRun(commandRunInput()));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("puts a command at the prompt once the shell is ready and follows it to its end", () =>
    Effect.gen(function* () {
      // In front of the terminal at its own prompt, or behind a program it started.
      const shellInFront = yield* Ref.make(true);
      let shellPid = 0;
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
        // Polling never gets a look in: the prompt alone ends it.
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 60_000,
        freshProcessRowsReader: () =>
          Ref.get(shellInFront).pipe(
            Effect.map((front) => [
              { ...processRow(shellPid, 1, "/bin/zsh"), status: front ? "Ss+" : "Ss" },
            ]),
          ),
      });
      const updates = yield* collectRunUpdates(manager);
      const types = Ref.get(updates).pipe(Effect.map((list) => list.map((update) => update.type)));
      yield* manager.startCommandRun(
        commandRunInput({ mode: "insert", command: "git add .\ngit commit" }),
      );
      const pty = ptyAdapter.processes[0]!;
      shellPid = pty.pid;
      expect(ptyAdapter.spawnInputs[0]?.args).toEqual(["-o", "nopromptsp"]);
      expect(pty.writes).toEqual([]);

      pty.emitData("prompt % \u001b[?2004h");
      yield* waitFor(Effect.sync(() => pty.writes.length === 1));
      expect(pty.writes[0]).toBe("\u001b[200~git add .\ngit commit\u001b[201~");

      pty.emitData("git add .\r\ngit commit");
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "\r" });
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("running"))));
      // A program it started that reads lines (the commit message editor)
      // turns the line editor on too: while it runs in front, the command goes on.
      yield* Ref.set(shellInFront, false);
      pty.emitData("\u001b[?2004l\r\nmessage: \u001b[?2004h");
      yield* Effect.sleep("150 millis");
      expect(yield* types).toEqual(["waiting", "running"]);

      // Back at the shell's own prompt: done, with what the tab showed.
      yield* Ref.set(shellInFront, true);
      pty.emitData("\u001b[?2004l\r\n[main 1a2b3c] fix\r\nprompt % \u001b[?2004h");
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("finished"))));
      expect((yield* Ref.get(updates)).at(-1)).toEqual({
        type: "finished",
        runId: "run-1",
        at: expect.any(String),
        startedAt: expect.any(String),
        exitCode: null,
        output: "git add .\ngit commit\nmessage:\n[main 1a2b3c] fix\nprompt %",
      });
    }),
  );

  it.effect("keeps following an entered insert until its shell's prompt is back", () =>
    Effect.gen(function* () {
      let shellPid = 0;
      const nextCommandRunning = yield* Ref.make(false);
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
        subprocessChecker: () => Ref.get(nextCommandRunning),
        subprocessPollIntervalMs: 20,
        // By the time anyone looks, the line typed ahead runs in front.
        freshProcessRowsReader: () =>
          Effect.sync(() => [{ ...processRow(shellPid, 1, "/bin/zsh"), status: "Ss" }]),
      });
      const updates = yield* collectRunUpdates(manager);
      const types = Ref.get(updates).pipe(Effect.map((list) => list.map((update) => update.type)));
      yield* manager.startCommandRun(commandRunInput({ mode: "insert", command: "read answer" }));
      const pty = ptyAdapter.processes[0]!;
      shellPid = pty.pid;
      pty.emitData("prompt % \u001b[?2004h");
      yield* waitFor(Effect.sync(() => pty.writes.length === 1));
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "\r" });
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("running"))));
      // A builtin waiting for input runs no process: idle polls don't end it.
      pty.emitData("read answer\u001b[?2004l\r\n");
      yield* Effect.sleep("250 millis");
      expect(yield* types).toEqual(["waiting", "running"]);

      // Answered, and the next command typed before the prompt is back: the
      // command ends at that prompt, before the next one takes the terminal.
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "yes\r" });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: "terminal-run",
        data: "npm run dev\r",
      });
      yield* Ref.set(nextCommandRunning, true);
      pty.emitData("yes\r\nprompt % \u001b[?2004hnpm run dev\u001b[?2004l\r\nready on :3000\r\n");
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("finished"))));
      expect((yield* Ref.get(updates)).at(-1)).toMatchObject({
        type: "finished",
        output: "read answer\nyes\nprompt %",
      });
    }),
  );

  it.effect("never takes an answer typed to the command for a line typed ahead", () =>
    Effect.gen(function* () {
      const shellInFront = yield* Ref.make(false);
      let shellPid = 0;
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
        subprocessChecker: () => Ref.get(shellInFront).pipe(Effect.map((front) => !front)),
        subprocessPollIntervalMs: 20,
        freshProcessRowsReader: () =>
          Ref.get(shellInFront).pipe(
            Effect.map((front) => [
              { ...processRow(shellPid, 1, "/bin/zsh"), status: front ? "Ss+" : "Ss" },
            ]),
          ),
      });
      const updates = yield* collectRunUpdates(manager);
      const types = Ref.get(updates).pipe(Effect.map((list) => list.map((update) => update.type)));
      yield* manager.startCommandRun(commandRunInput({ mode: "insert", command: "ssh build-box" }));
      const pty = ptyAdapter.processes[0]!;
      shellPid = pty.pid;
      pty.emitData("prompt % \u001b[?2004h");
      yield* waitFor(Effect.sync(() => pty.writes.length === 1));
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "\r" });
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("running"))));
      // The password is a line entered before any prompt; the remote shell's
      // prompt then stays up for the user, who works there.
      pty.emitData("ssh build-box\u001b[?2004l\r\npassword: ");
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "secret\r" });
      pty.emitData("\r\nremote $ \u001b[?2004h");
      yield* Effect.sleep("100 millis");
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "ls\r" });
      pty.emitData("ls\u001b[?2004l\r\nfile\r\nremote $ \u001b[?2004h");
      yield* Effect.sleep("150 millis");
      expect(yield* types).toEqual(["waiting", "running"]);

      yield* Ref.set(shellInFront, true);
      pty.emitData("logout\r\nprompt % \u001b[?2004h");
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("finished"))));
      expect((yield* Ref.get(updates)).at(-1)).toMatchObject({
        type: "finished",
        output: expect.stringContaining("remote $ ls\nfile"),
      });
    }),
  );

  it.effect("ends a PowerShell command entered from an insert at its prompt's marker", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "win32",
        shellResolver: () => "pwsh.exe",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });
      const updates = yield* collectRunUpdates(manager);
      const types = Ref.get(updates).pipe(Effect.map((list) => list.map((update) => update.type)));
      yield* manager.startCommandRun(
        commandRunInput({ mode: "insert", dialect: "powershell", command: "gh auth login" }),
      );
      const pty = ptyAdapter.processes[0]!;
      pty.emitData("\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(Effect.sync(() => pty.writes.length === 1));
      yield* manager.write({ threadId: "thread-1", terminalId: "terminal-run", data: "\r" });
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("running"))));
      // A cmdlet has no process to find: polling never ends it, the prompt does.
      yield* Effect.sleep("150 millis");
      expect(yield* types).toEqual(["waiting", "running"]);
      pty.emitData("gh auth login\r\nLogged in\r\n\u001b]633;D\u0007PS C:\\repo> ");
      yield* waitFor(types.pipe(Effect.map((list) => list.includes("finished"))));
      expect((yield* Ref.get(updates)).at(-1)).toMatchObject({
        type: "finished",
        exitCode: null,
        output: expect.stringContaining("Logged in"),
      });
    }),
  );

  const runFinished = (updates: Ref.Ref<ReadonlyArray<TerminalCommandRunUpdate>>, runId: string) =>
    waitFor(
      Ref.get(updates).pipe(
        Effect.map((list) => list.some((u) => u.type === "finished" && u.runId === runId)),
      ),
    );

  it.effect("runs commands one after another in the thread's unused first tab", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      const updates = yield* collectRunUpdates(manager);
      const chosen: string[] = [];
      const first = yield* manager.startCommandRun(
        commandRunInput({ terminalId: "terminal-a", reuseTerminalIds: [DEFAULT_TERMINAL_ID] }),
        (terminalId) =>
          Effect.sync(() => chosen.push(`${terminalId} after ${ptyAdapter.spawnInputs.length}`)),
      );
      expect(first).toBe(DEFAULT_TERMINAL_ID);
      // Told before anything spawned, so the run is recorded before it can end.
      expect(chosen).toEqual([`${DEFAULT_TERMINAL_ID} after 0`]);

      const shell = ptyAdapter.processes[0]!;
      shell.emitData("\u001b]6973;run-1;start\u0007installed\r\n\u001b]6973;run-1;0\u0007% ");
      yield* runFinished(updates, "run-1");

      const second = yield* manager.startCommandRun(
        commandRunInput({
          runId: "run-2",
          command: "pnpm test",
          terminalId: "terminal-b",
          reuseTerminalIds: [DEFAULT_TERMINAL_ID],
        }),
      );
      expect(second).toBe(DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({ THREADLINES_RUN_ID: "run-2" });
      yield* waitFor(Effect.sync(() => shell.killed));
      // The first run's output stays above; the next starts on a line of its own.
      const started = (yield* getEvents).filter(
        (event) => event.type === "started" && event.terminalId === DEFAULT_TERMINAL_ID,
      );
      expect(started.at(-1)).toMatchObject({ snapshot: { history: "installed\r\n% \r\n" } });
    }),
  );

  it.effect("never takes over a tab someone typed in, but the terminal's replies don't count", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput({ terminalId: "typed" }));
      yield* manager.open(openInput({ terminalId: "shift-f3" }));
      yield* manager.open(openInput({ terminalId: "replied" }));
      yield* manager.write({ threadId: "thread-1", terminalId: "typed", data: "ls\r" });
      // A key that reads like a cursor report from the first row.
      yield* manager.write({ threadId: "thread-1", terminalId: "shift-f3", data: "\u001b[1;2R" });
      // Cursor position, device attributes and a color, as xterm answers a prompt's queries.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: "replied",
        data: "\u001b[12;5R\u001b[?1;2c\u001b]11;rgb:0000/0000/0000\u001b\\",
      });

      const chosen = yield* manager.startCommandRun(
        commandRunInput({
          terminalId: "terminal-new",
          reuseTerminalIds: ["typed", "shift-f3", "replied"],
        }),
      );
      expect(chosen).toBe("replied");
      expect(ptyAdapter.processes.slice(0, 2).map((process) => process.killed)).toEqual([
        false,
        false,
      ]);
    }),
  );

  it.effect("never takes over a tab while something runs in it or lives on its terminal", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
        processTree: {
          ...noopProcessTree,
          // A job an earlier command left behind, still on the first tab's terminal.
          listTerminalProcesses: (pid) => (pid === 9000 ? [4321] : []),
        },
      });
      yield* manager.open(openInput({ terminalId: "left-a-job" }));
      yield* manager.startCommandRun(commandRunInput({ terminalId: "running" }));

      const chosen = yield* manager.startCommandRun(
        commandRunInput({
          runId: "run-2",
          terminalId: "terminal-new",
          reuseTerminalIds: ["left-a-job", "running"],
        }),
      );
      expect(chosen).toBe("terminal-new");
      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([false, false, false]);
    }),
  );

  it.effect("changes no tab until its run is recorded, nor one typed in meanwhile", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "darwin",
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const refused = yield* Effect.exit(
        manager.startCommandRun(commandRunInput({ reuseTerminalIds: [DEFAULT_TERMINAL_ID] }), () =>
          Effect.fail("not recorded"),
        ),
      );
      expect(refused).toEqual(Exit.fail("not recorded"));

      // Keys reach a tab without the lock a run holds while it is recorded.
      const typedMeanwhile = yield* Effect.exit(
        manager.startCommandRun(
          commandRunInput({ reuseTerminalIds: [DEFAULT_TERMINAL_ID] }),
          (terminalId) => manager.write({ threadId: "thread-1", terminalId, data: "g" }),
        ),
      );
      expect(Exit.isFailure(typedMeanwhile)).toBe(true);
      expect(ptyAdapter.processes).toHaveLength(1);
      expect(ptyAdapter.processes[0]!.killed).toBe(false);
    }),
  );

  it.effect("gives scripts the free tab in their folder, again once each one ends", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, baseDir } = yield* createManager(50, {
        // Poll-only path; see the platform note in the activity test above.
        platform: "linux",
        shellResolver: () => "/bin/zsh",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "elsewhere", cwd: baseDir }));
      const openForScript = (terminalId: string) =>
        manager.open(
          openInput({ terminalId, reuseTerminalIds: ["elsewhere", DEFAULT_TERMINAL_ID] }),
        );

      const first = yield* openForScript("terminal-a");
      // Typed into as it is: no new shell.
      expect(first.terminalId).toBe(DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      // Held until the first script's keys arrive.
      expect((yield* openForScript("terminal-b")).terminalId).toBe("terminal-b");

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "bun run lint\r",
        origin: "script",
      });
      // Busy until polling is sure the script ended.
      expect((yield* openForScript("terminal-c")).terminalId).toBe("terminal-c");
      yield* waitFor(
        openForScript("terminal-d").pipe(
          Effect.map((opened) => opened.terminalId === DEFAULT_TERMINAL_ID),
        ),
        "1500 millis",
      );
    }),
  );

  it.effect("takes no tab over whose shell ran a PowerShell command itself", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(50, {
        platform: "win32",
        shellResolver: () => "pwsh.exe",
      });
      const updates = yield* collectRunUpdates(manager);
      yield* manager.startCommandRun(
        commandRunInput({ terminalId: "ran-here", dialect: "powershell", command: "npm install" }),
      );
      // The command ran in the tab's own shell, which may have moved since.
      ptyAdapter.processes[0]!.emitData(
        "\u001b]6973;run-1;start\u0007ok\r\n\u001b]6973;run-1;0\u0007",
      );
      yield* runFinished(updates, "run-1");

      const chosen = yield* manager.startCommandRun(
        commandRunInput({
          runId: "run-2",
          terminalId: "terminal-new",
          dialect: "powershell",
          command: "npm test",
          reuseTerminalIds: ["ran-here"],
        }),
      );
      expect(chosen).toBe("terminal-new");
    }),
  );
  it.effect("never takes what is typed into a running program as the tab's command", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        subprocessChecker: () => Effect.succeed(true),
        subprocessPollIntervalMs: 20,
      });
      const write = (data: string) =>
        manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data });
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      yield* showPrompt(manager, shell);
      yield* write("sudo ls\r");
      // The line editor hands the line over (bracketed paste off) and sudo asks.
      shell.emitData("\u001b[?2004l\r\nPassword:");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (snapshot) => snapshot.history.includes("Password:")),
      );
      yield* write("hunter2\r");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.command === "sudo ls"),
        ),
        "1200 millis",
      );
      yield* Effect.sleep("120 millis");

      // A program reading lines the way the shell does (a REPL, a shell over
      // ssh) turns on the same bracketed paste switch.
      shell.emitData("\r\n>>> \u001b[?2004h");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (snapshot) => snapshot.history.includes(">>> ")),
      );
      yield* write("token = 'abc'\r");
      yield* Effect.sleep("120 millis");

      const commands = (yield* getEvents).flatMap((event) =>
        event.type === "activity" ? [event.command] : [],
      );
      expect(commands).not.toContain("hunter2");
      expect(commands.filter((command) => command?.includes("token"))).toEqual([]);
    }),
  );

  it.effect("names a command from the process table when the shell never shows its prompt", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager(5, {
        platform: "linux",
        subprocessChecker: () => Effect.succeed(true),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "secret-answer\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );
      const running = (yield* getEvents).find(
        (event) => event.type === "activity" && event.hasRunningSubprocess,
      );
      expect(running?.type === "activity" ? running.command : undefined).toBeNull();
    }),
  );

  it.effect("marks an entered command busy until polling sees it run or end", () =>
    Effect.gen(function* () {
      const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
        platform: "linux",
        subprocessChecker: () => Effect.succeed(false),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      yield* showPrompt(manager, shell);
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "cd ..\r",
      });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          activityAfter(
            events,
            (event) => event.commandPending === true,
            (event) => event.commandPending === false,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("shows a tab as it is when opened with another folder, never stopping its shell", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, baseDir } = yield* createManager();
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      shell.emitData("dev server running\n");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (snapshot) =>
          snapshot.history.includes("dev server running"),
        ),
      );

      const moved = yield* manager.open(
        openInput({ cwd: baseDir, env: { THREADLINES_WORKTREE_PATH: baseDir } }),
      );
      expect(moved.cwd).toBe(process.cwd());
      expect(moved.history).toContain("dev server running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(shell.killed).toBe(false);

      // Moving it is the user's call.
      const restarted = yield* manager.restart(restartInput({ cwd: baseDir }));
      expect(restarted.cwd).toBe(baseDir);
      expect(restarted.history).toContain("dev server running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("bounds kept history in size, so a progress bar can't grow it forever", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { historyCharLimit: 1_000 });
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      for (let step = 0; step < 500; step += 1) {
        shell.emitData(`\r[${"#".repeat(step % 40)}] ${step}`);
      }
      // A sequence that never ends is dropped, not held.
      shell.emitData(`\u001b]0;${"x".repeat(100_000)}`);
      shell.emitData("\r\ndone\n");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (snapshot) => snapshot.history.includes("done")),
      );

      const { history } = yield* manager.open(openInput());
      expect(history.length).toBeLessThanOrEqual(1_100);
      expect(history.startsWith("\r")).toBe(true);
      expect(history).toContain("] 499");
    }),
  );

  it.effect("lists a thread's tabs for every device, numbered for as long as they exist", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(streamed, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect((yield* Ref.get(streamed))[0]).toMatchObject({ type: "catalog", threads: [] });

      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "terminal-b" }));
      yield* manager.open(openInput({ terminalId: "terminal-c" }));
      ptyAdapter.processes[0]?.emitData("not for this stream\n");
      yield* manager.close({ threadId: "thread-1", terminalId: "terminal-b", deleteHistory: true });
      yield* manager.open(openInput({ terminalId: "terminal-d" }));

      const events = yield* Ref.get(streamed);
      const lastTabs = events.findLast((event) => event.type === "tabs");
      expect(
        lastTabs?.type === "tabs"
          ? lastTabs.tabs.map((tab) => [tab.terminalId, tab.number, tab.status])
          : [],
      ).toEqual([
        [DEFAULT_TERMINAL_ID, 1, "running"],
        ["terminal-c", 3, "running"],
        ["terminal-d", 2, "running"],
      ]);
      expect(events.some((event) => event.type === "output")).toBe(false);
      for (const event of events) {
        if (event.type === "started") expect(event.snapshot.history).toBe("");
      }
    }),
  );

  it.effect("builds a thread's tab list from history saved before tab lists existed", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = "3a28abe8-5c66-4815-95bb-72dbf4c33de4";
      const historyFile = (terminalId: string) =>
        multiTerminalHistoryLogPath(logsDir, threadId, terminalId).pipe(
          Effect.provideService(Path.Path, path),
        );
      yield* fileSystem.writeFileString(yield* historyFile(DEFAULT_TERMINAL_ID), "first\n");
      yield* fileSystem.writeFileString(yield* historyFile("terminal-x_y"), "second\n");
      // The oldest name for a first tab's history.
      const oldThreadId = "7c1f0e52-0d8e-4a8b-9a43-5b7e2b1f9d10";
      yield* fileSystem.writeFileString(path.join(logsDir, `${oldThreadId}.log`), "oldest\n");

      const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(streamed, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const catalog = (yield* Ref.get(streamed))[0];
      const threads = catalog?.type === "catalog" ? catalog.threads : [];
      expect(
        [...threads].sort((left, right) =>
          left.threadId === threadId ? -1 : right.threadId === threadId ? 1 : 0,
        ),
      ).toEqual([
        {
          threadId,
          tabs: [
            expect.objectContaining({
              terminalId: DEFAULT_TERMINAL_ID,
              number: 1,
              status: "stopped",
            }),
            expect.objectContaining({ terminalId: "terminal-x_y", number: 2, status: "stopped" }),
          ],
        },
        {
          threadId: oldThreadId,
          tabs: [expect.objectContaining({ terminalId: DEFAULT_TERMINAL_ID, number: 1 })],
        },
      ]);

      const attached = yield* manager.open(
        openInput({ threadId, terminalId: "terminal-x_y", attach: true }),
      );
      expect(attached.history).toBe("second\n");
      expect(attached.status).toBe("running");
    }),
  );

  it.effect("lets the device using a tab set its size and answer the terminal's queries", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0];
      if (!shell) return;
      const target = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };
      const resize = (cols: number, viewerId: string, claim = false) =>
        manager.resize({ ...target, cols, rows: 24, ...(claim ? { claim: true } : {}) }, viewerId);

      yield* resize(80, "desktop", true);
      yield* resize(40, "phone");
      expect(shell.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 24 });

      const cursorReport = "\u001b[12;1R";
      yield* manager.write({ ...target, data: cursorReport }, "phone");
      yield* manager.write({ ...target, data: cursorReport }, "desktop");
      expect(shell.writes).toEqual([cursorReport]);

      // Typing on the phone hands the tab to it, at the phone's size.
      yield* manager.write({ ...target, data: "l" }, "phone");
      expect(shell.resizeCalls.at(-1)).toEqual({ cols: 40, rows: 24 });

      yield* manager.releaseViewer("phone");
      yield* resize(90, "desktop");
      expect(shell.resizeCalls.at(-1)).toEqual({ cols: 90, rows: 24 });
    }),
  );

  it.effect("streams one thread's events, output included, after a subscribed marker", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));
      const streamed = yield* Ref.make<ReadonlyArray<TerminalStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeThread("thread-1", (event) =>
        Ref.update(streamed, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      ptyAdapter.processes[1]?.emitData("other thread\n");
      ptyAdapter.processes[0]?.emitData("this thread\n");
      yield* waitFor(
        Effect.map(Ref.get(streamed), (events) => events.some((event) => event.type === "output")),
      );
      const events = yield* Ref.get(streamed);
      expect(events[0]).toMatchObject({ type: "subscribed", threadId: "thread-1" });
      expect(events.every((event) => "threadId" in event && event.threadId === "thread-1")).toBe(
        true,
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "output", data: "this thread\n" }),
      );
    }),
  );

  it.effect(
    "names the tab and job holding a taken port on every device, until a line is entered",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, notice } = yield* setUpPortTaken();
        ptyAdapter.processes[1]?.emitData(`\u001b[31m${PORT_TAKEN}\u001b[39m`);

        yield* waitFor(Effect.map(notice, (value) => value !== null));
        expect(yield* notice).toMatchObject({
          port: 3000,
          holders: [
            {
              kind: "terminal",
              threadId: "thread-1",
              terminalId: "server",
              name: "node",
              command: "npm run dev",
            },
          ],
          canStop: true,
        });

        yield* manager.write({ threadId: "thread-1", data: "npm run dev\r" });
        yield* waitFor(Effect.map(notice, (value) => value === null));
      }),
  );

  it.effect("never brings a port notice back after Clear, and drops it once the port is free", () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ports = { rows: [HOLDER_LISTENING] as ReadonlyArray<ListeningPortRow> };
      let lookups = 0;
      const { manager, ptyAdapter, notice } = yield* setUpPortTaken({
        listeningPortReader: () =>
          Effect.gen(function* () {
            lookups += 1;
            if (lookups === 1) {
              yield* Deferred.succeed(lookupStarted, undefined);
              yield* Deferred.await(release);
            }
            return ports.rows;
          }),
      });
      ptyAdapter.processes[1]?.emitData(PORT_TAKEN);
      yield* Deferred.await(lookupStarted);
      // Cleared while the port was being looked up: that answer is old news.
      yield* manager.clear({ threadId: "thread-1" });
      yield* Deferred.succeed(release, undefined);
      yield* Effect.sleep(Duration.millis(50));
      expect(yield* notice).toBeNull();

      // The next command finds it taken again.
      yield* manager.write({ threadId: "thread-1", data: "npm start\r" });
      ptyAdapter.processes[1]?.emitData(PORT_TAKEN);
      yield* waitFor(Effect.map(notice, (value) => value !== null));
      // The holder's shell ends, and nothing listens any more.
      ports.rows = [];
      ptyAdapter.processes[0]?.emitExit({ exitCode: 1, signal: 0 });
      yield* waitFor(Effect.map(notice, (value) => value === null));
    }),
  );

  it.effect("stops only the job a port notice showed, and only on a click on that notice", () =>
    Effect.gen(function* () {
      const interrupted: number[] = [];
      const ports = { rows: [HOLDER_LISTENING] as ReadonlyArray<ListeningPortRow> };
      const { manager, ptyAdapter, notice } = yield* setUpPortTaken({
        listeningPortReader: () => Effect.sync(() => ports.rows),
        processTree: {
          ...noopProcessTree,
          interruptGroup: (pgid) => {
            interrupted.push(pgid);
            ports.rows = [];
          },
        },
      });
      ptyAdapter.processes[1]?.emitData(PORT_TAKEN);
      yield* waitFor(Effect.map(notice, (value) => value !== null));
      const shown = yield* notice;

      yield* manager.resolvePortInUse({ threadId: "thread-1", noticeId: "older", stop: true });
      expect(interrupted).toEqual([]);

      yield* manager.resolvePortInUse({
        threadId: "thread-1",
        noticeId: shown?.id ?? "",
        stop: true,
      });
      expect(interrupted).toEqual([7001]);
      yield* waitFor(Effect.map(notice, (value) => value === null));
    }),
  );

  it.effect("knows a quick ssh command's port error is another computer's", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, notice } = yield* setUpPortTaken({
        platform: "win32",
        shellResolver: () => "powershell.exe",
      });
      const shell = ptyAdapter.processes[1];
      const prompt = "\u001b]633;D\u0007PS C:\\repo> ";
      shell?.emitData(prompt);
      // The error and the command's end arrive together: by then the
      // process table has no ssh in it, only the line typed for it.
      yield* manager.write({ threadId: "thread-1", data: "ssh web-1 npm start\r" });
      shell?.emitData(`${PORT_TAKEN}${prompt}`);
      yield* Effect.sleep(Duration.millis(100));
      expect(yield* notice).toBeNull();

      yield* manager.write({ threadId: "thread-1", data: "npm start\r" });
      shell?.emitData(`${PORT_TAKEN}${prompt}`);
      yield* waitFor(Effect.map(notice, (value) => value !== null));
    }),
  );

  it.effect("never stops a job for a notice Clear took away while Stop was checking", () =>
    Effect.gen(function* () {
      const interrupted: number[] = [];
      const checking = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let stopping = false;
      const { manager, ptyAdapter, notice } = yield* setUpPortTaken({
        listeningPortReader: () =>
          Effect.gen(function* () {
            if (stopping) {
              yield* Deferred.succeed(checking, undefined);
              yield* Deferred.await(release);
            }
            return [HOLDER_LISTENING];
          }),
        processTree: { ...noopProcessTree, interruptGroup: (pgid) => interrupted.push(pgid) },
      });
      ptyAdapter.processes[1]?.emitData(PORT_TAKEN);
      yield* waitFor(Effect.map(notice, (value) => value !== null));
      const shown = yield* notice;

      stopping = true;
      const stop = yield* manager
        .resolvePortInUse({ threadId: "thread-1", noticeId: shown?.id ?? "", stop: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(checking);
      yield* manager.clear({ threadId: "thread-1" });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stop);
      expect(interrupted).toEqual([]);
    }),
  );
});
