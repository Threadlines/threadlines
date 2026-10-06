// @effect-diagnostics nodeBuiltinImport:off - builds archive fixtures, a scripted Node.js and a local registry
// @effect-diagnostics preferSchemaOverJson:off - reads lockfiles and writes fixtures as plain JSON
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  type ManagedNode,
  type ManagedNodePaths,
  type ManagedNodePlatformRelease,
  makeManagedNode,
} from "../managedRuntime/ManagedNode.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import { makeTar, makeZip } from "../testUtils/archiveFixtures.ts";
import {
  type AcpRegistryInstallerOptions,
  type AcpRegistryInstallProgress,
  acpRegistryAgentRoot,
  makeAcpRegistryInstaller,
} from "./AcpRegistryInstaller.ts";
import {
  type AcpRegistryDownloadRecipe,
  type AcpRegistryNpmRecipe,
  type AcpRegistryRecipe,
  acpRegistryRecipeDigest,
} from "./AcpRegistryRecipe.ts";

const AGENT_ID = "test-agent";
const LABEL = "Test Agent";
const PROGRAM = Buffer.from("#!/bin/sh\necho agent\n");
const CHUNK_BYTES = 16 * 1024;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const tarGz = (entries: Parameters<typeof makeTar>[0]) => zlib.gzipSync(makeTar(entries));

/** An archive with the program where `downloadRecipe` looks for it; `seed` makes it a different archive. */
const agentArchive = (seed = "a") =>
  tarGz([
    { name: "bin/agent", data: PROGRAM },
    { name: "README", data: Buffer.from(`agent ${seed}\n`) },
  ]);

const downloadRecipe = (
  overrides: Partial<AcpRegistryDownloadRecipe> = {},
): AcpRegistryDownloadRecipe => ({
  kind: "download",
  agentId: AGENT_ID,
  version: "1.0.0",
  args: ["acp"],
  env: {},
  url: "https://downloads.test/agent.tar.gz",
  sha256: null,
  format: "tar.gz",
  cmd: "bin/agent",
  ...overrides,
});

/** Serves bodies from memory in small chunks, with no content-length, like a chunked response. */
function makeServer(initial: Record<string, Buffer> = {}) {
  const bodies = new Map(Object.entries(initial));
  const requests: Array<string> = [];
  const fetch: DownloadFetch = async (url) => {
    requests.push(url);
    const body = bodies.get(url);
    if (!body) return new Response(null, { status: 404 });
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= body.length) {
            controller.close();
            return;
          }
          const chunk = body.subarray(offset, offset + CHUNK_BYTES);
          offset += chunk.length;
          controller.enqueue(new Uint8Array(chunk));
        },
      }),
    );
  };
  return { fetch, requests, serve: (url: string, body: Buffer) => bodies.set(url, body) };
}

/** Sends the first bytes of a download, then stalls until it is cancelled. */
function makeStallingFetch() {
  const state = { cancelled: false };
  const fetch: DownloadFetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(agentArchive().subarray(0, 64)));
        },
        cancel() {
          state.cancelled = true;
        },
      }),
    );
  return { fetch, state };
}

const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-acp-test-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

const listDir = (dir: string) =>
  Effect.promise(() =>
    NodeFS.readdir(dir).then(
      (names) => names.toSorted(),
      () => [] as Array<string>,
    ),
  );

const makeInstaller = (
  dir: string,
  options: Partial<AcpRegistryInstallerOptions> & Pick<AcpRegistryInstallerOptions, "fetch">,
) =>
  makeAcpRegistryInstaller({
    agentId: AGENT_ID,
    label: LABEL,
    toolsDir: path.join(dir, "acp"),
    nodeToolsDir: path.join(dir, "node"),
    nodeRelease: null,
    ...options,
  });

const agentRoot = (dir: string, agentId = AGENT_ID) =>
  acpRegistryAgentRoot(path.join(dir, "acp"), agentId);

const confirmAndInstall = (
  installer: ReturnType<typeof makeAcpRegistryInstaller>,
  recipe: AcpRegistryRecipe,
  onProgress?: (progress: AcpRegistryInstallProgress) => void,
) =>
  installer
    .confirm(recipe)
    .pipe(Effect.andThen(installer.install(acpRegistryRecipeDigest(recipe), onProgress)));

const phasesOf = (progress: ReadonlyArray<AcpRegistryInstallProgress>) =>
  progress.map((update) => update.phase).filter((phase, index, all) => phase !== all[index - 1]);

