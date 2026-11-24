// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createModelSelection } from "@threadlines/shared/model";

import {
  ApprovalRequestId,
  CursorSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@threadlines/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isProcessRunning } from "../testAgentProcess.ts";
import { PROJECT_BRIEF_CLEARED_NOTE } from "../projectBriefPreface.ts";
import { PROJECT_NOTE_WRITE_INSTRUCTION } from "../../projectContext/projectNotesAccess.ts";
import type { UsageLedgerEntry } from "../../usage/usageLedger.ts";
import { type AcpAdapterShape, acpDiffFileChanges, makeAcpAdapter } from "./AcpAdapter.ts";
import { discoverAcpModels } from "./AcpProvider.ts";
import { CURSOR_ACP_DESCRIPTOR } from "./CursorAcpSupport.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

// The mock agent emulates Cursor (`cursor/*` extension methods, parameterized
// model picker), so the generic adapter is exercised through the Cursor
// descriptor. Test-local service tag so tests can `yield* CursorAdapter`.
class CursorAdapter extends Context.Service<CursorAdapter, AcpAdapterShape>()(
  "test/CursorAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const nodeExe = process.execPath;
const isWindows = process.platform === "win32";

function batchQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function commandWrapperPath(dir: string): string {
  return path.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
}

function commandWrapperEnv(extraEnv?: Record<string, string>): string {
  return Object.entries(extraEnv ?? {})
    .map(([key, value]) =>
      isWindows ? `set "${key}=${value}"` : `export ${key}=${JSON.stringify(value)}`,
    )
    .join("\n");
}

async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-mock-"));
  const wrapperPath = commandWrapperPath(dir);
  const envExports = commandWrapperEnv(extraEnv);
  const script = isWindows
    ? `@echo off
setlocal
${envExports}
${options?.initialDelaySeconds ? `powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds ${options.initialDelaySeconds}"` : ""}
${batchQuote(nodeExe)} ${batchQuote(mockAgentPath)} %*
`
    : `#!/bin/sh
${envExports}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ""}
exec ${JSON.stringify(nodeExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-probe-"));
  const wrapperPath = commandWrapperPath(dir);
  const envExports = commandWrapperEnv(extraEnv);
  const script = isWindows
    ? `@echo off
setlocal
for %%A in (%*) do <nul set /p "=%%~A	" >> ${batchQuote(argvLogPath)}
echo.>> ${batchQuote(argvLogPath)}
set "T3_ACP_REQUEST_LOG_PATH=${requestLogPath}"
${envExports}
${batchQuote(nodeExe)} ${batchQuote(mockAgentPath)} %*
`
    : `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${envExports}
exec ${JSON.stringify(nodeExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await Effect.runPromise(Effect.yieldNow);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.cursor.binaryPath` to a mock ACP wrapper). The adapter
// captures `cursorSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot, matching the old "always read live" behavior that these
// tests assumed.
const makeResolveCursorSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.cursor),
      Effect.orDie,
    ),
  );
});

/** What the adapter wrote down for the usage ledger, by thread. */
const recordedTurnUsage: Array<UsageLedgerEntry> = [];

