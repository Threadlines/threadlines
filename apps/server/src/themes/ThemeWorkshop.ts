/**
 * Getting a theme ready, and showing it (docs/design/custom-themes.md):
 * checking it and embedding its fonts, rendering the specimen in the preview
 * browser for `preview_theme`, and capturing the stills and thumbnails a
 * theme with art carries. Everything that needs the network (fonts) or the
 * preview browser lives here, so the library and the page tools stay plain.
 */
import {
  BackdropEnergy,
  BackdropFailureReason,
  THEME_MAX_STILL_CHARS,
  ThemeError,
  type ThemeManifest,
} from "@threadlines/contracts";
import { checkThemeManifest } from "@threadlines/shared/themeManifest";
import {
  buildThemeArtDocument,
  buildThemeSpecimenDocument,
  THEME_SPECIMEN_ATTRIBUTES,
  type ThemeSpecimenLayout,
} from "@threadlines/shared/themeSpecimen";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeHttpsFetch } from "../provider/managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import type { ConsoleMessage } from "../pages/preview/headlessChrome.ts";
import { PagePreview, type PagePreviewError } from "../pages/preview/PagePreview.ts";
import { embedThemeFonts, makeThemeFontCache, THEME_FONT_HOSTS } from "./themeFonts.ts";

/** The window size themes are previewed and their stills captured at. */
export const THEME_SPECIMEN_WIDTH = 1440;
export const THEME_SPECIMEN_HEIGHT = 900;
/** A library thumbnail: the new-thread specimen, scaled down. */
export const THEME_THUMBNAIL_WIDTH = 320;
export const THEME_THUMBNAIL_HEIGHT = 200;
/** How long the art runs before the thread layout's shot and its stats. */
const ART_RUN_MS = 2_000;
/** And how much longer the preview waits for the first stats. */
const STATS_WAIT_MS = 3_000;
/** How long the art runs before a still or a live thumbnail. */
const STILL_RUN_MS = 1_500;

const ArtStats = Schema.Struct({
  fps: Schema.Number,
  msPerSecond: Schema.Number,
  energy: BackdropEnergy,
  throttled: Schema.Boolean,
});
export type ThemeArtStats = typeof ArtStats.Type;
const ArtFailure = Schema.Struct({
  reason: BackdropFailureReason,
  detail: Schema.optional(Schema.String),
});
export type ThemeArtFailure = typeof ArtFailure.Type;
const decodeStats = Schema.decodeUnknownOption(Schema.fromJsonString(ArtStats));
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(ArtFailure));

export interface ThemePreviewReport {
  readonly shots: ReadonlyArray<{ readonly layout: ThemeSpecimenLayout; readonly png: string }>;
  /** What the art's runtime measured, when it reported in time. */
  readonly stats: ThemeArtStats | null;
  readonly failure: ThemeArtFailure | null;
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
}

export interface ThemeWorkshopShape {
  /** Downloads and embeds the hosted fonts a theme names. */
  readonly embedFonts: (manifest: ThemeManifest) => Effect.Effect<ThemeManifest, ThemeError>;
  /** Checks an unknown value as a theme and embeds its fonts: what gets saved or shown. */
  readonly prepare: (input: unknown) => Effect.Effect<ThemeManifest, ThemeError>;
  /** The specimen in both layouts, with the art's cost when it has art. */
  readonly preview: (
    manifest: ThemeManifest,
  ) => Effect.Effect<ThemePreviewReport, PagePreviewError>;
  /**
   * The theme with a still of its art, captured when it has art and no
   * still. Never fails: without the browser or when the art fails, the
   * theme stays as it was and `note` says why.
   */
  readonly withStill: (
    manifest: ThemeManifest,
  ) => Effect.Effect<{ readonly manifest: ThemeManifest; readonly note?: string }>;
  /** A small PNG data URL for the library, for a theme with art; null when there's none to make. */
  readonly thumbnail: (manifest: ThemeManifest) => Effect.Effect<string | null>;
}

export class ThemeWorkshop extends Context.Service<ThemeWorkshop, ThemeWorkshopShape>()(
  "threadlines/themes/ThemeWorkshop",
) {}

/** A theme's problems as one message, for a person or an agent to fix. */
export const themeProblems = (errors: ReadonlyArray<string>) =>
  new ThemeError({
    detail: `The theme has ${errors.length === 1 ? "a problem" : `${errors.length} problems`}:\n- ${errors.join("\n- ")}`,
  });

const pngDataUrl = (png: string) => `data:image/png;base64,${png}`;