describe("makeAcpRegistryInstaller: downloads", () => {
  it.live("installs a tar.gz, a zip and a bare program, and says how to launch each", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const cases = [
        {
          recipe: downloadRecipe({ agentId: "agent-tar" }),
          body: agentArchive(),
          phases: ["downloading", "extracting", "validating", "activating"],
        },
        {
          recipe: downloadRecipe({
            agentId: "agent-zip",
            url: "https://downloads.test/agent.zip",
            format: "zip",
            cmd: "dist/agent",
          }),
          // The archive says the program isn't executable; it is made so anyway.
          body: makeZip([{ name: "dist/agent", data: PROGRAM, mode: 0o100644 }]),
          phases: ["downloading", "extracting", "validating", "activating"],
        },
        {
          recipe: downloadRecipe({
            agentId: "agent-raw",
            url: "https://downloads.test/agent",
            format: "raw",
            cmd: "agent",
          }),
          body: PROGRAM,
          phases: ["downloading", "validating", "activating"],
        },
      ];
      const server = makeServer(
        Object.fromEntries(cases.map(({ recipe, body }) => [recipe.url, body])),
      );

      for (const { recipe, body, phases } of cases) {
        const installer = makeInstaller(dir, { agentId: recipe.agentId, fetch: server.fetch });
        assert.isUndefined(yield* installer.installed);
        const progress: Array<AcpRegistryInstallProgress> = [];
        const agent = yield* confirmAndInstall(installer, recipe, (update) =>
          progress.push(update),
        );

        const digest = acpRegistryRecipeDigest(recipe);
        // The folder is named by hashes, never by what the registry calls the agent.
        const root = path.join(dir, "acp", sha256(Buffer.from(recipe.agentId)).slice(0, 16));
        const payloadDir = path.join(root, "versions", digest.slice(0, 16), "payload");
        assert.equal(agent.payloadDir, payloadDir, recipe.format);
        assert.deepStrictEqual(agent.launch, {
          program: path.join(payloadDir, ...recipe.cmd.split("/")),
          prefixArgs: [],
          needsShell: false,
        });
        assert.isNull(agent.node);
        assert.deepStrictEqual(
          {
            recipe: agent.receipt.recipe,
            recipeDigest: agent.receipt.recipeDigest,
            archiveSha256: agent.receipt.archiveSha256,
            verification: agent.receipt.verification,
          },
          {
            recipe,
            recipeDigest: digest,
            archiveSha256: sha256(body),
            verification: "firstInstall",
          },
        );
        assert.isTrue(
          (yield* Effect.promise(() => NodeFS.readFile(agent.launch.program))).equals(PROGRAM),
        );
        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => NodeFS.stat(agent.launch.program));
          assert.equal(stats.mode & 0o777, 0o755, recipe.format);
        }
        assert.deepStrictEqual(yield* installer.installed, agent);
        assert.deepStrictEqual(phasesOf(progress), phases, recipe.format);
        // Staging and the lock are gone.
        assert.deepStrictEqual(yield* listDir(root), ["active.json", "trust.json", "versions"]);
        assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), [digest.slice(0, 16)]);
      }
    }),
  );

  it.live("checks a download against the checksum its publisher lists", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const body = agentArchive();
      const server = makeServer({ "https://downloads.test/agent.tar.gz": body });
      const installer = makeInstaller(dir, { fetch: server.fetch });

      const wrong = downloadRecipe({ version: "0.9.0", sha256: sha256(Buffer.from("other")) });
      const error = yield* Effect.flip(confirmAndInstall(installer, wrong));
      assert.equal(error.reason, "checksum");
      assert.isUndefined(yield* installer.installed);
      assert.deepStrictEqual(yield* listDir(path.join(agentRoot(dir), "versions")), []);

      const right = downloadRecipe({ sha256: sha256(body).toUpperCase() });
      const agent = yield* confirmAndInstall(installer, right);
      assert.equal(agent.receipt.verification, "publisher");
    }),
  );

  it.live("holds every later install of a recipe to the download its first install got", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const digest = acpRegistryRecipeDigest(recipe);
      const original = agentArchive("original");
      const server = makeServer({ [recipe.url]: original });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const versionDir = path.join(agentRoot(dir), "versions", digest.slice(0, 16));
      const first = yield* confirmAndInstall(installer, recipe);

      // The publisher's address now serves something else.
      server.serve(recipe.url, agentArchive("changed"));
      // A copy that is complete on disk is reused, not downloaded again.
      yield* installer.install(digest);
      assert.lengthOf(server.requests, 1);

      // A damaged copy is installed again, and the download is no longer the same.
      yield* Effect.promise(() => NodeFS.rm(first.launch.program));
      assert.isUndefined(yield* installer.installed);
      const changed = yield* Effect.flip(installer.install(digest));
      assert.equal(changed.reason, "checksum");
      assert.equal(
        changed.message,
        "The Test Agent download changed since you installed it, so nothing was installed.",
      );

      // Deleting the version by hand doesn't make it a first install again.
      yield* Effect.promise(() => NodeFS.rm(versionDir, { recursive: true, force: true }));
      assert.equal((yield* Effect.flip(installer.install(digest))).reason, "checksum");
      assert.isUndefined(yield* installer.installed);

      server.serve(recipe.url, original);
      const again = yield* installer.install(digest);
      assert.equal(again.receipt.archiveSha256, sha256(original));
    }),
  );

  it.live("a recipe is unconfirmed without its trust record, whatever is on disk", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const digest = acpRegistryRecipeDigest(recipe);
      const original = agentArchive("original");
      const server = makeServer({ [recipe.url]: original });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const root = agentRoot(dir);

      // Never confirmed: refused, and nothing is created for it.
      const never = yield* Effect.flip(installer.install(digest));
      assert.equal(never.reason, "validate");
      assert.isFalse(existsSync(root));
      assert.lengthOf(server.requests, 0);

      yield* confirmAndInstall(installer, recipe);
      assert.deepStrictEqual(
        (yield* installer.confirmed).map((entry) => entry.recipeDigest),
        [digest],
      );

      // The record is lost; the version folder is still there.
      yield* Effect.promise(() => NodeFS.rm(path.join(root, "trust.json")));
      assert.deepStrictEqual(yield* installer.confirmed, []);
      assert.equal((yield* Effect.flip(installer.install(digest))).reason, "validate");

      // Confirmed again, the copy on disk is what later installs are held to.
      yield* confirmAndInstall(installer, recipe);
      server.serve(recipe.url, agentArchive("changed"));
      yield* Effect.promise(() =>
        NodeFS.rm(path.join(root, "versions"), { recursive: true, force: true }),
      );
      assert.equal((yield* Effect.flip(installer.install(digest))).reason, "checksum");
    }),
  );

  it.live("a lost trust record and a damaged copy don't add up to a first install", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const digest = acpRegistryRecipeDigest(recipe);
      const server = makeServer({ [recipe.url]: agentArchive("original") });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const root = agentRoot(dir);
      const first = yield* confirmAndInstall(installer, recipe);

      // The record is gone, the program is gone, and the address serves something else.
      yield* Effect.promise(() => NodeFS.rm(path.join(root, "trust.json")));
      yield* Effect.promise(() => NodeFS.rm(first.launch.program));
      server.serve(recipe.url, agentArchive("changed"));

      // The receipt still says what was installed, and the new record starts from it.
      yield* installer.confirm(recipe);
      const changed = yield* Effect.flip(installer.install(digest));
      assert.equal(changed.reason, "checksum");
      assert.isUndefined(yield* installer.installed);

      // A version folder that can't say what it held is not "never installed" either.
      yield* Effect.promise(() => NodeFS.rm(path.join(root, "trust.json")));
      yield* Effect.promise(() =>
        NodeFS.writeFile(
          path.join(root, "versions", digest.slice(0, 16), ".install-complete.json"),
          "{}",
        ),
      );
      const unreadable = yield* Effect.flip(installer.confirm(recipe));
      assert.equal(unreadable.reason, "validate");
      assert.equal(
        unreadable.message,
        "Test Agent's files changed since they were installed. Remove Test Agent and add it again.",
      );
      assert.deepStrictEqual(yield* installer.confirmed, []);
    }),
  );

  it.live("a trust record with one bad entry is never rewritten as if it were empty", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const v1 = downloadRecipe({ version: "1.0.0", url: "https://downloads.test/v1.tar.gz" });
      const v2 = downloadRecipe({ version: "2.0.0", url: "https://downloads.test/v2.tar.gz" });
      const server = makeServer({ [v1.url]: agentArchive("1"), [v2.url]: agentArchive("2") });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const trustFile = path.join(agentRoot(dir), "trust.json");
      yield* confirmAndInstall(installer, v1);

      const record = JSON.parse(yield* Effect.promise(() => NodeFS.readFile(trustFile, "utf8")));
      const damaged = `${JSON.stringify({ ...record, recipes: [...record.recipes, { recipeDigest: 7 }] })}\n`;
      yield* Effect.promise(() => NodeFS.writeFile(trustFile, damaged));

      const refused = yield* Effect.flip(installer.confirm(v2));
      assert.equal(refused.reason, "validate");
      assert.equal(
        refused.message,
        "Threadlines' record of what was installed for Test Agent is damaged. Remove Test Agent and add it again.",
      );
      assert.equal(
        (yield* Effect.flip(installer.install(acpRegistryRecipeDigest(v1)))).reason,
        "validate",
      );
      // Nothing was written over it, and what is installed keeps running.
      assert.equal(yield* Effect.promise(() => NodeFS.readFile(trustFile, "utf8")), damaged);
      assert.equal((yield* installer.installed)?.receipt.recipe.version, "1.0.0");

      // Removing the agent is the way out.
      yield* installer.remove;
      assert.equal((yield* confirmAndInstall(installer, v2)).receipt.recipe.version, "2.0.0");
    }),
  );

  it.live("refuses recipes and downloads that could put a program somewhere else", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const missing = downloadRecipe({ version: "1", url: "https://downloads.test/missing.tgz" });
      const linked = downloadRecipe({ version: "2", url: "https://downloads.test/linked.tgz" });
      const server = makeServer({
        [missing.url]: tarGz([{ name: "README", data: Buffer.from("no program\n") }]),
        [linked.url]: tarGz([
          { name: "bin/real", data: PROGRAM, mode: 0o755 },
          { name: "bin/agent", type: "2", linkname: "real" },
        ]),
      });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      // Unpacking a link needs a privilege most Windows accounts don't have.
      const refused = process.platform === "win32" ? [missing] : [missing, linked];

      for (const recipe of refused) {
        const error = yield* Effect.flip(confirmAndInstall(installer, recipe));
        assert.equal(error.reason, "archive", recipe.url);
      }
      assert.isUndefined(yield* installer.installed);
      assert.deepStrictEqual(yield* listDir(path.join(agentRoot(dir), "versions")), []);

      // These are never recorded, so they can never be installed.
      for (const recipe of [
        downloadRecipe({ cmd: "../agent" }),
        downloadRecipe({ url: "http://downloads.test/agent.tar.gz" }),
        downloadRecipe({ agentId: "another-agent" }),
        downloadRecipe({ format: "raw", cmd: "bin/agent" }),
      ]) {
        assert.equal((yield* Effect.flip(installer.confirm(recipe))).reason, "validate");
      }
      assert.lengthOf(yield* installer.confirmed, refused.length);
    }),
  );

  it.live("stops a download that is larger than allowed, or takes too long", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const digest = acpRegistryRecipeDigest(recipe);
      const server = makeServer({ [recipe.url]: Buffer.alloc(256 * 1024) });
      const versionsDir = path.join(agentRoot(dir), "versions");

      const capped = makeInstaller(dir, {
        fetch: server.fetch,
        limits: { maxDownloadBytes: 20 * 1024 },
      });
      const tooLarge = yield* Effect.flip(confirmAndInstall(capped, recipe));
      assert.equal(tooLarge.reason, "download");
      assert.include(tooLarge.message, "larger than");
      assert.deepStrictEqual(yield* listDir(versionsDir), []);

      const stalling = makeStallingFetch();
      const timed = makeInstaller(dir, {
        fetch: stalling.fetch,
        limits: { downloadTimeoutMs: 50 },
      });
      const tooSlow = yield* Effect.flip(timed.install(digest));
      assert.equal(tooSlow.reason, "download");
      assert.include(tooSlow.message, "took too long");
      assert.isTrue(stalling.state.cancelled);
      assert.deepStrictEqual(yield* listDir(versionsDir), []);
    }),
  );

  it.live("interrupting a download cancels it and leaves nothing behind", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const stalling = makeStallingFetch();
      const installer = makeInstaller(dir, { fetch: stalling.fetch });
      const root = agentRoot(dir);
      yield* installer.confirm(recipe);
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const fiber = yield* installer
        .install(acpRegistryRecipeDigest(recipe), (update) => {
          if (update.phase === "downloading" && update.receivedBytes) markStarted();
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(stalling.state.cancelled);
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), []);
      // Only the record of what was confirmed is left: no lock, no active version.
      assert.deepStrictEqual(yield* listDir(root), ["trust.json", "versions"]);
    }),
  );

  it.live("two installers of one agent at once end with one good version", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const digest = acpRegistryRecipeDigest(recipe);
      const server = makeServer({ [recipe.url]: agentArchive() });
      // Two installers share no memory, like two Threadlines servers on one folder.
      const one = makeInstaller(dir, { fetch: server.fetch });
      const other = makeInstaller(dir, { fetch: server.fetch });
      yield* one.confirm(recipe);

      const [first, second] = yield* Effect.all([one.install(digest), other.install(digest)], {
        concurrency: "unbounded",
      });

      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual(yield* other.installed, first);
      // The second waited for the first's lock and reused its files.
      assert.lengthOf(server.requests, 1);
      const root = agentRoot(dir);
      assert.deepStrictEqual(yield* listDir(root), ["active.json", "trust.json", "versions"]);
      assert.deepStrictEqual(yield* listDir(path.join(root, "versions")), [digest.slice(0, 16)]);
    }),
  );

  it.live(
    "waits out a running install elsewhere, and takes over a lock whose process is gone",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const recipe = downloadRecipe();
        const digest = acpRegistryRecipeDigest(recipe);
        const server = makeServer({ [recipe.url]: agentArchive() });
        const installer = makeInstaller(dir, { fetch: server.fetch, limits: { lockWaitMs: 150 } });
        const token = "00000000000000aa";
        const lockFile = path.join(agentRoot(dir), `install.lock.${token}`);
        yield* installer.confirm(recipe);
        const writeLock = (pid: number, createdAt = Date.now()) =>
          Effect.promise(() =>
            NodeFS.writeFile(lockFile, JSON.stringify({ pid, startedAt: 1, createdAt, token })),
          );
        const locks = listDir(agentRoot(dir)).pipe(
          Effect.map((names) => names.filter((name) => name.startsWith("install.lock"))),
        );

        // Another live process (the one that started this test run) holds the lock.
        yield* writeLock(process.ppid);
        const busy = yield* Effect.flip(installer.install(digest));
        assert.equal(
          busy.message,
          "Test Agent is being installed by another Threadlines window. Try again in a moment.",
        );
        assert.lengthOf(server.requests, 0);
        // Its lock is untouched, and the attempts that gave way left none of their own.
        assert.deepStrictEqual(yield* locks, [`install.lock.${token}`]);

        // A lock from before this computer last started: that pid is something else now.
        yield* writeLock(process.ppid, 1);
        yield* installer.install(digest);
        assert.deepStrictEqual(yield* locks, []);

        // Its owner is gone: the lock is stale.
        const deadPid = 2_147_483_646;
        assert.throws(() => process.kill(deadPid, 0));
        yield* writeLock(deadPid);
        yield* Effect.promise(() =>
          NodeFS.rm(path.join(agentRoot(dir), "versions"), { recursive: true, force: true }),
        );
        yield* installer.install(digest);
        assert.deepStrictEqual(yield* locks, []);
      }),
  );

  it.live("an update switches versions, and the old one goes once nothing leases it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const v1 = downloadRecipe({ version: "1.0.0", url: "https://downloads.test/v1.tar.gz" });
      const v2 = downloadRecipe({ version: "2.0.0", url: "https://downloads.test/v2.tar.gz" });
      const v3 = downloadRecipe({ version: "3.0.0", url: "https://downloads.test/v3.tar.gz" });
      const server = makeServer({
        [v1.url]: agentArchive("1"),
        [v2.url]: agentArchive("2"),
        [v3.url]: agentArchive("3"),
      });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const versionsDir = path.join(agentRoot(dir), "versions");
      const id = (recipe: AcpRegistryRecipe) => acpRegistryRecipeDigest(recipe).slice(0, 16);
      yield* confirmAndInstall(installer, v1);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const running = yield* installer.acquire;
          assert.equal(running.receipt.recipe.version, "1.0.0");
          const updated = yield* confirmAndInstall(installer, v2);
          assert.equal(updated.receipt.recipe.version, "2.0.0");
          assert.equal((yield* installer.installed)?.receipt.recipe.version, "2.0.0");
          // The session on 1.0.0 keeps its files.
          assert.isTrue(existsSync(running.launch.program));
          assert.deepStrictEqual(yield* listDir(versionsDir), [id(v1), id(v2)].toSorted());
        }),
      );
      yield* installer.prune;
      assert.deepStrictEqual(yield* listDir(versionsDir), [id(v2)]);

      // With nothing running, the update itself drops the old version.
      yield* confirmAndInstall(installer, v3);
      assert.deepStrictEqual(yield* listDir(versionsDir), [id(v3)]);
      assert.deepStrictEqual(
        (yield* installer.confirmed).map((entry) => entry.recipe.version),
        ["1.0.0", "2.0.0", "3.0.0"],
      );
    }),
  );

  it.live("the trust record keeps the installed recipe and the newest eight", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipes = Array.from({ length: 10 }, (_, index) =>
        downloadRecipe({
          version: `${index + 1}.0.0`,
          url: `https://downloads.test/v${index + 1}.tar.gz`,
        }),
      );
      const [installedRecipe, dropped] = recipes;
      assert.isDefined(installedRecipe);
      assert.isDefined(dropped);
      const server = makeServer({ [installedRecipe.url]: agentArchive() });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      yield* confirmAndInstall(installer, installedRecipe);
      for (const recipe of recipes.slice(1)) yield* installer.confirm(recipe);

      assert.deepStrictEqual(
        (yield* installer.confirmed).map((entry) => entry.recipe.version),
        ["1.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0", "7.0.0", "8.0.0", "9.0.0", "10.0.0"],
      );
      // What fell off the end has to be confirmed again.
      const unconfirmed = yield* Effect.flip(installer.install(acpRegistryRecipeDigest(dropped)));
      assert.equal(unconfirmed.reason, "validate");
    }),
  );

  it.live("remove refuses while a session leases the agent, then deletes everything", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const recipe = downloadRecipe();
      const server = makeServer({ [recipe.url]: agentArchive() });
      const installer = makeInstaller(dir, { fetch: server.fetch });
      const root = agentRoot(dir);
      yield* confirmAndInstall(installer, recipe);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installer.acquire;
          assert.equal((yield* Effect.flip(installer.remove)).reason, "io");
          assert.isDefined(yield* installer.installed);
          assert.lengthOf(yield* installer.confirmed, 1);
        }),
      );

      yield* installer.remove;
      assert.isFalse(existsSync(root));
      assert.isUndefined(yield* installer.installed);
      assert.deepStrictEqual(yield* installer.confirmed, []);
      // With its record gone, the recipe has to be confirmed again.
      const error = yield* Effect.flip(installer.install(acpRegistryRecipeDigest(recipe)));
      assert.equal(error.reason, "validate");
    }),
  );
});

