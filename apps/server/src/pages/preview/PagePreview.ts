/**
 * PagePreview — runs published pages in the preview browser: a screenshot
 * for an agent checking its page before publishing, and the page's height at
 * the chat's widths, so the chat can reserve room before the page loads.
 *
 * Each call runs its own browser, at most two at once. The browser is
 * installed the first time either is asked for; a measurement never waits
 * for that.
 *
 * @module pages/preview/PagePreview
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as HeadlessChrome from "./headlessChrome.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

export type PagePreviewError =
  | PreviewBrowser.PagePreviewInstallingError
  | PreviewBrowser.PagePreviewUnsupportedError
  | PreviewBrowser.PagePreviewInstallError
  | HeadlessChrome.PagePreviewSandboxError
  | HeadlessChrome.PagePreviewBrowserError;

export interface PagePreviewResult {
  /** Base64 PNG of the iframe area, its top `capturedHeight` CSS pixels. */
  readonly png: string;
  readonly width: number;
  /** The last height the page reported with `ui/notifications/size-changed`; 0 if none arrived. */
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<{
    readonly level: "log" | "info" | "warning" | "error";
    readonly text: string;
  }>;
}

export class PagePreview extends Context.Service<
  PagePreview,
  {
    /**
     * Screenshot a built page document at a CSS width (240-1600). Starts the
     * one-time install if needed; while installing, fails with
     * PagePreviewInstallingError (message tells the agent to retry in about a
     * minute).
     */
    readonly preview: (input: {
      readonly document: string;
      readonly width: number;
    }) => Effect.Effect<PagePreviewResult, PagePreviewError>;
    /**
     * Content heights at each width, ascending by width. Option.none() when
     * the browser is not installed yet (kick off the install in the
     * background, never wait for it), or when measuring fails or exceeds 6 s.
     * Never fails.
     */
    readonly measure: (input: {
      readonly document: string;
      readonly widths: ReadonlyArray<number>;
    }) => Effect.Effect<Option.Option<ReadonlyArray<readonly [number, number]>>>;
  }
>()("threadlines/pages/PagePreview") {}

export const MIN_PREVIEW_WIDTH = 240;
export const MAX_PREVIEW_WIDTH = 1_600;
// Each preview or measurement runs its own browser; more at once mostly costs memory.
const MAX_CONCURRENT_BROWSERS = 2;
const CAPTURE_TIMEOUT = "20 seconds";
// Publishing waits this long at most for heights, then goes on without them.
const MEASURE_TIMEOUT: Duration.Input = "6 seconds";

/** Builds the service on a given browser installer; `layer` uses the real one. */
export const makePagePreview = Effect.fn("PagePreview.make")(function* (
  browser: PreviewBrowser.PreviewBrowser,
  options: {
    /** Test seam: the cap on one measurement. */
    readonly measureTimeout?: Duration.Input;
  } = {},
) {
  const measureTimeout = Duration.fromInputUnsafe(options.measureTimeout ?? MEASURE_TIMEOUT);
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const browsers = yield* Semaphore.make(MAX_CONCURRENT_BROWSERS);

  const preview = Effect.fn("PagePreview.preview")(function* (input: {
    readonly document: string;
    readonly width: number;
  }) {
    const width = Math.min(
      MAX_PREVIEW_WIDTH,
      Math.max(MIN_PREVIEW_WIDTH, Math.round(Number.isFinite(input.width) ? input.width : 0)),
    );
    const capture = yield* Effect.scoped(
      Effect.gen(function* () {
        // Leased before the browser starts, so the lease outlives it.
        const executable = yield* browser.acquire;
        return yield* browsers.withPermits(1)(
          HeadlessChrome.capturePage({ executable, document: input.document, width }).pipe(
            Effect.timeoutOrElse({
              duration: CAPTURE_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new HeadlessChrome.PagePreviewBrowserError({
                    reason: `the page did not finish loading within ${CAPTURE_TIMEOUT}`,
                  }),
                ),
            }),
          ),
        );
      }),
    ).pipe(Effect.provideContext(services));
    return { ...capture, width } satisfies PagePreviewResult;
  });

  const measure = (input: { readonly document: string; readonly widths: ReadonlyArray<number> }) =>
    Effect.gen(function* () {
      const widths = [
        ...new Set(input.widths.filter((width) => Number.isFinite(width)).map(Math.round)),
      ]
        .filter((width) => width > 0)
        .toSorted((left, right) => left - right);
      if (widths.length === 0) return Option.some([]);
      const heights = yield* Effect.scoped(
        Effect.gen(function* () {
          const executable = yield* browser.acquireInstalled;
          if (Option.isNone(executable)) return Option.none();
          return Option.some(
            yield* browsers.withPermits(1)(
              HeadlessChrome.measurePage({
                executable: executable.value,
                document: input.document,
                widths,
              }),
            ),
          );
        }),
      ).pipe(
        Effect.provideContext(services),
        Effect.timeoutOrElse({
          duration: measureTimeout,
          orElse: () =>
            Effect.fail(
              new HeadlessChrome.PagePreviewBrowserError({
                reason: `measuring took longer than ${Duration.format(measureTimeout)}`,
              }),
            ),
        }),
      );
      return Option.map(heights, (measured) =>
        measured.toSorted(([left], [right]) => left - right),
      );
    }).pipe(
      // Publishing must go on whatever went wrong here, unless it was stopped itself.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Could not measure a page; it publishes without heights.", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(Option.none())),
      ),
      Effect.withSpan("PagePreview.measure"),
    );

  return PagePreview.of({ preview, measure });
});

export const layer: Layer.Layer<
  PagePreview,
  never,
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  PagePreview,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // `providerStatusCacheDir` is `<baseDir>/caches`, shared by dev and live servers.
    const browser = yield* PreviewBrowser.makePreviewBrowser({
      cachesDir: config.providerStatusCacheDir,
    });
    return yield* makePagePreview(browser);
  }),
);
