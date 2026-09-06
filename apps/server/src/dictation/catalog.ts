// @effect-diagnostics nodeBuiltinImport:off - platform detection and path joins
/**
 * Catalog of everything dictation downloads: the prebuilt sherpa-onnx native
 * runtime for the host platform, and the speech models. Sizes are exact so a
 * model directory can be declared ready without hashing, and so download
 * progress is byte-accurate before the first byte arrives.
 *
 * @module dictation/catalog
 */
import * as os from "node:os";
import * as nodePath from "node:path";

import type { DictationModelId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** npm version of the `sherpa-onnx-<platform>-<arch>` runtime packages. */
export const DICTATION_RUNTIME_VERSION = "1.13.7";

/** File the native addon is loaded from inside an extracted runtime package. */
export const DICTATION_ADDON_FILE = "sherpa-onnx.node";

/**
 * Environment variable the child process needs pointed at the runtime
 * directory so the addon's sibling shared libraries resolve.
 */
export type DictationLibraryPathEnv = "PATH" | "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH";

export interface DictationRuntimePackage {
  readonly packageName: string;
  readonly tarballUrl: string;
  readonly addonFile: string;
  readonly libraryPathEnv: DictationLibraryPathEnv;
}

const RUNTIME_PACKAGES: ReadonlyArray<{
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packageName: string;
  readonly libraryPathEnv: DictationLibraryPathEnv;
}> = [
  // The publisher renamed win32-x64 to win-x64 to dodge registry spam filters.
  { platform: "win32", arch: "x64", packageName: "sherpa-onnx-win-x64", libraryPathEnv: "PATH" },
  {
    platform: "darwin",
    arch: "arm64",
    packageName: "sherpa-onnx-darwin-arm64",
    libraryPathEnv: "DYLD_LIBRARY_PATH",
  },
  {
    platform: "darwin",
    arch: "x64",
    packageName: "sherpa-onnx-darwin-x64",
    libraryPathEnv: "DYLD_LIBRARY_PATH",
  },
  {
    platform: "linux",
    arch: "x64",
    packageName: "sherpa-onnx-linux-x64",
    libraryPathEnv: "LD_LIBRARY_PATH",
  },
  {
    platform: "linux",
    arch: "arm64",
    packageName: "sherpa-onnx-linux-arm64",
    libraryPathEnv: "LD_LIBRARY_PATH",
  },
];

/** `null` when no prebuilt addon is published for this platform/arch. */
export function resolveRuntimePackage(
  platform: NodeJS.Platform,
  arch: string,
): DictationRuntimePackage | null {
  const entry = RUNTIME_PACKAGES.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!entry) {
    return null;
  }
  return {
    packageName: entry.packageName,
    tarballUrl: `https://registry.npmjs.org/${entry.packageName}/-/${entry.packageName}-${DICTATION_RUNTIME_VERSION}.tgz`,
    addonFile: DICTATION_ADDON_FILE,
    libraryPathEnv: entry.libraryPathEnv,
  };
}

/** Directory name the extracted runtime lives under, inside `runtime/`. */
export function runtimeDirectoryName(runtimePackage: DictationRuntimePackage): string {
  return `${runtimePackage.packageName}-${DICTATION_RUNTIME_VERSION}`;
}

export interface DictationModelFile {
  readonly name: string;
  readonly bytes: number;
}

/**
 * Recognizer config accepted by `createOfflineRecognizer`. Model paths are
 * absolute; the shape mirrors what `sherpa-onnx-node` builds.
 */
export interface DictationRecognizerConfig {
  readonly featConfig: { readonly sampleRate: number; readonly featureDim: number };
  readonly modelConfig: Record<string, unknown>;
  readonly decodingMethod: string;
}

export interface DictationModelEntry {
  readonly id: DictationModelId;
  readonly label: string;
  readonly hfRepo: string;
  readonly files: ReadonlyArray<DictationModelFile>;
  readonly recognizerConfig: (modelDir: string, numThreads: number) => DictationRecognizerConfig;
}

const FEAT_CONFIG = { sampleRate: 16000, featureDim: 80 } as const;