const NODE_VERSION = "1.2.3";

interface FakePackage {
  readonly name: string;
  readonly bin?: unknown;
  /** Files inside the package, by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** The package's `engines.node`. */
  readonly engines?: string;
  /** Bin names npm would write a `.cmd` for. */
  readonly cmdShims?: ReadonlyArray<string>;
}

const npmRecipe = (packageName: string, agentId = AGENT_ID): AcpRegistryNpmRecipe => ({
  kind: "npm",
  agentId,
  version: "1.0.0",
  args: ["--acp"],
  env: {},
  packageName,
  packageVersion: "1.0.0",
});

/**
 * A Node.js release whose `node` is a script: it answers `--version`, and
 * plays npm from the files in a scenario folder (`view` prints `view.json`,
 * `install` copies `tree/` into the prefix, `ci` copies its `node_modules`;
 * an `install-fails` or `install-hangs` file makes `install` do that).
 * It is installed for real, into a Node store of its own.
 */
const makeNpmWorld = (platform: "linux" | "win32" = "linux") =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    const scenario = path.join(dir, "npm");
    const tree = path.join(scenario, "tree");
    const script = `#!/bin/sh
scenario='${scenario}'
if [ "$1" = "--version" ]; then echo "v${NODE_VERSION}"; exit 0; fi
shift
if [ "$1" = "--version" ]; then echo "11.0.0"; exit 0; fi
command="$1"
echo "$*" >> "$scenario/calls.log"
printf '%s' "$PATH" > "$scenario/path.txt"
printf '%s' "\${NODE_OPTIONS-unset}" > "$scenario/node-options.txt"
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
case "$command" in
  view)
    /bin/cat "$scenario/view.json"
    ;;
  install)
    if [ -f "$scenario/install-hangs" ]; then
      /bin/sleep 60 &
      echo "$$ $!" > "$scenario/pids.txt"
      wait
    fi
    if [ -f "$scenario/install-fails" ]; then
      echo "npm error code E404"
      echo "npm error 404 Not Found - GET https://registry.npmjs.org/nope" >&2
      exit 1
    fi
    echo "added 1 package in 1s"
    /bin/cp -R "$scenario/tree/." "$prefix/"
    ;;
  ci)
    /bin/cp "$prefix/package.json" "$scenario/ci-package.json" || exit 1
    /bin/cp "$prefix/package-lock.json" "$scenario/ci-package-lock.json" || exit 1
    /bin/cp -R "$scenario/tree/node_modules" "$prefix/"
    ;;
esac
`;
    const layout =
      platform === "win32"
        ? { node: "node.exe", npmCli: "node_modules/npm/bin/npm-cli.js" }
        : { node: "bin/node", npmCli: "lib/node_modules/npm/bin/npm-cli.js" };
    const archive = tarGz([
      { name: `node/${layout.node}`, data: Buffer.from(script), mode: 0o755 },
      { name: `node/${layout.npmCli}`, data: Buffer.from("// npm\n") },
    ]);
    const release: ManagedNodePlatformRelease = {
      version: NODE_VERSION,
      assetKey: "linux-x64",
      asset: {
        url: "https://downloads.test/node.tar.gz",
        sha256: sha256(archive),
        archiveBytes: archive.length,
        unpackedBytes: 1024,
        kind: "tar.gz",
      },
    };
    const server = makeServer({ [release.asset.url]: archive });
    const node = makeManagedNode({
      toolsDir: path.join(dir, "node"),
      release,
      fetch: server.fetch,
      platform,
    });
    yield* Effect.promise(() => NodeFS.mkdir(tree, { recursive: true }));

    const writePackage = (fake: FakePackage) =>
      Effect.promise(async () => {
        const packageDir = path.join(tree, "node_modules", ...fake.name.split("/"));
        await NodeFS.rm(tree, { recursive: true, force: true });
        await NodeFS.mkdir(packageDir, { recursive: true });
        await NodeFS.writeFile(
          path.join(tree, "package.json"),
          `${JSON.stringify({ dependencies: { [fake.name]: "1.0.0" } })}\n`,
        );
        await NodeFS.writeFile(
          path.join(tree, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${fake.name}`]: {} } })}\n`,
        );
        await NodeFS.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: fake.name, version: "1.0.0", bin: fake.bin }),
        );
        for (const [file, contents] of Object.entries(fake.files ?? {})) {
          await NodeFS.mkdir(path.dirname(path.join(packageDir, file)), { recursive: true });
          await NodeFS.writeFile(path.join(packageDir, file), contents, { mode: 0o644 });
        }
        for (const name of fake.cmdShims ?? []) {
          await NodeFS.mkdir(path.join(tree, "node_modules", ".bin"), { recursive: true });
          await NodeFS.writeFile(path.join(tree, "node_modules", ".bin", `${name}.cmd`), "@echo\n");
        }
        await NodeFS.writeFile(
          path.join(scenario, "view.json"),
          JSON.stringify({
            name: fake.name,
            version: "1.0.0",
            engines: { node: fake.engines ?? ">=1" },
          }),
        );
      });

    return {
      dir,
      scenario,
      tree,
      node,
      writePackage,
      /** The npm commands run so far, as `<command> <arguments>`. */
      calls: Effect.promise(() =>
        NodeFS.readFile(path.join(scenario, "calls.log"), "utf8").then(
          (log) => log.trim().split("\n"),
          () => [] as Array<string>,
        ),
      ),
      installer: (agentId = AGENT_ID, options: Partial<AcpRegistryInstallerOptions> = {}) =>
        makeInstaller(dir, {
          agentId,
          fetch: server.fetch,
          platform,
          nodeRelease: release,
          makeNode: () => node,
          ...options,
        }),
    };
  });

