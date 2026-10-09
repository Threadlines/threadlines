import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  capturePage,
  PREVIEW_BROWSER_APPARMOR_COMMAND,
  splitCdpMessages,
} from "./headlessChrome.ts";

describe("splitCdpMessages", () => {
  it("joins messages split across chunks and splits chunks holding several", () => {
    const partial: Array<string> = [];
    expect(splitCdpMessages(partial, '{"id":1,"res')).toEqual([]);
    expect(splitCdpMessages(partial, 'ult":{}}\0{"id":2}\0{"method":"Page.')).toEqual([
      '{"id":1,"result":{}}',
      '{"id":2}',
    ]);
    expect(splitCdpMessages(partial, "loadEventFired")).toEqual([]);
    expect(splitCdpMessages(partial, '"}\0')).toEqual(['{"method":"Page.loadEventFired"}']);
    expect(partial).toEqual([]);
  });
});

/**
 * A stand-in browser that reads the first command off its debugging pipe,
 * then runs `exit`. Reading it first keeps the pipe from resetting.
 */
const exitingBrowser = (exit: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "threadlines-exiting-browser-",
    });
    const executable = path.join(directory, "chrome-headless-shell");
    yield* fileSystem.writeFileString(
      executable,
      [
        `#!${process.execPath}`,
        `new (process.getBuiltinModule("node:net").Socket)({ fd: 3 }).on("data", (chunk) => { if (chunk.includes(0)) { ${exit} } });`,
      ].join("\n"),
    );
    yield* fileSystem.chmod(executable, 0o755);
    return executable;
  });

const captureError = (exit: string) =>
  Effect.gen(function* () {
    const executable = yield* exitingBrowser(exit);
    return yield* capturePage({ executable, document: "<p>x</p>", width: 400 }).pipe(Effect.flip);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(process.platform === "win32")("when the browser exits before rendering", () => {
  it.live("reports its exit code and the last line it printed", () =>
    Effect.gen(function* () {
      const error = yield* captureError(
        `process.stderr.write("[WARNING:bus.cc] Failed to connect to the bus\\n[FATAL:shared_memory.cc] Check failed: /dev/shm is not writable\\n"); process.exit(3);`,
      );

      expect(error.message).toBe(
        "The preview browser could not show the page: the browser exited unexpectedly (exit code 3): [FATAL:shared_memory.cc] Check failed: /dev/shm is not writable.",
      );
    }),
  );

  it.live("reports the signal that ended it", () =>
    Effect.gen(function* () {
      const error = yield* captureError(`process.kill(process.pid, "SIGKILL");`);

      expect(error.message).toBe(
        "The preview browser could not show the page: the browser exited unexpectedly (signal SIGKILL).",
      );
    }),
  );

  it.live("names the AppArmor fix when the host blocks Chrome's sandbox", () =>
    Effect.gen(function* () {
      const error = yield* captureError(
        `process.stderr.write("[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.\\n"); process.exit(1);`,
      );

      expect(error._tag).toBe("PagePreviewSandboxError");
      expect(error.message).toContain("AppArmor");
      expect(error.message).toContain(PREVIEW_BROWSER_APPARMOR_COMMAND);
    }),
  );

  it.live("says the sandbox cannot run as root instead of turning it off", () =>
    Effect.gen(function* () {
      const error = yield* captureError(
        `process.stderr.write("[FATAL:zygote_host_impl_linux.cc(132)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.\\n"); process.exit(1);`,
      );

      expect(error).toMatchObject({ _tag: "PagePreviewSandboxError", blockedBy: "root" });
    }),
  );
});

// Covers patches/@effect__platform-node-shared@4.0.0-beta.107.patch, which the
// browser's debugging pipe depends on. A stopped child never reads its input,
// so a chunk larger than the socket buffer leaves a write queued. Closing the
// scope interrupts the writer and kills the child, and the pipe then fails
// with EPIPE (stdin) or ECONNRESET (extra fds, which Node also reads).
// Unpatched, nothing listens by then and the uncaught error kills the server.
const killChildWithQueuedInput = (target: "stdin" | "fd3") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.kill(process.pid, 'SIGSTOP')"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "100 millis",
            additionalFds: { fd3: { type: "input" } },
          }),
        );
        const pulled = yield* Deferred.make<void>();
        const input = Stream.make(new Uint8Array(4 * 1024 * 1024)).pipe(
          Stream.tap(() => Deferred.succeed(pulled, undefined)),
        );
        yield* Effect.forkScoped(
          Stream.run(input, target === "stdin" ? child.stdin : child.getInputFd(3)),
        );
        yield* Deferred.await(pulled);
      }),
    );
    // The scope ends once the killed child is reaped. Its pipe failure is
    // already queued by then and lands in this same poll phase.
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
  }).pipe(Effect.provide(NodeServices.layer));

describe.skipIf(process.platform === "win32")("child process input pipes", () => {
  it.live("survive a child killed with stdin still queued", () =>
    killChildWithQueuedInput("stdin"),
  );

  it.live("survive a child killed with additional fd input still queued", () =>
    killChildWithQueuedInput("fd3"),
  );
});
