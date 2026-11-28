// @effect-diagnostics nodeBuiltinImport:off - builds tarball fixtures and inspects the runtime's files
// @effect-diagnostics preferSchemaOverJson:off - writes old markers and reads active.json as plain JSON
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import { makeTar, type TarEntry } from "../testUtils/archiveFixtures.ts";
import {
  ANTIGRAVITY_RELEASE,
  type AntigravityPlatformRelease,
  antigravityFeedUrl,
  antigravityReleaseFor,
  parseAntigravityFeedManifest,
} from "./AntigravityRelease.ts";
import { makeAntigravityReleaseSource } from "./AntigravityReleaseSource.ts";
import {
  type AntigravityFetch,
  type AntigravityInstallProgress,
  type AntigravityRuntimePaths,
  makeAntigravityRuntime,
} from "./AntigravityRuntime.ts";

const EXECUTABLE = "antigravity";
const CHUNK_BYTES = 16 * 1024;

class HandshakeFailed extends Data.TaggedError("HandshakeFailed")<{ readonly message: string }> {}

const sha512 = (data: Buffer) => createHash("sha512").update(data).digest("hex");

/**
 * A release whose tarball holds the one expected executable, or `entries`
 * built from it. `sizes: "feed"` leaves the sizes out, as a release read
 * from Google's update feed does.
 */
