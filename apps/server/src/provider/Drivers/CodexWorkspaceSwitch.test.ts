import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CodexSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { makeLaunchGate } from "../managedRuntime/LaunchGate.ts";
import { makeCodexWorkspaceSwitchFlows } from "./CodexWorkspaceSwitch.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** What the stand-in Codex answers `accountSession/switch` with. */
type SwitchAnswer =
  | { readonly kind: "switched" }
  | { readonly kind: "refused"; readonly message: string }
  /** A page to sign in on; `completes` sends its completion after a moment. */
  | { readonly kind: "signOn"; readonly completes?: { readonly success: boolean } };

const ACCOUNT_SESSIONS = {
  activeSessionId: "session-1",
  sessions: [
    {
      sessionId: "session-1",
      isActive: true,
      lastUsedAt: 1,
      selectedWorkspaceAccountId: "acct-personal",
      workspaces: [
        { accountId: "acct-personal", kind: "personal", name: null },
        // Named by its administrator, who can put a page address in it.
        { accountId: "acct-acme", kind: "workspace", name: "Acme https://phish.example/login" },
      ],
    },
  ],
};

/**
 * A stand-in `codex` that speaks just enough app-server for a switch, and
 * writes every request it gets to `requests.ndjson`.
 */
const makeStandInCodex = (answer: SwitchAnswer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "threadlines-codex-switch-" });
    const scriptPath = path.join(dir, "stand-in-codex.cjs");
    const requestsPath = path.join(dir, "requests.ndjson");
    yield* fs.writeFileString(
      scriptPath,
      [
        '"use strict";',
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `const answer = ${JSON.stringify(answer)};`,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `const sessions = ${JSON.stringify(ACCOUNT_SESSIONS)};`,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `const requestsPath = ${JSON.stringify(requestsPath)};`,
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.id === undefined || !message.method) return;",
        "  fs.appendFileSync(requestsPath, JSON.stringify({ method: message.method, params: message.params }) + '\\n');",
        "  switch (message.method) {",
        "    case 'initialize':",
        "      return send({ id: message.id, result: { userAgent: 'stand-in', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'macos' } });",
        "    case 'accountSession/list':",
        "      return send({ id: message.id, result: sessions });",
        "    case 'account/login/cancel':",
        "      return send({ id: message.id, result: { status: 'canceled' } });",
        "    case 'accountSession/switch':",
        "      if (answer.kind === 'refused') return send({ id: message.id, error: { code: -32600, message: answer.message } });",
        "      if (answer.kind === 'switched') return send({ id: message.id, result: sessions });",
        "      send({ id: message.id, result: { auth_url: 'https://auth.example.com/sso?state=1', login_id: 'login-1' } });",
        "      if (answer.completes) setTimeout(() => {",
        "        send({ method: 'account/login/completed', params: { loginId: 'login-other', success: false, error: 'not this one' } });",
        "        send({ method: 'account/login/completed', params: { loginId: 'login-1', success: answer.completes.success, error: answer.completes.success ? null : 'Workspace validation failed' } });",
        "      }, 50);",
        "      return;",
        "  }",
        "  send({ id: message.id, error: { code: -32601, message: 'not in the stand-in' } });",
        "});",
        "",
      ].join("\n"),
    );
    const binaryPath = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    yield* fs.writeFileString(
      binaryPath,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    );
    yield* fs.chmod(binaryPath, 0o755);
    const requests = fs.readFileString(requestsPath).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) =>
        text
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { method: string; params: unknown }),
      ),
    );
    return { binaryPath, requests };
  });

