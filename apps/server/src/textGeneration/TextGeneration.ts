import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@threadlines/contracts";
import { TextGenerationError } from "@threadlines/contracts";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /** Optional backup model on a different provider. Used only after the primary fails. */
  backupModelSelection?: ModelSelection | null;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /** Optional backup model on a different provider. Used only after the primary fails. */
  backupModelSelection?: ModelSelection | null;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /** Optional backup model on a different provider. Used only after the primary fails. */
  backupModelSelection?: ModelSelection | null;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /** Optional backup model on a different provider. Used only after the primary fails. */
  backupModelSelection?: ModelSelection | null;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "threadlines/text-generation/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

type TextGenerationInput =
  | CommitMessageGenerationInput
  | PrContentGenerationInput
  | BranchNameGenerationInput
  | ThreadTitleGenerationInput;

type TextGenerationResult =
  | CommitMessageGenerationResult
  | PrContentGenerationResult
  | BranchNameGenerationResult
  | ThreadTitleGenerationResult;

const withBackupFallback = <Input extends TextGenerationInput, Output extends TextGenerationResult>(
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  input: Input,
  run: (
    textGeneration: ProviderInstance["textGeneration"],
    nextInput: Input,
  ) => Effect.Effect<Output, TextGenerationError>,
): Effect.Effect<Output, TextGenerationError> =>
  resolveInstance(registry, operation, input.modelSelection.instanceId).pipe(
    Effect.flatMap((primaryInstance) =>
      run(primaryInstance.textGeneration, input).pipe(
        Effect.catch((primaryError: TextGenerationError) => {
          const backupSelection = input.backupModelSelection;
          if (!backupSelection) {
            return Effect.fail(primaryError);
          }

          return resolveInstance(registry, operation, backupSelection.instanceId).pipe(
            Effect.catch(() => Effect.succeed(null as ProviderInstance | null)),
            Effect.flatMap((backupInstance) => {
              if (!backupInstance) {
                return Effect.fail(primaryError);
              }
              if (backupInstance.driverKind === primaryInstance.driverKind) {
                return Effect.fail(primaryError);
              }

              const backupInput = {
                ...input,
                modelSelection: backupSelection,
                backupModelSelection: null,
              } as Input;

              return Effect.logWarning("text generation primary failed; retrying backup provider", {
                operation,
                primaryInstanceId: primaryInstance.instanceId,
                backupInstanceId: backupInstance.instanceId,
                primaryDetail: primaryError.detail,
              }).pipe(
                Effect.andThen(run(backupInstance.textGeneration, backupInput)),
                Effect.catch((backupError: TextGenerationError) =>
                  Effect.fail(
                    new TextGenerationError({
                      operation,
                      detail: `Primary provider failed: ${primaryError.detail} Backup provider failed: ${backupError.detail}`,
                      cause: { primaryError, backupError },
                    }),
                  ),
                ),
              );
            }),
          );
        }),
      ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    withBackupFallback(registry, "generateCommitMessage", input, (textGeneration, nextInput) =>
      textGeneration.generateCommitMessage(nextInput),
    ),
  generatePrContent: (input) =>
    withBackupFallback(registry, "generatePrContent", input, (textGeneration, nextInput) =>
      textGeneration.generatePrContent(nextInput),
    ),
  generateBranchName: (input) =>
    withBackupFallback(registry, "generateBranchName", input, (textGeneration, nextInput) =>
      textGeneration.generateBranchName(nextInput),
    ),
  generateThreadTitle: (input) =>
    withBackupFallback(registry, "generateThreadTitle", input, (textGeneration, nextInput) =>
      textGeneration.generateThreadTitle(nextInput),
    ),
});

export const layer = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
