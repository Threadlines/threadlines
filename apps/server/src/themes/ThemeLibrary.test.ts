import {
  THEME_FILE_FORMAT,
  type ThemeEntry,
  type ThemeError,
  type ThemeManifest,
  ThemeMergeInput,
} from "@threadlines/contracts";
import { themeContentHash } from "@threadlines/shared/themeManifest";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { PagePreviewBrowserError } from "../pages/preview/headlessChrome.ts";
import { PagePreview } from "../pages/preview/PagePreview.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import { ThemeLibrary, ThemeLibraryLive } from "./ThemeLibrary.ts";
import { ThemeLibraryRepositoryLive } from "./ThemeLibraryRepository.ts";
import { makeThemeWorkshop, ThemeWorkshop } from "./ThemeWorkshop.ts";

const aurora: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Aurora",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
};

const dunes: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Dunes",
  base: "light",
  colors: {
    background: "#fbf6ee",
    foreground: "#2a1f16",
    mutedForeground: "#6f5b48",
    accent: "#b8532a",
    accentForeground: "#fff7ef",
  },
};

const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]); // "wOF2…"
const THUMBNAIL_PNG = "iVBORw0KGgo=";

/** One weight's faces in a Google stylesheet: latin-ext, then latin. */
const googleFaces = (weight: number, latin: string) =>
  `/* latin-ext */\n@font-face { font-weight: ${weight}; src: url(https://fonts.gstatic.com/s/inter/ext.woff2) format('woff2'); }\n/* latin */\n@font-face { font-weight: ${weight}; src: url(${latin}) format('woff2'); }\n`;

/**
 * The fonts hosts, faked, and nothing else: Inter is variable, so Google
 * answers any set of its weights with the one latin file.
 */
const fakeFonts =
  (asked: Array<string>): DownloadFetch =>
  (url) => {
    asked.push(url);
    const weights = /^https:\/\/fonts\.googleapis\.com\/css2\?family=Inter:wght@([\d;]+)&/.exec(
      url,
    )?.[1];
    if (weights !== undefined) {
      return Promise.resolve(
        new Response(
          weights
            .split(";")
            .map((weight) =>
              googleFaces(Number(weight), "https://fonts.gstatic.com/s/inter/latin.woff2"),
            )
            .join(""),
        ),
      );
    }
    if (url === "https://fonts.gstatic.com/s/inter/latin.woff2") {
      return Promise.resolve(new Response(FONT_BYTES));
    }
    return Promise.resolve(new Response("", { status: 400 }));
  };