const runSwitch = (answer: SwitchAnswer, workspaceId: string) =>
  Effect.gen(function* () {
    const standIn = yield* makeStandInCodex(answer);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const gate = makeLaunchGate();
    const lines: string[] = [];
    let stops = 0;
    const flows = makeCodexWorkspaceSwitchFlows({
      settings: decodeCodexSettings({ binaryPath: standIn.binaryPath }),
      environment: process.env,
      spawner,
      gate,
      stopSessions: Effect.sync(() => {
        stops += 1;
      }),
    });
    const run = flows.run({
      flow: "switch-workspace",
      workspaceId,
      report: (line) => Effect.sync(() => void lines.push(line)),
      requestPage: () => Effect.succeed(false),
      showCode: () => Effect.void,
      ask: () => Effect.succeed(null),
    });
    return { run, lines, gate, standIn, stops: () => stops };
  });

// Real time: the stand-in answers on its own clock.
it.layer(NodeServices.layer, { excludeTestServices: true })("CodexWorkspaceSwitch", (it) => {
  describe.skipIf(process.platform === "win32")("switch-workspace", () => {
    it.effect("stops Codex chats, then has Codex switch the login to the workspace", () =>
      Effect.gen(function* () {
        const harness = yield* runSwitch({ kind: "switched" }, "acct-acme");
        yield* harness.run;
        expect(harness.stops()).toBeGreaterThan(0);
        expect(harness.gate.busy).toBe(false);
        const switched = (yield* harness.standIn.requests).find(
          (request) => request.method === "accountSession/switch",
        );
        expect(switched?.params).toEqual({
          sessionId: "session-1",
          accountId: "acct-acme",
          allowBrowserLogin: true,
        });
        expect(harness.lines.at(-1)).toBe("Switched workspace.");
        // The name's address never reaches the lines a panel scans for pages.
        expect(harness.lines.some((line) => line.includes("://"))).toBe(false);
      }),
    );

    it.effect("finishes a workspace behind sign-on once its own sign-in completes", () =>
      Effect.gen(function* () {
        const harness = yield* runSwitch(
          { kind: "signOn", completes: { success: true } },
          "acct-acme",
        );
        yield* harness.run;
        // Codex's page on its own line, for the panel to open, and no other
        // address: the panel opens the first one a run prints.
        expect(harness.lines.filter((line) => line.includes("://"))).toEqual([
          "https://auth.example.com/sso?state=1",
        ]);
        expect(harness.lines.at(-1)).toBe("Switched workspace.");

        const failing = yield* runSwitch(
          { kind: "signOn", completes: { success: false } },
          "acct-acme",
        );
        const error = yield* Effect.flip(failing.run);
        expect(error.message).toBe("Workspace validation failed");
      }),
    );

    it.effect("cancels Codex's sign-on when the switch is stopped", () =>
      Effect.gen(function* () {
        const harness = yield* runSwitch({ kind: "signOn" }, "acct-acme");
        const fiber = yield* Effect.forkChild(harness.run);
        yield* Effect.sync(() => harness.lines.some((line) => line.startsWith("https://"))).pipe(
          Effect.repeat({ until: (shown) => shown, schedule: Schedule.spaced("20 millis") }),
          Effect.timeout("10 seconds"),
        );
        yield* Fiber.interrupt(fiber);
        expect(
          (yield* harness.standIn.requests).filter(
            (request) => request.method === "account/login/cancel",
          ),
        ).toEqual([{ method: "account/login/cancel", params: { loginId: "login-1" } }]);
        expect(harness.gate.busy).toBe(false);
      }),
    );

    it.effect("says Codex's refusals in the panel's words", () =>
      Effect.gen(function* () {
        const harness = yield* runSwitch(
          { kind: "refused", message: "This workspace requires a new sign-in." },
          "acct-acme",
        );
        const error = yield* Effect.flip(harness.run);
        expect(error.message).toBe(
          "That workspace needs you to sign in again. Sign in to Codex, then switch.",
        );

        const unknown = yield* runSwitch({ kind: "switched" }, "acct-gone");
        expect((yield* Effect.flip(unknown.run)).message).toBe(
          "This sign-in can't use that workspace any more.",
        );
      }),
    );
  });
});