describe.skipIf(process.platform === "win32")("makeAcpRegistryInstaller: npm", () => {
  it.live("installs a package with the managed Node.js, and runs it with that Node.js", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      yield* world.writePackage({
        name: "@scope/tool",
        bin: { tool: "dist/cli.js" },
        files: { "dist/cli.js": "console.log('agent')\n" },
      });
      const recipe = npmRecipe("@scope/tool");
      const digest = acpRegistryRecipeDigest(recipe);
      const installer = world.installer(AGENT_ID, {
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=64" },
      });
      const progress: Array<AcpRegistryInstallProgress> = [];

      const agent = yield* confirmAndInstall(installer, recipe, (update) => progress.push(update));

      const node = yield* world.node.installed;
      assert.isDefined(node);
      const payloadDir = path.join(
        agentRoot(world.dir),
        "versions",
        digest.slice(0, 16),
        "payload",
      );
      assert.deepStrictEqual(agent.launch, {
        program: node?.node,
        prefixArgs: [path.join(payloadDir, "node_modules", "@scope", "tool", "dist", "cli.js")],
        needsShell: false,
      });
      assert.deepStrictEqual(agent.node, node);
      assert.equal(agent.receipt.verification, "packageRegistry");
      assert.deepStrictEqual(
        { version: agent.receipt.node?.version, releaseId: agent.receipt.node?.releaseId },
        { version: NODE_VERSION, releaseId: node?.releaseId },
      );
      assert.deepStrictEqual(yield* installer.installed, agent);

      // npm ran as `node npm-cli.js`, asked about the package first, and
      // installed it locally with a lockfile whatever the user's settings say.
      const [view, install = "", ...rest] = yield* world.calls;
      assert.equal(view, "view @scope/tool@1.0.0 name version engines --json --no-update-notifier");
      assert.match(
        install,
        /^install --prefix \S+\/versions\/\.staging-[0-9a-f]+\/r\/payload @scope\/tool@1\.0\.0 /u,
      );
      for (const flag of [
        "--global=false",
        "--package-lock=true",
        "--save=true",
        "--save-exact",
        "--no-audit",
        "--no-fund",
      ]) {
        assert.include(install.split(" "), flag);
      }
      // What a user's npm settings could leave out of the tree is installed regardless.
      for (const flag of ["--include=optional", "--include=peer", "--legacy-peer-deps=false"]) {
        assert.include(install.split(" "), flag);
      }
      assert.deepStrictEqual(rest, []);
      const read = (file: string) =>
        Effect.promise(() => NodeFS.readFile(path.join(world.scenario, file), "utf8"));
      // The managed Node.js comes first on PATH, and the server's own Node flags stay behind.
      assert.isTrue((yield* read("path.txt")).startsWith(`${node?.binDir}${path.delimiter}`));
      assert.equal(yield* read("node-options.txt"), "unset");
      assert.deepStrictEqual(phasesOf(progress), [
        "downloading",
        "extracting",
        "validating",
        "activating",
        "installing",
        "validating",
        "activating",
      ]);
      assert.deepInclude(progress, { phase: "installing", line: "added 1 package in 1s" });

      // A running agent holds its version and its Node.js.
      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* installer.acquire, agent);
          assert.equal((yield* Effect.flip(world.node.remove)).reason, "io");
          assert.equal((yield* Effect.flip(installer.remove)).reason, "io");
        }),
      );

      // Without its Node.js the agent can't start: it isn't installed, and installing again repairs it.
      yield* world.node.remove;
      assert.isUndefined(yield* installer.installed);
      assert.equal((yield* Effect.scoped(Effect.flip(installer.acquire))).reason, "notInstalled");
      assert.deepStrictEqual(yield* installer.install(digest), agent);
    }),
  );

  it.live(
    "installing a recipe again runs npm ci from the first install's manifest and lockfile",
    () =>
      Effect.gen(function* () {
        const world = yield* makeNpmWorld();
        yield* world.writePackage({
          name: "tool",
          bin: "cli.js",
          files: { "cli.js": "console.log('agent')\n" },
        });
        const recipe = npmRecipe("tool");
        const digest = acpRegistryRecipeDigest(recipe);
        const installer = world.installer();
        const first = yield* confirmAndInstall(installer, recipe);
        const read = (file: string) => Effect.promise(() => NodeFS.readFile(file, "utf8"));
        const manifest = yield* read(path.join(world.tree, "package.json"));
        const lock = yield* read(path.join(world.tree, "package-lock.json"));

        // The registry would resolve differently today; the saved lockfile decides.
        yield* Effect.promise(() =>
          NodeFS.writeFile(path.join(world.tree, "package-lock.json"), '{"lockfileVersion":3}\n'),
        );
        yield* Effect.promise(() =>
          NodeFS.rm(path.join(agentRoot(world.dir), "versions"), { recursive: true, force: true }),
        );
        const again = yield* installer.install(digest);

        const calls = yield* world.calls;
        assert.lengthOf(calls, 3);
        const ci = (calls[2] ?? "").split(" ");
        assert.deepStrictEqual(ci.slice(0, 2), ["ci", "--prefix"]);
        assert.include(ci, "--package-lock=true");
        assert.include(ci, "--global=false");
        // The whole tree the lockfile names, whatever the user's npm settings leave out.
        for (const flag of ["--include=optional", "--include=peer", "--dry-run=false"]) {
          assert.include(ci, flag);
        }
        assert.equal(yield* read(path.join(world.scenario, "ci-package.json")), manifest);
        assert.equal(yield* read(path.join(world.scenario, "ci-package-lock.json")), lock);
        assert.equal(yield* read(path.join(again.payloadDir, "package-lock.json")), lock);
        assert.deepStrictEqual(
          { ...again.receipt, installedAt: "" },
          { ...first.receipt, installedAt: "" },
        );
      }),
  );

  it.live("picks the package's program by its only bin, the package's name, then the agent's", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      const files = { "a.js": "", "b.js": "", "main.js": "" };
      const cases: ReadonlyArray<{
        readonly agentId: string;
        readonly fake: FakePackage;
        readonly script: string;
      }> = [
        {
          agentId: "only-bin",
          fake: { name: "pkg", bin: { other: "a.js" }, files },
          script: "a.js",
        },
        {
          agentId: "string-bin",
          fake: { name: "pkg", bin: "./main.js", files },
          script: "main.js",
        },
        {
          agentId: "package-name",
          fake: {
            name: "@scope/pkg",
            bin: { a: "a.js", pkg: "main.js", "package-name": "b.js" },
            files,
          },
          script: "main.js",
        },
        {
          agentId: "agent-name",
          fake: { name: "pkg", bin: { a: "a.js", "agent-name": "main.js" }, files },
          script: "main.js",
        },
      ];
      for (const { agentId, fake, script } of cases) {
        yield* world.writePackage(fake);
        const agent = yield* confirmAndInstall(
          world.installer(agentId),
          npmRecipe(fake.name, agentId),
        );
        assert.equal(
          agent.launch.prefixArgs[0],
          path.join(agent.payloadDir, "node_modules", ...fake.name.split("/"), script),
          agentId,
        );
      }

      const refused: ReadonlyArray<{ readonly agentId: string; readonly fake: FakePackage }> = [
        { agentId: "ambiguous", fake: { name: "pkg", bin: { a: "a.js", b: "b.js" }, files } },
        { agentId: "no-bin", fake: { name: "pkg", files } },
        { agentId: "bin-outside", fake: { name: "pkg", bin: "../../package.json", files } },
        { agentId: "bin-missing", fake: { name: "pkg", bin: "gone.js", files } },
      ];
      for (const { agentId, fake } of refused) {
        yield* world.writePackage(fake);
        const installer = world.installer(agentId);
        const error = yield* Effect.flip(
          confirmAndInstall(installer, npmRecipe(fake.name, agentId)),
        );
        assert.equal(error.reason, "validate", agentId);
        assert.include(error.message, "package", agentId);
        assert.isUndefined(yield* installer.installed);
        assert.deepStrictEqual(
          yield* listDir(path.join(agentRoot(world.dir, agentId), "versions")),
          [],
        );
      }
    }),
  );

  it.live("runs a script for Node.js with the managed node, and any other program directly", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      const launchOf = (agentId: string, file: string, contents: string) =>
        Effect.gen(function* () {
          yield* world.writePackage({
            name: "pkg",
            bin: { pkg: file },
            files: { [file]: contents },
          });
          const agent = yield* confirmAndInstall(
            world.installer(agentId),
            npmRecipe("pkg", agentId),
          );
          return { agent, file: path.join(agent.payloadDir, "node_modules", "pkg", file) };
        });
      const node = (yield* world.node.install()).node;

      for (const [agentId, file, contents] of [
        ["by-extension", "cli.mjs", "export {}\n"],
        ["by-shebang", "bin/cli", "#!/usr/bin/env node\nconsole.log('agent')\n"],
        ["by-env-flags", "bin/cli", "#!/usr/bin/env -S node --no-warnings\n"],
      ] as const) {
        const { agent, file: script } = yield* launchOf(agentId, file, contents);
        assert.deepStrictEqual(
          agent.launch,
          { program: node, prefixArgs: [script], needsShell: false },
          agentId,
        );
      }

      for (const [agentId, file, contents] of [
        ["native", "bin/tool", "\u007fELF not really\n"],
        ["shell-script", "bin/tool", '#!/bin/sh\nexec node-gyp "$@"\n'],
      ] as const) {
        const { agent, file: program } = yield* launchOf(agentId, file, contents);
        assert.deepStrictEqual(
          agent.launch,
          { program, prefixArgs: [], needsShell: false },
          agentId,
        );
        // It is still an npm agent: its PATH gets the managed Node.js.
        assert.equal(agent.node?.node, node);
        const stats = yield* Effect.promise(() => NodeFS.stat(program));
        assert.equal(stats.mode & 0o777, 0o755, agentId);
      }
    }),
  );

  it.live(
    "on Windows, a program Node.js doesn't run starts through npm's .cmd, with the shell",
    () =>
      Effect.gen(function* () {
        const world = yield* makeNpmWorld("win32");
        yield* world.writePackage({
          name: "@scope/pkg",
          bin: { droid: "bin/droid" },
          files: { "bin/droid": '#!/bin/sh\nexec droid-native "$@"\n' },
          cmdShims: ["droid"],
        });
        const native = yield* confirmAndInstall(
          world.installer("native"),
          npmRecipe("@scope/pkg", "native"),
        );
        assert.deepStrictEqual(native.launch, {
          program: path.join(native.payloadDir, "node_modules", ".bin", "droid.cmd"),
          prefixArgs: [],
          needsShell: true,
        });
        assert.equal(native.receipt.program.path, "node_modules/@scope/pkg/bin/droid");

        // A script for Node.js still runs with node.exe and no shell.
        yield* world.writePackage({
          name: "pkg",
          bin: { pkg: "cli.js" },
          files: { "cli.js": "" },
          cmdShims: ["pkg"],
        });
        const script = yield* confirmAndInstall(
          world.installer("script"),
          npmRecipe("pkg", "script"),
        );
        assert.deepStrictEqual(script.launch, {
          program: (yield* world.node.install()).node,
          prefixArgs: [path.join(script.payloadDir, "node_modules", "pkg", "cli.js")],
          needsShell: false,
        });

        // No `.cmd` to start it with: refused.
        yield* world.writePackage({
          name: "pkg",
          bin: { pkg: "bin/tool" },
          files: { "bin/tool": "#!/bin/sh\n" },
        });
        const error = yield* Effect.flip(
          confirmAndInstall(world.installer("no-shim"), npmRecipe("pkg", "no-shim")),
        );
        assert.equal(error.reason, "validate");
      }),
  );

  it.live("refuses a package that needs another Node.js, before npm installs anything", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      yield* world.writePackage({
        name: "pkg",
        bin: "cli.js",
        files: { "cli.js": "" },
        engines: ">=22.19 <23 || >=24 <27",
      });
      const installer = world.installer();

      const error = yield* Effect.flip(confirmAndInstall(installer, npmRecipe("pkg")));

      assert.equal(error.reason, "unsupportedPlatform");
      assert.equal(
        error.message,
        "Test Agent needs Node.js >=22.19 <23 || >=24 <27, and Threadlines installs 1.2.3.",
      );
      assert.deepStrictEqual(yield* world.calls, [
        "view pkg@1.0.0 name version engines --json --no-update-notifier",
      ]);
      assert.deepStrictEqual(yield* listDir(path.join(agentRoot(world.dir), "versions")), []);

      // A computer Node.js publishes no build for gets no npm agents.
      const nowhere = world.installer("nowhere", { nodeRelease: null });
      const unsupported = yield* Effect.flip(
        confirmAndInstall(nowhere, npmRecipe("pkg", "nowhere")),
      );
      assert.equal(unsupported.reason, "unsupportedPlatform");
    }),
  );

  it.live("a failed npm install reports npm's last lines and leaves nothing behind", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      yield* world.writePackage({ name: "pkg", bin: "cli.js", files: { "cli.js": "" } });
      yield* Effect.promise(() => NodeFS.writeFile(path.join(world.scenario, "install-fails"), ""));
      const installer = world.installer();

      const error = yield* Effect.flip(confirmAndInstall(installer, npmRecipe("pkg")));

      assert.equal(error.reason, "download");
      assert.equal(error.message, "npm couldn't install Test Agent, so nothing was installed.");
      const detail = error.detail ?? "";
      assert.include(detail, "npm error code E404");
      assert.include(detail, "npm error 404 Not Found");
      assert.isAtMost(detail.length, 2000);
      assert.isUndefined(yield* installer.installed);
      assert.deepStrictEqual(yield* listDir(path.join(agentRoot(world.dir), "versions")), []);
    }),
  );

  it.live("interrupting an npm install stops npm and what it started, and leaves nothing", () =>
    Effect.gen(function* () {
      const world = yield* makeNpmWorld();
      yield* world.writePackage({ name: "pkg", bin: "cli.js", files: { "cli.js": "" } });
      yield* Effect.promise(() => NodeFS.writeFile(path.join(world.scenario, "install-hangs"), ""));
      const installer = world.installer();
      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const fiber = yield* confirmAndInstall(installer, npmRecipe("pkg")).pipe(Effect.forkChild);
      // npm, and a program npm started (an install script).
      const pids = yield* Effect.promise(async () => {
        for (;;) {
          const written = await NodeFS.readFile(
            path.join(world.scenario, "pids.txt"),
            "utf8",
          ).catch(() => "");
          if (written.endsWith("\n")) return written.trim().split(" ").map(Number);
          await new Promise((done) => setTimeout(done, 10));
        }
      });
      assert.lengthOf(pids, 2);
      assert.isTrue(pids.every(isAlive));
      yield* Fiber.interrupt(fiber);

      // The interrupt returned only once npm had exited; what it started was
      // stopped with it, and is gone once the system has cleaned up after it.
      assert.isFalse(isAlive(pids[0] ?? 0));
      yield* Effect.promise(async () => {
        for (let waited = 0; isAlive(pids[1] ?? 0) && waited < 5000; waited += 10) {
          await new Promise((done) => setTimeout(done, 10));
        }
      });
      assert.isFalse(isAlive(pids[1] ?? 0));
      assert.deepStrictEqual(yield* listDir(path.join(agentRoot(world.dir), "versions")), []);
      assert.isUndefined(yield* installer.installed);
    }),
  );
});