function makeFixture(
  seed: string,
  options: {
    readonly entries?: (executable: Buffer) => Array<TarEntry>;
    readonly sizes?: "known" | "feed";
  } = {},
) {
  const executable = Buffer.from(`#!/bin/sh\necho ${seed}\n${"#".repeat(40_000)}\n`);
  const tarball = zlib.gzipSync(
    makeTar(options.entries?.(executable) ?? [{ name: EXECUTABLE, data: executable, mode: 0o755 }]),
  );
  const known = options.sizes !== "feed";
  const release: AntigravityPlatformRelease = {
    version: `1.0.0-${seed}`,
    asset: {
      url: `https://downloads.test/${seed}.tar.gz`,
      sha512: sha512(tarball),
      format: "tar.gz",
      ...(known ? { archiveBytes: tarball.length } : {}),
      executable: { name: EXECUTABLE, ...(known ? { bytes: executable.length } : {}) },
    },
  };
  return { tarball, release, executable, releaseId: release.asset.sha512.slice(0, 16) };
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

const readFile = (file: string) => Effect.promise(() => NodeFS.readFile(file));

describe("makeAntigravityRuntime", () => {
  it.live("installs a tarball, activates it and reports a read-only executable", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const server = makeServer({ [fixture.release.asset.url]: fixture.tarball });
      const { calls, validate } = recordingValidate();
      const runtime = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      assert.isUndefined(yield* runtime.installed);

      const progress: Array<AntigravityInstallProgress> = [];
      const result = yield* runtime.install(fixture.release, (update) => progress.push(update));

      const { releaseId } = fixture;
      const versionDir = path.join(root, "versions", releaseId);
      const executablePath = path.join(versionDir, EXECUTABLE);
      assert.deepStrictEqual(result, { releaseId, version: fixture.release.version });
      assert.deepStrictEqual(yield* runtime.installed, {
        releaseId,
        version: fixture.release.version,
        executable: executablePath,
        kind: "cli",
      });
      assert.isTrue((yield* readFile(executablePath)).equals(fixture.executable));
      if (process.platform !== "win32") {
        const stats = yield* Effect.promise(() => NodeFS.stat(executablePath));
        assert.equal(stats.mode & 0o777, 0o555);
      }
      const active = yield* Effect.promise(() =>
        NodeFS.readFile(path.join(root, "active.json"), "utf8"),
      );
      assert.deepStrictEqual(JSON.parse(active), { releaseId, version: fixture.release.version });
      // Staging is gone; only the version is left, holding the executable and its marker.
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), [releaseId]);
      assert.deepStrictEqual((yield* listDir(versionDir)).toSorted(), [
        ".install-complete.json",
        EXECUTABLE,
      ]);
      assert.deepStrictEqual(server.requests, [
        { url: fixture.release.asset.url, acceptEncoding: "identity" },
      ]);
      assert.lengthOf(calls, 1);
      const phases = progress
        .map((update) => update.phase)
        .filter((phase, index, all) => phase !== all[index - 1]);
      assert.deepStrictEqual(phases, ["downloading", "extracting", "validating", "activating"]);
      assert.deepStrictEqual(
        progress.findLast((update) => update.phase === "downloading"),
        {
          phase: "downloading",
          receivedBytes: fixture.tarball.length,
          totalBytes: fixture.tarball.length,
        },
      );

      // Installing again reuses the files on disk: validated, not downloaded.
      yield* runtime.install(fixture.release);
      assert.lengthOf(server.requests, 1);
      assert.lengthOf(calls, 2);
    }),
  );

  it.live("installs a Windows build, whose download is the executable", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const exe = Buffer.from(`MZ${"x".repeat(50_000)}`);
      const release: AntigravityPlatformRelease = {
        version: "1.0.0-win",
        asset: {
          url: "https://downloads.test/cli_windows_x64.exe",
          sha512: sha512(exe),
          format: "exe",
          archiveBytes: exe.length,
          executable: { name: "agy.exe", bytes: exe.length },
        },
      };
      const server = makeServer({ [release.asset.url]: exe });
      const runtime = makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch: server.fetch,
        platform: "win32",
      });

      yield* runtime.install(release);

      const installed = yield* runtime.installed;
      const versionDir = path.join(root, "versions", release.asset.sha512.slice(0, 16));
      assert.equal(installed?.kind, "cli");
      assert.equal(installed?.executable, path.join(versionDir, "agy.exe"));
      assert.isTrue((yield* readFile(path.join(versionDir, "agy.exe"))).equals(exe));
      assert.deepStrictEqual((yield* listDir(versionDir)).toSorted(), [
        ".install-complete.json",
        "agy.exe",
      ]);
    }),
  );

  it.live("installs a release listed without sizes and keeps it installed", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("feed", { sizes: "feed" });
      const server = makeServer({ [fixture.release.asset.url]: fixture.tarball });
      const runtime = makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch: server.fetch,
      });

      const progress: Array<AntigravityInstallProgress> = [];
      yield* runtime.install(fixture.release, (update) => progress.push(update));

      // `installed` checks the executable against the size the marker
      // recorded, so this holds only if the real size was recorded.
      const installed = yield* runtime.installed;
      assert.equal(installed?.releaseId, fixture.releaseId);
      assert.isTrue((yield* readFile(installed!.executable)).equals(fixture.executable));
      assert.isTrue(
        progress.every((update) => update.totalBytes === undefined),
        "no total is reported for a download of unknown size",
      );
      // And a later process still finds it complete, so it isn't downloaded again.
      yield* makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch: server.fetch,
      }).install(fixture.release);
      assert.lengthOf(server.requests, 1);
    }),
  );

  it.live("installs nothing when the download's sha512 does not match", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const tampered = Buffer.from(fixture.tarball);
      tampered[40] = tampered[40]! ^ 0xff;
      const server = makeServer({ [fixture.release.asset.url]: tampered });
      const { calls, validate } = recordingValidate();
      const runtime = makeAntigravityRuntime({ root, validate, fetch: server.fetch });

      const error = yield* Effect.flip(runtime.install(fixture.release));

      assert.equal(error.reason, "checksum");
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      assert.isUndefined(yield* runtime.installed);
      assert.lengthOf(calls, 0);
    }),
  );

  it.live("refuses tarballs that hold anything but the one executable", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixtures = [
        makeFixture("two-entries", {
          entries: (executable) => [
            { name: EXECUTABLE, data: executable },
            { name: "README", data: Buffer.from("hello") },
          ],
        }),
        makeFixture("wrong-name", {
          entries: (executable) => [{ name: "agy", data: executable }],
        }),
        makeFixture("symlink", {
          entries: () => [{ name: EXECUTABLE, type: "2", linkname: "/bin/sh" }],
        }),
        makeFixture("directory", {
          entries: () => [{ name: `${EXECUTABLE}/`, type: "5", mode: 0o755 }],
        }),
        makeFixture("bigger-than-listed", {
          entries: (executable) => [
            { name: EXECUTABLE, data: Buffer.concat([executable, Buffer.from("extra")]) },
          ],
        }),
      ];
      const server = makeServer(
        Object.fromEntries(fixtures.map((fixture) => [fixture.release.asset.url, fixture.tarball])),
      );
      const { calls, validate } = recordingValidate();
      for (const fixture of fixtures) {
        const runtime = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
        const error = yield* Effect.flip(runtime.install(fixture.release));
        assert.equal(error.reason, "archive", fixture.release.version);
        assert.isUndefined(yield* runtime.installed, fixture.release.version);
      }
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      assert.lengthOf(calls, 0);
    }),
  );

  it.live("installs nothing when the executable fails validation", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const server = makeServer({ [fixture.release.asset.url]: fixture.tarball });
      const runtime = makeAntigravityRuntime({
        root,
        validate: () => Effect.fail(new HandshakeFailed({ message: "initialize timed out" })),
        fetch: server.fetch,
      });

      const error = yield* Effect.flip(runtime.install(fixture.release));

      assert.equal(error.reason, "validate");
      assert.equal(error.detail, "initialize timed out");
      assert.isUndefined(yield* runtime.installed);
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      assert.isFalse(existsSync(path.join(root, "active.json")));
    }),
  );

  it.live("stops reading a download that runs past the expected size", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const fixture = makeFixture("a");
      const oversized = Buffer.concat([fixture.tarball, Buffer.alloc(4 * 1024 * 1024)]);
      const server = makeServer({ [fixture.release.asset.url]: oversized });
      const runtime = makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch: server.fetch,
      });

      const error = yield* Effect.flip(runtime.install(fixture.release));

      assert.equal(error.reason, "checksum");
      assert.isBelow(server.pulledBytes(), fixture.tarball.length + 1024 * 1024);
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
              controller.enqueue(new Uint8Array(fixture.tarball.subarray(0, 64)));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      const runtime = makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch,
      });
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const fiber = yield* runtime
        .install(fixture.release, (update) => {
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
      const server = makeServer({
        [a.release.asset.url]: a.tarball,
        [b.release.asset.url]: b.tarball,
      });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const runtimeB = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const versionsDir = path.join(root, "versions");
      const leasesA = path.join(versionsDir, a.releaseId, ".leases");
      yield* runtimeA.install(a.release);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const leased = yield* runtimeA.acquire;
          assert.equal(leased.releaseId, a.releaseId);
          assert.equal(leased.kind, "cli");
          // Activating B prunes, but A is in use.
          yield* runtimeB.install(b.release);
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

      // The executable is read-only, and remove still deletes it.
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
      const server = makeServer({
        [a.release.asset.url]: a.tarball,
        [b.release.asset.url]: b.tarball,
      });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const runtimeB = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const versionsDir = path.join(root, "versions");
      // Both versions on disk, A active.
      yield* runtimeB.install(b.release);
      yield* Effect.scoped(runtimeB.acquire.pipe(Effect.andThen(runtimeA.install(a.release))));
      assert.equal((yield* runtimeA.installed)?.releaseId, a.releaseId);
      assert.lengthOf(yield* listDir(versionsDir), 2);

      // Another process activates B, pruning A, after this acquire resolved
      // A but before its lease landed.
      let raced = false;
      const racing = makeAntigravityRuntime({
        root,
        validate,
        fetch: server.fetch,
        beforeLeaseWritten: () => {
          if (raced) return Effect.void;
          raced = true;
          return runtimeB.install(b.release).pipe(Effect.orDie, Effect.asVoid);
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
      const server = makeServer({
        [a.release.asset.url]: a.tarball,
        [b.release.asset.url]: b.tarball,
      });
      const { validate } = recordingValidate();
      const runtimeA = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const runtimeB = makeAntigravityRuntime({ root, validate, fetch: server.fetch });
      const versionsDir = path.join(root, "versions");
      const activeFile = path.join(root, "active.json");
      yield* runtimeB.install(b.release);
      const pointerB = yield* Effect.promise(() => NodeFS.readFile(activeFile, "utf8"));
      yield* Effect.scoped(runtimeB.acquire.pipe(Effect.andThen(runtimeA.install(a.release))));

      // Another server switches to B, A stays on disk, and its prune has not
      // run yet: a lease on A now would be one that prune can miss.
      let raced = false;
      const racing = makeAntigravityRuntime({
        root,
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

describe("makeAntigravityRuntime with an install from before the CLI", () => {
  const LEGACY_ID = "0123456789abcdef";

  /** Writes what an install of Google's old ACP server left on disk, active. */
  const writeLegacyInstall = (root: string) =>
    Effect.promise(async () => {
      const versionDir = path.join(root, "versions", LEGACY_ID);
      await NodeFS.mkdir(versionDir, { recursive: true });
      const server = Buffer.from("old server");
      const harness = Buffer.from("old harness");
      await NodeFS.writeFile(path.join(versionDir, "agy_acp_server.par"), server);
      await NodeFS.writeFile(path.join(versionDir, "localharness_external"), harness);
      await NodeFS.writeFile(
        path.join(versionDir, ".install-complete.json"),
        `${JSON.stringify({
          releaseId: LEGACY_ID,
          version: "1.0.4",
          executable: { name: "agy_acp_server.par", bytes: server.length },
          harness: { name: "localharness_external", bytes: harness.length },
        })}\n`,
      );
      await NodeFS.writeFile(
        path.join(root, "active.json"),
        `${JSON.stringify({ releaseId: LEGACY_ID, version: "1.0.4" })}\n`,
      );
      return versionDir;
    });

  it.live("reports it as legacy, never starts it, and prunes it once the CLI replaces it", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const legacyDir = yield* writeLegacyInstall(root);
      const fixture = makeFixture("cli");
      const server = makeServer({ [fixture.release.asset.url]: fixture.tarball });
      const runtime = makeAntigravityRuntime({
        root,
        validate: recordingValidate().validate,
        fetch: server.fetch,
      });

      // Shown as installed, so the row offers Update.
      assert.deepStrictEqual(yield* runtime.installed, {
        releaseId: LEGACY_ID,
        version: "1.0.4",
        executable: path.join(legacyDir, "agy_acp_server.par"),
        kind: "legacy",
      });
      const refused = yield* Effect.flip(Effect.scoped(runtime.acquire));
      assert.equal(refused.reason, "notInstalled");

      // An old process still running on it keeps it through the update.
      const leasesDir = path.join(legacyDir, ".leases");
      const otherLiveProcess = path.join(leasesDir, `${process.ppid}-deadbeef`);
      yield* Effect.promise(async () => {
        await NodeFS.mkdir(leasesDir, { recursive: true });
        await NodeFS.writeFile(otherLiveProcess, "");
      });
      yield* runtime.install(fixture.release);
      const installed = yield* runtime.installed;
      assert.equal(installed?.kind, "cli");
      assert.equal(installed?.releaseId, fixture.releaseId);
      assert.isTrue(existsSync(legacyDir));

      // Once that process is done with it, a prune removes it.
      yield* Effect.promise(() => NodeFS.rm(otherLiveProcess));
      yield* runtime.prune;
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), [fixture.releaseId]);
      const leased = yield* Effect.scoped(runtime.acquire);
      assert.equal(leased.kind, "cli");
    }),
  );
});

describe("makeAntigravityReleaseSource", () => {
  const builtIn = antigravityReleaseFor("darwin", "arm64")!;
  const FEED_SHA512 = "ab".repeat(64);
  const downloadUrl = (version: string, folder = "darwin-arm", file = "cli_mac_arm64.tar.gz") =>
    `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-123456/${folder}/${file}`;
  const manifest = (overrides: Record<string, unknown> = {}) => ({
    version: "9.0.0",
    url: downloadUrl("9.0.0"),
    sha512: FEED_SHA512,
    ...overrides,
  });

  /** Answers every read of the feed with `answer()`, counting the reads. */
  function feed(answer: () => Response | Promise<Response>) {
    const urls: Array<string> = [];
    const fetch: DownloadFetch = async (url) => {
      urls.push(url);
      return answer();
    };
    return { fetch, urls };
  }
  const json = (body: unknown) => () => new Response(JSON.stringify(body));

  it.effect("offers the feed's release when it is newer than the built-in one", () =>
    Effect.gen(function* () {
      const server = feed(json(manifest()));
      const source = makeAntigravityReleaseSource({
        builtIn,
        assetKey: "darwin-arm64",
        fetch: server.fetch,
      });

      assert.deepStrictEqual(yield* source.newest, {
        version: "9.0.0",
        asset: {
          url: downloadUrl("9.0.0"),
          sha512: FEED_SHA512,
          format: "tar.gz",
          executable: { name: EXECUTABLE },
        },
      });
      assert.deepStrictEqual(server.urls, [antigravityFeedUrl("darwin-arm64")]);
    }),
  );

  it.effect("keeps the built-in release unless the feed lists a newer one it can install", () =>
    Effect.gen(function* () {
      const answers: Record<string, () => Response | Promise<Response>> = {
        "same version": json(
          manifest({ version: builtIn.version, url: downloadUrl(builtIn.version) }),
        ),
        "older version": json(manifest({ version: "1.5.13", url: downloadUrl("1.5.13") })),
        "not JSON": () => new Response("<html>"),
        "no sha512": json(manifest({ sha512: undefined })),
        "another host": json(
          manifest({ url: downloadUrl("9.0.0").replace("storage.googleapis.com", "example.com") }),
        ),
        "another build's folder": json(manifest({ url: downloadUrl("9.0.0", "darwin-x64") })),
        "an HTTP error": () => new Response("busy", { status: 503 }),
        "a network error": () => Promise.reject(new Error("offline")),
      };
      for (const [label, answer] of Object.entries(answers)) {
        const source = makeAntigravityReleaseSource({
          builtIn,
          assetKey: "darwin-arm64",
          fetch: feed(answer).fetch,
        });
        assert.deepStrictEqual(yield* source.newest, builtIn, label);
      }
    }),
  );

  it.effect("asks the feed at most once an hour, and waits 10 minutes after a failure", () =>
    Effect.gen(function* () {
      const server = feed(json(manifest()));
      const source = makeAntigravityReleaseSource({
        builtIn,
        assetKey: "darwin-arm64",
        fetch: server.fetch,
      });
      assert.equal((yield* source.newest).version, "9.0.0");
      yield* TestClock.adjust("59 minutes");
      assert.equal((yield* source.newest).version, "9.0.0");
      assert.lengthOf(server.urls, 1);
      yield* TestClock.adjust("2 minutes");
      yield* source.newest;
      assert.lengthOf(server.urls, 2);

      let down = true;
      const flaky = feed(() => (down ? Promise.reject(new Error("offline")) : json(manifest())()));
      const recovering = makeAntigravityReleaseSource({
        builtIn,
        assetKey: "darwin-arm64",
        fetch: flaky.fetch,
      });
      assert.equal((yield* recovering.newest).version, builtIn.version);
      down = false;
      yield* TestClock.adjust("9 minutes");
      assert.equal((yield* recovering.newest).version, builtIn.version);
      assert.lengthOf(flaky.urls, 1);
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* recovering.newest).version, "9.0.0");
      assert.lengthOf(flaky.urls, 2);
    }),
  );
});

describe("parseAntigravityFeedManifest", () => {
  const builtInAsset = ANTIGRAVITY_RELEASE.assets["darwin-arm64"];
  // Google's manifest for the built-in release on Apple silicon, as the feed served it.
  const google = {
    version: ANTIGRAVITY_RELEASE.version,
    url: builtInAsset.url,
    sha512: builtInAsset.sha512,
  };

  it("accepts Google's manifest as the built-in release, without its sizes", () => {
    assert.deepStrictEqual(parseAntigravityFeedManifest(google, "darwin-arm64"), {
      version: ANTIGRAVITY_RELEASE.version,
      asset: {
        url: builtInAsset.url,
        sha512: builtInAsset.sha512,
        format: "tar.gz",
        executable: { name: EXECUTABLE },
      },
    });
    // The hash may come in uppercase; the release id is the same either way.
    assert.equal(
      parseAntigravityFeedManifest(
        { ...google, sha512: google.sha512.toUpperCase() },
        "darwin-arm64",
      )?.asset.sha512,
      builtInAsset.sha512,
    );
  });

  it("reads a Windows manifest as the bare executable", () => {
    const windows = ANTIGRAVITY_RELEASE.assets["win32-x64"];
    assert.deepStrictEqual(
      parseAntigravityFeedManifest(
        { version: ANTIGRAVITY_RELEASE.version, url: windows.url, sha512: windows.sha512 },
        "win32-x64",
      ),
      {
        version: ANTIGRAVITY_RELEASE.version,
        asset: {
          url: windows.url,
          sha512: windows.sha512,
          format: "exe",
          executable: { name: "agy.exe" },
        },
      },
    );
  });

  it("refuses a manifest it can't be sure is Google's build for this machine", () => {
    const refused: Record<string, unknown> = {
      "another build's folder": {
        ...google,
        url: google.url.replace("/darwin-arm/", "/darwin-x64/"),
      },
      "another file name": { ...google, url: google.url.replace("cli_mac_arm64", "cli_mac_x64") },
      "a query string": { ...google, url: `${google.url}?alt=media` },
      "plain http": { ...google, url: google.url.replace("https:", "http:") },
      "a version the url doesn't name": { ...google, version: "1.5.99" },
      "a prerelease version": {
        ...google,
        version: `${ANTIGRAVITY_RELEASE.version}-beta`,
        url: google.url.replace(
          `${ANTIGRAVITY_RELEASE.version}-`,
          `${ANTIGRAVITY_RELEASE.version}-beta-`,
        ),
      },
      "a two-part version": {
        ...google,
        version: "1.5",
        url: google.url.replace(`${ANTIGRAVITY_RELEASE.version}-`, "1.5-"),
      },
      "a short sha512": { ...google, sha512: google.sha512.slice(0, 64) },
      "a sha512 that isn't hex": { ...google, sha512: `${google.sha512.slice(0, 127)}g` },
      "a missing url": { version: google.version, sha512: google.sha512 },
      "an array": [google],
      null: null,
    };
    for (const [label, manifest] of Object.entries(refused)) {
      assert.isUndefined(parseAntigravityFeedManifest(manifest, "darwin-arm64"), label);
    }
    // Google's Apple silicon manifest is not a Linux build.
    assert.isUndefined(parseAntigravityFeedManifest(google, "linux-arm64"));
  });
});
