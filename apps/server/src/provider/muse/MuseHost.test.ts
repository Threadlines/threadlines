import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { startMuseHost } from "./MuseHost.ts";

// Answers the handshake, then ignores the end of its input and never exits.
const STUBBORN_HOST = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], String(process.pid));
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { schema: { version: 1 } } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("startMuseHost", () => {
  it.live(
    "ends a host that ignores the end of its input once the drain window runs out",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "threadlines-muse-host-"));
        const script = join(dir, "stubborn-host.mjs");
        const pidFile = join(dir, "pid");
        writeFileSync(script, STUBBORN_HOST);

        const scope = yield* Scope.make();
        yield* startMuseHost({
          binaryPath: process.execPath,
          args: [script, pidFile],
          environment: process.env,
          exitGrace: "200 millis",
        }).pipe(Scope.provide(scope));
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(isRunning(pid)).toBe(true);

        yield* Scope.close(scope, Exit.void);
        expect(isRunning(pid)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );
});
