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
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@threadlines/shared/git";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { extractJsonObject } from "@threadlines/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { parseOpenCodeModelSlug, runOpenCode } from "../provider/opencode/OpenCodeClient.ts";
import type { OpenCodeServerManagerShape } from "../provider/opencode/OpenCodeServerManager.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeOpenCodeTextGeneration = (manager: OpenCodeServerManagerShape) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const generateText = (input: {
      readonly operation: Operation;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelSelection: { readonly model: string; readonly options?: unknown };
    }) =>
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

    const generateJson = <S extends Schema.Top>(input: {
      readonly operation: Operation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: { readonly model: string; readonly options?: unknown };
    }) =>
      Effect.gen(function* () {
        const text = yield* generateText(input);
        if (!text.trim()) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned empty output.",
          });
        }
        return yield* decodeJson(extractJsonObject(text))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(input.outputSchema)))
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OpenCode returned invalid structured output.",
                  cause,
                }),
            ),
          );
      });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* generateJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      });

    const generatePrContent: TextGenerationShape["generatePrContent"] = (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          prTemplate: input.prTemplate,
        });
        const generated = yield* generateJson({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGenerationShape["generateBranchName"] = (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
          policy: input.policy,
        });
        const generated = yield* generateJson({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* generateJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGenerationShape;
  });
