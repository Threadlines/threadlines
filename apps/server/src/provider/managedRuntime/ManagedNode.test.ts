// @effect-diagnostics nodeBuiltinImport:off - builds archive fixtures and inspects the installed files
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeTar, type TarEntry } from "../testUtils/archiveFixtures.ts";
import {
  MANAGED_NODE_RELEASE,
  type ManagedNodePlatformRelease,
  makeManagedNode,
  managedNodeReleaseFor,
} from "./ManagedNode.ts";
import type { ManagedInstallProgress } from "./ManagedRuntimeStore.ts";
import type { DownloadFetch } from "./VerifiedDownload.ts";

const VERSION = "1.2.3";

/** A build shaped like an official one: everything inside one folder, `node` a script that answers `--version`. */
function makeFixture(entries?: ReadonlyArray<TarEntry>) {
  const archive = zlib.gzipSync(
    makeTar(
      entries ?? [
        {
          name: `node-v${VERSION}-test/bin/node`,
          data: Buffer.from(`#!/bin/sh\necho v${VERSION}\n`),
          mode: 0o755,
        },
        {
          name: `node-v${VERSION}-test/lib/node_modules/npm/bin/npm-cli.js`,
          data: Buffer.from("// npm\n"),
        },
        {
          name: `node-v${VERSION}-test/bin/npm`,
          type: "2",
          linkname: "../lib/node_modules/npm/bin/npm-cli.js",
        },
      ],
    ),
  );
  const release: ManagedNodePlatformRelease = {
    version: VERSION,
    assetKey: "linux-x64",
    asset: {
      url: "https://downloads.test/node.tar.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
      archiveBytes: archive.length,
      unpackedBytes: 1024,
      kind: "tar.gz",
    },
  };
  return { archive, release };
}

function serving(archive: Buffer) {
  const requests: Array<string> = [];
  const fetch: DownloadFetch = async (url) => {
    requests.push(url);
    return new Response(new Uint8Array(archive));
  };
  return { fetch, requests };
}

const tempToolsDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-node-test-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

describe("managedNodeReleaseFor", () => {
  it("pins one official build per platform, and none where Node publishes none", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "x64"],
    ] as const) {
      const release = managedNodeReleaseFor(platform, arch, "glibc");
      assert.equal(release?.version, MANAGED_NODE_RELEASE.version);
      assert.match(release?.asset.sha256 ?? "", /^[0-9a-f]{64}$/u);
      assert.equal(release?.asset.kind, platform === "win32" ? "zip" : "tar.gz");
    }
    // Alpine and friends: official builds need glibc.
    assert.isUndefined(managedNodeReleaseFor("linux", "x64", "musl"));
    assert.isUndefined(managedNodeReleaseFor("linux", "riscv64", "glibc"));
    assert.isUndefined(managedNodeReleaseFor("freebsd", "x64", "glibc"));
  });
});

