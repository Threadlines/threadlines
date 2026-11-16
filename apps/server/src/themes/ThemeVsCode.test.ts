import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeZip } from "../provider/testUtils/archiveFixtures.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import { makeThemeVsCode, OPEN_VSX_API, readExtensionManifest } from "./ThemeVsCode.ts";

const night = {
  colors: {
    "editor.background": "#1a1b26",
    "editor.foreground": "#a9b1d6",
    "activityBarBadge.background": "#3d59a1",
  },
  tokenColors: [{ scope: "keyword", settings: { foreground: "#bb9af7" } }],
};

const packageJson = (license: string) => ({
  name: "night",
  displayName: "Night",
  license,
  author: "Someone <someone@example.com>",
  repository: { url: "git+https://github.com/someone/night.git" },
  contributes: {
    themes: [
      { label: "%night%", uiTheme: "vs-dark", path: "./themes/night.json" },
      { label: "Night Storm", uiTheme: "vs-dark", path: "./themes/storm.json" },
      { label: "Escape", uiTheme: "vs-dark", path: "../../outside.json" },
    ],
  },
});

const vsix = makeZip([
  { name: "extension/package.json", data: Buffer.from(JSON.stringify(packageJson("MIT"))) },
  { name: "extension/package.nls.json", data: Buffer.from('{ "night": "Night" }') },
  {
    name: "extension/themes/night.json",
    data: Buffer.from(`// comment\n${JSON.stringify(night)}`),
  },
  {
    name: "extension/themes/storm.json",
    data: Buffer.from(
      JSON.stringify({ include: "./night.json", colors: { "editor.background": "#24283b" } }),
    ),
  },
]);

/** The store, as far as these tests need it: two extensions, one under a closed license. */
function fakeStore(options: { readonly digest?: string } = {}) {
  const requests: string[] = [];
  const files: Record<string, string | Buffer> = {
    [`${OPEN_VSX_API}/someone/night/1.0.0/file/package.json`]: JSON.stringify(packageJson("MIT")),
    [`${OPEN_VSX_API}/someone/dawn/1.0.0/file/package.json`]: JSON.stringify(packageJson("ISC")),
    [`${OPEN_VSX_API}/other/closed/2.0.0/file/package.json`]: JSON.stringify(
      packageJson("SEE LICENSE IN LICENSE"),
    ),
    [`${OPEN_VSX_API}/someone/night/1.0.0/file/someone.night-1.0.0.sha256`]:
      options.digest ?? createHash("sha256").update(vsix).digest("hex"),
    [`${OPEN_VSX_API}/someone/night/1.0.0/file/someone.night-1.0.0.vsix`]: vsix,
  };
  const fetch: DownloadFetch = async (url) => {
    requests.push(url);
    if (url.startsWith(`${OPEN_VSX_API}/-/search?`)) {
      return new Response(
        JSON.stringify({
          totalSize: 3,
          extensions: [
            {
              namespace: "someone",
              name: "night",
              version: "1.0.0",
              displayName: "Night",
              downloadCount: 1200,
            },
            { namespace: "other", name: "closed", version: "2.0.0", displayName: "Closed" },
            { namespace: "someone", name: "dawn", version: "1.0.0", displayName: "Dawn" },
          ],
        }),
      );
    }
    const body = files[url];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  };
  return { fetch, requests };
}

it.effect(
  "lists only extensions with color themes under an open license, and remembers the page",
  () =>
    Effect.gen(function* () {
      const store = fakeStore();
      const vscode = yield* makeThemeVsCode({ fetch: store.fetch });
      const result = yield* vscode.search({ query: "night", sort: "downloads" });
      assert.deepStrictEqual(
        result.extensions.map((entry) => [
          entry.namespace,
          entry.name,
          entry.license,
          entry.themeCount,
          entry.downloads,
        ]),
        [
          ["someone", "night", "MIT", 3, 1200],
          ["someone", "dawn", "ISC", 3, 0],
        ],
      );
      assert.strictEqual(result.nextOffset, null);
      const asked = store.requests.length;
      yield* vscode.search({ query: "Night ", sort: "downloads" });
      assert.strictEqual(store.requests.length, asked);
    }),
);

it.effect("reads an extension's themes, translated, through includes, skipping what it can't", () =>
  Effect.gen(function* () {
    const vscode = yield* makeThemeVsCode({ fetch: fakeStore().fetch });
    const result = yield* vscode.read({ namespace: "someone", name: "night", version: "1.0.0" });
    assert.deepStrictEqual(
      result.themes.map((theme) => [theme.label, theme.base, theme.colors.background]),
      [
        ["Night", "dark", "#1a1b26"],
        ["Night Storm", "dark", "#24283b"],
      ],
    );
    assert.deepStrictEqual(
      result.skipped.map((entry) => entry.label),
      ["Escape"],
    );
    const [first] = result.themes;
    // Credited by name only: never the address in the author field.
    assert.deepStrictEqual(first?.manifest.credits, {
      author: "Someone",
      link: "https://github.com/someone/night",
      license: "MIT",
      vscode: "someone.night",
    });
    assert.deepStrictEqual(first?.manifest.createdBy, {
      kind: "imported",
      vscode: { theme: "Night", extension: "someone.night", version: "1.0.0", license: "MIT" },
    });
  }),
);

