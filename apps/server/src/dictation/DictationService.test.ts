// @effect-diagnostics nodeBuiltinImport:off - path joins for fixture assertions
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  DictationDownloadState,
  DictationModelId,
  DictationModelStatus,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DICTATION_ADDON_FILE,
  dictationModel,
  modelTotalBytes,
  resolveRuntimePackage,
  runtimeDirectoryName,
} from "./catalog.ts";
import {
  DictationEngine,
  type DictationEngineShape,
  type DictationEngineSnapshot,
} from "./DictationEngine.ts";
import { DictationService, DictationServiceLive } from "./DictationService.ts";
import { DictationDownloader, DictationDownloadError } from "./download.ts";

const MODEL: DictationModelId = "moonshine";

interface EngineProbe {
  readonly loads: Ref.Ref<ReadonlyArray<DictationModelId>>;
  readonly unloads: Ref.Ref<number>;
}

/** Records what the service asked the worker to do and returns fixed text. */
const makeEngineLayer = (probe: EngineProbe) =>
  Layer.effect(
    DictationEngine,
    Effect.gen(function* () {
      const stateRef = yield* SubscriptionRef.make<DictationEngineSnapshot>({
        state: "idle",
        loadedModel: null,
      });
      return {
        snapshot: SubscriptionRef.get(stateRef),
        changes: SubscriptionRef.changes(stateRef),
        load: (input) =>
          Ref.update(probe.loads, (loads) => [...loads, input.model]).pipe(
            Effect.andThen(
              SubscriptionRef.set(stateRef, { state: "ready", loadedModel: input.model }),
            ),
          ),
        transcribe: () => Effect.succeed("  hello there  "),
        unload: Ref.update(probe.unloads, (count) => count + 1).pipe(
          Effect.andThen(SubscriptionRef.set(stateRef, { state: "idle", loadedModel: null })),
        ),
      } satisfies DictationEngineShape;
    }),
  );

/**
 * Writes each requested file at exactly its expected size without moving real
 * bytes. `gate`, when given, holds the first file open so a test can observe
 * the in-progress status.
 */
const makeDownloaderLayer = (options: { readonly gate?: Latch.Latch; readonly fail?: boolean }) =>
  Layer.effect(
    DictationDownloader,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        downloadFile: (input) =>
          Effect.gen(function* () {
            const partPath = `${input.destPath}.part`;
            const expectedBytes = input.expectedBytes ?? 1024;
            yield* fs.makeDirectory(nodePath.dirname(input.destPath), { recursive: true });
            yield* fs.writeFile(partPath, new Uint8Array(0));
            yield* input.onProgress?.(Math.floor(expectedBytes / 2)) ?? Effect.void;
            if (options.fail) {
              return yield* Effect.fail(new DictationDownloadError("network is down"));
            }
            if (options.gate) {
              yield* options.gate.await;
            }
            yield* fs.truncate(partPath, expectedBytes);
            yield* fs.rename(partPath, input.destPath);
          }).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Success"
                ? Effect.void
                : fs.remove(`${input.destPath}.part`, { force: true }).pipe(Effect.ignore),
            ),
            Effect.mapError((cause) =>
              cause instanceof DictationDownloadError
                ? cause
                : new DictationDownloadError(String(cause)),
            ),
          ),
      };
    }),
  );

const makeLayer = (
  probe: EngineProbe,
  options: { readonly gate?: Latch.Latch; readonly fail?: boolean },
) =>
  DictationServiceLive.pipe(
    Layer.provide(makeEngineLayer(probe)),
    Layer.provide(makeDownloaderLayer(options)),
    Layer.provideMerge(ServerSettingsService.layerTest({ dictationModel: MODEL })),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-dictation-test-" })),
    ),
  );

