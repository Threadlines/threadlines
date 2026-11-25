/**
 * The Threadlines extension inside a real Pi, against the test model and tool
 * servers. Runs when a Pi `cli.js` is available (THREADLINES_PI_CLI, or the
 * server's pinned dev dependency).
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { piTurnBoundaries, planPiRevert } from "./PiCursor.ts";
import {
  parsePiApprovalTitle,
  PI_APPROVAL_OPTIONS,
  PI_EXTENSION_SOURCE,
  PI_PLAN_MODE_REASON,
  piExtensionFileName,
  piModeCommandText,
  piTurnCommandText,
  PI_TURN_COMMAND,
} from "./PiExtensionSource.ts";
import { type PiAccessLevel, piProcessArgs, piProcessEnvironment } from "./PiLaunch.ts";
import { decodePi, PiCommands, PiEntries } from "./PiProtocol.ts";
import { type PiRpc, startPiRpc } from "./PiRpc.ts";
import { writePiSecretsFile } from "./PiSecrets.ts";
import { collectPiRecords, type PiRecordLog } from "./testing/PiRecordLog.ts";
import {
  makeTestPiHome,
  resolveTestPiCli,
  startTestMcpServer,
  startTestModelServer,
  testPiEnvironment,
} from "./testing/PiTestServers.ts";

const piCli = resolveTestPiCli();
const TOKEN = "test-token";
const NONCE = "n0nce";

const withPi = <A, E>(
  access: PiAccessLevel,
  body: (input: {
    rpc: PiRpc;
    log: PiRecordLog;
    tools: Awaited<ReturnType<typeof startTestMcpServer>>;
    model: Awaited<ReturnType<typeof startTestModelServer>>;
    secretsFile: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const model = yield* Effect.acquireRelease(
        Effect.promise(() => startTestModelServer()),
        (server) => Effect.promise(() => server.close()),
      );
      const tools = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startTestMcpServer({
            token: TOKEN,
            tools: [
              { name: "peek", readOnly: true },
              { name: "poke", readOnly: false },
            ],
          }),
        ),
        (server) => Effect.promise(() => server.close()),
      );
      const home = makeTestPiHome(model.url);
      const extensionDir = mkdtempSync(join(tmpdir(), "threadlines-pi-ext-"));
      const extensionPath = join(extensionDir, piExtensionFileName());
      writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 });
      const secretsFile = yield* Effect.promise(() =>
        writePiSecretsFile(join(extensionDir, "run"), { token: TOKEN, nonce: NONCE }),
      );
      const rpc = yield* startPiRpc({
        command: process.execPath,
        args: piProcessArgs(
          { command: process.execPath, prefixArgs: [piCli!] },
          {
            purpose: "chat",
            session: { kind: "new" },
            launchArgs: [],
            extensionPath,
            instructionsPath: undefined,
          },
        ),
        cwd: home.projectDir,
        environment: piProcessEnvironment({
          instanceEnvironment: undefined,
          baseEnv: testPiEnvironment(home.agentDir),
          extension: {
            access,
            plan: false,
            toolServers: [{ name: "threadlines_test", url: tools.url }],
            secretsFile,
          },
        }),
      });
      const log = yield* collectPiRecords(rpc);
      return yield* body({ rpc, log, tools, model, secretsFile });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const settled = (log: PiRecordLog, from: number) =>
  log.waitFor((record) => record.type === "agent_settled", { from });
const toolEnd = (log: PiRecordLog, from: number) =>
  log.waitFor((record) => record.type === "tool_execution_end", { from });
const prompt = (rpc: PiRpc, message: string) =>
  rpc.request({ type: "prompt", message, streamingBehavior: "steer" }, { timeout: null });
const resultText = (record: Record<string, unknown>) =>
  JSON.stringify((record.result as { content?: unknown } | undefined)?.content ?? "");

describe.skipIf(!piCli)("Threadlines extension in a real Pi", () => {
  it.live(
    "asks before acting, remembers allow-for-this-session, and lets read-only tools through",
    () =>
      withPi("approval-required", ({ rpc, log, tools }) =>
        Effect.gen(function* () {
          let from = log.mark();
          yield* prompt(rpc, 'TOOL bash {"command":"echo first"}');
          const dialog = yield* log.waitFor((record) => record.type === "extension_ui_request", {
            from,
          });
          const approval = parsePiApprovalTitle(String(dialog.title), NONCE);
          expect(approval?.toolName).toBe("bash");
          expect(approval?.input).toContain("echo first");
          yield* rpc.send({
            type: "extension_ui_response",
            id: dialog.id,
            value: PI_APPROVAL_OPTIONS.allowForSession,
          });
          expect(resultText(yield* toolEnd(log, from))).toContain("first");
          yield* settled(log, from);

          // The same call again: remembered, no dialog.
          from = log.mark();
          yield* prompt(rpc, 'TOOL bash {"command":"echo first"}');
          yield* toolEnd(log, from);
          yield* settled(log, from);
          expect(log.all.slice(from).some((record) => record.type === "extension_ui_request")).toBe(
            false,
          );

          // Allowing a long command covers that whole command, not every command
          // that starts the same way.
          const long = `echo ${"x".repeat(4_100)}`;
          from = log.mark();
          yield* prompt(rpc, `TOOL bash ${JSON.stringify({ command: `${long} one` })}`);
          const longDialog = yield* log.waitFor(
            (record) => record.type === "extension_ui_request",
            { from },
          );
          yield* rpc.send({
            type: "extension_ui_response",
            id: longDialog.id,
            value: PI_APPROVAL_OPTIONS.allowForSession,
          });
          yield* toolEnd(log, from);
          yield* settled(log, from);
          from = log.mark();
          yield* prompt(rpc, `TOOL bash ${JSON.stringify({ command: `${long} two` })}`);
          const otherDialog = yield* log.waitFor(
            (record) => record.type === "extension_ui_request",
            { from },
          );
          yield* rpc.send({
            type: "extension_ui_response",
            id: otherDialog.id,
            value: PI_APPROVAL_OPTIONS.deny,
          });
          yield* toolEnd(log, from);
          yield* settled(log, from);

          // A read-only Threadlines tool runs without asking; a writing one asks.
          from = log.mark();
          yield* prompt(rpc, 'TOOL mcp__threadlines_test__peek {"text":"x"}');
          expect(resultText(yield* toolEnd(log, from))).toContain("peek:");
          yield* settled(log, from);
          from = log.mark();
          yield* prompt(rpc, 'TOOL mcp__threadlines_test__poke {"text":"y"}');
          const pokeDialog = yield* log.waitFor(
            (record) => record.type === "extension_ui_request",
            { from },
          );
          yield* rpc.send({
            type: "extension_ui_response",
            id: pokeDialog.id,
            value: PI_APPROVAL_OPTIONS.deny,
          });
          const denied = yield* toolEnd(log, from);
          expect(denied.isError).toBe(true);
          yield* settled(log, from);
          expect(tools.calls.map((call) => call.name)).toEqual(["peek"]);
        }),
      ),
    60_000,
  );

  it.live(
    "keeps the tool token out of commands, and plan mode blocks writing at full access",
    () =>
      withPi("full-access", ({ rpc, log, model, secretsFile }) =>
        Effect.gen(function* () {
          // The secrets came in a file, read once and gone; the environment only named it.
          expect(existsSync(secretsFile)).toBe(false);
          let from = log.mark();
          yield* prompt(
            rpc,
            'TOOL bash {"command":"echo file=[$THREADLINES_PI_SECRETS_FILE] token=[$THREADLINES_PI_TOOL_TOKEN]"}',
          );
          expect(resultText(yield* toolEnd(log, from))).toContain("file=[] token=[]");
          yield* settled(log, from);

          // A mode command with the wrong nonce changes nothing.
          yield* prompt(
            rpc,
            piModeCommandText({ nonce: "wrong", access: "full-access", plan: true }),
          );
          const ack = yield* prompt(
            rpc,
            piModeCommandText({ nonce: NONCE, access: "full-access", plan: true }),
          );
          expect(ack).toEqual({ disposition: "handled" });

          from = log.mark();
          yield* prompt(rpc, 'TOOL write {"path":"plan.txt","content":"no"}');
          const blocked = yield* toolEnd(log, from);
          expect(blocked.isError).toBe(true);
          expect(resultText(blocked)).toContain(PI_PLAN_MODE_REASON.slice(0, 20));
          yield* settled(log, from);
          const lastRequest = JSON.stringify(model.requests.at(-1));
          expect(lastRequest).toContain("threadlines_plan_mode");
        }),
      ),
    60_000,
  );

  it.live(
    "marks each turn in Pi's own tree, so revert finds the turn's first message",
    () =>
      withPi("full-access", ({ rpc, log }) =>
        Effect.gen(function* () {
          const commands = decodePi(PiCommands)(yield* rpc.request({ type: "get_commands" }));
          expect(
            commands._tag === "Some" &&
              commands.value.commands.some((c) => c.name === PI_TURN_COMMAND),
          ).toBe(true);
          for (const turnId of ["turn-a", "turn-b"]) {
            const from = log.mark();
            expect(yield* prompt(rpc, piTurnCommandText({ nonce: NONCE, turnId }))).toEqual({
              disposition: "handled",
            });
            yield* prompt(rpc, `hello from ${turnId}`);
            yield* settled(log, from);
          }
          const entries = decodePi(PiEntries)(yield* rpc.request({ type: "get_entries" }));
          expect(entries._tag).toBe("Some");
          if (entries._tag !== "Some") return;
          const boundaries = piTurnBoundaries(entries.value.entries, entries.value.leafId);
          expect(boundaries.map((boundary) => boundary.turnId)).toEqual(["turn-a", "turn-b"]);
          const plan = planPiRevert(boundaries, "turn-b");
          expect(plan.kind).toBe("fork");
          const target = entries.value.entries.find(
            (entry) => plan.kind === "fork" && entry.id === plan.entryId,
          );
          expect(JSON.stringify(target?.message?.content)).toContain("hello from turn-b");
        }),
      ),
    60_000,
  );

  it.live(
    "registers MCP tool servers in deterministic config order regardless of response timing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* Effect.acquireRelease(
            Effect.promise(() => startTestModelServer()),
            (server) => Effect.promise(() => server.close()),
          );
          const slowFirst = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startTestMcpServer({
                token: TOKEN,
                tools: [{ name: "alpha", readOnly: true }],
                listToolsDelayMs: 120,
              }),
            ),
            (server) => Effect.promise(() => server.close()),
          );
          const fastSecond = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startTestMcpServer({
                token: TOKEN,
                tools: [{ name: "beta", readOnly: true }],
              }),
            ),
            (server) => Effect.promise(() => server.close()),
          );
          const home = makeTestPiHome(model.url);
          const extensionDir = mkdtempSync(join(tmpdir(), "threadlines-pi-ext-order-"));
          const extensionPath = join(extensionDir, piExtensionFileName());
          writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 });
          const secretsFile = yield* Effect.promise(() =>
            writePiSecretsFile(join(extensionDir, "run"), { token: TOKEN, nonce: NONCE }),
          );
          const rpc = yield* startPiRpc({
            command: process.execPath,
            args: piProcessArgs(
              { command: process.execPath, prefixArgs: [piCli!] },
              {
                purpose: "chat",
                session: { kind: "new" },
                launchArgs: [],
                extensionPath,
                instructionsPath: undefined,
              },
            ),
            cwd: home.projectDir,
            environment: piProcessEnvironment({
              instanceEnvironment: undefined,
              baseEnv: testPiEnvironment(home.agentDir),
              extension: {
                access: "full-access",
                plan: false,
                toolServers: [
                  { name: "threadlines_first", url: slowFirst.url },
                  { name: "threadlines_second", url: fastSecond.url },
                ],
                secretsFile,
              },
            }),
          });
          const log = yield* collectPiRecords(rpc);
          const from = log.mark();
          yield* prompt(rpc, "REPLY ok");
          yield* settled(log, from);

          const rawTools = (model.requests.at(-1)?.tools ?? []) as ReadonlyArray<{
            readonly function?: { readonly name?: string };
          }>;
          const toolNames = rawTools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => typeof name === "string");
          const firstIndex = toolNames.indexOf("mcp__threadlines_first__alpha");
          const secondIndex = toolNames.indexOf("mcp__threadlines_second__beta");
          expect(firstIndex).toBeGreaterThanOrEqual(0);
          expect(secondIndex).toBeGreaterThan(firstIndex);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "defers non-core MCP tools behind Pi tool_search, loads them on demand, and still enforces approvals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* Effect.acquireRelease(
            Effect.promise(() => startTestModelServer()),
            (server) => Effect.promise(() => server.close()),
          );
          const tools = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startTestMcpServer({
                token: TOKEN,
                instructions: "Test workspace utilities for widgets.",
                tools: [
                  { name: "eager_read", readOnly: true },
                  {
                    name: "deferred_write",
                    readOnly: false,
                    deferred: true,
                    description: "Create a secret widget on demand.",
                  },
                ],
              }),
            ),
            (server) => Effect.promise(() => server.close()),
          );
          const home = makeTestPiHome(model.url);
          const extensionDir = mkdtempSync(join(tmpdir(), "threadlines-pi-ext-defer-"));
          const extensionPath = join(extensionDir, piExtensionFileName());
          writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 });
          const secretsFile = yield* Effect.promise(() =>
            writePiSecretsFile(join(extensionDir, "run"), { token: TOKEN, nonce: NONCE }),
          );
          const rpc = yield* startPiRpc({
            command: process.execPath,
            args: piProcessArgs(
              { command: process.execPath, prefixArgs: [piCli!] },
              {
                purpose: "chat",
                session: { kind: "new" },
                launchArgs: [],
                extensionPath,
                instructionsPath: undefined,
              },
            ),
            cwd: home.projectDir,
            environment: piProcessEnvironment({
              instanceEnvironment: undefined,
              baseEnv: testPiEnvironment(home.agentDir),
              extension: {
                access: "approval-required",
                plan: false,
                toolServers: [{ name: "threadlines_test", url: tools.url }],
                secretsFile,
              },
            }),
          });
          const log = yield* collectPiRecords(rpc);
          const toolNamesOf = (request: Record<string, unknown> | undefined) =>
            (
              (request?.tools ?? []) as ReadonlyArray<{
                readonly function?: { readonly name?: string };
              }>
            )
              .map((tool) => tool.function?.name)
              .filter((name): name is string => typeof name === "string");

          // Turn 1: call tool_search for the deferred tool; must run without approval.
          let from = log.mark();
          yield* prompt(rpc, 'TOOL tool_search {"query":"deferred_write"}');
          const searchEnd = yield* toolEnd(log, from);
          expect(searchEnd.isError).toBe(false);
          expect(resultText(searchEnd)).toContain("mcp__threadlines_test__deferred_write");
          yield* settled(log, from);
          expect(log.all.slice(from).some((record) => record.type === "extension_ui_request")).toBe(
            false,
          );

          // Before tool_search ran, only the eager tool and tool_search were declared,
          // and the system prompt noted the deferred server namespace and instructions.
          const firstRequest = model.requests[0];
          const initialTools = toolNamesOf(firstRequest);
          expect(initialTools).toContain("mcp__threadlines_test__eager_read");
          expect(initialTools).toContain("tool_search");
          expect(initialTools).not.toContain("mcp__threadlines_test__deferred_write");
          expect(JSON.stringify(firstRequest)).toContain("Test workspace utilities for widgets.");

          // After tool_search ran, the deferred tool is declared to the model.
          const afterSearchTools = toolNamesOf(model.requests[1]);
          expect(afterSearchTools).toContain("mcp__threadlines_test__deferred_write");

          // Calling the newly loaded write tool still asks for approval.
          from = log.mark();
          yield* prompt(rpc, 'TOOL mcp__threadlines_test__deferred_write {"text":"go"}');
          const dialog = yield* log.waitFor((record) => record.type === "extension_ui_request", {
            from,
          });
          const approval = parsePiApprovalTitle(String(dialog.title), NONCE);
          expect(approval?.toolName).toBe("mcp__threadlines_test__deferred_write");
          yield* rpc.send({
            type: "extension_ui_response",
            id: dialog.id,
            value: PI_APPROVAL_OPTIONS.allow,
          });
          expect(resultText(yield* toolEnd(log, from))).toContain("deferred_write:");
          yield* settled(log, from);
          expect(tools.calls.map((call) => call.name)).toEqual(["deferred_write"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "falls back to direct exposure when Pi excludes tool_search so deferred tools stay reachable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* Effect.acquireRelease(
            Effect.promise(() => startTestModelServer()),
            (server) => Effect.promise(() => server.close()),
          );
          const tools = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startTestMcpServer({
                token: TOKEN,
                tools: [{ name: "deferred_read", readOnly: true, deferred: true }],
              }),
            ),
            (server) => Effect.promise(() => server.close()),
          );
          const home = makeTestPiHome(model.url);
          const extensionDir = mkdtempSync(join(tmpdir(), "threadlines-pi-ext-fallback-"));
          const extensionPath = join(extensionDir, piExtensionFileName());
          writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 });
          const secretsFile = yield* Effect.promise(() =>
            writePiSecretsFile(join(extensionDir, "run"), { token: TOKEN, nonce: NONCE }),
          );
          const rpc = yield* startPiRpc({
            command: process.execPath,
            args: piProcessArgs(
              { command: process.execPath, prefixArgs: [piCli!] },
              {
                purpose: "chat",
                session: { kind: "new" },
                launchArgs: ["--exclude-tools", "tool_search"],
                extensionPath,
                instructionsPath: undefined,
              },
            ),
            cwd: home.projectDir,
            environment: piProcessEnvironment({
              instanceEnvironment: undefined,
              baseEnv: testPiEnvironment(home.agentDir),
              extension: {
                access: "full-access",
                plan: false,
                toolServers: [{ name: "threadlines_test", url: tools.url }],
                secretsFile,
              },
            }),
          });
          const log = yield* collectPiRecords(rpc);
          const from = log.mark();
          yield* prompt(rpc, 'TOOL mcp__threadlines_test__deferred_read {"text":"ok"}');
          expect(resultText(yield* toolEnd(log, from))).toContain("deferred_read:");
          yield* settled(log, from);
          const declared = (
            (model.requests[0]?.tools ?? []) as ReadonlyArray<{
              readonly function?: { readonly name?: string };
            }>
          ).map((tool) => tool.function?.name);
          expect(declared).toContain("mcp__threadlines_test__deferred_read");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.live(
    "does not activate tool_search or advertise deferred namespaces when Pi excludes all MCP tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* Effect.acquireRelease(
            Effect.promise(() => startTestModelServer()),
            (server) => Effect.promise(() => server.close()),
          );
          const tools = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startTestMcpServer({
                token: TOKEN,
                instructions: "Should not be advertised when excluded.",
                tools: [{ name: "deferred_read", readOnly: true, deferred: true }],
              }),
            ),
            (server) => Effect.promise(() => server.close()),
          );
          const home = makeTestPiHome(model.url);
          const extensionDir = mkdtempSync(join(tmpdir(), "threadlines-pi-ext-excl-"));
          const extensionPath = join(extensionDir, piExtensionFileName());
          writeFileSync(extensionPath, PI_EXTENSION_SOURCE, { mode: 0o600 });
          const secretsFile = yield* Effect.promise(() =>
            writePiSecretsFile(join(extensionDir, "run"), { token: TOKEN, nonce: NONCE }),
          );
          const rpc = yield* startPiRpc({
            command: process.execPath,
            args: piProcessArgs(
              { command: process.execPath, prefixArgs: [piCli!] },
              {
                purpose: "chat",
                session: { kind: "new" },
                launchArgs: ["--exclude-tools", "mcp__*"],
                extensionPath,
                instructionsPath: undefined,
              },
            ),
            cwd: home.projectDir,
            environment: piProcessEnvironment({
              instanceEnvironment: undefined,
              baseEnv: testPiEnvironment(home.agentDir),
              extension: {
                access: "full-access",
                plan: false,
                toolServers: [{ name: "threadlines_test", url: tools.url }],
                secretsFile,
              },
            }),
          });
          const log = yield* collectPiRecords(rpc);
          const from = log.mark();
          yield* prompt(rpc, "REPLY ok");
          yield* settled(log, from);
          const declared = (
            (model.requests[0]?.tools ?? []) as ReadonlyArray<{
              readonly function?: { readonly name?: string };
            }>
          ).map((tool) => tool.function?.name);
          expect(declared).not.toContain("tool_search");
          expect(JSON.stringify(model.requests[0])).not.toContain(
            "Should not be advertised when excluded.",
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});