const joinModelPath = (modelDir: string, file: string) => nodePath.join(modelDir, file);

export const DICTATION_MODELS: ReadonlyArray<DictationModelEntry> = [
  {
    id: "parakeet",
    label: "Parakeet TDT 0.6B v2",
    hfRepo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    files: [
      { name: "encoder.int8.onnx", bytes: 652184296 },
      { name: "decoder.int8.onnx", bytes: 7257753 },
      { name: "joiner.int8.onnx", bytes: 1739080 },
      { name: "tokens.txt", bytes: 9384 },
    ],
    recognizerConfig: (modelDir, numThreads) => ({
      featConfig: FEAT_CONFIG,
      modelConfig: {
        transducer: {
          encoder: joinModelPath(modelDir, "encoder.int8.onnx"),
          decoder: joinModelPath(modelDir, "decoder.int8.onnx"),
          joiner: joinModelPath(modelDir, "joiner.int8.onnx"),
        },
        tokens: joinModelPath(modelDir, "tokens.txt"),
        modelType: "nemo_transducer",
        numThreads,
        debug: 0,
      },
      decodingMethod: "greedy_search",
    }),
  },
  {
    id: "moonshine",
    label: "Moonshine tiny en",
    hfRepo: "csukuangfj/sherpa-onnx-moonshine-tiny-en-int8",
    files: [
      { name: "preprocess.onnx", bytes: 6800738 },
      { name: "encode.int8.onnx", bytes: 18249187 },
      { name: "uncached_decode.int8.onnx", bytes: 53216096 },
      { name: "cached_decode.int8.onnx", bytes: 45264830 },
      { name: "tokens.txt", bytes: 436688 },
    ],
    recognizerConfig: (modelDir, numThreads) => ({
      featConfig: FEAT_CONFIG,
      modelConfig: {
        moonshine: {
          preprocessor: joinModelPath(modelDir, "preprocess.onnx"),
          encoder: joinModelPath(modelDir, "encode.int8.onnx"),
          uncachedDecoder: joinModelPath(modelDir, "uncached_decode.int8.onnx"),
          cachedDecoder: joinModelPath(modelDir, "cached_decode.int8.onnx"),
        },
        tokens: joinModelPath(modelDir, "tokens.txt"),
        numThreads,
        debug: 0,
      },
      decodingMethod: "greedy_search",
    }),
  },
];

export function dictationModel(id: DictationModelId): DictationModelEntry {
  const entry = DICTATION_MODELS.find((model) => model.id === id);
  if (!entry) {
    throw new Error(`Unknown dictation model: ${id}`);
  }
  return entry;
}

export function modelTotalBytes(entry: DictationModelEntry): number {
  return entry.files.reduce((total, file) => total + file.bytes, 0);
}

/** Hugging Face serves individual files, so no archive extraction is needed. */
export function modelFileUrl(entry: DictationModelEntry, file: DictationModelFile): string {
  return `https://huggingface.co/${entry.hfRepo}/resolve/main/${file.name}`;
}

/** Decoding threads: enough to matter, few enough to leave the UI responsive. */
export function dictationNumThreads(): number {
  return Math.min(4, os.availableParallelism());
}

/**
 * A model directory counts as downloaded only when every catalog file is
 * present at exactly its catalog size, so an interrupted download can never
 * be mistaken for a usable model.
 */
export const modelIsReady = Effect.fn(function* (entry: DictationModelEntry, modelDir: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of entry.files) {
    const info = yield* fs
      .stat(joinModelPath(modelDir, file.name))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined || info.type !== "File" || Number(info.size) !== file.bytes) {
      return false;
    }
  }
  return true;
});

/** Bytes already on disk for a model, counting only files at catalog size. */
export const modelBytesOnDisk = Effect.fn(function* (entry: DictationModelEntry, modelDir: string) {
  const fs = yield* FileSystem.FileSystem;
  let bytes = 0;
  for (const file of entry.files) {
    const info = yield* fs
      .stat(joinModelPath(modelDir, file.name))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (info !== undefined && info.type === "File" && Number(info.size) === file.bytes) {
      bytes += file.bytes;
    }
  }
  return bytes;
});
