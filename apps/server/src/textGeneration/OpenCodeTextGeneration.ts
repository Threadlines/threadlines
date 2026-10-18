/**
 * OpenCodeTextGeneration — commit messages, PR text, branch names and thread
 * titles through OpenCode 2.
 *
 * Each request is one `generate` call on a throwaway session in the request's
 * directory: a plain model completion, no tools and no turn, on the model the
 * user picked. The session is deleted afterwards so it never shows up in the
 * user's own OpenCode history. The server is the instance's shared one.
 *
 * @module textGeneration/OpenCodeTextGeneration
 */
import { TextGenerationError } from "@threadlines/contracts";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseOpenCodeModelSlug, runOpenCode } from "../provider/opencode/OpenCodeClient.ts";
import type { OpenCodeServerManagerShape } from "../provider/opencode/OpenCodeServerManager.ts";
import {
  makeTextGenerationFromText,
  type TextGenerationRequest,
} from "./TextGenerationFromText.ts";

export const makeOpenCodeTextGeneration = (manager: OpenCodeServerManagerShape) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const generateText = (input: TextGenerationRequest) =>
      Effect.gen(function* () {
        const ref = parseOpenCodeModelSlug(input.modelSelection.model);
        if (!ref) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode model selection must use the 'provider/model' format.",
          });
        }
        const variant = getModelSelectionStringOptionValue(
          input.modelSelection as never,
          "variant",
        );
        const directory = yield* fileSystem
          .realPath(input.cwd)
          .pipe(Effect.orElseSucceed(() => input.cwd));
        return yield* manager
          .withServer(({ server }) =>
            Effect.acquireUseRelease(
              runOpenCode("session.create", (signal) =>
                server.client.session.create(
                  {
                    title: "Threadlines text generation",
                    location: { directory },
                    model: { ...ref, ...(variant ? { variant } : {}) },
                  },
                  { signal },
                ),
              ),
              (session) =>
                runOpenCode("session.generate", (signal) =>
                  server.client.session.generate(
                    { sessionID: session.id, prompt: input.prompt },
                    { signal },
                  ),
                ),
              (session) =>
                runOpenCode("session.remove", (signal) =>
                  server.client.session.remove({ sessionID: session.id }, { signal }),
                ).pipe(Effect.ignore),
            ),
          )
          .pipe(
            Effect.map((result) => result.text),
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
      });

    return makeTextGenerationFromText({ label: "OpenCode", generateText });
  });
