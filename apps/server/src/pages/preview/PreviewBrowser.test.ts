// @effect-diagnostics nodeBuiltinImport:off - builds archive fixtures and inspects the installed files
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { makeZip } from "../../provider/testUtils/archiveFixtures.ts";
import type { DownloadFetch } from "../../provider/managedRuntime/VerifiedDownload.ts";
import {
  makePreviewBrowser,
  PagePreviewInstallingError,
  previewBrowserRelease,
} from "./PreviewBrowser.ts";

const VERSION = "100.0.0.1";
const ROOT = "chrome-headless-shell-fixture/";

/** A zip shaped like Chrome for Testing's: one top folder, Unix modes on every entry. */
const browserArchive = makeZip([
  { name: ROOT, mode: 0o40755 },
  { name: `${ROOT}chrome-headless-shell`, data: Buffer.from("#!/bin/sh\n"), mode: 0o100755 },
  { name: `${ROOT}libEGL.so`, data: Buffer.from("library"), mode: 0o100755 },
  { name: `${ROOT}locales/`, mode: 0o40755 },
  { name: `${ROOT}locales/en-US.pak`, data: Buffer.from("strings"), mode: 0o100644 },
]);

const tempDir = Effect.acquireRelease(
  Effect.promise(() =>
    NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "threadlines-preview-browser-")),
  ),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

const makeHarness = Effect.fn("test.makePreviewBrowser")(function* (
  options: {
    readonly sha256?: string;
    /** The response body; default the whole archive at once. */
    readonly body?: () => ConstructorParameters<typeof Response>[0];
    readonly wait?: Duration.Input;
    readonly retryAfter?: Duration.Input;
    readonly unsupported?: boolean;
  } = {},
) {
  const cachesDir = yield* tempDir;
  const sha256 = options.sha256 ?? createHash("sha256").update(browserArchive).digest("hex");
  const requests: Array<string> = [];
  const fetch: DownloadFetch = async (url) => {
    requests.push(url);
    return new Response(options.body?.() ?? new Uint8Array(browserArchive));
  };
  const browser = yield* makePreviewBrowser({
    cachesDir,
    release: options.unsupported
      ? null
      : {
          version: VERSION,
          platform: "fixture",
          url: "https://downloads.test/chrome-headless-shell-fixture.zip",
          bytes: browserArchive.byteLength,
          sha256,
          unpackedBytes: 1024,
        },
    fetch,
    platform: "linux",
    arch: "x64",
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter }),
  });
  const root = NodePath.join(cachesDir, "preview-browser");
  return {
    browser,
    root,
    requests,
    versionDir: NodePath.join(root, VERSION, "versions", sha256.slice(0, 16)),
    versionsDir: NodePath.join(root, VERSION, "versions"),
  };
});

const listDir = (dir: string) =>
  Effect.promise(() =>
    NodeFS.readdir(dir).then(
      (names) => names.toSorted(),
      () => [] as Array<string>,
    ),
  );

const modeOf = (file: string) =>
  Effect.promise(() => NodeFS.stat(file).then((info) => info.mode & 0o777));

/**
 * A store folder for another pinned version. `leasedBy` is a live process
 * running it; `installing` adds a fresh staging folder, as another server's
 * install in progress has.
 */
const otherVersion = (
  root: string,
  version: string,
  options: { readonly leasedBy?: number; readonly installing?: boolean } = {},
) =>
  Effect.promise(async () => {
    const versions = NodePath.join(root, version, "versions");
    const leases = NodePath.join(versions, "0123456789abcdef", ".leases");
    await NodeFS.mkdir(leases, { recursive: true });
    if (options.leasedBy !== undefined) {
      await NodeFS.writeFile(NodePath.join(leases, `${options.leasedBy}-ab`), "");
    }
    if (options.installing) await NodeFS.mkdir(NodePath.join(versions, ".staging-0a1b2c3d"));
  });

