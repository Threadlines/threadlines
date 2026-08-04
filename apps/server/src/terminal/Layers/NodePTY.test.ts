import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import * as Layer from "effect/Layer";

import { ensureNodePtySpawnHelperExecutable, layer, resolveNodePtyShell } from "./NodePTY.ts";
import { PtyAdapter } from "../Services/PTY.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

it.layer(NodeServices.layer)("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o644);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o755);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("resolves bare Windows shells through PATH and PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-windows-shell-test-" });
      const executablePath = path.join(dir, "claude.exe");
      yield* fs.writeFileString(executablePath, "not executed");

      assert.equal(
        resolveNodePtyShell("claude", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"),
        executablePath,
      );
    }),
  );

  it("keeps macOS and Linux shell names unchanged", () => {
    assert.equal(resolveNodePtyShell("claude", { PATH: "/opt/bin" }, "darwin"), "claude");
    assert.equal(resolveNodePtyShell("claude", { PATH: "/opt/bin" }, "linux"), "claude");
  });
});

const NodePtyTestLayer = layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(NodePtyTestLayer)("NodePTY Windows executable resolution", (it) => {
  it.effect("spawns a bare command backed by a PATH batch shim", () =>
    Effect.gen(function* () {
      if (globalThis.process.platform !== "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pty = yield* PtyAdapter;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-windows-spawn-test-" });
      const executablePath = path.join(dir, "claude.cmd");
      yield* fs.writeFileString(
        executablePath,
        "@echo off\r\nset /p THREADLINES_AUTH_PTY_READY=\r\necho threadlines-auth-pty-ok\r\n",
      );

      const ptyProcess = yield* pty.spawn({
        shell: "claude",
        args: [],
        cwd: dir,
        cols: 100,
        rows: 26,
        env: { ...globalThis.process.env, PATH: dir, PATHEXT: ".EXE;.CMD" },
      });
      const result = yield* Effect.callback<{
        readonly exitCode: number;
        readonly output: string;
      }>((resume) => {
        let output = "";
        let settled = false;
        const unsubscribeData = ptyProcess.onData((data) => {
          output += data;
        });
        let unsubscribeExit = () => {};
        const cleanup = () => {
          clearTimeout(timeout);
          unsubscribeData();
          unsubscribeExit();
        };
        const killSafely = () => {
          try {
            ptyProcess.kill();
          } catch {
            // The native process may already have exited while cleanup races it.
          }
        };
        const settle = (exitCode: number) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(Effect.succeed({ exitCode, output }));
        };
        const timeout = setTimeout(() => {
          killSafely();
          settle(-1);
        }, 5_000);
        unsubscribeExit = ptyProcess.onExit((event) => {
          settle(event.exitCode);
        });
        ptyProcess.write("\r");
        return Effect.sync(() => {
          if (settled) return;
          settled = true;
          cleanup();
          killSafely();
        });
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.output, /threadlines-auth-pty-ok/u);
    }),
  );
});
