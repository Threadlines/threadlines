/**
 * The Threadlines extension inside a real Pi, against the test model and tool
 * servers. Runs when a Pi `cli.js` is available (THREADLINES_PI_CLI, or the
 * server's pinned dev dependency).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  parsePiApprovalTitle,
  PI_APPROVAL_OPTIONS,
  PI_EXTENSION_SOURCE,
  PI_PLAN_MODE_REASON,
  piExtensionFileName,
  piModeCommandText,
} from "./PiExtensionSource.ts";
import { type PiAccessLevel, piProcessArgs, piProcessEnvironment } from "./PiLaunch.ts";
import { type PiRpc, startPiRpc } from "./PiRpc.ts";
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
            token: TOKEN,
            nonce: NONCE,
          },
        }),
      });
      const log = yield* collectPiRecords(rpc);
      return yield* body({ rpc, log, tools, model });
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
      withPi("full-access", ({ rpc, log, model }) =>
        Effect.gen(function* () {
          let from = log.mark();
          yield* prompt(rpc, 'TOOL bash {"command":"echo token=[$THREADLINES_PI_TOOL_TOKEN]"}');
          expect(resultText(yield* toolEnd(log, from))).toContain("token=[]");
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
});
