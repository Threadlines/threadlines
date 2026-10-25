/**
 * PiTextGeneration — commit messages, PR text, branch names and thread titles
 * through Pi (docs/providers/pi-plan.md, "Titles and commit messages").
 *
 * Each request runs one prompt on a short-lived `pi --mode rpc --no-session
 * --no-tools`: nothing is written to the user's Pi history and the model can
 * only answer. The user's own extensions stay on, so models they add still
 * work; Threadlines' extension is not loaded. A dialog one of those
 * extensions opens has nobody to answer it and is cancelled.
 *
 * @module textGeneration/PiTextGeneration
 */
import { type ProviderInstanceEnvironment, TextGenerationError } from "@threadlines/contracts";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { piTurnFailure } from "../provider/pi/PiFailure.ts";
import { type PiLaunch, piProcessArgs, piProcessEnvironment } from "../provider/pi/PiLaunch.ts";
import {
  decodePi,
  parsePiModelSlug,
  PI_DIALOG_METHODS,
  PiExtensionUiRequest,
  PiMessageEvent,
  PiPromptAck,
} from "../provider/pi/PiProtocol.ts";
import { startPiRpc } from "../provider/pi/PiRpc.ts";
import {
  makeTextGenerationFromText,
  type TextGenerationRequest,
} from "./TextGenerationFromText.ts";

const GENERATION_TIMEOUT = Duration.seconds(180);

export interface PiTextGenerationOptions {
  readonly launch: PiLaunch;
  /** The instance's extra `pi` flags. */
  readonly launchArgs: ReadonlyArray<string>;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  /** The server's environment; tests pass their own. */
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
}

export const makePiTextGeneration = (options: PiTextGenerationOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const generateText = (request: TextGenerationRequest) =>
      Effect.scoped(
        Effect.gen(function* () {
          const failure = (detail: string, cause?: unknown) =>
            new TextGenerationError({
              operation: request.operation,
              detail,
              ...(cause !== undefined ? { cause } : {}),
            });
          const directory = yield* fileSystem
            .realPath(request.cwd)
            .pipe(Effect.orElseSucceed(() => request.cwd));
          const launcher = yield* options.launch.pipe(
            Effect.mapError((error) => failure(error.message, error)),
          );
          const rpc = yield* startPiRpc({
            command: launcher.command,
            args: piProcessArgs(launcher, { purpose: "utility", launchArgs: options.launchArgs }),
            cwd: directory,
            environment: piProcessEnvironment({
              instanceEnvironment: options.instanceEnvironment,
              ...(options.baseEnvironment ? { baseEnv: options.baseEnvironment } : {}),
            }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) => failure(error.detail, error)),
          );
          const ask = (command: { readonly type: string; readonly [key: string]: unknown }) =>
            rpc.request(command).pipe(Effect.mapError((error) => failure(error.detail, error)));

          const model = parsePiModelSlug(request.modelSelection.model);
          if (model) {
            yield* ask({ type: "set_model", provider: model.provider, modelId: model.modelId });
          }
          const effort = getModelSelectionStringOptionValue(
            request.modelSelection as never,
            "reasoningEffort",
          );
          // A level the model lacks is Pi's to clamp; never a reason to fail.
          if (effort) yield* Effect.ignore(ask({ type: "set_thinking_level", level: effort }));

          const settled = yield* Deferred.make<void>();
          let modelError: string | undefined;
          yield* rpc.records.pipe(
            Stream.runForEach((record) =>
              Effect.gen(function* () {
                if (record.type === "agent_settled") {
                  yield* Deferred.succeed(settled, undefined);
                  return;
                }
                if (record.type === "message_end") {
                  const event = decodePi(PiMessageEvent)(record);
                  if (
                    Option.isSome(event) &&
                    event.value.message.role === "assistant" &&
                    event.value.message.stopReason === "error"
                  ) {
                    modelError = event.value.message.errorMessage ?? "Pi's model failed.";
                  }
                  return;
                }
                if (record.type === "extension_ui_request") {
                  const dialog = decodePi(PiExtensionUiRequest)(record);
                  if (Option.isSome(dialog) && PI_DIALOG_METHODS.has(dialog.value.method)) {
                    yield* rpc.send({
                      type: "extension_ui_response",
                      id: dialog.value.id,
                      cancelled: true,
                    });
                  }
                }
              }),
            ),
            Effect.forkScoped,
          );

          const ack = decodePi(PiPromptAck)(
            yield* rpc
              .request({ type: "prompt", message: request.prompt }, { timeout: GENERATION_TIMEOUT })
              .pipe(Effect.mapError((error) => failure(error.detail, error))),
          );
          if (Option.isSome(ack) && ack.value.disposition === "handled") {
            return yield* failure("Pi took the request for a command and did not answer it.");
          }
          const finished = yield* Deferred.await(settled).pipe(
            Effect.timeoutOption(GENERATION_TIMEOUT),
          );
          if (Option.isNone(finished)) return yield* failure("Pi did not answer in time.");
          if (modelError !== undefined) {
            return yield* failure(piTurnFailure(modelError, model?.provider).message);
          }
          const last = yield* ask({ type: "get_last_assistant_text" });
          const text =
            typeof last === "object" && last !== null && "text" in last ? last.text : null;
          return typeof text === "string" ? text : "";
        }),
      );

    return makeTextGenerationFromText({ label: "Pi", generateText });
  });