const cursorAdapterTestLayer = it.layer(
  Layer.effect(
    CursorAdapter,
    Effect.gen(function* () {
      const cursorConfig = decodeCursorSettings({});
      const resolveSettings = yield* makeResolveCursorSettings;
      return yield* makeAcpAdapter(CURSOR_ACP_DESCRIPTOR, cursorConfig, {
        resolveSettings,
        recordTurnUsage: (entry) => Effect.sync(() => void recordedTurnUsage.push(entry)),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-cursor-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

// An agent driven through its own controls (the ACP registry's kind): the
// Cursor descriptor, flagged native.
class NativeControlsAdapter extends Context.Service<NativeControlsAdapter, AcpAdapterShape>()(
  "test/NativeControlsAdapter",
) {}
let authRequiredNotices = 0;

const nativeControlsAdapterTestLayer = it.layer(
  Layer.effect(
    NativeControlsAdapter,
    Effect.gen(function* () {
      const resolveSettings = yield* makeResolveCursorSettings;
      return yield* makeAcpAdapter(
        {
          ...CURSOR_ACP_DESCRIPTOR,
          sessionControls: "native",
          // Counts the notice, then breaks: a driver's mistake here must never
          // replace the agent's own answer.
          onAuthRequired: () =>
            Effect.sync(() => {
              authRequiredNotices += 1;
              throw new Error("the driver's sign-in hook broke");
            }),
        },
        decodeCursorSettings({}),
        { resolveSettings },
      );
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-native-controls-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

nativeControlsAdapterTestLayer("an agent driven through its own controls", (it) => {
  it.effect("never has its mode changed for it, in plan mode or full access", () =>
    Effect.gen(function* () {
      const adapter = yield* NativeControlsAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("native-controls-mode");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "native-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, path.join(tempDir, "argv.txt")),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });
      // The same turn makes a mapped agent switch to its plan mode (see
      // "maps app plan mode onto the ACP plan session mode").
      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_mode" ||
          (entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
      );
      assert.deepStrictEqual(modeRequests, []);
      // The model the user picked still goes through.
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "model",
        ),
      );
    }),
  );

  it.effect("lists the models and mode of an agent that only speaks the older API", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_LEGACY_CONTROLS: "1" }),
      );
      const {
        modelOptions: _modelOptions,
        modelCapabilitiesVaryByModel: _varies,
        ...cursorBase
      } = CURSOR_ACP_DESCRIPTOR;
      const models = yield* discoverAcpModels(
        { ...cursorBase, sessionControls: "native" },
        { ...decodeCursorSettings({}), binaryPath: wrapperPath },
      );
      // Its `models` field is the catalog, and its `modes` field an option on each.
      assert.deepStrictEqual(
        models.map((model) => [
          model.slug,
          model.name,
          model.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
        ]),
        [
          ["default", "Auto", ["mode"]],
          ["composer-2", "Composer 2", ["mode"]],
        ],
      );
    }),
  );

  it.effect("tells its driver when it wants a sign-in before it starts", () =>
    Effect.gen(function* () {
      const adapter = yield* NativeControlsAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_AUTH_REQUIRED: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const before = authRequiredNotices;

      // `result` only catches the adapter's own error: a hook that got loose
      // would fail this test as a defect.
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("native-controls-auth"),
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(authRequiredNotices - before, 1);
    }),
  );

  it.effect(
    "fails a refusal with no reply as a refusal, unless a retry notice came before it",
    () =>
      Effect.gen(function* () {
        const adapter = yield* NativeControlsAdapter;
        const serverSettings = yield* ServerSettingsService;
        const silentRefusalCategory = (env: Record<string, string>, threadId: ThreadId) =>
          Effect.gen(function* () {
            const wrapperPath = yield* Effect.promise(() =>
              makeMockAgentWrapper({ T3_ACP_SILENT_PROMPT_STOP_REASON: "refusal", ...env }),
            );
            yield* serverSettings.updateSettings({
              providers: { cursor: { binaryPath: wrapperPath } },
            });
            const turnCompletedFiber = yield* Stream.filter(
              adapter.streamEvents,
              (event) =>
                String(event.threadId) === String(threadId) && event.type === "turn.completed",
            ).pipe(Stream.runHead, Effect.forkChild);
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            yield* adapter.sendTurn({ threadId, input: "do the thing", attachments: [] });
            const turnCompleted = yield* Fiber.join(turnCompletedFiber);
            assert.equal(turnCompleted._tag, "Some");
            if (turnCompleted._tag !== "Some" || turnCompleted.value.type !== "turn.completed") {
              return undefined;
            }
            assert.equal(turnCompleted.value.payload.state, "failed");
            return turnCompleted.value.payload.failureCategory;
          });

        assert.equal(
          yield* silentRefusalCategory({}, ThreadId.make("native-controls-silent-refusal")),
          "refusal",
        );
        // An exhausted rate-limit retry ends the same way; its notice is in the
        // message, so the wording decides.
        assert.equal(
          yield* silentRefusalCategory(
            { T3_ACP_SILENT_PROMPT_STATUS: "Rate limited, retrying (3/3)" },
            ThreadId.make("native-controls-silent-refusal-after-retry"),
          ),
          undefined,
        );
      }),
  );

  it.effect("tells its driver when a model change is refused until sign-in", () =>
    Effect.gen(function* () {
      const adapter = yield* NativeControlsAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_SET_CONFIG_OPTION: "auth" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const before = authRequiredNotices;

      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("native-controls-auth-on-model"),
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(authRequiredNotices - before, 1);
    }),
  );
});

it.live.skipIf(isWindows)(
  "proves an agent, and a shell it left in a process group of its own, are gone after a stop",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "acp-confirm-")));
      const shellPidPath = path.join(dir, "shell.pid");
      // A helper the agent runs in the background starts a shell in a group
      // of its own, the way Grok's background shells do. It writes the
      // shell's pid beside the wrapper script, which hands it that path.
      const helper = `const { spawn } = require("node:child_process"); const shell = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); shell.unref(); require("node:fs").writeFileSync(process.argv[1], String(shell.pid)); setInterval(() => {}, 1000);`;
      const wrapperPath = path.join(dir, "agent-with-shell.sh");
      yield* Effect.promise(async () => {
        await writeFile(
          wrapperPath,
          `#!/bin/sh\n${JSON.stringify(nodeExe)} -e '${helper}' "$(dirname "$0")/shell.pid" &\nexec ${JSON.stringify(nodeExe)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
          "utf8",
        );
        await chmod(wrapperPath, 0o755);
      });
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const adapter = yield* makeAcpAdapter(CURSOR_ACP_DESCRIPTOR, decodeCursorSettings({}), {
        resolveSettings: yield* makeResolveCursorSettings,
      });
      const threadId = ThreadId.make("cursor-confirm-stopped");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      const shellPid = Number(yield* Effect.promise(() => waitForFileContent(shellPidPath, 2_000)));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(shellPid, "SIGKILL");
          } catch {}
        }),
      );

      // A stop for a move notes what it started first (ProviderService does).
      yield* adapter.noteBeforeStop!(threadId);
      yield* adapter.stopSession(threadId);
      // The stop ended the agent's own process group; the shell lives on.
      assert.isTrue(isProcessRunning(shellPid));

      assert.deepStrictEqual(yield* adapter.confirmThreadStopped!(threadId), { confirmed: true });
      assert.isFalse(isProcessRunning(shellPid));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-acp-confirm-test-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

cursorAdapterTestLayer("CursorAdapterLive", (it) => {
  it.effect("opens a fresh session when the agent can't reopen the saved one, and says so", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_LOAD_SESSION: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId: ThreadId.make("cursor-resume-refused"),
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        resumeCursor: { schemaVersion: 1, sessionId: "saved-before-an-update" },
      });

      // The thread's history then goes with its next message
      // (ProviderCommandReactor's owed history seed).
      assert.isTrue(session.resumeFailed);
      assert.notEqual(
        (session.resumeCursor as { readonly sessionId?: unknown } | undefined)?.sessionId,
        "saved-before-an-update",
      );
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      assert.equal(session.provider, "cursor");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const assistantStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantStarted);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:segment:0$/);
      }

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: "Inspect mock ACP state", status: "completed" },
          { step: "Implement the requested change", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }

      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "cursor-adapter-exit-log-")),
      );
      const exitLogPath = path.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect(
    "serializes concurrent startSession calls for the same thread and closes the replaced ACP session",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") {
          return;
        }

        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-concurrent-start-session");
        const tempDir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "cursor-adapter-concurrent-exit-log-")),
        );
        const exitLogPath = path.join(tempDir, "exit.log");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper(
            {
              T3_ACP_EXIT_LOG_PATH: exitLogPath,
            },
            { initialDelaySeconds: 0.2 },
          ),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

        const [firstSession, secondSession] = yield* Effect.all(
          [
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
            }),
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(firstSession.threadId, threadId);
        assert.equal(secondSession.threadId, threadId);

        yield* adapter.stopSession(threadId);

        const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
        assert.equal(exitLog.match(/SIGTERM/g)?.length ?? 0, 2);
      }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect(
    "offers HTTP MCP tools to agents that advertise HTTP MCP, and bridges over stdio otherwise",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const sessionNewServers = (advertiseHttpMcp: boolean, roomTools = false) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`acp-browser-mcp-${advertiseHttpMcp}-${roomTools}`);
            const tempDir = yield* Effect.promise(() =>
              mkdtemp(path.join(os.tmpdir(), "cursor-acp-")),
            );
            const requestLogPath = path.join(tempDir, "requests.ndjson");
            yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
            const wrapperPath = yield* Effect.promise(() =>
              makeProbeWrapper(
                requestLogPath,
                path.join(tempDir, "argv.txt"),
                advertiseHttpMcp ? { T3_ACP_ADVERTISE_HTTP_MCP: "1" } : undefined,
              ),
            );
            yield* serverSettings.updateSettings({
              providers: { cursor: { binaryPath: wrapperPath } },
            });
            const session = yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
              ...(roomTools ? { roomTools: true } : {}),
            });
            yield* adapter.stopSession(threadId);
            const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
            const sessionNew = requests.find((entry) => entry.method === "session/new");
            const servers = (sessionNew?.params as { readonly mcpServers?: ReadonlyArray<unknown> })
              ?.mcpServers;
            return Object.assign(servers ?? [], { roomTools: session.roomTools });
          });

        const offered = yield* sessionNewServers(true);
        assert.lengthOf(offered ?? [], 1);
        assert.equal(offered.roomTools, undefined);
        assert.deepInclude(offered?.[0] as object, { type: "http", name: "threadlines_browser" });
        const server = offered?.[0] as {
          readonly url: string;
          readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
        };
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\//);
        assert.match(server.headers[0]?.value ?? "", /^Bearer \S+/);

        // Agents that do not advertise HTTP MCP get stdio-to-HTTP bridge entries
        // with the endpoint URL and Bearer token passed via env, never argv.
        const bridged = yield* sessionNewServers(false);
        assert.lengthOf(bridged, 1);
        const bridgedBrowser = bridged[0] as {
          readonly type?: string;
          readonly name: string;
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
        };
        assert.equal(bridgedBrowser.type, undefined);
        assert.equal(bridgedBrowser.name, "threadlines_browser");
        assert.equal(bridgedBrowser.command, process.execPath);
        const bridgedUrl = bridgedBrowser.env.find((entry) => entry.name === "THREADLINES_MCP_URL");
        const bridgedAuth = bridgedBrowser.env.find(
          (entry) => entry.name === "THREADLINES_MCP_AUTHORIZATION",
        );
        assert.match(bridgedUrl?.value ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        assert.match(bridgedAuth?.value ?? "", /^Bearer \S+/);
        assert.notInclude(bridgedBrowser.args.join(" "), bridgedAuth!.value);

        // In a room the room endpoint rides the same credential, which dies
        // with the session — both directly over HTTP and over the stdio bridge.
        const inRoom = yield* sessionNewServers(true, true);
        assert.deepEqual(
          inRoom.map((entry) => (entry as { readonly name: string }).name),
          ["threadlines_browser", "threadlines_room"],
        );
        assert.equal(inRoom.roomTools, true);
        const roomServer = inRoom[1] as {
          readonly url: string;
          readonly headers: ReadonlyArray<{ readonly value: string }>;
        };
        assert.match(roomServer.url, /\/mcp\/room$/);
        const token = roomServer.headers[0]!.value.replace("Bearer ", "");
        assert.equal(yield* mcpSessionRegistry.resolve(token), null);

        const inRoomBridged = yield* sessionNewServers(false, true);
        assert.deepEqual(
          inRoomBridged.map((entry) => (entry as { readonly name: string }).name),
          ["threadlines_browser", "threadlines_room"],
        );
        assert.equal(inRoomBridged.roomTools, true);
        const bridgedRoom = inRoomBridged[1] as {
          readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
        };
        const bridgedRoomAuth = bridgedRoom.env.find(
          (entry) => entry.name === "THREADLINES_MCP_AUTHORIZATION",
        );
        const bridgedToken = (bridgedRoomAuth?.value ?? "").replace("Bearer ", "");
        assert.equal(yield* mcpSessionRegistry.resolve(bridgedToken), null);
      }),
  );

  it.effect(
    "marks roomTools false and omits project_note_write when the agent cannot reach host loopback",
    () => {
      const noLoopbackAdapterLayer = Layer.effect(
        CursorAdapter,
        Effect.gen(function* () {
          const cursorConfig = decodeCursorSettings({});
          const resolveSettings = yield* makeResolveCursorSettings;
          return yield* makeAcpAdapter(
            { ...CURSOR_ACP_DESCRIPTOR, reachesHostLoopback: () => false },
            cursorConfig,
            { resolveSettings },
          );
        }),
      );
      const isolatedLayer = noLoopbackAdapterLayer.pipe(
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      return Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("acp-no-loopback-notes");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, path.join(tempDir, "argv.txt")),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
          roomTools: true,
          projectInstructions: `Project brief for "Demo".\n\n${PROJECT_NOTE_WRITE_INSTRUCTION}`,
        });
        assert.equal(session.roomTools, false);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
        yield* Fiber.join(completed);
        yield* adapter.stopSession(threadId);
        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const sessionNew = requests.find((entry) => entry.method === "session/new");
        assert.deepEqual(
          (sessionNew?.params as { readonly mcpServers?: ReadonlyArray<unknown> })?.mcpServers,
          [],
        );
        const prompt = requests.find((entry) => entry.method === "session/prompt");
        const text = (prompt?.params as { prompt: Array<{ text?: string }> }).prompt
          .map((part) => part.text ?? "")
          .join("");
        assert.include(text, 'Project brief for "Demo".');
        assert.notInclude(text, "project_note_write");
      }).pipe(Effect.provide(isolatedLayer));
    },
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-plan-mode-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === "session/set_mode" ||
            (entry.method === "session/set_config_option" &&
              (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
        );
      assert.isDefined(modeRequest);
      assert.equal(
        (modeRequest?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
      assert.include(
        ["architect", "plan"],
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
      );
    }),
  );

  it.effect(
    "applies initial model and mode configuration during startSession and skips repeating it on first send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-initial-config-probe");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const argvLogPath = path.join(tempDir, "argv.txt");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const modelSelection = createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });

        yield* Effect.promise(() => waitForFileContent(requestLogPath));

        const requestsAfterStart = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const configIdsAfterStart = requestsAfterStart.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(configIdsAfterStart, [
          "model",
          "reasoning",
          "context",
          "fast",
          "mode",
        ]);

        // sendTurn returns once the prompt is dispatched; the turn itself
        // finishes on the event stream.
        const turnCompletedFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId,
          input: "hello mock",
          attachments: [],
          modelSelection,
          interactionMode: "default",
        });
        yield* Fiber.join(turnCompletedFiber);
        yield* adapter.stopSession(threadId);

        const finalRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const finalConfigIds = finalRequests.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(finalConfigIds, ["model", "reasoning", "context", "fast", "mode"]);
        assert.equal(finalRequests.filter((entry) => entry.method === "session/prompt").length, 1);
      }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const previousEmitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS;
        process.env.T3_ACP_EMIT_TOOL_CALLS = "1";

        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-tool-call-probe");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        const program = Effect.gen(function* () {
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("cursor"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
          });

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "run a tool call",
            attachments: [],
          });
          yield* Deferred.await(settledEventsReady);

          const threadEvents = runtimeEvents.filter(
            (event) => String(event.threadId) === String(threadId),
          );
          assert.includeMembers(
            threadEvents.map((event) => event.type),
            [
              "session.started",
              "session.state.changed",
              "thread.started",
              "turn.started",
              "request.opened",
              "request.resolved",
              "item.updated",
              "item.completed",
              "content.delta",
              "turn.completed",
            ],
          );

          const turnEvents = threadEvents.filter(
            (event) => String(event.turnId) === String(turn.turnId),
          );
          const toolUpdates = turnEvents.filter((event) => event.type === "item.updated");
          // ACP updates can arrive either as distinct pending + in-progress events
          // or as a single coalesced in-progress update before approval resolves.
          assert.isAtLeast(toolUpdates.length, 1);
          for (const toolUpdate of toolUpdates) {
            if (toolUpdate.type !== "item.updated") {
              continue;
            }
            assert.equal(toolUpdate.payload.itemType, "command_execution");
            assert.equal(toolUpdate.payload.status, "inProgress");
            assert.equal(toolUpdate.payload.detail, "cat server/package.json");
            assert.equal(String(toolUpdate.itemId), "tool-call-1");
          }

          const requestOpened = turnEvents.find((event) => event.type === "request.opened");
          assert.isDefined(requestOpened);
          if (requestOpened?.type === "request.opened") {
            assert.equal(String(requestOpened.turnId), String(turn.turnId));
            assert.equal(requestOpened.payload.requestType, "exec_command_approval");
            assert.equal(requestOpened.payload.detail, "cat server/package.json");
          }

          const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
          assert.isDefined(requestResolved);
          if (requestResolved?.type === "request.resolved") {
            assert.equal(String(requestResolved.turnId), String(turn.turnId));
            assert.equal(requestResolved.payload.requestType, "exec_command_approval");
            assert.equal(requestResolved.payload.decision, "accept");
          }

          const toolCompleted = turnEvents.find(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "command_execution",
          );
          assert.isDefined(toolCompleted);
          if (toolCompleted?.type === "item.completed") {
            assert.equal(String(toolCompleted.turnId), String(turn.turnId));
            assert.equal(toolCompleted.payload.itemType, "command_execution");
            assert.equal(toolCompleted.payload.status, "completed");
            assert.equal(toolCompleted.payload.detail, "cat server/package.json");
            assert.equal(String(toolCompleted.itemId), "tool-call-1");
          }

          const contentDelta = turnEvents.find((event) => event.type === "content.delta");
          assert.isDefined(contentDelta);
          if (contentDelta?.type === "content.delta") {
            assert.equal(String(contentDelta.turnId), String(turn.turnId));
            assert.equal(contentDelta.payload.delta, "hello from mock");
            assert.equal(String(contentDelta.itemId), "assistant:mock-session-1:segment:0");
          }
        });

        yield* program.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousEmitToolCalls === undefined) {
                delete process.env.T3_ACP_EMIT_TOOL_CALLS;
              } else {
                process.env.T3_ACP_EMIT_TOOL_CALLS = previousEmitToolCalls;
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.effect(
            CursorAdapter,
            Effect.gen(function* () {
              const cursorConfig = decodeCursorSettings({});
              const resolveSettings = yield* makeResolveCursorSettings;
              return yield* makeAcpAdapter(CURSOR_ACP_DESCRIPTOR, cursorConfig, {
                resolveSettings,
              });
            }),
          ).pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "threadlines-cursor-adapter-test-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "auto-approves ACP tool permissions in full-access mode without approval runtime events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-full-access-auto-approve");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const argvLogPath = path.join(tempDir, "argv.txt");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });

        yield* Deferred.await(settledEventsReady);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const turnEvents = runtimeEvents.filter(
          (event) =>
            String(event.threadId) === String(threadId) &&
            String(event.turnId) === String(turn.turnId),
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.opened",
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.resolved",
        );
        assert.includeMembers(
          turnEvents.map((event) => event.type),
          ["item.updated", "item.completed", "content.delta", "turn.completed"],
        );

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const permissionResponse = requests.find(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "selected" &&
            "optionId" in entry.result.outcome &&
            // Once, not always: full access answers every request anyway,
            // and "always" would leave a standing rule in the agent.
            entry.result.outcome.optionId === "allow-once",
        );
        assert.isDefined(permissionResponse);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("segments assistant messages around ACP tool activity in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-assistant-tool-segmentation");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const settledEventTypes = new Set<string>();
      const settledEventsReady = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      });

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (
            event.type === "content.delta" ||
            (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
            event.type === "turn.completed"
          ) {
            if (event.type === "content.delta") {
              settledEventTypes.add(`delta:${event.payload.delta}`);
            } else {
              settledEventTypes.add(event.type);
            }
            if (
              settledEventTypes.has("delta:before tool") &&
              settledEventTypes.has("delta:after tool") &&
              settledEventTypes.has("item.completed") &&
              settledEventTypes.has("turn.completed")
            ) {
              yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run an interleaved tool call",
        attachments: [],
      });

      yield* Deferred.await(settledEventsReady);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const turnEvents = runtimeEvents.filter(
        (event) =>
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turn.turnId),
      );
      const firstAssistantStartIndex = turnEvents.findIndex(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const firstAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "before tool",
      );
      const assistantBoundaryIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolUpdateIndex = turnEvents.findIndex(
        (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
      );
      const toolCompletedIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      const secondAssistantStartIndex = turnEvents.findIndex(
        (event, index) =>
          index > toolCompletedIndex &&
          event.type === "item.started" &&
          event.payload.itemType === "assistant_message",
      );
      const secondAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "after tool",
      );

      assert.isAtLeast(firstAssistantStartIndex, 0);
      assert.isAtLeast(firstAssistantDeltaIndex, 0);
      assert.isAtLeast(assistantBoundaryIndex, 0);
      assert.isAtLeast(toolUpdateIndex, 0);
      assert.isAtLeast(toolCompletedIndex, 0);
      assert.isAtLeast(secondAssistantStartIndex, 0);
      assert.isAtLeast(secondAssistantDeltaIndex, 0);
      assert.isBelow(firstAssistantStartIndex, firstAssistantDeltaIndex);
      assert.isBelow(firstAssistantDeltaIndex, assistantBoundaryIndex);
      assert.isBelow(assistantBoundaryIndex, toolUpdateIndex);
      assert.isBelow(toolUpdateIndex, toolCompletedIndex);
      assert.isBelow(toolCompletedIndex, secondAssistantStartIndex);
      assert.isBelow(secondAssistantStartIndex, secondAssistantDeltaIndex);

      const assistantStarts = turnEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const assistantDeltas = turnEvents.filter((event) => event.type === "content.delta");
      assert.lengthOf(assistantStarts, 2);
      assert.lengthOf(assistantDeltas, 2);
      if (
        assistantStarts[0]?.type === "item.started" &&
        assistantStarts[1]?.type === "item.started" &&
        assistantDeltas[0]?.type === "content.delta" &&
        assistantDeltas[1]?.type === "content.delta"
      ) {
        assert.notEqual(String(assistantStarts[0].itemId), String(assistantStarts[1].itemId));
        assert.equal(String(assistantDeltas[0].itemId), String(assistantStarts[0].itemId));
        assert.equal(String(assistantDeltas[1].itemId), String(assistantStarts[1].itemId));
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("streams ACP thoughts as a Thinking item and reports the context fill", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-thoughts-and-usage");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const turnCompleted = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_THOUGHTS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      });

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.orDie);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "think first", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const indexOf = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        runtimeEvents.findIndex(predicate);
      const reasoningStart = indexOf(
        (event) => event.type === "item.started" && event.payload.itemType === "reasoning",
      );
      const reasoningEnd = indexOf(
        (event) => event.type === "item.completed" && event.payload.itemType === "reasoning",
      );
      const replyDelta = indexOf(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      const thoughtDeltas = runtimeEvents.filter(
        (event) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text",
      );

      assert.isAtLeast(reasoningStart, 0);
      assert.isBelow(reasoningStart, reasoningEnd);
      assert.isBelow(reasoningEnd, replyDelta);
      assert.deepEqual(
        thoughtDeltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["Checking the ", "workspace first."],
      );
      const completed = runtimeEvents[reasoningEnd];
      assert.deepEqual(completed?.type === "item.completed" ? completed.payload.data : undefined, {
        summary: "Checking the workspace first.",
      });

      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.deepEqual(
        usage?.type === "thread.token-usage.updated" ? usage.payload.usage : undefined,
        { usedTokens: 11_767, maxTokens: 256_000 },
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("records each turn's reported tokens and its share of the running cost", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-turn-usage");
      const turnsCompleted = yield* Queue.unbounded<void>();
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_THOUGHTS: "1", T3_ACP_REPORT_USAGE: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        String(event.threadId) === String(threadId) && event.type === "turn.completed"
          ? Queue.offer(turnsCompleted, undefined)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      for (const input of ["first", "second"]) {
        yield* adapter.sendTurn({ threadId, input, attachments: [] });
        yield* Queue.take(turnsCompleted);
      }
      yield* Fiber.interrupt(runtimeEventsFiber);

      const turns = recordedTurnUsage.filter((entry) => entry.sessionId === "mock-session-1");
      // A session opened here starts at no cost, so each turn's share is exact.
      assert.deepEqual(
        turns.map((entry) => ({
          model: entry.model,
          totals: entry.totals,
          costUsd: Number(entry.costUsd?.toFixed(6)),
        })),
        [0.01, 0.015].map((costUsd) => ({
          model: "default",
          totals: {
            uncachedInputTokens: 1_111,
            cachedInputTokens: 4_000,
            cacheCreationTokens: 0,
            outputTokens: 53,
            reasoningTokens: 5,
          },
          costUsd,
        })),
      );
      assert.notEqual(turns[0]?.turnId, turns[1]?.turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-cancel-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && !interrupted) {
            interrupted = true;
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/cancel"));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "cancelled",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("stopping a session settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-approval");
      const approvalRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a tool call and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stopping a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("interrupting a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-interrupt-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then interrupt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      // Waiting on the user is still a turn in flight: the idle reaper must see it as running.
      const listed = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      assert.equal(listed?.status, "running");
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(sendTurnFiber);
      yield* Deferred.await(turnCompleted);

      assert.equal(yield* adapter.hasSession(threadId), true);
      // The turn's bookkeeping settles just after it reports completing.
      const listedNow = adapter
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));
      let settled = yield* listedNow;
      for (let attempt = 0; attempt < 200 && settled?.status !== "ready"; attempt += 1) {
        yield* Effect.yieldNow;
        settled = yield* listedNow;
      }
      assert.equal(settled?.status, "ready");
      assert.equal(settled?.activeTurnId, undefined);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("broadcasts runtime events to multiple stream consumers", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-runtime-event-broadcast");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const firstConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const firstEvents = Array.from(yield* Fiber.join(firstConsumer));
      const secondEvents = Array.from(yield* Fiber.join(secondConsumer));

      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches model in-session via session/set_config_option", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-model-switch");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn after switching model",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: true },
        ]),
      });

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.lengthOf(argvRuns, 1, "session should not restart — only one spawn");
      assert.deepStrictEqual(argvRuns[0], ["acp"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const setConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "model",
      );
      assert.isAbove(setConfigRequests.length, 0, "should call session/set_config_option");
      assert.equal((setConfigRequests[0]?.params as Record<string, unknown>)?.value, "composer-2");

      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAbove(fastConfigRequests.length, 0, "should apply fast mode as a separate config");
      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "true");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears prior fast mode in-session when the next turn sets fastMode: false", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-fast-mode-reset");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn with fast mode",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: true },
        ]),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn without fast mode",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: false },
        ]),
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAtLeast(fastConfigRequests.length, 2, "should set fast mode on and then off");

      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "false");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "sends the project's brief again when the agent refused the prompt that carried it",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-project-brief-refused");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, path.join(tempDir, "argv.txt"), {
            T3_ACP_FAIL_FIRST_PROMPT: "1",
          }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });
        const brief = "Use pnpm here.";
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
          projectInstructions: brief,
        });
        const turn = (text: string) =>
          Effect.gen(function* () {
            const ended = yield* adapter.streamEvents.pipe(
              Stream.takeUntil((event) => event.type === "turn.completed"),
              Stream.runDrain,
              Effect.forkChild,
            );
            yield* adapter.sendTurn({ threadId, input: text, attachments: [] });
            yield* Fiber.join(ended);
          });
        yield* turn("first try");
        yield* turn("second try");
        yield* adapter.stopSession(threadId);

        const prompts = (yield* Effect.promise(() => readJsonLines(requestLogPath)))
          .filter((entry) => entry.method === "session/prompt")
          .map((entry) =>
            (entry.params as { prompt: Array<{ text?: string }> }).prompt
              .map((part) => part.text ?? "")
              .join(""),
          );
        assert.deepEqual(prompts, [`${brief}\n\nfirst try`, `${brief}\n\nsecond try`]);
      }),
  );

  it.effect(
    "sends the project's brief ahead of a new session's first prompt, and on a resume only when it changed",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-project-brief");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, path.join(tempDir, "argv.txt")),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });
        const brief = "Use pnpm here. Never touch the generated folder.";

        /** One runtime start and its first turn; returns what that prompt said and the cursor after it. */
        const firstTurn = (input: {
          readonly projectInstructions?: string;
          readonly resumeCursor?: unknown;
        }) =>
          Effect.gen(function* () {
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
              ...input,
            });
            const completed = yield* adapter.streamEvents.pipe(
              Stream.takeUntil((event) => event.type === "turn.completed"),
              Stream.runDrain,
              Effect.forkChild,
            );
            yield* adapter.sendTurn({ threadId, input: "hello mock", attachments: [] });
            yield* Fiber.join(completed);
            const cursor = (yield* adapter.listSessions()).find(
              (session) => session.threadId === threadId,
            )?.resumeCursor;
            yield* adapter.stopSession(threadId);
            const prompts = (yield* Effect.promise(() => readJsonLines(requestLogPath))).filter(
              (entry) => entry.method === "session/prompt",
            );
            const parts = (prompts.at(-1)!.params as { prompt: Array<{ text?: string }> }).prompt;
            return { text: parts.map((part) => part.text ?? "").join(""), cursor };
          });

        const fresh = yield* firstTurn({ projectInstructions: brief });
        assert.equal(fresh.text, `${brief}\n\nhello mock`);

        const same = yield* firstTurn({ projectInstructions: brief, resumeCursor: fresh.cursor });
        assert.equal(same.text, "hello mock");

        const changed = yield* firstTurn({
          projectInstructions: `${brief} Tests run with vp.`,
          resumeCursor: same.cursor,
        });
        assert.equal(changed.text, `${brief} Tests run with vp.\n\nhello mock`);

        const cleared = yield* firstTurn({ resumeCursor: changed.cursor });
        assert.equal(cleared.text, `${PROJECT_BRIEF_CLEARED_NOTE}\n\nhello mock`);

        // The note is said once.
        const after = yield* firstTurn({ resumeCursor: cleared.cursor });
        assert.equal(after.text, "hello mock");
      }),
  );

  it.effect(
    "applies fast mode on the first turn when modelSelection uses a non-default instance id",
    () => {
      const customInstanceId = ProviderInstanceId.make("cursor_secondary");
      // Custom-instance cases can't share the suite-level `CursorAdapter`
      // layer because that one binds `instanceId: "cursor"`. We build a
      // fresh layer graph — including a fresh `ServerSettingsService` — so
      // mid-test `updateSettings` calls target the same service instance the
      // adapter's `resolveSettings` reads from, and so the outer
      // `yield* ServerSettingsService` sees the same snapshot as well.
      const customAdapterLayer = Layer.effect(
        CursorAdapter,
        Effect.gen(function* () {
          const cursorConfig = decodeCursorSettings({});
          const resolveSettings = yield* makeResolveCursorSettings;
          return yield* makeAcpAdapter(CURSOR_ACP_DESCRIPTOR, cursorConfig, {
            instanceId: customInstanceId,
            resolveSettings,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "threadlines-cursor-adapter-custom-instance-",
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-fast-mode-custom-instance");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const argvLogPath = path.join(tempDir, "argv.txt");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: customInstanceId,
            model: "composer-2",
          },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "first turn with fast mode",
          attachments: [],
          modelSelection: {
            ...createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
              { id: "fastMode", value: true },
            ]),
            instanceId: customInstanceId,
          },
        });

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const fastConfigRequests = requests.filter(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
        );
        assert.isAbove(
          fastConfigRequests.length,
          0,
          "fast mode should apply when instance id matches the adapter binding",
        );
        const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
        assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "true");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(customAdapterLayer));
    },
  );
});

it("names an edit's files relative to the session, whichever way the agent wrote them", () => {
  const root = path.resolve("/work/project");
  const linked = path.resolve("/private/work/project");
  const changes = acpDiffFileChanges(
    {
      toolCallId: "edit-1",
      kind: "edit",
      status: "completed",
      data: {
        content: [
          { type: "diff", path: "src/a.ts", oldText: "a\n", newText: "b\n" },
          { type: "diff", path: path.join(linked, "b.ts"), newText: "x\n" },
          { type: "diff", path: path.resolve("/elsewhere/c.ts"), newText: "x\n" },
        ],
      },
    },
    [root, linked],
    path,
  );
  assert.deepEqual(changes, [
    { path: "src/a.ts", kind: "update", additions: 1, deletions: 1 },
    { path: "b.ts", kind: "add", additions: 1, deletions: 0 },
  ]);
});

it.effect(
  "emits prompt suggestions after completed user turns, skips non-user turns, and drops stale suggestions when a new turn starts",
  () =>
    Effect.gen(function* () {
      const mockBinary = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_PROMPT_RESPONSE_TEXT: "Done! Want me to run the browser suite next?",
        }),
      );
      const sampleStarted = yield* Deferred.make<void>();
      const releaseBlockedSample = yield* Deferred.make<void>();
      let blockNextSample = false;
      const seenBatches: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> =
        [];

      const adapter = yield* makeAcpAdapter(
        CURSOR_ACP_DESCRIPTOR,
        decodeCursorSettings({ enabled: true, binaryPath: mockBinary }),
        {
          promptSuggestions: {
            shouldSuggest: () => Effect.succeed(true),
            sample: ({ messages }) =>
              Effect.gen(function* () {
                seenBatches.push(messages);
                if (blockNextSample) {
                  yield* Deferred.succeed(sampleStarted, undefined);
                  yield* Deferred.await(releaseBlockedSample);
                  return "Stale suggestion that must be dropped";
                }
                return '  "Run the browser suite."  ';
              }),
          },
        },
      );

      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const allEvents: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          allEvents.push(event);
        }).pipe(Effect.andThen(Queue.offer(events, event)), Effect.asVoid),
      ).pipe(Effect.forkScoped);

      const threadId = ThreadId.make("acp-prompt-suggestions-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("cursor"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // 1. User-originated turn completes -> emits sanitized prompt suggestion.
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Fix the sidebar spacing",
        suggestNextMessage: true,
      });

      const waitForEvent = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const next = yield* Queue.take(events);
            if (predicate(next)) return next;
          }
        }).pipe(Effect.timeout("5 seconds"));

      const suggestionEvent = yield* waitForEvent(
        (event) =>
          event.type === "turn.prompt-suggestion.updated" && event.turnId === firstTurn.turnId,
      );
      assert.equal(suggestionEvent.type, "turn.prompt-suggestion.updated");
      if (suggestionEvent.type === "turn.prompt-suggestion.updated") {
        assert.equal(suggestionEvent.payload.suggestion, "Run the browser suite.");
      }
      assert.deepEqual(seenBatches[0], [
        { role: "user", text: "Fix the sidebar spacing" },
        { role: "assistant", text: "Done! Want me to run the browser suite next?" },
      ]);

      // 2. Non-user turn (suggestNextMessage omitted) -> no suggestion sampled.
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Background check",
      });
      yield* waitForEvent(
        (event) => event.type === "turn.completed" && event.turnId === secondTurn.turnId,
      );
      assert.equal(seenBatches.length, 1);

      // 3. Stale suggestion cancelled when a newer turn starts before it resolves.
      blockNextSample = true;
      const thirdTurn = yield* adapter.sendTurn({
        threadId,
        input: "Check lint too",
        suggestNextMessage: true,
      });
      yield* Deferred.await(sampleStarted).pipe(Effect.timeout("5 seconds"));
      blockNextSample = false;

      const fourthTurn = yield* adapter.sendTurn({
        threadId,
        input: "Actually skip lint and ship",
        suggestNextMessage: true,
      });
      yield* Deferred.succeed(releaseBlockedSample, undefined);

      const fourthSuggestion = yield* waitForEvent(
        (event) =>
          event.type === "turn.prompt-suggestion.updated" && event.turnId === fourthTurn.turnId,
      );
      assert.equal(fourthSuggestion.type, "turn.prompt-suggestion.updated");
      // Make sure the third turn's blocked suggestion never arrived.
      assert.equal(
        allEvents.some(
          (event) =>
            event.type === "turn.prompt-suggestion.updated" && event.turnId === thirdTurn.turnId,
        ),
        false,
      );

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "threadlines-acp-suggestions-test-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect(
  "does not sample a prompt suggestion when a turn-machine turn is interrupted while reading its outcome",
  () =>
    Effect.gen(function* () {
      const mockBinary = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_PROMPT_RESPONSE_TEXT: "Finished the refactor.",
        }),
      );
      const outcomeReadReached = yield* Deferred.make<void>();
      const releaseOutcomeRead = yield* Deferred.make<void>();
      let sampleCalls = 0;

      const adapter = yield* makeAcpAdapter(
        {
          ...CURSOR_ACP_DESCRIPTOR,
          turnMachine: {
            workAfterPrompt: () => undefined,
            steer: false,
            silentLimit: Duration.minutes(5),
          },
        },
        decodeCursorSettings({ enabled: true, binaryPath: mockBinary }),
        {
          turnMachineSeams: (seam) =>
            seam.point === "outcomeRead"
              ? Deferred.succeed(outcomeReadReached, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseOutcomeRead)),
                )
              : Effect.void,
          promptSuggestions: {
            shouldSuggest: () => Effect.succeed(true),
            sample: () =>
              Effect.sync(() => {
                sampleCalls += 1;
                return "Should not run after interrupt";
              }),
          },
        },
      );

      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const allEvents: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          allEvents.push(event);
        }).pipe(Effect.andThen(Queue.offer(events, event)), Effect.asVoid),
      ).pipe(Effect.forkScoped);

      const threadId = ThreadId.make("acp-machine-interrupt-suggestion-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("cursor"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Refactor the helper",
        suggestNextMessage: true,
      });

      // Hold the turn at outcomeRead, interrupt it, then let the answered
      // outcome settle as completed. The interrupt must suppress suggestions.
      yield* Deferred.await(outcomeReadReached).pipe(Effect.timeout("5 seconds"));
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.succeed(releaseOutcomeRead, undefined);

      yield* Effect.gen(function* () {
        while (true) {
          const next = yield* Queue.take(events);
          if (next.type === "turn.completed" && next.turnId === turn.turnId) return;
        }
      }).pipe(Effect.timeout("5 seconds"));

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);

      assert.equal(sampleCalls, 0);
      assert.equal(
        allEvents.some((event) => event.type === "turn.prompt-suggestion.updated"),
        false,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "threadlines-acp-machine-suggestions-test-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
