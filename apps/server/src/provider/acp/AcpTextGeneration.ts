/**
 * AcpTextGeneration — commit / PR / branch / title generation over a
 * throwaway ACP session. Prompts the agent for structured JSON, collects the
 * `agent_message_chunk` stream, and decodes it against the prompt's schema.
 *
 * @module provider/acp/AcpTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, TextGenerationError } from "@threadlines/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@threadlines/shared/git";
import { extractJsonObject } from "@threadlines/shared/schemaJson";

import { type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import type { AcpProviderDescriptor, AcpProviderSettings } from "./AcpProviderDescriptor.ts";
import { applyAcpModelSelection, makeAcpProviderRuntime } from "./AcpProviderRuntime.ts";

const ACP_TEXT_GENERATION_TIMEOUT_MS = 180_000;
/** Text generation must not touch the workspace; prefer the agent's ask/read-only mode. */
const ACP_TEXT_GENERATION_MODE_ID = "ask";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

export const makeAcpTextGeneration = Effect.fn("makeAcpTextGeneration")(function* <
  Settings extends AcpProviderSettings,
>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentName = descriptor.presentation.displayName;

  const mapAcpError = (operation: TextGenerationOperation, detail: string, cause: unknown) =>
    new TextGenerationError({
      operation,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  const runJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeAcpProviderRuntime(descriptor, {
        settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "threadlines-git-text", version: "0.0.0" },
      });

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode(ACP_TEXT_GENERATION_MODE_ID));
        yield* applyAcpModelSelection({
          descriptor,
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            mapAcpError(
              operation,
              step === "set-config-option"
                ? `Failed to set ${agentName} ACP config option "${configId}" for text generation.`
                : `Failed to set ${agentName} ACP model for text generation.`,
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(ACP_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `${agentName} request timed out.`,
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapAcpError(operation, `${agentName} ACP request failed.`, cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${agentName} ACP request was cancelled.`
              : `${agentName} returned empty output.`,
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: `${agentName} returned invalid structured output.`,
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapAcpError(operation, `${agentName} ACP text generation failed.`, cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "AcpTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      policy: input.policy,
    });

    const generated = yield* runJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
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

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "AcpTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      policy: input.policy,
      prTemplate: input.prTemplate,
    });

    const generated = yield* runJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "AcpTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      policy: input.policy,
    });

    const generated = yield* runJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "AcpTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