const asked: Array<string> = [];
/** What the library counted, as PostHog would get it. */
const recorded: Array<{ event: string; properties: unknown }> = [];
const TestLayer = ThemeLibraryLive.pipe(
  Layer.provide(ThemeLibraryRepositoryLive),
  Layer.provide(
    Layer.succeed(AnalyticsService, {
      record: (event, properties) => Effect.sync(() => recorded.push({ event, properties })),
      flush: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.effect(ThemeWorkshop, makeThemeWorkshop({ fetch: fakeFonts(asked) })).pipe(
      Layer.provide(
        // The browser answers thumbnails (scaled-down shots) only.
        Layer.mock(PagePreview)({
          captureViewports: (input) =>
            input.scale !== undefined && input.scale < 1
              ? Effect.succeed([{ png: THUMBNAIL_PNG, attributes: {}, consoleMessages: [] }])
              : Effect.fail(new PagePreviewBrowserError({ reason: "no browser in tests" })),
        }),
      ),
    ),
  ),
  Layer.provide(ServerEnvironment.layerTest()),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const failure = <A>(effect: Effect.Effect<A, ThemeError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.detail),
  );

it.layer(TestLayer)("ThemeLibrary", (it) => {
  it.effect("saves a checked theme as a new entry, and refuses one that fails the checks", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({ manifest: aurora, name: "Night" });
      assert.strictEqual(saved.name, "Night");
      assert.strictEqual(saved.base, "dark");
      assert.strictEqual(saved.background, "#0a1029");
      assert.strictEqual(saved.backdropMode, null);
      assert.strictEqual(saved.revisedBy, "env-test");
      assert.isFalse(saved.deleted);
      assert.strictEqual(saved.hash, yield* Effect.promise(() => themeContentHash(aurora)));
      const content = yield* library.read({ hash: saved.hash });
      assert.deepStrictEqual(content.manifest, aurora);

      const before = (yield* library.snapshot).entries.length;
      const detail = yield* failure(
        library.save({
          manifest: { ...aurora, colors: { ...aurora.colors, mutedForeground: "#11182f" } },
        }),
      );
      assert.include(detail, "muted-foreground");
      assert.strictEqual((yield* library.snapshot).entries.length, before);
    }),
  );

  it.effect("embeds a hosted font when saving, from the fonts hosts only", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      asked.length = 0;
      const saved = yield* library.save({
        manifest: { ...aurora, fonts: { ui: { family: "Inter", source: "google" } } },
      });
      const { manifest } = yield* library.read({ hash: saved.hash });
      assert.strictEqual(manifest.fonts?.ui?.data, Buffer.from(FONT_BYTES).toString("base64"));
      // One variable file carries regular through bold.
      assert.deepStrictEqual(manifest.fonts?.ui?.weights, { min: 400, max: 700 });
      assert.deepStrictEqual(
        asked.map((url) => new URL(url).hostname),
        ["fonts.googleapis.com", "fonts.gstatic.com"],
      );

      const missing = yield* failure(
        library.save({
          manifest: { ...aurora, fonts: { mono: { family: "Nope Mono", source: "google" } } },
        }),
      );
      assert.include(missing, '"source": "system"');
    }),
  );

  it.effect("gives every rename, delete and restore a new revision, and keeps the tombstone", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({ manifest: dunes });
      const renamed = yield* library.rename({ entryId: saved.entryId, name: "Sand" });
      assert.strictEqual(renamed.name, "Sand");
      assert.strictEqual(renamed.revision, saved.revision + 1);
      const deleted = yield* library.delete({ entryId: saved.entryId });
      assert.isTrue(deleted.deleted);
      assert.strictEqual(deleted.revision, saved.revision + 2);
      // Deleting a tombstone changes nothing.
      assert.strictEqual(
        (yield* library.delete({ entryId: saved.entryId })).revision,
        deleted.revision,
      );
      const { entries } = yield* library.snapshot;
      assert.isTrue(entries.some((entry) => entry.entryId === saved.entryId && entry.deleted));
      const restored = yield* library.restore({ entryId: saved.entryId });
      assert.isFalse(restored.deleted);
      assert.strictEqual(restored.revision, saved.revision + 3);
    }),
  );

  it.effect("keeps both entries of a duplicated theme when one is deleted", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const first = yield* library.save({ manifest: dunes, name: "Dunes" });
      const copy = yield* library.save({ manifest: dunes, name: "Dunes copy" });
      assert.strictEqual(copy.hash, first.hash);
      assert.notStrictEqual(copy.entryId, first.entryId);
      yield* library.delete({ entryId: first.entryId });
      const { entries } = yield* library.snapshot;
      const kept = entries.find((entry) => entry.entryId === copy.entryId);
      assert.isFalse(kept?.deleted);
      assert.strictEqual((yield* library.read({ hash: copy.hash })).manifest.name, "Dunes");
    }),
  );

  it.effect("counts a save and a delete made here, never the theme's name; a merge isn't", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      recorded.length = 0;
      // Content no other test saved, so its first save is not a copy.
      const imported = {
        ...dunes,
        colors: { ...dunes.colors, accent: "#a8472a" },
        createdBy: { kind: "imported" as const },
      };
      const first = yield* library.save({ manifest: imported, name: "Mine" });
      yield* library.save({ manifest: imported, name: "Mine copy" });
      yield* library.delete({ entryId: first.entryId });
      // A delete of a theme already deleted counts nothing.
      yield* library.delete({ entryId: first.entryId });
      const theme = { origin: "imported", base: "light", art: "none", customFonts: false };
      assert.deepStrictEqual(recorded, [
        { event: "theme.saved", properties: { ...theme, copy: false } },
        { event: "theme.saved", properties: { ...theme, copy: true } },
        { event: "theme.deleted", properties: theme },
      ]);
      // Another computer's entry: that computer counted it.
      const elsewhere = yield* Effect.promise(() => themeContentHash(aurora));
      yield* library.merge({
        entry: {
          entryId: "from-elsewhere",
          name: "Elsewhere",
          hash: elsewhere,
          revision: 99,
          revisedBy: "env-other",
          deleted: false,
          createdAt: "2026-11-06T00:00:00.000Z",
          updatedAt: "2026-11-06T00:00:00.000Z",
        },
        manifest: aurora,
      });
      assert.strictEqual(recorded.length, 3);
    }),
  );

  it.effect("takes a newer computer's theme with a field it doesn't know, and keeps it", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      // Through the wire as the RPC decodes it, then merged.
      const manifest = { ...dunes, name: "From later", soundscape: { kind: "rain" } };
      const hash = yield* Effect.promise(() => themeContentHash(manifest));
      const input = yield* Schema.decodeUnknownEffect(ThemeMergeInput)({
        entry: {
          entryId: "from-a-newer-build",
          name: "From later",
          hash,
          revision: 7,
          revisedBy: "env-newer",
          deleted: false,
          createdAt: "2026-11-09T00:00:00.000Z",
          updatedAt: "2026-11-09T00:00:00.000Z",
        },
        manifest,
      });
      const merged = yield* library.merge(input);
      assert.strictEqual(merged.hash, hash);
      const stored = (yield* library.read({ hash })).manifest as Record<string, unknown>;
      assert.deepStrictEqual(stored["soundscape"], { kind: "rain" });
    }),
  );

  it.effect("merges by revision: the newer copy wins, an older one changes nothing", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({ manifest: aurora, name: "Mine" });
      const theirs: ThemeEntry = {
        entryId: saved.entryId,
        name: saved.name,
        hash: saved.hash,
        revision: saved.revision,
        revisedBy: saved.revisedBy,
        deleted: saved.deleted,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
      const older = yield* library.merge({
        entry: { ...theirs, name: "Older", revision: saved.revision - 1, revisedBy: "env-other" },
      });
      assert.strictEqual(older.name, "Mine");
      const newer = yield* library.merge({
        entry: { ...theirs, name: "Theirs", revision: saved.revision + 40, revisedBy: "env-other" },
      });
      assert.strictEqual(newer.name, "Theirs");
      assert.strictEqual(newer.revisedBy, "env-other");
      // The next change here counts on from the highest revision it has seen.
      const renamed = yield* library.rename({ entryId: saved.entryId, name: "Ours again" });
      assert.strictEqual(renamed.revision, saved.revision + 41);
      assert.strictEqual(renamed.revisedBy, "env-test");
    }),
  );

  it.effect(
    "merges a new entry only with its content, and only content that matches its hash",
    () =>
      Effect.gen(function* () {
        const library = yield* ThemeLibrary;
        const night: ThemeManifest = {
          ...aurora,
          name: "Night",
          colors: { ...aurora.colors, accent: "#5fb3ff", accentForeground: "#04121f" },
        };
        const hash = yield* Effect.promise(() => themeContentHash(night));
        const entry: ThemeEntry = {
          entryId: "8a3e4b1c-0d2f-4e5a-9b6c-7d8e9f0a1b2c",
          name: "Night",
          hash,
          revision: 3,
          revisedBy: "env-other",
          deleted: false,
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:00:00.000Z",
        };
        assert.include(yield* failure(library.merge({ entry })), "doesn't have");
        assert.include(
          yield* failure(library.merge({ entry, manifest: dunes })),
          "isn't the content the entry names",
        );
        const merged = yield* library.merge({ entry, manifest: night });
        assert.strictEqual(merged.entryId, entry.entryId);
        assert.strictEqual(merged.revisedBy, "env-other");
        assert.deepStrictEqual((yield* library.read({ hash })).manifest, night);
      }),
  );

  it.effect("gives a theme with art its thumbnail once it is saved", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const saved = yield* library.save({
        manifest: {
          ...aurora,
          name: "Aurora live",
          glass: { frame: 0.6, list: 0.7, column: 0.85, composer: 0.85, blur: 16 },
          backdrop: { mode: "grid", maxFps: 24, script: "threadlines.backdrop({ mode: 'grid' })" },
        },
      });
      assert.strictEqual(saved.backdropMode, "grid");
      // Made in the background, after the save answered.
      yield* TestClock.adjust(Duration.millis(10));
      const { entries } = yield* library.snapshot;
      const entry = entries.find((candidate) => candidate.entryId === saved.entryId);
      assert.strictEqual(entry?.thumbnail, `data:image/png;base64,${THUMBNAIL_PNG}`);
    }),
  );

  it.effect("tells subscribers about every change", () =>
    Effect.gen(function* () {
      const library = yield* ThemeLibrary;
      const before = (yield* library.snapshot).entries.length;
      const watching = yield* library.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.millis(200));
      yield* library.save({ manifest: aurora, name: "Watched" });
      yield* TestClock.adjust(Duration.millis(200));
      const [first, second] = yield* Fiber.join(watching);
      assert.strictEqual(first?.entries.length, before);
      assert.isTrue(second?.entries.some((entry) => entry.name === "Watched"));
    }),
  );
});