const withService = <A, E>(
  run: (
    probe: EngineProbe,
  ) => Effect.Effect<A, E, DictationService | ServerConfig | FileSystem.FileSystem>,
  options: { readonly gate?: Latch.Latch; readonly fail?: boolean } = {},
) =>
  Effect.gen(function* () {
    const probe: EngineProbe = {
      loads: yield* Ref.make<ReadonlyArray<DictationModelId>>([]),
      unloads: yield* Ref.make(0),
    };
    return yield* run(probe).pipe(
      Effect.provide(makeLayer(probe, options)),
      Effect.provide(NodeServices.layer),
    );
  });

/**
 * Waits on the status stream (the same one clients subscribe to) until the
 * model matches, with a real-clock timeout so a bug fails fast instead of
 * hanging the suite.
 */
const awaitModel = (description: string, matches: (model: DictationModelStatus) => boolean) =>
  Effect.gen(function* () {
    const dictation = yield* DictationService;
    const matched = yield* dictation.streamChanges.pipe(
      Stream.filter((status) => {
        const model = status.models.find((entry) => entry.id === MODEL);
        return model !== undefined && matches(model);
      }),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`dictation model never became ${description}`),
      }),
    );
    return yield* Option.match(matched, {
      onNone: () => Effect.die(`dictation status stream ended before ${description}`),
      onSome: Effect.succeed,
    });
  });

const awaitModelState = (state: DictationDownloadState) =>
  awaitModel(state, (model) => model.state === state);

const leftoverPartFiles = (modelDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(modelDir).pipe(Effect.orElseSucceed(() => []));
    return entries.filter((entry) => entry.endsWith(".part"));
  });

/** Marks the native runtime as present so the model paths can be reached. */
const installRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const runtimePackage = resolveRuntimePackage(process.platform, process.arch);
  assert.isNotNull(runtimePackage, "test host has no prebuilt dictation runtime");
  const runtimeDir = nodePath.join(
    config.speechModelsDir,
    "runtime",
    runtimeDirectoryName(runtimePackage!),
  );
  yield* fs.makeDirectory(runtimeDir, { recursive: true });
  yield* fs.writeFile(nodePath.join(runtimeDir, DICTATION_ADDON_FILE), new Uint8Array(1));
});

const audioClip = (durationMs: number) => {
  const samples = new Int16Array(Math.round((durationMs / 1000) * 16000));
  return {
    audioBase64: Buffer.from(samples.buffer).toString("base64"),
    sampleRate: 16000 as const,
    durationMs,
  };
};

