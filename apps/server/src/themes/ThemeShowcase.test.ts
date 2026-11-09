import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { assert, it } from "@effect/vitest";
import {
  THEME_FILE_FORMAT,
  THEME_SHOWCASE_FORMAT,
  type ThemeManifest,
  type ThemeShowcaseEntry,
  type ThemeShowcaseError,
} from "@threadlines/contracts";
import { themeContentHash } from "@threadlines/shared/themeManifest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { PagePreview } from "../pages/preview/PagePreview.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { ThemeLibrary, ThemeLibraryLive } from "./ThemeLibrary.ts";
import { ThemeLibraryRepositoryLive } from "./ThemeLibraryRepository.ts";
import { makeThemeShowcase, ThemeShowcase } from "./ThemeShowcase.ts";
import { ThemeShowcaseRepository, ThemeShowcaseRepositoryLive } from "./ThemeShowcaseRepository.ts";
import { makeThemeWorkshop, ThemeWorkshop } from "./ThemeWorkshop.ts";

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A PNG of one color, with any extra chunks after its header. */
function solidPng(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
  const chunk = pngChunk;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc(height * (1 + width * 3), 0x40);
  for (let row = 0; row < height; row++) rows[row * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const PICTURE = solidPng(320, 200);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const harbor: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Harbor",
  base: "dark",
  colors: {
    background: "#0b1420",
    foreground: "#e6eef8",
    mutedForeground: "#9fb0c4",
    accent: "#4cc2ff",
    accentForeground: "#04121f",
  },
  credits: { author: "Sam", license: "CC-BY-4.0" },
};

/** A Showcase entry for a theme file, with the digests the list would carry. */
async function entryFor(id: string, manifest: ThemeManifest, file: Uint8Array) {
  const entry: ThemeShowcaseEntry = {
    id,
    name: manifest.name,
    base: manifest.base,
    hasArt: false,
    colors: {
      background: manifest.colors.background,
      foreground: manifest.colors.foreground,
      accent: manifest.colors.accent,
    },
    sharedBy: "sam",
    featured: false,
    addedAt: "2026-11-09",
    hash: await themeContentHash(manifest),
    file: {
      path: `themes/${id}/theme.threadlines-theme`,
      sha256: sha256(file),
      bytes: file.length,
    },
    thumbnail: {
      path: `themes/${id}/thumbnail.png`,
      sha256: sha256(PICTURE),
      bytes: PICTURE.length,
    },
  };
  return entry;
}

/** raw.githubusercontent.com, faked: whatever files the test puts here, or a dropped connection. */
const repository = {
  files: new Map<string, Uint8Array | string>(),
  down: false,
  asked: [] as string[],
};
const fakeRaw: DownloadFetch = (url) => {
  repository.asked.push(url);
  if (repository.down) return Promise.reject(new Error("offline"));
  const path = url.replace("https://raw.githubusercontent.com/Threadlines/themes/main/", "");
  const file = repository.files.get(path);
  return Promise.resolve(
    file === undefined ? new Response("", { status: 404 }) : new Response(file),
  );
};
const setIndex = (themes: ReadonlyArray<unknown>, format = THEME_SHOWCASE_FORMAT) =>
  repository.files.set("index.json", JSON.stringify({ format, themes }));

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

/**
 * `gh api` against github.com, faked: who is signed in, the fork, the git
 * objects a share writes, and the pull requests. `pullPost` decides how
 * opening one goes ("ok", or "lost": GitHub opens it but the answer never
 * comes back).
 */
const github = {
  login: "octocat",
  pullPost: "ok" as "ok" | "lost",
  writes: [] as string[],
  blobs: [] as Array<{ sha: string; bytes: Buffer }>,
  trees: [] as Array<{ base_tree: string; tree: Array<{ path: string; sha: string }> }>,
  refs: new Map<string, string>(),
  pulls: [] as Array<{ number: number; url: string; head: string; state: string; merged: boolean }>,
};
const execute: GitHubCli.GitHubCliShape["execute"] = (input) => {
  const args = input.args.slice(3).filter((arg) => arg !== "--input" && arg !== "-");
  const method = args[0] === "--method" ? args[1]! : "GET";
  const path = args[0] === "--method" ? args[2]! : args[0]!;
  const body = input.stdin === undefined ? {} : JSON.parse(input.stdin);
  if (method !== "GET") github.writes.push(`${method} ${path}`);
  const json = (value: unknown) => Effect.succeed(output(`${JSON.stringify(value)}\n`));
  if (path === "user") return Effect.succeed(output(`${github.login}\n`));
  if (path === "repos/Threadlines/themes/forks") {
    return json({ name: `${github.login}/themes`, owner: github.login });
  }
  if (path === `repos/${github.login}/themes/git/ref/heads/main`) return json("forkmain");
  if (path === "repos/Threadlines/themes/git/ref/heads/main")
    return Effect.succeed(output("base1\n"));
  if (path === "repos/Threadlines/themes/git/commits/base1")
    return Effect.succeed(output("tree1\n"));
  if (path.endsWith("/git/blobs")) {
    const sha = `blob${github.blobs.length + 1}`;
    github.blobs.push({ sha, bytes: Buffer.from(body.content, "base64") });
    return Effect.succeed(output(`${sha}\n`));
  }
  if (path.endsWith("/git/trees")) {
    github.trees.push(body);
    return Effect.succeed(output(`tree${github.trees.length + 1}\n`));
  }
  if (path.endsWith("/git/commits")) return Effect.succeed(output("commit1\n"));
  if (path.endsWith("/git/refs") && method === "POST") {
    if (github.refs.has(body.ref)) {
      return Effect.fail(
        new GitHubCli.GitHubCliError({
          operation: "execute",
          detail: "Reference already exists (HTTP 422)",
        }),
      );
    }
    github.refs.set(body.ref, body.sha);
    return Effect.succeed(output(`${body.ref}\n`));
  }
  if (method === "PATCH" && path.includes("/git/refs/heads/")) return json({});
  if (path.startsWith("repos/Threadlines/themes/pulls?head=")) {
    const head = decodeURIComponent(/head=([^&]+)/.exec(path)![1]!);
    return json(
      github.pulls.filter((pull) => pull.head === head).map(({ number, url }) => ({ number, url })),
    );
  }
  if (path === "repos/Threadlines/themes/pulls" && method === "POST") {
    const number = github.pulls.length + 1;
    const pull = {
      number,
      url: `https://github.com/Threadlines/themes/pull/${number}`,
      head: body.head,
      state: "open",
      merged: false,
    };
    github.pulls.push(pull);
    if (github.pullPost === "lost") {
      return Effect.fail(
        new GitHubCli.GitHubCliError({ operation: "execute", detail: "context deadline exceeded" }),
      );
    }
    return json({ number, url: pull.url });
  }
  const pullNumber = /^repos\/Threadlines\/themes\/pulls\/(\d+)$/.exec(path)?.[1];
  if (pullNumber !== undefined) {
    const pull = github.pulls.find((candidate) => candidate.number === Number(pullNumber));
    return json({ state: pull?.state, merged: pull?.merged });
  }
  return Effect.die(new Error(`unexpected gh call: ${input.args.join(" ")}`));
};

let clock = Date.parse("2026-11-09T12:00:00Z");
const recorded: Array<{ event: string; properties: unknown }> = [];

const TestLayer = Layer.effect(
  ThemeShowcase,
  makeThemeShowcase({ fetch: fakeRaw, now: () => clock }),
).pipe(
  Layer.provideMerge(ThemeLibraryLive),
  Layer.provideMerge(ThemeShowcaseRepositoryLive),
  Layer.provide(ThemeLibraryRepositoryLive),
  Layer.provide(Layer.mock(GitHubCli.GitHubCli)({ execute })),
  Layer.provide(
    Layer.succeed(AnalyticsService, {
      record: (event, properties) => Effect.sync(() => recorded.push({ event, properties })),
      flush: Effect.void,
    }),
  ),
  Layer.provide(
    Layer.effect(ThemeWorkshop, makeThemeWorkshop()).pipe(
      Layer.provide(
        Layer.mock(PagePreview)({
          captureViewports: () =>
            Effect.succeed([
              {
                // A browser's screenshot may carry text; the published picture never does.
                png: Buffer.from(
                  solidPng(320, 200, [pngChunk("tEXt", Buffer.from("Software\0Chrome"))]),
                ).toString("base64"),
                attributes: {},
                consoleMessages: [],
              },
            ]),
        }),
      ),
    ),
  ),
  Layer.provide(ServerEnvironment.layerTest()),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const failure = <A>(effect: Effect.Effect<A, ThemeShowcaseError>) => effect.pipe(Effect.flip);

it.layer(TestLayer)("ThemeShowcase", (it) => {
  it.effect(
    "lists only entries that point where they should, and keeps the list when a fetch fails",
    () =>
      Effect.gen(function* () {
        const showcase = yield* ThemeShowcase;
        const file = new TextEncoder().encode(JSON.stringify(harbor));
        const good = yield* Effect.promise(() => entryFor("harbor", harbor, file));
        const elsewhere = {
          ...good,
          id: "other",
          file: { ...good.file, path: "themes/harbor/theme.threadlines-theme" },
        };
        setIndex([good, elsewhere, { id: "broken" }]);
        repository.files.set(good.file.path, file);
        repository.files.set(good.thumbnail.path, PICTURE);

        const first = yield* showcase.list({});
        assert.deepStrictEqual(
          first.themes.map((entry) => entry.id),
          ["harbor"],
        );
        assert.strictEqual(first.issue, null);

        // An hour later GitHub can't be reached: the list stays, marked old.
        clock += 60 * 60_000;
        repository.down = true;
        const offline = yield* showcase.list({});
        assert.deepStrictEqual(
          offline.themes.map((entry) => entry.id),
          ["harbor"],
        );
        assert.strictEqual(offline.issue, "unreachable");
        repository.down = false;

        // A list in a newer format: this build says to update, and keeps what it had.
        setIndex([], "threadlines-showcase@2");
        const newer = yield* showcase.list({ refresh: true });
        assert.strictEqual(newer.issue, "updateNeeded");
        assert.strictEqual(newer.themes.length, 1);
        setIndex([good]);
        assert.strictEqual((yield* showcase.list({ refresh: true })).issue, null);
      }),
  );

  it.effect("tries a theme only when its file and picture match the list", () =>
    Effect.gen(function* () {
      const showcase = yield* ThemeShowcase;
      const file = new TextEncoder().encode(JSON.stringify(harbor));
      const entry = yield* Effect.promise(() => entryFor("harbor", harbor, file));
      setIndex([entry]);
      repository.files.set(entry.file.path, file);
      repository.files.set(entry.thumbnail.path, PICTURE);
      yield* showcase.list({ refresh: true });

      const tried = yield* showcase.read({ id: "harbor" });
      assert.strictEqual(tried.hash, entry.hash);
      assert.strictEqual(tried.manifest.name, "Harbor");
      assert.deepInclude(recorded.at(-1), { event: "theme.showcase.tried" });
      const picture = yield* showcase.picture({ id: "harbor" });
      assert.isTrue(picture.dataUrl.startsWith("data:image/png;base64,"));

      // Someone changes the file without the list: it isn't used.
      repository.files.set(
        entry.file.path,
        new TextEncoder().encode(
          JSON.stringify({ ...harbor, colors: { ...harbor.colors, accent: "#ff0000" } }),
        ),
      );
      const changed = yield* failure(showcase.read({ id: "harbor" }));
      assert.match(changed.detail, /doesn't match its list/);
      const missing = yield* failure(showcase.read({ id: "nope" }));
      assert.match(missing.detail, /isn't in the Showcase/);
    }),
  );

  it.effect("shares a library theme as one pull request, however many times it's sent", () =>
    Effect.gen(function* () {
      const showcase = yield* ThemeShowcase;
      const library = yield* ThemeLibrary;
      setIndex([]);
      yield* showcase.list({ refresh: true });
      const saved = yield* library.save({
        manifest: {
          ...harbor,
          name: "Tide Pool",
          credits: undefined,
          prompt: "a calm harbor at night",
          createdBy: { kind: "agent", agent: "Claude", threadId: "thread-1" },
        } as ThemeManifest,
      });
      const share = {
        entryId: saved.entryId,
        credits: { author: "Octo", license: "CC0-1.0" as const },
        includePrompt: false,
      };

      const ready = yield* showcase.prepare(share);
      assert.deepStrictEqual(ready.problems, []);
      assert.isUndefined(ready.manifest.createdBy);
      assert.isUndefined(ready.manifest.prompt);
      assert.deepStrictEqual(ready.manifest.credits, { author: "Octo", license: "CC0-1.0" });

      // Signed in as someone else: nothing is written.
      github.login = "someone-else";
      const wrongAccount = yield* failure(
        showcase.submit({ ...share, submissionId: "share0000001", login: "octocat" }),
      );
      assert.match(wrongAccount.detail, /now signed in as @someone-else/);
      assert.deepStrictEqual(github.writes, []);
      github.login = "octocat";

      const sent = yield* showcase.submit({
        ...share,
        submissionId: "share0000002",
        login: "octocat",
      });
      assert.strictEqual(sent.state, "inReview");
      assert.strictEqual(sent.pullRequestUrl, "https://github.com/Threadlines/themes/pull/1");
      const tree = github.trees[0]!;
      assert.strictEqual(tree.base_tree, "tree1");
      assert.deepStrictEqual(
        tree.tree.map((item) => item.path),
        [
          "themes/tide-pool/theme.threadlines-theme",
          "themes/tide-pool/thumbnail.png",
          "themes/tide-pool/meta.json",
        ],
      );
      const blob = (index: number) =>
        github.blobs.find((candidate) => candidate.sha === tree.tree[index]!.sha)!.bytes;
      const published = JSON.parse(blob(0).toString("utf8")) as ThemeManifest;
      assert.strictEqual(
        yield* Effect.promise(() => themeContentHash(published)),
        sent.publishedHash,
      );
      assert.isUndefined(published.createdBy);
      assert.isFalse(blob(1).includes("tEXt"));
      assert.deepStrictEqual(JSON.parse(blob(2).toString("utf8")), { sharedBy: "octocat" });
      assert.deepInclude(recorded.at(-1), { event: "theme.showcase.shared" });

      // Sent again (a second click, a retry after a restart): the same pull request.
      const again = yield* showcase.submit({
        ...share,
        submissionId: "share0000002",
        login: "octocat",
      });
      assert.deepStrictEqual(again, sent);
      const pullPosts = () =>
        github.writes.filter((write) => write === "POST repos/Threadlines/themes/pulls").length;
      assert.strictEqual(pullPosts(), 1);
      // A new share of the same theme while that one is in review: that one again.
      const twice = yield* showcase.submit({
        ...share,
        submissionId: "share0000003",
        login: "octocat",
      });
      assert.strictEqual(twice.submissionId, "share0000002");
      assert.strictEqual(pullPosts(), 1);

      // Merged: still on its way until the list has it, then in the Showcase.
      github.pulls[0]!.state = "closed";
      github.pulls[0]!.merged = true;
      clock += 10 * 60_000;
      const merged = yield* showcase.submissions;
      assert.deepStrictEqual(
        merged.submissions.map((row) => row.state),
        ["inReview"],
      );
      const added = yield* Effect.promise(() => entryFor("tide-pool", published, blob(0)));
      setIndex([added]);
      clock += 40 * 60_000;
      const after = yield* showcase.submissions;
      assert.deepStrictEqual(
        after.submissions.map((row) => row.state),
        ["listed"],
      );
    }),
  );

  it.effect("finds a pull request GitHub opened without answering instead of opening another", () =>
    Effect.gen(function* () {
      const showcase = yield* ThemeShowcase;
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({ manifest: { ...harbor, name: "Low Tide" } });
      github.pullPost = "lost";
      const before = github.pulls.length;
      const sent = yield* showcase.submit({
        entryId: saved.entryId,
        credits: null,
        includePrompt: false,
        submissionId: "share0000004",
        login: "octocat",
      });
      github.pullPost = "ok";
      assert.strictEqual(github.pulls.length, before + 1);
      assert.strictEqual(sent.pullRequestUrl, github.pulls.at(-1)!.url);
    }),
  );

  it.effect("picks up a share a restart cut off, from a new dialog and another account", () =>
    Effect.gen(function* () {
      const showcase = yield* ThemeShowcase;
      const library = yield* ThemeLibrary;
      const shares = yield* ThemeShowcaseRepository;
      const saved = yield* library.save({
        manifest: {
          ...harbor,
          name: "Slack Water",
          colors: { ...harbor.colors, accent: "#6fd0c4" },
        },
      });
      // The first try opened its pull request as @octocat; the server stopped before noting it.
      yield* shares.put({
        submissionId: "cutoff000001",
        entryId: saved.entryId,
        sourceHash: saved.hash,
        // That try published other credits than this one would.
        publishedHash: "c".repeat(64),
        slug: "slack-water",
        login: "octocat",
        pullRequestNumber: null,
        pullRequestUrl: null,
        state: "inReview",
        createdAt: "2026-11-09T12:00:00.000Z",
        checkedAt: null,
      });
      github.pulls.push({
        number: 99,
        url: "https://github.com/Threadlines/themes/pull/99",
        head: "octocat:showcase/cutoff000001",
        state: "open",
        merged: false,
      });
      const writesBefore = github.writes.length;

      // Shared again from a new dialog, signed in as someone else now: that pull request is the share.
      github.login = "octo-two";
      const sent = yield* showcase.submit({
        entryId: saved.entryId,
        credits: null,
        includePrompt: false,
        submissionId: "fresh0000001",
        login: "octo-two",
      });
      github.login = "octocat";
      assert.strictEqual(sent.pullRequestUrl, "https://github.com/Threadlines/themes/pull/99");
      assert.strictEqual(sent.submissionId, "cutoff000001");
      assert.strictEqual(sent.login, "octocat");
      // What that pull request holds, not what this try would have sent.
      assert.strictEqual(sent.publishedHash, "c".repeat(64));
      assert.deepStrictEqual(github.writes.slice(writesBefore), []);
    }),
  );

  it.effect("won't share a theme under a starter's MIT license", () =>
    Effect.gen(function* () {
      const showcase = yield* ThemeShowcase;
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({
        manifest: {
          ...harbor,
          name: "Starter Copy",
          credits: { author: "Threadlines", license: "MIT" },
        },
      });
      const ready = yield* showcase.prepare({
        entryId: saved.entryId,
        credits: null,
        includePrompt: false,
      });
      assert.isTrue(ready.problems.some((problem) => problem.includes("MIT")));
      const refused = yield* failure(
        showcase.submit({
          entryId: saved.entryId,
          credits: null,
          includePrompt: false,
          submissionId: "share0000005",
          login: "octocat",
        }),
      );
      assert.match(refused.detail, /can't be shared yet/);
    }),
  );
});