const execFileAsync = promisify(execFile);

/** The npm that ships with the Node.js running this test, if it is where official builds put it. */
const ownNpmCli = [
  ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"],
  ["..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"],
  ["node_modules", "npm", "bin", "npm-cli.js"],
]
  .map((segments) => path.join(path.dirname(process.execPath), ...segments))
  .find((candidate) => existsSync(candidate));

describe.skipIf(ownNpmCli === undefined)("makeAcpRegistryInstaller: real npm", () => {
  it.live(
    "installs a local tree with a lockfile even when the user's npm is set to global and no lockfile",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const name = "threadlines-test-tiny-agent";
        const tarball = tarGz([
          {
            name: "package/package.json",
            data: Buffer.from(
              JSON.stringify({
                name,
                version: "1.0.0",
                bin: { [name]: "cli.js" },
                engines: { node: ">=18" },
              }),
            ),
          },
          {
            name: "package/cli.js",
            data: Buffer.from(
              "#!/usr/bin/env node\nconsole.log('tiny agent ' + process.argv[2])\n",
            ),
            mode: 0o755,
          },
        ]);
        // A registry on this computer: the only one npm is told about.
        const requests: Array<string> = [];
        const registry = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<http.Server>((resolve) => {
                const server = http.createServer((request, response) => {
                  requests.push(request.url ?? "");
                  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                  if (request.url === `/${name}`) {
                    response.setHeader("content-type", "application/json");
                    response.end(
                      JSON.stringify({
                        name,
                        "dist-tags": { latest: "1.0.0" },
                        versions: {
                          "1.0.0": {
                            name,
                            version: "1.0.0",
                            bin: { [name]: "cli.js" },
                            engines: { node: ">=18" },
                            dist: {
                              tarball: `${origin}/${name}/-/${name}-1.0.0.tgz`,
                              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                            },
                          },
                        },
                      }),
                    );
                  } else if (request.url === `/${name}/-/${name}-1.0.0.tgz`) {
                    response.end(tarball);
                  } else {
                    response.statusCode = 404;
                    response.end("{}");
                  }
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const port = (registry.address() as AddressInfo).port;
        const userConfig = path.join(dir, "npmrc");
        yield* Effect.promise(() =>
          NodeFS.writeFile(
            userConfig,
            `registry=http://127.0.0.1:${port}/\nglobal=true\npackage-lock=false\n`,
          ),
        );
        // npm settings from whatever started the test run stay out of it.
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^npm_/iu.test(key)),
        );
        const node: ManagedNodePaths = {
          version: process.versions.node,
          releaseId: "0123456789abcdef",
          node: process.execPath,
          npmCli: ownNpmCli ?? "",
          binDir: path.dirname(process.execPath),
        };
        const managedNode: ManagedNode = {
          installed: Effect.succeed(node),
          install: () => Effect.succeed(node),
          acquire: Effect.succeed(node),
          prune: Effect.void,
          remove: Effect.void,
        };
        const recipe = npmRecipe(name);
        const installer = makeInstaller(dir, {
          fetch: makeServer().fetch,
          nodeRelease: {
            version: node.version,
            assetKey: "linux-x64",
            asset: { url: "", sha256: "", archiveBytes: 0, unpackedBytes: 0, kind: "tar.gz" },
          },
          makeNode: () => managedNode,
          env: {
            ...env,
            NPM_CONFIG_USERCONFIG: userConfig,
            NPM_CONFIG_GLOBALCONFIG: path.join(dir, "no-global-npmrc"),
            NPM_CONFIG_CACHE: path.join(dir, "npm-cache"),
          },
        });

        const agent = yield* confirmAndInstall(installer, recipe);

        // The user's registry setting was used, for the lookup and for the install.
        assert.include(requests, `/${name}`);
        assert.include(requests, `/${name}/-/${name}-1.0.0.tgz`);
        // A local tree with a lockfile, not a global install without one.
        const script = path.join(agent.payloadDir, "node_modules", name, "cli.js");
        assert.deepStrictEqual(agent.launch, {
          program: process.execPath,
          prefixArgs: [script],
          needsShell: false,
        });
        const lock = JSON.parse(
          yield* Effect.promise(() =>
            NodeFS.readFile(path.join(agent.payloadDir, "package-lock.json"), "utf8"),
          ),
        ) as { packages: Record<string, { version?: string }> };
        // Nothing in it names the folder it was made in, so it installs anywhere.
        assert.deepStrictEqual(Object.keys(lock.packages), ["", `node_modules/${name}`]);
        assert.equal(lock.packages[`node_modules/${name}`]?.version, "1.0.0");
        const manifest = JSON.parse(
          yield* Effect.promise(() =>
            NodeFS.readFile(path.join(agent.payloadDir, "package.json"), "utf8"),
          ),
        ) as { dependencies: Record<string, string> };
        assert.deepStrictEqual(manifest.dependencies, { [name]: "1.0.0" });
        assert.isFalse(existsSync(path.join(agent.payloadDir, "lib")));
        // And it starts the way `launch` says.
        const { stdout } = yield* Effect.promise(() =>
          execFileAsync(agent.launch.program, [...agent.launch.prefixArgs, "ran"]),
        );
        assert.equal(stdout.trim(), "tiny agent ran");

        // Installing it again goes through `npm ci` and ends with the same tree.
        yield* Effect.promise(() =>
          NodeFS.rm(path.join(agentRoot(dir), "versions"), { recursive: true, force: true }),
        );
        const again = yield* installer.install(acpRegistryRecipeDigest(recipe));
        assert.equal(again.receipt.manifestSha256, agent.receipt.manifestSha256);
        assert.isTrue(existsSync(script));
      }),
    { timeout: 180_000 },
  );
});