describe.skipIf(process.platform === "win32")("makeManagedNode", () => {
  it.live("installs the pinned build once, and hands out where node and npm are", () =>
    Effect.gen(function* () {
      const toolsDir = yield* tempToolsDir;
      const { archive, release } = makeFixture();
      const server = serving(archive);
      const node = makeManagedNode({ toolsDir, release, fetch: server.fetch, platform: "linux" });
      assert.isUndefined(yield* node.installed);

      const progress: Array<ManagedInstallProgress> = [];
      const paths = yield* node.install((update) => progress.push(update));

      const versionDir = path.join(
        toolsDir,
        `${VERSION}-linux-x64`,
        "versions",
        release.asset.sha256.slice(0, 16),
      );
      // The folder that wraps an official build is gone.
      assert.deepStrictEqual(paths, {
        version: VERSION,
        releaseId: release.asset.sha256.slice(0, 16),
        node: path.join(versionDir, "bin", "node"),
        npmCli: path.join(versionDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        binDir: path.join(versionDir, "bin"),
      });
      assert.deepStrictEqual(yield* node.installed, paths);
      assert.equal(
        yield* Effect.promise(() => NodeFS.readlink(path.join(versionDir, "bin", "npm"))),
        "../lib/node_modules/npm/bin/npm-cli.js",
      );
      assert.deepStrictEqual(
        progress
          .map((update) => update.phase)
          .filter((phase, index, all) => phase !== all[index - 1]),
        ["downloading", "extracting", "validating", "activating"],
      );

      // Installing again reuses what is on disk.
      yield* node.install();
      assert.deepStrictEqual(server.requests, [release.asset.url]);

      // A running agent keeps it from being removed.
      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* node.acquire, paths);
          assert.equal((yield* Effect.flip(node.remove)).reason, "io");
        }),
      );
      yield* node.remove;
      assert.isUndefined(yield* node.installed);
    }),
  );

  it.live("installs nothing when the download isn't the pinned build", () =>
    Effect.gen(function* () {
      const toolsDir = yield* tempToolsDir;
      const { archive, release } = makeFixture();
      const tampered = Buffer.from(archive);
      tampered[tampered.length - 9] = tampered[tampered.length - 9]! ^ 0xff;
      const node = makeManagedNode({
        toolsDir,
        release,
        fetch: serving(tampered).fetch,
        platform: "linux",
      });

      assert.equal((yield* Effect.flip(node.install())).reason, "checksum");
      assert.isUndefined(yield* node.installed);
    }),
  );

  it.live("an install stopped while Node is being checked leaves no process and no files", () =>
    Effect.gen(function* () {
      const toolsDir = yield* tempToolsDir;
      const pidFile = path.join(toolsDir, "node.pid");
      // A `node` that hangs, like one waiting on something it will never get.
      const hanging = makeFixture([
        {
          name: "node/bin/node",
          data: Buffer.from(`#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`),
          mode: 0o755,
        },
        { name: "node/lib/node_modules/npm/bin/npm-cli.js", data: Buffer.from("// npm\n") },
      ]);
      const node = makeManagedNode({
        toolsDir,
        release: hanging.release,
        fetch: serving(hanging.archive).fetch,
        platform: "linux",
      });

      const install = yield* node.install().pipe(Effect.forkChild);
      const pid = yield* Effect.promise(async () => {
        for (;;) {
          const written = await NodeFS.readFile(pidFile, "utf8").catch(() => "");
          if (written.trim()) return Number(written);
          await new Promise((done) => setTimeout(done, 10));
        }
      });
      yield* Fiber.interrupt(install);

      // The interrupt returned only once the process had gone.
      assert.throws(() => process.kill(pid, 0));
      const versions = yield* Effect.promise(() =>
        NodeFS.readdir(path.join(toolsDir, `${VERSION}-linux-x64`, "versions")),
      );
      assert.deepStrictEqual(versions, []);
    }),
  );

  it.live("installs nothing when the build doesn't run, or isn't a Node build", () =>
    Effect.gen(function* () {
      const toolsDir = yield* tempToolsDir;
      const wrongVersion = makeFixture([
        { name: "node-v9/bin/node", data: Buffer.from("#!/bin/sh\necho v9.9.9\n"), mode: 0o755 },
        { name: "node-v9/lib/node_modules/npm/bin/npm-cli.js", data: Buffer.from("// npm\n") },
      ]);
      const noNode = makeFixture([{ name: "something/README", data: Buffer.from("hello\n") }]);
      const escaping = makeFixture([
        { name: "node/bin/node", data: Buffer.from("#!/bin/sh\necho v1.2.3\n"), mode: 0o755 },
        { name: "node/../../outside", data: Buffer.from("x") },
      ]);

      for (const [fixture, reason] of [
        [wrongVersion, "validate"],
        [noNode, "archive"],
        [escaping, "archive"],
      ] as const) {
        const node = makeManagedNode({
          toolsDir,
          release: fixture.release,
          fetch: serving(fixture.archive).fetch,
          platform: "linux",
        });
        assert.equal((yield* Effect.flip(node.install())).reason, reason);
        assert.isUndefined(yield* node.installed);
      }
      // Nothing is left behind, staging included.
      const versions = yield* Effect.promise(() =>
        NodeFS.readdir(path.join(toolsDir, `${VERSION}-linux-x64`, "versions")),
      );
      assert.deepStrictEqual(versions, []);
    }),
  );
});
