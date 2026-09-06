// @effect-diagnostics nodeBuiltinImport:off - child process entry, plain Node
/**
 * Dictation worker: the child process that owns the sherpa-onnx native addon.
 *
 * It runs as a hidden subcommand of the server binary (`threadlines
 * dictation-worker`) so the entry path resolves the same in dev, npm and
 * desktop builds. Keeping the addon out of the server process means a native
 * crash cannot take the server down, and the multi-second model load never
 * blocks the event loop.
 *
 * The parent sets the platform's library-path variable in the spawn env
 * before this process starts, so the addon's sibling shared libraries
 * resolve; the worker itself does nothing special about that.
 *
 * @module dictation/worker
 */
import { createRequire } from "node:module";

export type DictationWorkerRequest =
  | {
      readonly type: "load";
      readonly model: string;
      readonly addonPath: string;
      readonly config: unknown;
    }
  | {
      readonly type: "transcribe";
      readonly requestId: string;
      readonly samples: Int16Array;
      readonly sampleRate: number;
    }
  | { readonly type: "unload" }
  | { readonly type: "shutdown" };

export type DictationWorkerResponse =
  | { readonly type: "loaded"; readonly model: string }
  | { readonly type: "result"; readonly requestId: string; readonly text: string }
  | { readonly type: "error"; readonly requestId?: string; readonly message: string };

/** The handful of raw addon calls offline recognition needs. */
interface SherpaAddon {
  readonly createOfflineRecognizer: (config: unknown) => unknown;
  readonly createOfflineStream: (recognizer: unknown) => unknown;
  readonly acceptWaveformOffline: (
    stream: unknown,
    waveform: { readonly samples: Float32Array; readonly sampleRate: number },
  ) => void;
  readonly decodeOfflineStream: (recognizer: unknown, stream: unknown) => void;
  readonly getOfflineStreamResultAsJson: (stream: unknown) => string;
}

const toFloat32 = (samples: Int16Array): Float32Array => {
  const float = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    float[index] = samples[index]! / 32768;
  }
  return float;
};

const readText = (json: string): string => {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
    const text = (parsed as { readonly text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
};

/**
 * Runs the worker's message loop until the parent asks it to shut down or the
 * IPC channel closes. Exported so the CLI subcommand is a one-liner.
 */
export function runDictationWorker(): void {
  const send = (response: DictationWorkerResponse): void => {
    process.send?.(response);
  };

  let addon: SherpaAddon | undefined;
  let recognizer: unknown;
  let loadedModel: string | undefined;

  const unload = (): void => {
    recognizer = undefined;
    loadedModel = undefined;
  };

  const handle = (message: DictationWorkerRequest): void => {
    switch (message.type) {
      case "load": {
        if (loadedModel === message.model && recognizer !== undefined) {
          send({ type: "loaded", model: message.model });
          return;
        }
        unload();
        if (addon === undefined) {
          addon = createRequire(import.meta.url)(message.addonPath) as SherpaAddon;
        }
        recognizer = addon.createOfflineRecognizer(message.config);
        loadedModel = message.model;
        send({ type: "loaded", model: message.model });
        return;
      }
      case "transcribe": {
        if (addon === undefined || recognizer === undefined) {
          send({
            type: "error",
            requestId: message.requestId,
            message: "No dictation model is loaded.",
          });
          return;
        }
        const stream = addon.createOfflineStream(recognizer);
        addon.acceptWaveformOffline(stream, {
          samples: toFloat32(message.samples),
          sampleRate: message.sampleRate,
        });
        addon.decodeOfflineStream(recognizer, stream);
        send({
          type: "result",
          requestId: message.requestId,
          text: readText(addon.getOfflineStreamResultAsJson(stream)),
        });
        return;
      }
      case "unload": {
        unload();
        return;
      }
      case "shutdown": {
        unload();
        process.exit(0);
      }
    }
  };

  process.on("message", (message: DictationWorkerRequest) => {
    try {
      handle(message);
    } catch (cause) {
      send({
        type: "error",
        ...(message.type === "transcribe" ? { requestId: message.requestId } : {}),
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });

  // A disconnected parent means nothing will ever read our results again.
  process.on("disconnect", () => {
    process.exit(0);
  });
}
