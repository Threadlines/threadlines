// @effect-diagnostics nodeBuiltinImport:off - builds zip fixtures and inspects the runtime's files
// @effect-diagnostics preferSchemaOverJson:off - reads active.json back as plain JSON
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { AntigravityPlatformRelease } from "./AntigravityRelease.ts";
import {
  type AntigravityFetch,
  type AntigravityInstallProgress,
  type AntigravityRuntimePaths,
  makeAntigravityRuntime,
} from "./AntigravityRuntime.ts";

const EXECUTABLE = "agy_acp_server.par";
const HARNESS = "localharness_external";
const CHUNK_BYTES = 16 * 1024;

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
}

/** A minimal zip writer: local headers and data, then the central directory and end record. */
function makeZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const parts: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A release whose zip holds the two expected files, or `entries` built from them. */
function makeFixture(
  seed: string,
  entries?: (files: { readonly executable: Buffer; readonly harness: Buffer }) => Array<ZipEntry>,
) {
  const executable = Buffer.from(`#!/bin/sh\necho ${seed}\n`);
  const harness = Buffer.from(`harness ${seed}\n`.repeat(64));
  const zip = makeZip(
    entries?.({ executable, harness }) ?? [
      { name: EXECUTABLE, data: executable },
      { name: HARNESS, data: harness, deflate: true },
    ],
  );
  const release: AntigravityPlatformRelease = {
    version: `1.0.0-${seed}`,
    asset: {
      url: `https://downloads.test/${seed}.zip`,
      sha256: sha256(zip),
      archiveBytes: zip.length,
      executable: { name: EXECUTABLE, bytes: executable.length },
      harness: { name: HARNESS, bytes: harness.length },
    },
  };
  return { zip, release, executable, harness, releaseId: release.asset.sha256.slice(0, 16) };
}

/** Serves archives from memory in small chunks, with no content-length, like a chunked response. */
function makeServer(archives: Record<string, Buffer>) {
  const requests: Array<{ readonly url: string; readonly acceptEncoding: string | null }> = [];
  let pulledBytes = 0;
  const fetch: AntigravityFetch = async (url, init) => {
    requests.push({ url, acceptEncoding: new Headers(init.headers).get("accept-encoding") });
    const body = archives[url];
    if (!body) return new Response(null, { status: 404 });
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        const chunk = body.subarray(offset, offset + CHUNK_BYTES);
        offset += chunk.length;
        pulledBytes += chunk.length;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    return new Response(stream);
  };
  return { fetch, requests, pulledBytes: () => pulledBytes };
}

function recordingValidate() {
  const calls: Array<AntigravityRuntimePaths> = [];
  const validate = (paths: AntigravityRuntimePaths) =>
    Effect.sync(() => {
      calls.push(paths);
    });
  return { calls, validate };
}

/** A fresh root named like a real one, inside a temp directory removed afterwards. */
const tempRoot = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-agy-test-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => path.join(dir, "darwin-arm64")));

const listDir = (dir: string) =>
  Effect.promise(() => NodeFS.readdir(dir).catch(() => [] as Array<string>));

