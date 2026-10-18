/**
 * TextGenerationFromText — commit messages, PR text, branch names and thread
 * titles for a provider that can answer one prompt with plain text.
 *
 * The provider supplies `generateText` (one prompt in, the model's reply
 * out); this builds the four operations on it: the shared prompts, the JSON
 * the reply must hold, and the shared clean-up of each field. Used by the
 * providers without a structured-output API of their own (OpenCode, Muse
 * Code, Pi).
 *
 * @module textGeneration/TextGenerationFromText
 */
import { TextGenerationError } from "@threadlines/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@threadlines/shared/git";
import { extractJsonObject } from "@threadlines/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

export type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface TextGenerationRequest {
  readonly operation: TextGenerationOperation;
  readonly cwd: string;
  readonly prompt: string;
  readonly modelSelection: { readonly model: string; readonly options?: unknown };
}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export function makeTextGenerationFromText(input: {
  /** The provider's name, for messages ("OpenCode returned empty output."). */
  readonly label: string;
  readonly generateText: (
    request: TextGenerationRequest,
  ) => Effect.Effect<string, TextGenerationError>;
}): TextGenerationShape {
  const generateJson = <S extends Schema.Top>(
    request: TextGenerationRequest & { readonly outputSchema: S },
  ) =>
    Effect.gen(function* () {
      const text = yield* input.generateText(request);
      if (!text.trim()) {
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: `${input.label} returned empty output.`,
        });
      }
      return yield* decodeJson(extractJsonObject(text))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(request.outputSchema)))
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: request.operation,
                detail: `${input.label} returned invalid structured output.`,
                cause,
              }),
          ),
        );
    });

  return {
    generateCommitMessage: (request) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: request.branch,
          stagedSummary: request.stagedSummary,
          stagedPatch: request.stagedPatch,
          includeBranch: request.includeBranch === true,
          policy: request.policy,
        });
        const generated = yield* generateJson({
          operation: "generateCommitMessage",
          cwd: request.cwd,
          prompt,
          outputSchema,
          modelSelection: request.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      }),
    generatePrContent: (request) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: request.baseBranch,
          headBranch: request.headBranch,
          commitSummary: request.commitSummary,
          diffSummary: request.diffSummary,
          diffPatch: request.diffPatch,
          policy: request.policy,
          prTemplate: request.prTemplate,
        });
        const generated = yield* generateJson({
          operation: "generatePrContent",
          cwd: request.cwd,
          prompt,
          outputSchema,
          modelSelection: request.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      }),
    generateBranchName: (request) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: request.message,
          attachments: request.attachments,
          policy: request.policy,
        });
        const generated = yield* generateJson({
          operation: "generateBranchName",
          cwd: request.cwd,
          prompt,
          outputSchema,
          modelSelection: request.modelSelection,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      }),
    generateThreadTitle: (request) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: request.message,
          attachments: request.attachments,
        });
        const generated = yield* generateJson({
          operation: "generateThreadTitle",
          cwd: request.cwd,
          prompt,
          outputSchema,
          modelSelection: request.modelSelection,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      }),
  };
}
