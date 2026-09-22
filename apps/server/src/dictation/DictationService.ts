// @effect-diagnostics nodeBuiltinImport:off - platform detection and path joins
/**
 * DictationService - the server side of composer dictation.
 *
 * Owns the observable `DictationStatus` (native runtime, both models, engine),
 * the on-demand downloads that produce it, and transcription itself. Audio
 * arrives as one base64 PCM16 clip per request and is handed to the worker
 * process; nothing leaves the machine.
 *
 * @module dictation/DictationService
 */
import * as nodePath from "node:path";

import {
  DICTATION_MAX_CLIP_MS,
  DictationError,
  type DictationModelId,
  type DictationModelStatus,
  type DictationStatus,
  type DictationTranscribeInput,
  type DictationTranscribeResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DICTATION_ADDON_FILE,
  DICTATION_MODELS,
  dictationModel,
  dictationNumThreads,
  modelBytesOnDisk,
  modelFileUrl,
  modelIsReady,
  modelTotalBytes,
  resolveRuntimePackage,
  runtimeDirectoryName,
  type DictationRuntimePackage,
} from "./catalog.ts";
import { DictationEngine, DictationEngineLive } from "./DictationEngine.ts";
import { DictationDownloader, DictationDownloaderLive } from "./download.ts";
import { extractNpmTarball } from "./npmTarball.ts";

/**
 * The registry tarballs are all around 22 MB. The exact size is not known
 * before the request, so this is only what progress is shown against.
 */
export const DICTATION_RUNTIME_APPROX_BYTES = 22 * 1024 * 1024;

/** Progress is noisy; publishing more often than this just burns frames. */
const PROGRESS_PUBLISH_INTERVAL_MS = 100;

/** Sample count may drift from the declared duration by at most this share. */
const DURATION_TOLERANCE = 0.1;

export interface DictationServiceShape {
  readonly status: Effect.Effect<DictationStatus>;
  /** Current status first, then every change. */
  readonly streamChanges: Stream.Stream<DictationStatus>;
  readonly downloadModel: (model: DictationModelId) => Effect.Effect<void, DictationError>;
  readonly cancelDownload: (model: DictationModelId) => Effect.Effect<void>;
  readonly removeModel: (model: DictationModelId) => Effect.Effect<void, DictationError>;
  /** Loads the selected model ahead of the first clip. Never fails. */
  readonly warmUp: Effect.Effect<void>;
  readonly transcribe: (
    input: DictationTranscribeInput,
  ) => Effect.Effect<DictationTranscribeResult, DictationError>;
}

export class DictationService extends Context.Service<DictationService, DictationServiceShape>()(
  "threadlines/dictation/DictationService",
) {}

const dictationError = (code: DictationError["code"], message: string) =>
  new DictationError({ code, message });

/** Decodes base64 PCM16 into the sample array the worker expects. */
function decodePcm16(audioBase64: string): Int16Array {
  const bytes = Buffer.from(audioBase64, "base64");
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2);
  }
  return samples;
}

function validateAudio(input: DictationTranscribeInput): DictationError | undefined {
  if (input.durationMs <= 0 || input.durationMs > DICTATION_MAX_CLIP_MS) {
    return dictationError(
      "audio_invalid",
      `Recording must be between 0 and ${DICTATION_MAX_CLIP_MS / 1000} seconds.`,
    );
  }
  const byteLength = Buffer.from(input.audioBase64, "base64").length;
  if (byteLength === 0 || byteLength % 2 !== 0) {
    return dictationError("audio_invalid", "Recording is not 16-bit PCM audio.");
  }
  const expectedSamples = (input.durationMs / 1000) * input.sampleRate;
  const actualSamples = byteLength / 2;
  if (Math.abs(actualSamples - expectedSamples) > expectedSamples * DURATION_TOLERANCE) {
    return dictationError("audio_invalid", "Recording length does not match the audio sent.");
  }
  return undefined;
}

