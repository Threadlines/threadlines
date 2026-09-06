import * as Schema from "effect/Schema";

/**
 * Push-to-talk speech-to-text. Transcription runs on the Threadlines server
 * with a locally downloaded sherpa-onnx runtime and model, so audio never
 * leaves the machine.
 */

export const DictationModelId = Schema.Literals(["parakeet", "moonshine"]);
export type DictationModelId = typeof DictationModelId.Type;

/** Download lifecycle shared by the native runtime and each model. */
export const DictationDownloadState = Schema.Literals(["missing", "downloading", "ready"]);
export type DictationDownloadState = typeof DictationDownloadState.Type;

export const DictationModelStatus = Schema.Struct({
  id: DictationModelId,
  state: DictationDownloadState,
  bytesDownloaded: Schema.Number,
  /** Catalog size, known before the download starts. */
  bytesTotal: Schema.Number,
  /** Last download failure, cleared when a retry starts. */
  error: Schema.NullOr(Schema.String),
});
export type DictationModelStatus = typeof DictationModelStatus.Type;

export const DictationRuntimeStatus = Schema.Struct({
  /** False when no prebuilt native addon exists for this platform/arch. */
  supported: Schema.Boolean,
  state: DictationDownloadState,
  bytesDownloaded: Schema.Number,
  bytesTotal: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type DictationRuntimeStatus = typeof DictationRuntimeStatus.Type;

/** State of the transcription worker process. */
export const DictationEngineState = Schema.Literals(["idle", "loading", "ready", "busy"]);
export type DictationEngineState = typeof DictationEngineState.Type;

export const DictationStatus = Schema.Struct({
  runtime: DictationRuntimeStatus,
  /** Always every catalog model, in catalog order. */
  models: Schema.Array(DictationModelStatus),
  engine: DictationEngineState,
  loadedModel: Schema.NullOr(DictationModelId),
  /** Where the runtime and models live on the server, shown in Settings. */
  modelsDir: Schema.String,
});
export type DictationStatus = typeof DictationStatus.Type;

/** One clip per request: PCM16 mono at 16 kHz, base64 encoded. */
export const DictationTranscribeInput = Schema.Struct({
  audioBase64: Schema.String,
  sampleRate: Schema.Literal(16000),
  durationMs: Schema.Number,
});
export type DictationTranscribeInput = typeof DictationTranscribeInput.Type;

export const DictationTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type DictationTranscribeResult = typeof DictationTranscribeResult.Type;

export const DictationModelRequest = Schema.Struct({
  model: DictationModelId,
});
export type DictationModelRequest = typeof DictationModelRequest.Type;

export const DictationErrorCode = Schema.Literals([
  "unsupported_platform",
  "runtime_missing",
  "model_missing",
  "download_failed",
  "download_cancelled",
  "audio_invalid",
  "busy",
  "engine_failed",
]);
export type DictationErrorCode = typeof DictationErrorCode.Type;

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  code: DictationErrorCode,
  message: Schema.String,
}) {}

/** The wire cap on a single clip; longer recordings are rejected. */
export const DICTATION_MAX_CLIP_MS = 120_000;
export const DICTATION_SAMPLE_RATE = 16_000;
