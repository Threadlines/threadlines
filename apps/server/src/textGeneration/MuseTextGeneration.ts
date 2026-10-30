/**
 * MuseTextGeneration — commit messages, PR text, branch names and thread
 * titles through Muse Code.
 *
 * Each request runs one turn on a throwaway host that can do nothing but
 * answer: no session log (it never shows in the user's Muse history), no
 * shell, no file writes, and every approval denied. The host takes the
 * user's data-sharing choice like any other, since the prompt carries the
 * user's text.
 *
 * @module textGeneration/MuseTextGeneration
 */
import { TextGenerationError } from "@threadlines/contracts";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { startMuseHost } from "../provider/muse/MuseHost.ts";
import {
  describeMuseBillingRefusal,
  museBillingRefusal,
  museHostProfile,
  museWorkspaceRoot,
} from "../provider/muse/MuseLaunch.ts";
import {
  MuseAccountState,
  MuseItemEvent,
  MuseTurnCompleted,
} from "../provider/muse/MuseProtocol.ts";
import type { ProviderInstanceEnvironment } from "@threadlines/contracts";
import { museTurnErrorMessage } from "../provider/Layers/MuseAdapter.ts";
import {
  makeTextGenerationFromText,
  type TextGenerationRequest,
} from "./TextGenerationFromText.ts";

const GENERATION_TIMEOUT = Duration.seconds(180);
const decodeItemEvent = Schema.decodeUnknownOption(MuseItemEvent);
const decodeCompleted = Schema.decodeUnknownOption(MuseTurnCompleted);
const decodeAccount = Schema.decodeUnknownOption(MuseAccountState);

export interface MuseTextGenerationOptions {
  readonly binaryPath: () => string;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  readonly allowApiKeyBilling: boolean;
  readonly readContributorMode: Effect.Effect<boolean | undefined>;
}

export const makeMuseTextGeneration = (options: MuseTextGenerationOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const generateText = (input: TextGenerationRequest) =>
      Effect.scoped(
        Effect.gen(function* () {
          const failure = (detail: string, cause?: unknown) =>
            new TextGenerationError({
              operation: input.operation,
              detail,
              ...(cause !== undefined ? { cause } : {}),
            });
          const directory = yield* fileSystem
            .realPath(input.cwd)
            .pipe(Effect.orElseSucceed(() => input.cwd));
          const profile = museHostProfile({
            purpose: "utility",
            runtimeMode: "approval-required",
            contributorMode: yield* options.readContributorMode,
            sandboxAvailable: undefined,
          });
          const host = yield* startMuseHost({
            binaryPath: options.binaryPath(),
            args: [...profile.args, "--disable-request-user-input"],
            environment: options.environment,
            cwd: directory,
            experimentalApi: true,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) => failure(error.detail, error)),
          );
          if (!options.allowApiKeyBilling) {
            const accountState = host.initialize.experimentalApi
              ? yield* host.request("account/read", {}).pipe(
                  Effect.map((raw) => Option.getOrUndefined(decodeAccount(raw))?.state),
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
            const refusal = museBillingRefusal({
              allowApiKeyBilling: options.allowApiKeyBilling,
              accountState,
              instanceEnvironment: options.instanceEnvironment,
            });
            if (refusal) return yield* failure(describeMuseBillingRefusal(refusal));
          }
          const started = yield* host
            .command("session/start", {
              workspaceRoot: museWorkspaceRoot(directory),
              providerId: "meta",
              approvalMode: profile.approvalMode,
              modelId: input.modelSelection.model,
            })
            .pipe(Effect.mapError((error) => failure(error.detail, error)));
          const session = started.session as { readonly sessionId?: unknown } | undefined;
          const sessionId = typeof session?.sessionId === "string" ? session.sessionId : undefined;
          if (!sessionId) return yield* failure("Muse Code did not open a session.");
          const turnId = host.mintCommandId();
          const done = yield* Deferred.make<string, TextGenerationError>();
          let finalText = "";
          yield* host.notifications.pipe(
            Stream.runForEach((notification) =>
              Effect.gen(function* () {
                if (notification.params.sessionId !== sessionId) return;
                if (notification.method === "item/completed") {
                  const event = decodeItemEvent(notification.params);
                  if (
                    Option.isSome(event) &&
                    event.value.item.kind === "agentMessage" &&
                    event.value.item.turnId === turnId &&
                    event.value.item.text?.trim()
                  ) {
                    finalText = event.value.item.text;
                  }
                } else if (notification.method === "turn/completed") {
                  const completed = decodeCompleted(notification.params);
                  if (Option.isNone(completed) || completed.value.turnId !== turnId) return;
                  if (completed.value.terminal === "completed") {
                    yield* Deferred.succeed(done, finalText);
                  } else {
                    yield* Deferred.fail(done, failure(museTurnErrorMessage(completed.value)));
                  }
                }
              }),
            ),
            Effect.forkScoped,
          );
          const effort = getModelSelectionStringOptionValue(
            input.modelSelection as never,
            "reasoningEffort",
          );
          yield* host
            .command(
              "turn/start",
              {
                sessionId,
                input: [{ type: "text", text: input.prompt }],
                ...(effort ? { reasoningEffort: effort } : {}),
              },
              { commandId: turnId },
            )
            .pipe(Effect.mapError((error) => failure(error.detail, error)));
          const text = yield* Deferred.await(done).pipe(
            Effect.timeoutOption(GENERATION_TIMEOUT),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(failure("Muse Code did not answer in time.")),
                onSome: Effect.succeed,
              }),
            ),
          );
          return text;
        }),
      );

    return makeTextGenerationFromText({ label: "Muse Code", generateText });
  });