const initialModelStatus = (id: DictationModelId): DictationModelStatus => ({
  id,
  state: "missing",
  bytesDownloaded: 0,
  bytesTotal: modelTotalBytes(dictationModel(id)),
  error: null,
});

const makeDictationService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const engine = yield* DictationEngine;
  const downloader = yield* DictationDownloader;

  const runtimePackage = resolveRuntimePackage(process.platform, process.arch);
  const speechDir = config.speechModelsDir;
  const runtimeRoot = nodePath.join(speechDir, "runtime");
  const runtimeDir =
    runtimePackage === null
      ? runtimeRoot
      : nodePath.join(runtimeRoot, runtimeDirectoryName(runtimePackage));
  const addonPath = nodePath.join(runtimeDir, DICTATION_ADDON_FILE);
  const modelDirFor = (model: DictationModelId) => nodePath.join(speechDir, model);

  const runtimeIsReady = fs.exists(addonPath).pipe(Effect.orElseSucceed(() => false));

  const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const statusRef = yield* SubscriptionRef.make<DictationStatus>({
    runtime: {
      supported: runtimePackage !== null,
      state: "missing",
      bytesDownloaded: 0,
      bytesTotal: DICTATION_RUNTIME_APPROX_BYTES,
      error: null,
    },
    models: DICTATION_MODELS.map((entry) => initialModelStatus(entry.id)),
    engine: "idle",
    loadedModel: null,
    modelsDir: speechDir,
  });

  const updateRuntime = (
    update: (current: DictationStatus["runtime"]) => DictationStatus["runtime"],
  ) =>
    SubscriptionRef.update(statusRef, (status) => ({ ...status, runtime: update(status.runtime) }));

  const updateModel = (
    model: DictationModelId,
    update: (current: DictationModelStatus) => DictationModelStatus,
  ) =>
    SubscriptionRef.update(statusRef, (status) => ({
      ...status,
      models: status.models.map((entry) => (entry.id === model ? update(entry) : entry)),
    }));

  // Initial scan: whatever is already on disk decides the starting status.
  yield* Effect.gen(function* () {
    const readyRuntime = yield* runtimeIsReady;
    if (readyRuntime) {
      yield* updateRuntime((runtime) => ({
        ...runtime,
        state: "ready",
        bytesDownloaded: runtime.bytesTotal,
      }));
    }
    for (const entry of DICTATION_MODELS) {
      const modelDir = modelDirFor(entry.id);
      const ready = yield* modelIsReady(entry, modelDir);
      const bytes = ready ? modelTotalBytes(entry) : yield* modelBytesOnDisk(entry, modelDir);
      yield* updateModel(entry.id, (current) => ({
        ...current,
        state: ready ? "ready" : "missing",
        bytesDownloaded: bytes,
      }));
    }
  });

  // The engine transitions on its own (idle unload, worker crash), so status
  // mirrors it instead of being written at each call site.
  yield* engine.changes.pipe(
    Stream.runForEach((snapshot) =>
      SubscriptionRef.update(statusRef, (status) => ({
        ...status,
        engine: snapshot.state,
        loadedModel: snapshot.loadedModel,
      })),
    ),
    Effect.forkScoped,
  );

  const downloads = yield* FiberMap.make<DictationModelId>();
  const runtimeLock = yield* Semaphore.make(1);

  /** Publishes at most every `PROGRESS_PUBLISH_INTERVAL_MS`. */
  const makeProgressPublisher = (publish: (bytes: number) => Effect.Effect<void>) => {
    let lastPublishedAt = 0;
    return (bytes: number) =>
      Effect.suspend(() => {
        const now = Date.now();
        if (now - lastPublishedAt < PROGRESS_PUBLISH_INTERVAL_MS) {
          return Effect.void;
        }
        lastPublishedAt = now;
        return publish(bytes);
      });
  };

  const ensureRuntime = (packageInfo: DictationRuntimePackage) =>
    runtimeLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* runtimeIsReady) {
          return;
        }
        yield* updateRuntime((runtime) => ({
          ...runtime,
          state: "downloading",
          bytesDownloaded: 0,
          error: null,
        }));

        const tarballPath = nodePath.join(runtimeRoot, ".download.tgz");
        const onProgress = makeProgressPublisher((bytes) =>
          updateRuntime((runtime) => ({ ...runtime, bytesDownloaded: bytes })),
        );
        yield* downloader
          .downloadFile({ url: packageInfo.tarballUrl, destPath: tarballPath, onProgress })
          .pipe(Effect.mapError((cause) => dictationError("download_failed", cause.message)));
        yield* extractNpmTarball(tarballPath, runtimeDir).pipe(
          Effect.mapError((cause) =>
            dictationError("download_failed", `Failed to unpack the speech runtime: ${cause}`),
          ),
        );
        yield* fs.remove(tarballPath, { force: true }).pipe(Effect.ignore);

        if (!(yield* runtimeIsReady)) {
          return yield* Effect.fail(
            dictationError(
              "download_failed",
              `The speech runtime package did not contain ${DICTATION_ADDON_FILE}.`,
            ),
          );
        }
        yield* updateRuntime((runtime) => ({
          ...runtime,
          state: "ready",
          bytesDownloaded: runtime.bytesTotal,
          error: null,
        }));
      }).pipe(
        Effect.tapError((error) =>
          updateRuntime((runtime) => ({
            ...runtime,
            state: "missing",
            bytesDownloaded: 0,
            error: error.message,
          })),
        ),
        Effect.onInterrupt(() =>
          updateRuntime((runtime) => ({ ...runtime, state: "missing", bytesDownloaded: 0 })),
        ),
      ),
    );

  const downloadJob = (model: DictationModelId, packageInfo: DictationRuntimePackage) =>
    Effect.gen(function* () {
      yield* ensureRuntime(packageInfo);

      const entry = dictationModel(model);
      const modelDir = modelDirFor(model);
      yield* fs
        .makeDirectory(modelDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            dictationError("download_failed", `Failed to create ${modelDir}: ${cause}`),
          ),
        );

      let completedBytes = yield* modelBytesOnDisk(entry, modelDir);
      const onProgress = makeProgressPublisher((bytes) =>
        updateModel(model, (current) => ({ ...current, bytesDownloaded: bytes })),
      );
      yield* updateModel(model, (current) => ({ ...current, bytesDownloaded: completedBytes }));

      for (const file of entry.files) {
        const destPath = nodePath.join(modelDir, file.name);
        const alreadyThere = yield* fs.stat(destPath).pipe(
          Effect.map((info) => info.type === "File" && Number(info.size) === file.bytes),
          Effect.orElseSucceed(() => false),
        );
        if (alreadyThere) {
          continue;
        }
        const bytesBefore = completedBytes;
        yield* downloader
          .downloadFile({
            url: modelFileUrl(entry, file),
            destPath,
            expectedBytes: file.bytes,
            onProgress: (bytes) => onProgress(bytesBefore + bytes),
          })
          .pipe(Effect.mapError((cause) => dictationError("download_failed", cause.message)));
        completedBytes += file.bytes;
      }

      yield* updateModel(model, (current) => ({
        ...current,
        state: "ready",
        bytesDownloaded: current.bytesTotal,
        error: null,
      }));
    }).pipe(
      Effect.tapError((error) =>
        updateModel(model, (current) => ({
          ...current,
          state: "missing",
          error: error.message,
        })),
      ),
      // A cancelled download keeps whatever whole files landed and clears the
      // spinner; `downloadFile` already removed the in-flight `.part`.
      Effect.onInterrupt(() =>
        updateModel(model, (current) => ({ ...current, state: "missing", error: null })),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const downloadModel = (model: DictationModelId) =>
    Effect.gen(function* () {
      if (runtimePackage === null) {
        return yield* Effect.fail(
          dictationError(
            "unsupported_platform",
            "Dictation is not available for this platform yet.",
          ),
        );
      }
      const status = yield* SubscriptionRef.get(statusRef);
      const current = status.models.find((entry) => entry.id === model);
      if (current?.state === "ready" || current?.state === "downloading") {
        return;
      }
      yield* updateModel(model, (entry) => ({ ...entry, state: "downloading", error: null }));
      yield* FiberMap.run(downloads, model, downloadJob(model, runtimePackage));
    });

  const cancelDownload = (model: DictationModelId) => FiberMap.remove(downloads, model);

  const removeModel = (model: DictationModelId) =>
    Effect.gen(function* () {
      yield* cancelDownload(model);
      const snapshot = yield* engine.snapshot;
      if (snapshot.loadedModel === model) {
        yield* engine.unload;
      }
      yield* fs
        .remove(modelDirFor(model), { recursive: true, force: true })
        .pipe(
          Effect.mapError((cause) =>
            dictationError("download_failed", `Failed to remove the model files: ${cause}`),
          ),
        );
      yield* updateModel(model, (current) => ({
        ...current,
        state: "missing",
        bytesDownloaded: 0,
        error: null,
      }));
    });

  const selectedModel = settings.getSettings.pipe(
    Effect.map((current) => current.dictationModel),
    Effect.orElseSucceed(() => "parakeet" as const satisfies DictationModelId),
  );

  const loadSelectedModel = (model: DictationModelId, packageInfo: DictationRuntimePackage) =>
    engine.load({
      model,
      config: dictationModel(model).recognizerConfig(modelDirFor(model), dictationNumThreads()),
      runtimeDir,
      libraryPathEnv: packageInfo.libraryPathEnv,
    });

  const warmUp = Effect.gen(function* () {
    if (runtimePackage === null || !(yield* runtimeIsReady)) {
      return;
    }
    const model = yield* selectedModel;
    if (!(yield* modelIsReady(dictationModel(model), modelDirFor(model)))) {
      return;
    }
    yield* loadSelectedModel(model, runtimePackage);
  }).pipe(Effect.ignoreCause({ log: true }));

  const transcribe = (input: DictationTranscribeInput) =>
    Effect.gen(function* () {
      const invalid = validateAudio(input);
      if (invalid) {
        return yield* Effect.fail(invalid);
      }
      if (runtimePackage === null) {
        return yield* Effect.fail(
          dictationError(
            "unsupported_platform",
            "Dictation is not available for this platform yet.",
          ),
        );
      }
      if (!(yield* runtimeIsReady)) {
        return yield* Effect.fail(
          dictationError("runtime_missing", "The speech runtime has not been downloaded yet."),
        );
      }
      const model = yield* selectedModel;
      if (!(yield* modelIsReady(dictationModel(model), modelDirFor(model)))) {
        return yield* Effect.fail(
          dictationError("model_missing", "The selected dictation model is not downloaded yet."),
        );
      }

      yield* loadSelectedModel(model, runtimePackage);
      const text = yield* engine.transcribe(decodePcm16(input.audioBase64), input.sampleRate);
      return { text: text.trim() } satisfies DictationTranscribeResult;
    });

  return {
    status: SubscriptionRef.get(statusRef),
    // Current value first, then every change; nothing is lost in between.
    streamChanges: SubscriptionRef.changes(statusRef),
    // The service owns a `FileSystem` for its whole lifetime, so callers get
    // plain effects with nothing left to provide.
    downloadModel: (model) => withFileSystem(downloadModel(model)),
    cancelDownload,
    removeModel: (model) => withFileSystem(removeModel(model)),
    warmUp: withFileSystem(warmUp),
    transcribe: (input) => withFileSystem(transcribe(input)),
  } satisfies DictationServiceShape;
});

export const DictationServiceLive = Layer.effect(DictationService, makeDictationService);

/** Everything dictation needs: the worker engine, the downloader, the service. */
export const DictationLive = DictationServiceLive.pipe(
  Layer.provide(DictationEngineLive),
  Layer.provide(DictationDownloaderLive),
);