describe("makeAntigravityRuntime", () => {
  it.live("installs, activates and reports the installed files", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const server = makeServer({ [fixture.release.asset.url]: fixture.zip });
      const { calls, validate } = recordingValidate();
      const runtime = makeAntigravityRuntime({
        root,
        release: fixture.release,
        validate,
        fetch: server.fetch,
      });
      assert.isUndefined(yield* runtime.installed);

      const progress: Array<AntigravityInstallProgress> = [];
      const result = yield* runtime.install((update) => progress.push(update));

      const { releaseId } = fixture;
      const versionDir = path.join(root, "versions", releaseId);
      assert.deepStrictEqual(result, { releaseId, version: fixture.release.version });
      assert.deepStrictEqual(yield* runtime.installed, {
        releaseId,
        version: fixture.release.version,
        executable: path.join(versionDir, EXECUTABLE),
        harness: path.join(versionDir, HARNESS),
      });
      const executable = yield* Effect.promise(() =>
        NodeFS.readFile(path.join(versionDir, EXECUTABLE)),
      );
      const harness = yield* Effect.promise(() => NodeFS.readFile(path.join(versionDir, HARNESS)));
      assert.isTrue(executable.equals(fixture.executable));
      assert.isTrue(harness.equals(fixture.harness));
      if (process.platform !== "win32") {
        for (const name of [EXECUTABLE, HARNESS]) {
          const stats = yield* Effect.promise(() => NodeFS.stat(path.join(versionDir, name)));
          assert.equal(stats.mode & 0o777, 0o755);
        }
      }
      const active = yield* Effect.promise(() =>
        NodeFS.readFile(path.join(root, "active.json"), "utf8"),
      );
      assert.deepStrictEqual(JSON.parse(active), { releaseId, version: fixture.release.version });
      // Staging is gone; only the version is left.
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), [releaseId]);
      assert.deepStrictEqual(server.requests, [
        { url: fixture.release.asset.url, acceptEncoding: "identity" },
      ]);
      assert.equal(calls.length, 1);
      const phases = progress
        .map((update) => update.phase)
        .filter((phase, index, all) => phase !== all[index - 1]);
      assert.deepStrictEqual(phases, ["downloading", "extracting", "validating", "activating"]);
      assert.deepStrictEqual(
        progress.findLast((update) => update.phase === "downloading"),
        {
          phase: "downloading",
          receivedBytes: fixture.zip.length,
          totalBytes: fixture.zip.length,
        },
      );

      // Installing again reuses the files on disk: validated, not downloaded.
      yield* runtime.install();
      assert.equal(server.requests.length, 1);
      assert.equal(calls.length, 2);
    }),
  );

  it.live("rejects a download whose hash does not match and leaves nothing behind", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const tampered = Buffer.from(fixture.zip);
      tampered[40] = tampered[40]! ^ 0xff;
      const server = makeServer({ [fixture.release.asset.url]: tampered });
      const { calls, validate } = recordingValidate();
      const runtime = makeAntigravityRuntime({
        root,
        release: fixture.release,
        validate,
        fetch: server.fetch,
      });

      const error = yield* Effect.flip(runtime.install());

      assert.equal(error.reason, "checksum");
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      assert.isUndefined(yield* runtime.installed);
      assert.equal(calls.length, 0);
    }),
  );

  it.live("rejects archives that hold anything but the two expected files", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixtures = [
        makeFixture("extra", ({ executable, harness }) => [
          { name: EXECUTABLE, data: executable },
          { name: HARNESS, data: harness },
          { name: "README", data: Buffer.from("hello") },
        ]),
        makeFixture("escape", ({ executable, harness }) => [
          { name: `../${EXECUTABLE}`, data: executable },
          { name: HARNESS, data: harness },
        ]),
      ];
      const server = makeServer(
        Object.fromEntries(fixtures.map((fixture) => [fixture.release.asset.url, fixture.zip])),
      );
      const { calls, validate } = recordingValidate();
      for (const fixture of fixtures) {
        const runtime = makeAntigravityRuntime({
          root,
          release: fixture.release,
          validate,
          fetch: server.fetch,
        });
        const error = yield* Effect.flip(runtime.install());
        assert.equal(error.reason, "archive", fixture.release.version);
      }
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      assert.equal(calls.length, 0);
    }),
  );

  it.live("stops reading a download that runs past the expected size", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const oversized = Buffer.concat([fixture.zip, Buffer.alloc(4 * 1024 * 1024)]);
      const server = makeServer({ [fixture.release.asset.url]: oversized });
      const runtime = makeAntigravityRuntime({
        root,
        release: fixture.release,
        validate: recordingValidate().validate,
        fetch: server.fetch,
      });

      const error = yield* Effect.flip(runtime.install());

      assert.equal(error.reason, "checksum");
      assert.isBelow(server.pulledBytes(), fixture.zip.length + 1024 * 1024);
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
    }),
  );

  it.live("interrupting a download cancels it and removes the partial files", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      let cancelled = false;
      // Sends the first bytes, then stalls until cancelled.
      const fetch: AntigravityFetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(fixture.zip.subarray(0, 64)));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      const runtime = makeAntigravityRuntime({
        root,
        release: fixture.release,
        validate: recordingValidate().validate,
        fetch,
      });
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const fiber = yield* runtime
        .install((update) => {
          if (update.receivedBytes) markStarted();
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(cancelled);
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
    }),
  );

  it.live("keeps a leased version through prune and drops it once the lease is gone", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const a = makeFixture("a");
      const b = makeFixture("b");
      const server = makeServer({ [a.release.asset.url]: a.zip, [b.release.asset.url]: b.zip });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({
        root,
        release: a.release,
        validate,
        fetch: server.fetch,
      });
      const runtimeB = makeAntigravityRuntime({
        root,
        release: b.release,
        validate,
        fetch: server.fetch,
      });
      const versionsDir = path.join(root, "versions");
      const leasesA = path.join(versionsDir, a.releaseId, ".leases");
      yield* runtimeA.install();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const leased = yield* runtimeA.acquire;
          assert.equal(leased.releaseId, a.releaseId);
          // Activating B prunes, but A is in use.
          yield* runtimeB.install();
          assert.equal((yield* runtimeB.installed)?.releaseId, b.releaseId);
          assert.isTrue(existsSync(leased.executable));
          assert.lengthOf(yield* listDir(leasesA), 1);
          const refused = yield* Effect.flip(runtimeB.remove);
          assert.equal(refused.reason, "io");
        }),
      );
      assert.deepStrictEqual(yield* listDir(leasesA), []);

      // A lease left by a process that is gone does not protect the version.
      const deadPid = 2_147_483_646;
      assert.throws(() => process.kill(deadPid, 0));
      yield* Effect.promise(() => NodeFS.writeFile(path.join(leasesA, `${deadPid}-deadbeef`), ""));
      // Nor does one in this process's name that no acquire here holds (an
      // attempt that gave up while another server had the version moved).
      yield* Effect.promise(() =>
        NodeFS.writeFile(path.join(leasesA, `${process.pid}-0badcafe`), ""),
      );
      yield* runtimeB.prune;
      assert.deepStrictEqual(yield* listDir(versionsDir), [b.releaseId]);

      yield* runtimeB.remove;
      assert.isFalse(existsSync(root));
      assert.isUndefined(yield* runtimeB.installed);
    }),
  );

  it.live("acquire follows the active version when a prune moves it away mid-lease", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const a = makeFixture("a");
      const b = makeFixture("b");
      const server = makeServer({ [a.release.asset.url]: a.zip, [b.release.asset.url]: b.zip });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({
        root,
        release: a.release,
        validate,
        fetch: server.fetch,
      });
      const runtimeB = makeAntigravityRuntime({
        root,
        release: b.release,
        validate,
        fetch: server.fetch,
      });
      const versionsDir = path.join(root, "versions");
      // Both versions on disk, A active.
      yield* runtimeB.install();
      yield* Effect.scoped(runtimeB.acquire.pipe(Effect.andThen(runtimeA.install())));
      assert.equal((yield* runtimeA.installed)?.releaseId, a.releaseId);
      assert.lengthOf(yield* listDir(versionsDir), 2);

      // Another process activates B, pruning A, after this acquire resolved
      // A but before its lease landed.
      let raced = false;
      const racing = makeAntigravityRuntime({
        root,
        release: a.release,
        validate,
        fetch: server.fetch,
        beforeLeaseWritten: () => {
          if (raced) return Effect.void;
          raced = true;
          return runtimeB.install().pipe(Effect.orDie, Effect.asVoid);
        },
      });
      const leasesB = path.join(versionsDir, b.releaseId, ".leases");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leased = yield* racing.acquire;
          assert.isTrue(raced);
          assert.equal(leased.releaseId, b.releaseId);
          // A is gone, and so is the stray lease directory the first attempt made.
          assert.deepStrictEqual(yield* listDir(versionsDir), [b.releaseId]);
          assert.lengthOf(yield* listDir(leasesB), 1);
        }),
      );
      assert.deepStrictEqual(yield* listDir(leasesB), []);
    }),
  );

  it.live("acquire never keeps a version that stopped being active while its lease landed", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const a = makeFixture("a");
      const b = makeFixture("b");
      const server = makeServer({ [a.release.asset.url]: a.zip, [b.release.asset.url]: b.zip });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({
        root,
        release: a.release,
        validate,
        fetch: server.fetch,
      });
      const runtimeB = makeAntigravityRuntime({
        root,
        release: b.release,
        validate,
        fetch: server.fetch,
      });
      const versionsDir = path.join(root, "versions");
      const activeFile = path.join(root, "active.json");
      yield* runtimeB.install();
      const pointerB = yield* Effect.promise(() => NodeFS.readFile(activeFile, "utf8"));
      yield* Effect.scoped(runtimeB.acquire.pipe(Effect.andThen(runtimeA.install())));

      // Another server switches to B, A stays on disk, and its prune has not
      // run yet: a lease on A now would be one that prune can miss.
      let raced = false;
      const racing = makeAntigravityRuntime({
        root,
        release: a.release,
        validate,
        fetch: server.fetch,
        beforeLeaseWritten: () =>
          Effect.promise(async () => {
            if (raced) return;
            raced = true;
            await NodeFS.writeFile(activeFile, pointerB);
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leased = yield* racing.acquire;
          assert.isTrue(raced);
          assert.equal(leased.releaseId, b.releaseId);
          assert.deepStrictEqual(
            yield* listDir(path.join(versionsDir, a.releaseId, ".leases")),
            [],
          );
        }),
      );
    }),
  );
});