describe.skipIf(process.platform === "win32")("PreviewBrowser", () => {
  it.live(
    "installs a verified download once, keeps its file modes, and drops older unused versions",
    () =>
      Effect.gen(function* () {
        const { browser, root, requests, versionDir } = yield* makeHarness();
        // An older version nobody uses, one another server is running, one
        // another server is installing, and a newer one.
        yield* otherVersion(root, "99.0.0.0");
        yield* otherVersion(root, "98.0.0.0", { leasedBy: process.ppid });
        yield* otherVersion(root, "97.0.0.0", { installing: true });
        yield* otherVersion(root, "101.0.0.0");

        const executable = yield* Effect.scoped(browser.acquire);

        expect(executable).toBe(NodePath.join(versionDir, "chrome-headless-shell"));
        expect(
          yield* Effect.promise(() =>
            NodeFS.readFile(NodePath.join(versionDir, "locales", "en-US.pak"), "utf8"),
          ),
        ).toBe("strings");
        expect(yield* modeOf(executable)).toBe(0o755);
        expect(yield* modeOf(NodePath.join(versionDir, "libEGL.so"))).toBe(0o755);
        expect(yield* modeOf(NodePath.join(versionDir, "locales", "en-US.pak"))).toBe(0o644);
        expect(yield* listDir(root)).toEqual([VERSION, "101.0.0.0", "97.0.0.0", "98.0.0.0"]);

        expect(yield* Effect.scoped(browser.acquire)).toBe(executable);
        expect(yield* Effect.scoped(browser.acquireInstalled)).toEqual(Option.some(executable));
        expect(requests).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.live.each([
    { name: "a hash mismatch", sha256: "0".repeat(64) },
    { name: "a short download", body: () => new Uint8Array(browserArchive.subarray(0, -1)) },
    {
      name: "an oversized download",
      body: () => new Uint8Array(Buffer.concat([browserArchive, Buffer.from("extra")])),
    },
  ])("refuses $name, leaves nothing behind, and starts over on the next call", (testCase) =>
    Effect.gen(function* () {
      const { browser, requests, versionsDir } = yield* makeHarness(testCase);

      const error = yield* Effect.scoped(browser.acquire).pipe(Effect.flip);

      expect(error._tag).toBe("PagePreviewInstallError");
      expect(error.message).toMatch(
        /^Threadlines could not install the browser it previews pages in\. The Chrome for Testing download didn't match the expected release/,
      );
      // No version, and no staging folder.
      expect(yield* listDir(versionsDir)).toEqual([]);
      yield* Effect.scoped(browser.acquire).pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("shares one install between callers and finishes it after they stop waiting", () =>
    Effect.gen(function* () {
      let firstChunkRead!: () => void;
      const firstChunk = new Promise<void>((resolve) => (firstChunkRead = resolve));
      let finishDownload!: () => void;
      const finished = new Promise<void>((resolve) => (finishDownload = resolve));
      const { browser, requests } = yield* makeHarness({
        wait: "30 seconds",
        body: () => {
          let pulls = 0;
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              pulls += 1;
              if (pulls === 1)
                return controller.enqueue(new Uint8Array(browserArchive.subarray(0, 100)));
              // Asked for more: the first chunk has been counted.
              firstChunkRead();
              await finished;
              controller.enqueue(new Uint8Array(browserArchive.subarray(100)));
              controller.close();
            },
          });
        },
      });

      const callers = yield* Effect.forEach([1, 2], () =>
        Effect.forkChild(Effect.scoped(browser.acquire).pipe(Effect.flip)),
      );
      yield* Effect.promise(() => firstChunk);
      yield* TestClock.adjust("30 seconds");
      for (const caller of callers) {
        const error = yield* Fiber.join(caller);
        expect(error).toMatchObject({
          _tag: "PagePreviewInstallingError",
          downloadedBytes: 100,
          unpacking: false,
        });
      }

      // The install belongs to the service, so it outlives the callers that gave up on it.
      finishDownload();
      expect(yield* Effect.scoped(browser.acquire)).toMatch(/chrome-headless-shell$/);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live("measuring starts the install in the background without waiting for it", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness();

      expect(yield* Effect.scoped(browser.acquireInstalled)).toEqual(Option.none());
      // A preview joins the install the measurement started.
      const executable = yield* Effect.scoped(browser.acquire);

      expect(yield* Effect.scoped(browser.acquireInstalled)).toEqual(Option.some(executable));
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("after a failed install, measuring waits before downloading again", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({
        sha256: "0".repeat(64),
        retryAfter: "15 minutes",
      });

      expect(yield* Effect.scoped(browser.acquireInstalled)).toEqual(Option.none());
      // A preview joins the failing install and reports it.
      yield* Effect.scoped(browser.acquire).pipe(Effect.flip);
      expect(requests).toHaveLength(1);

      yield* Effect.scoped(browser.acquireInstalled);
      yield* TestClock.adjust("14 minutes");
      yield* Effect.scoped(browser.acquireInstalled);
      expect(requests).toHaveLength(1);

      yield* TestClock.adjust("1 minute");
      yield* Effect.scoped(browser.acquireInstalled);
      yield* Effect.scoped(browser.acquire).pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("reports hosts Chrome for Testing does not build for without downloading", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({ unsupported: true });

      expect((yield* Effect.scoped(browser.acquire).pipe(Effect.flip))._tag).toBe(
        "PagePreviewUnsupportedError",
      );
      expect(yield* Effect.scoped(browser.acquireInstalled)).toEqual(Option.none());
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("previewBrowserRelease", () => {
  it("pins one Chrome for Testing build per host", () => {
    const hosts = [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
      ["win32", "arm64"],
      ["win32", "ia32"],
      ["linux", "ia32"],
      ["freebsd", "x64"],
    ] as const;
    expect(
      hosts.map(([platform, arch]) => previewBrowserRelease(platform, arch)?.platform),
    ).toEqual([
      "linux64",
      "linux-arm64",
      "mac-arm64",
      "mac-x64",
      "win64",
      "win64",
      "win32",
      undefined,
      undefined,
    ]);
    expect(previewBrowserRelease("darwin", "arm64")).toMatchObject({
      url: "https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/mac-arm64/chrome-headless-shell-mac-arm64.zip",
      bytes: 99_221_129,
    });
  });

  it("tells the agent how far the install has come", () => {
    expect(
      new PagePreviewInstallingError({
        downloadedBytes: 37_200_000,
        totalBytes: 99_221_129,
        unpacking: false,
      }).message,
    ).toBe(
      "Threadlines is installing the browser it previews pages in (37 of 99 MB downloaded). Try the preview again in about a minute.",
    );
  });
});
