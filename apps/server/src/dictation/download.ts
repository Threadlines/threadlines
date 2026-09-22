// @effect-diagnostics nodeBuiltinImport:off - path resolution for the .part file
/**
 * Streaming file download used for the dictation runtime tarball and model
 * files. Bytes land in a sibling `.part` file and are renamed into place only
 * once the expected byte count arrives, so a cancelled or failed download can
 * never leave something that looks complete.
 *
 * @module dictation/download
 */
import * as nodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class DictationDownloadError extends Error {
  readonly _tag = "DictationDownloadError";
}

export interface DownloadFileOptions {
  readonly url: string;
  readonly destPath: string;
  /** Catalog size; a mismatch fails the download. `undefined` skips the check. */
  readonly expectedBytes?: number;
  /** Called with the running byte count for this file. */
  readonly onProgress?: (bytesDownloaded: number) => Effect.Effect<void>;
}

export interface DictationDownloaderShape {
  /**
   * Downloads one file. Interruptible: on interrupt or failure the partial
   * file is removed and nothing appears at `destPath`.
   */
  readonly downloadFile: (
    options: DownloadFileOptions,
  ) => Effect.Effect<void, DictationDownloadError>;
}

/**
 * Isolated so `DictationService` can be tested without a network: tests
 * provide a layer that writes bytes straight to disk.
 */
export class DictationDownloader extends Context.Service<
  DictationDownloader,
  DictationDownloaderShape
>()("threadlines/dictation/DictationDownloader") {}

const removeQuietly = (fs: FileSystem.FileSystem, path: string) =>
  fs.remove(path, { force: true }).pipe(Effect.ignore);

export const DictationDownloaderLive = Layer.effect(
  DictationDownloader,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Redirects are followed by the underlying fetch, which Hugging Face
    // relies on to hand off to its CDN.
    const client = yield* HttpClient.HttpClient;

    const downloadFile: DictationDownloaderShape["downloadFile"] = Effect.fn(
      "dictation.downloadFile",
    )(function* (options: DownloadFileOptions) {
      const partPath = `${options.destPath}.part`;

      yield* fs
        .makeDirectory(nodePath.dirname(options.destPath), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new DictationDownloadError(`Failed to prepare download directory: ${cause}`),
          ),
        );
      yield* removeQuietly(fs, partPath);

      const download = Effect.gen(function* () {
        const response = yield* client
          .execute(HttpClientRequest.get(options.url))
          .pipe(
            Effect.mapError(
              (cause) => new DictationDownloadError(`Failed to request ${options.url}: ${cause}`),
            ),
          );

        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            new DictationDownloadError(
              `Download of ${options.url} failed with HTTP ${response.status}`,
            ),
          );
        }

        let bytesDownloaded = 0;
        yield* response.stream.pipe(
          Stream.tap((chunk) => {
            bytesDownloaded += chunk.length;
            return options.onProgress?.(bytesDownloaded) ?? Effect.void;
          }),
          Stream.run(fs.sink(partPath)),
          Effect.mapError(
            (cause) => new DictationDownloadError(`Download of ${options.url} failed: ${cause}`),
          ),
        );

        if (options.expectedBytes !== undefined && bytesDownloaded !== options.expectedBytes) {
          return yield* Effect.fail(
            new DictationDownloadError(
              `Download of ${options.url} returned ${bytesDownloaded} bytes, expected ${options.expectedBytes}`,
            ),
          );
        }

        yield* fs
          .rename(partPath, options.destPath)
          .pipe(
            Effect.mapError(
              (cause) =>
                new DictationDownloadError(`Failed to finish ${options.destPath}: ${cause}`),
            ),
          );
      });

      yield* download.pipe(
        Effect.onExit((exit) =>
          exit._tag === "Success" ? Effect.void : removeQuietly(fs, partPath),
        ),
      );
    });

    return { downloadFile } satisfies DictationDownloaderShape;
  }),
);