/** Builds the workshop on a given fetch for fonts; `layer` uses the real one. */
export const makeThemeWorkshop = Effect.fn("ThemeWorkshop.make")(function* (
  options: { readonly fetch?: DownloadFetch } = {},
) {
  const previews = yield* PagePreview;
  const fetch =
    options.fetch ?? makeHttpsFetch({ allowedHosts: THEME_FONT_HOSTS, publicAddressesOnly: true });
  const cache = makeThemeFontCache();

  const embedFonts: ThemeWorkshopShape["embedFonts"] = (manifest) =>
    embedThemeFonts({ manifest, fetch, cache });

  const prepare: ThemeWorkshopShape["prepare"] = (input) =>
    Effect.gen(function* () {
      const check = checkThemeManifest(input);
      if (!check.ok) return yield* themeProblems(check.errors);
      // Embedded fonts add up to a megabyte: the theme as saved must still pass,
      // or another computer would refuse it in a merge.
      const embedded = checkThemeManifest(yield* embedFonts(check.manifest));
      if (!embedded.ok) return yield* themeProblems(embedded.errors);
      return embedded.manifest;
    });

  const specimen = (manifest: ThemeManifest, layout: ThemeSpecimenLayout) =>
    buildThemeSpecimenDocument({
      manifest,
      layout,
      width: THEME_SPECIMEN_WIDTH,
      height: THEME_SPECIMEN_HEIGHT,
    });

  const preview: ThemeWorkshopShape["preview"] = (manifest) =>
    Effect.gen(function* () {
      const art = manifest.backdrop !== undefined;
      const [thread, fresh, settings] = yield* previews.captureViewports({
        width: THEME_SPECIMEN_WIDTH,
        height: THEME_SPECIMEN_HEIGHT,
        shots: [
          {
            document: specimen(manifest, "thread"),
            waitMs: art ? ART_RUN_MS : 0,
            waitFor: art
              ? {
                  anyOf: [THEME_SPECIMEN_ATTRIBUTES.stats, THEME_SPECIMEN_ATTRIBUTES.failure],
                  maxMs: STATS_WAIT_MS,
                }
              : undefined,
            readAttributes: [THEME_SPECIMEN_ATTRIBUTES.stats, THEME_SPECIMEN_ATTRIBUTES.failure],
          },
          {
            document: specimen(manifest, "new-thread"),
            waitMs: art ? STILL_RUN_MS : 0,
            readAttributes: [THEME_SPECIMEN_ATTRIBUTES.failure],
          },
          {
            document: specimen(manifest, "settings"),
            waitMs: art ? STILL_RUN_MS : 0,
            readAttributes: [THEME_SPECIMEN_ATTRIBUTES.failure],
          },
        ],
      });
      const shotsTaken = [thread, fresh, settings];
      const attribute = (name: string) =>
        shotsTaken.map((shot) => shot?.attributes[name]).find((value) => value != null);
      return {
        shots: [
          { layout: "thread" as const, png: thread?.png ?? "" },
          { layout: "new-thread" as const, png: fresh?.png ?? "" },
          { layout: "settings" as const, png: settings?.png ?? "" },
        ].filter((shot) => shot.png.length > 0),
        stats: Option.getOrNull(decodeStats(attribute(THEME_SPECIMEN_ATTRIBUTES.stats))),
        failure: Option.getOrNull(decodeFailure(attribute(THEME_SPECIMEN_ATTRIBUTES.failure))),
        consoleMessages: shotsTaken.flatMap((shot) => shot?.consoleMessages ?? []),
      };
    });

  /** One shot of the art alone, or why there is none. */
  const captureArt = (manifest: ThemeManifest, scale: number) =>
    previews
      .captureViewports({
        width: THEME_SPECIMEN_WIDTH,
        height: THEME_SPECIMEN_HEIGHT,
        scale,
        installedOnly: true,
        shots: [
          {
            document: buildThemeArtDocument({ manifest }),
            waitMs: STILL_RUN_MS,
            readAttributes: [THEME_SPECIMEN_ATTRIBUTES.frame, THEME_SPECIMEN_ATTRIBUTES.failure],
          },
        ],
      })
      .pipe(
        Effect.map(([shot]) => {
          const failure = Option.getOrUndefined(
            decodeFailure(shot?.attributes[THEME_SPECIMEN_ATTRIBUTES.failure]),
          );
          if (failure !== undefined) {
            return { skipped: `the art failed in the preview browser (${failure.reason})` };
          }
          if (shot === undefined || shot.attributes[THEME_SPECIMEN_ATTRIBUTES.frame] == null) {
            return { skipped: "the art drew no frame in the preview browser" };
          }
          return { still: pngDataUrl(shot.png) };
        }),
        Effect.catch((error) => Effect.succeed({ skipped: error.message })),
      );

  const withStill: ThemeWorkshopShape["withStill"] = (manifest) =>
    Effect.gen(function* () {
      const backdrop = manifest.backdrop;
      if (backdrop === undefined || backdrop.still !== undefined) return { manifest };
      let captured = yield* captureArt(manifest, 1);
      // Busy art compresses badly; half size still fills a phone.
      if ("still" in captured && captured.still.length > THEME_MAX_STILL_CHARS) {
        captured = yield* captureArt(manifest, 0.5);
      }
      if ("skipped" in captured) {
        return { manifest, note: `It has no still yet: ${captured.skipped}.` };
      }
      if (captured.still.length > THEME_MAX_STILL_CHARS) {
        return { manifest, note: "It has no still: a frame of its art is too large to keep." };
      }
      return { manifest: { ...manifest, backdrop: { ...backdrop, still: captured.still } } };
    });

  const thumbnail: ThemeWorkshopShape["thumbnail"] = (manifest) =>
    Effect.gen(function* () {
      if (manifest.backdrop === undefined) return null;
      const still = manifest.backdrop.still !== undefined;
      const [shot] = yield* previews.captureViewports({
        width: THEME_SPECIMEN_WIDTH,
        height: THEME_SPECIMEN_HEIGHT,
        scale: THEME_THUMBNAIL_WIDTH / THEME_SPECIMEN_WIDTH,
        installedOnly: true,
        shots: [
          {
            document: buildThemeSpecimenDocument({
              manifest,
              layout: "new-thread",
              width: THEME_SPECIMEN_WIDTH,
              height: THEME_SPECIMEN_HEIGHT,
              art: still ? "still" : "live",
            }),
            waitMs: still ? 0 : STILL_RUN_MS,
          },
        ],
      });
      return shot === undefined ? null : pngDataUrl(shot.png);
    }).pipe(
      Effect.catch((error) =>
        Effect.logInfo("No thumbnail for a theme.", { reason: error.message }).pipe(
          Effect.as(null),
        ),
      ),
    );

  return ThemeWorkshop.of({ embedFonts, prepare, preview, withStill, thumbnail });
});

export const ThemeWorkshopLive = Layer.effect(ThemeWorkshop, makeThemeWorkshop());
