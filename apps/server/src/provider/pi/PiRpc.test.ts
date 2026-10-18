import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PI_STARTUP_QUESTION_MESSAGE, PiLineSplitter, startPiRpc } from "./PiRpc.ts";

// Speaks Pi's RPC shape: answers get_state, answers `slow` after `fast`, refuses
// `refuse`, emits one event per `emit`, and exits on `exit`. Splits stdin on LF
// only, as Pi does.
const FAKE_PI = `
let buffer = "";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let held;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const reply = (extra) => out({ type: "response", id: command.id, command: command.type, ...extra });
    if (command.type === "get_state") reply({ success: true, data: { sessionFile: "/s.jsonl" } });
    else if (command.type === "slow") held = () => reply({ success: true, data: { which: "slow" } });
    else if (command.type === "fast") { reply({ success: true, data: { which: "fast" } }); held?.(); }
    else if (command.type === "refuse") reply({ success: false, error: "Nothing to compact" });
    else if (command.type === "emit") { out({ type: "agent_start" }); out({ type: "message_update", text: "a\\u2028b" }); reply({ success: true }); }
    else if (command.type === "exit") process.exit(3);
  }
});
`;

// Asks a question before it reads stdin, like Pi 1.3 with a startup dialog.
const STARTUP_QUESTION_PI = `
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: "?" }) + "\\n");
setInterval(() => {}, 1000);
`;

const scriptFile = (source: string) => {
  const dir = mkdtempSync(join(tmpdir(), "threadlines-pi-rpc-"));
  const file = join(dir, "fake-pi.mjs");
  writeFileSync(file, source);
  return file;
};

describe("PiLineSplitter", () => {
  it("splits on LF only, strips one CR, and keeps U+2028 inside a record", () => {
    const splitter = new PiLineSplitter();
    expect(splitter.push('{"a":"x y"}\r\n{"b"')).toEqual(['{"a":"x y"}']);
    expect(splitter.push(":1}\n\n")).toEqual(['{"b":1}']);
  });

  it("drops a record over the limit whole and keeps the next one", () => {
    const splitter = new PiLineSplitter(8);
    expect(splitter.push("0123456789")).toEqual([]);
    expect(splitter.push("abc\nok\n")).toEqual(["ok"]);
    expect(splitter.dropped).toBe(1);
  });
});

describe("startPiRpc", () => {
  it.live(
    "matches replies by id, reports refusals, streams events, and fails waiters when Pi exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* startPiRpc({
            command: process.execPath,
            args: [scriptFile(FAKE_PI)],
            environment: process.env,
          });
          expect(rpc.initialState).toEqual({ sessionFile: "/s.jsonl" });

          // `slow` is answered only after `fast`: each reply still finds its request.
          const slow = yield* Effect.forkChild(rpc.request({ type: "slow" }));
          // Lets the forked request go out first.
          yield* Effect.sleep("50 millis");
          const fast = yield* rpc.request({ type: "fast" });
          expect(fast).toEqual({ which: "fast" });
          expect(yield* Fiber.join(slow)).toEqual({ which: "slow" });

          const refused = yield* Effect.flip(rpc.request({ type: "refuse" }));
          expect(refused.kind).toBe("rejected");
          expect(refused.message).toBe("Nothing to compact");

          yield* rpc.request({ type: "emit" });
          const events = yield* rpc.records.pipe(Stream.take(2), Stream.runCollect);
          expect(Array.from(events).map((record) => record.type)).toEqual([
            "agent_start",
            "message_update",
          ]);
          expect(Array.from(events)[1]?.text).toBe("a b");

          const waiting = yield* Effect.forkChild(rpc.request({ type: "slow" }, { timeout: null }));
          yield* rpc.send({ type: "exit" });
          const failure = yield* Effect.flip(Fiber.join(waiting));
          expect(failure.kind).toBe("exited");
          expect((yield* rpc.exited).code).toBe(3);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "says why startup hangs when an extension asks a question first",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            startPiRpc({
              command: process.execPath,
              args: [scriptFile(STARTUP_QUESTION_PI)],
              environment: process.env,
              startupTimeout: "500 millis",
              exitGrace: "100 millis",
            }),
          );
          expect(error.kind).toBe("startup");
          expect(error.message).toContain(PI_STARTUP_QUESTION_MESSAGE);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );
});