// `it.live` rather than `it.effect`: the waits below need the real clock so a
// stalled download fails in ten seconds instead of at the suite timeout.
describe("DictationService", () => {
  it.live("starts with the runtime and both models missing", () =>
    withService(() =>
      Effect.gen(function* () {
        const dictation = yield* DictationService;
        const status = yield* dictation.status;
        assert.deepEqual(
          status.models.map((model) => [model.id, model.state]),
          [
            ["parakeet", "missing"],
            ["moonshine", "missing"],
          ],
        );
        assert.equal(status.runtime.state, "missing");
        assert.equal(status.engine, "idle");
        assert.isTrue(status.runtime.supported);
      }),
    ),
  );

  it.live("moves a model through downloading with progress to ready", () =>
    Effect.gen(function* () {
      const gate = yield* Latch.make(false);
      yield* withService(
        () =>
          Effect.gen(function* () {
            const dictation = yield* DictationService;
            yield* installRuntime;
            yield* dictation.downloadModel(MODEL);

            // "downloading" is published the moment the job is queued; the
            // progress the UI draws arrives with the first chunk after that.
            const downloading = yield* awaitModel(
              "downloading with progress",
              (model) => model.state === "downloading" && model.bytesDownloaded > 0,
            );
            const inProgress = downloading.models.find((model) => model.id === MODEL);
            assert.isAbove(inProgress?.bytesDownloaded ?? 0, 0);
            assert.isBelow(inProgress?.bytesDownloaded ?? 0, inProgress?.bytesTotal ?? 0);

            yield* gate.open;
            const ready = yield* awaitModelState("ready");
            const done = ready.models.find((model) => model.id === MODEL);
            assert.equal(done?.bytesDownloaded, modelTotalBytes(dictationModel(MODEL)));
            assert.isNull(done?.error ?? null);
          }),
        { gate },
      );
    }),
  );

  it.live("keeps the failure on the model and removes partial files", () =>
    withService(
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const dictation = yield* DictationService;
          yield* installRuntime;
          yield* dictation.downloadModel(MODEL);

          const failed = yield* awaitModel("failed", (model) => model.error !== null);
          const model = failed.models.find((entry) => entry.id === MODEL);
          assert.equal(model?.state, "missing");
          assert.include(model?.error ?? "", "network is down");
          assert.deepEqual(
            yield* leftoverPartFiles(nodePath.join(config.speechModelsDir, MODEL)),
            [],
          );
        }),
      { fail: true },
    ),
  );

  it.live("cancelling a download clears the state and leaves no partial files", () =>
    Effect.gen(function* () {
      const gate = yield* Latch.make(false);
      yield* withService(
        () =>
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const dictation = yield* DictationService;
            yield* installRuntime;
            yield* dictation.downloadModel(MODEL);
            yield* awaitModelState("downloading");

            yield* dictation.cancelDownload(MODEL);

            const cancelled = yield* awaitModelState("missing");
            const model = cancelled.models.find((entry) => entry.id === MODEL);
            assert.isNull(model?.error ?? null);
            assert.deepEqual(
              yield* leftoverPartFiles(nodePath.join(config.speechModelsDir, MODEL)),
              [],
            );
          }),
        { gate },
      );
    }),
  );

  it.live("rejects a clip whose declared length does not match the audio", () =>
    withService(() =>
      Effect.gen(function* () {
        const dictation = yield* DictationService;
        const clip = audioClip(1000);

        const mismatched = yield* dictation
          .transcribe({ ...clip, durationMs: 20_000 })
          .pipe(Effect.flip);
        assert.equal(mismatched.code, "audio_invalid");

        const tooLong = yield* dictation
          .transcribe({ ...clip, durationMs: 200_000 })
          .pipe(Effect.flip);
        assert.equal(tooLong.code, "audio_invalid");
      }),
    ),
  );

  it.live("reports the missing piece before download and transcribes after", () =>
    withService((probe) =>
      Effect.gen(function* () {
        const dictation = yield* DictationService;
        const clip = audioClip(1000);

        const noRuntime = yield* dictation.transcribe(clip).pipe(Effect.flip);
        assert.equal(noRuntime.code, "runtime_missing");

        yield* installRuntime;
        const noModel = yield* dictation.transcribe(clip).pipe(Effect.flip);
        assert.equal(noModel.code, "model_missing");

        yield* dictation.downloadModel(MODEL);
        yield* awaitModelState("ready");

        const result = yield* dictation.transcribe(clip);
        assert.equal(result.text, "hello there");
        assert.deepEqual(yield* Ref.get(probe.loads), [MODEL]);
      }),
    ),
  );

  it.live("unloads the engine and deletes the files when a model is removed", () =>
    withService((probe) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const dictation = yield* DictationService;

        yield* installRuntime;
        yield* dictation.downloadModel(MODEL);
        yield* awaitModelState("ready");
        yield* dictation.warmUp;
        assert.deepEqual(yield* Ref.get(probe.loads), [MODEL]);

        yield* dictation.removeModel(MODEL);

        assert.equal(yield* Ref.get(probe.unloads), 1);
        assert.isFalse(yield* fs.exists(nodePath.join(config.speechModelsDir, MODEL)));
        const status = yield* dictation.status;
        assert.equal(status.models.find((model) => model.id === MODEL)?.state, "missing");
      }),
    ),
  );
});