it.effect(
  "refuses a package that isn't the one the store lists, or one under a closed license",
  () =>
    Effect.gen(function* () {
      const tampered = yield* makeThemeVsCode({
        fetch: fakeStore({ digest: "0".repeat(64) }).fetch,
      });
      const mismatch = yield* Effect.flip(
        tampered.read({ namespace: "someone", name: "night", version: "1.0.0" }),
      );
      assert.match(mismatch.detail, /isn't the one the store lists/);
      const closed = yield* Effect.flip(
        tampered.read({ namespace: "other", name: "closed", version: "2.0.0" }),
      );
      assert.match(closed.detail, /open license/);
    }),
);

it.effect("says the store couldn't be reached when it can't", () =>
  Effect.gen(function* () {
    const vscode = yield* makeThemeVsCode({
      fetch: async () => {
        throw new Error("ENOTFOUND open-vsx.org");
      },
    });
    const error = yield* Effect.flip(vscode.search({ query: "", sort: "downloads" }));
    assert.match(error.detail, /Couldn't reach/);
  }),
);

it.effect(
  "asks again for a manifest the store didn't answer, instead of hiding the extension",
  () =>
    Effect.gen(function* () {
      const store = fakeStore();
      let failing = true;
      const vscode = yield* makeThemeVsCode({
        fetch: async (url, init) => {
          if (failing && url.endsWith("/night/1.0.0/file/package.json")) {
            return new Response(null, { status: 503 });
          }
          return store.fetch(url, init);
        },
      });
      // Left out while the store doesn't answer for it, and not remembered as gone.
      const partial = yield* vscode.search({ query: "night", sort: "downloads" });
      assert.deepStrictEqual(
        partial.extensions.map((entry) => entry.name),
        ["dawn"],
      );
      failing = false;
      const result = yield* vscode.search({ query: "night", sort: "downloads" });
      assert.deepStrictEqual(
        result.extensions.map((entry) => entry.name),
        ["night", "dawn"],
      );
    }),
);

it.effect("skips a theme file larger than a theme may be, and reads the rest", () =>
  Effect.gen(function* () {
    const big = makeZip([
      { name: "extension/package.json", data: Buffer.from(JSON.stringify(packageJson("MIT"))) },
      { name: "extension/package.nls.json", data: Buffer.from('{ "night": "Night" }') },
      { name: "extension/themes/night.json", data: Buffer.from(JSON.stringify(night)) },
      { name: "extension/themes/storm.json", data: Buffer.alloc(2 * 1024 * 1024, 0x20) },
    ]);
    const store = fakeStore({ digest: createHash("sha256").update(big).digest("hex") });
    const vscode = yield* makeThemeVsCode({
      fetch: async (url, init) =>
        url.endsWith(".vsix") ? new Response(big) : store.fetch(url, init),
    });
    const result = yield* vscode.read({ namespace: "someone", name: "night", version: "1.0.0" });
    assert.deepStrictEqual(
      result.themes.map((theme) => theme.label),
      ["Night"],
    );
    assert.isTrue(result.skipped.some((entry) => entry.label === "Night Storm"));
  }),
);

it("reads a manifest's author as a name only, and doesn't stall on hostile fields", () => {
  const started = performance.now();
  const manifest = readExtensionManifest({
    license: "MIT",
    author: { name: `dev@example.com Ann Lee ${"<".repeat(100_000)}` },
    homepage: `https://${"a".repeat(250_000)} x`,
    contributes: { themes: [{ label: "A", path: "./a.json" }] },
  });
  assert.isBelow(performance.now() - started, 200);
  assert.strictEqual(manifest?.author, "Ann Lee");
  assert.strictEqual(manifest?.link, undefined);
  assert.strictEqual(readExtensionManifest({ author: "someone@example.com" })?.author, undefined);
});

it.effect("asks again, after a while, for a manifest that wasn't there yet", () =>
  Effect.gen(function* () {
    const store = fakeStore();
    let missing = true;
    let clock = 0;
    const vscode = yield* makeThemeVsCode({
      now: () => clock,
      fetch: async (url, init) =>
        missing && url.endsWith("/dawn/1.0.0/file/package.json")
          ? new Response(null, { status: 404 })
          : store.fetch(url, init),
    });
    const early = yield* vscode.search({ query: "", sort: "downloads" });
    assert.deepStrictEqual(
      early.extensions.map((entry) => entry.name),
      ["night"],
    );
    missing = false;
    clock = 11 * 60_000;
    const later = yield* vscode.search({ query: "", sort: "downloads" });
    assert.deepStrictEqual(
      later.extensions.map((entry) => entry.name),
      ["night", "dawn"],
    );
  }),
);
