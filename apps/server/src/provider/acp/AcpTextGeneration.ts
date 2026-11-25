/**
 * AcpTextGeneration — commit / PR / branch / title generation over a
 * throwaway ACP session. Prompts the agent for structured JSON, collects the
 * `agent_message_chunk` stream, and decodes it against the prompt's schema.
 *
 * @module provider/acp/AcpTextGeneration
 */
import { THREADLINES_ACP_CLIENT_INFO } from "./acpClientInfo.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import {
  type ModelSelection,
  type ProviderOptionSelection,
  TextGenerationError,
} from "@threadlines/contracts";
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
import { selectSuggestionEffort } from "../promptSuggestions.ts";
import type { AcpProviderDescriptor, AcpProviderSettings } from "./AcpProviderDescriptor.ts";
import {
  flattenSessionConfigSelectOptions,
  selectConfigOptionCurrentValue,
} from "./AcpProviderModels.ts";
import {
  applyAcpModelSelection,
  defaultResolveAcpModelId,
  makeAcpProviderRuntime,
} from "./AcpProviderRuntime.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";

const ACP_TEXT_GENERATION_TIMEOUT_MS = 180_000;
const ACP_PROMPT_SUGGESTION_TIMEOUT_MS = 30_000;
/** Text generation must not touch the workspace; prefer the agent's ask/read-only mode. */
const ACP_TEXT_GENERATION_MODE_ID = "ask";
const REASONING_CONFIG_ID = /^(?:thought[_-]?level|reasoning[_-]?effort|reasoning|effort)$/iu;

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
  const fileSystem = yield* FileSystem.FileSystem;
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
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> => {
    let openedSessionId: string | undefined;
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      // Workspace hooks and settings can act before a denied tool call
      // would stop them; agents that read them run in an empty directory.
      const runCwd = descriptor.isolateTextGeneration
        ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-text-" })
        : cwd;
      const runtime = yield* makeAcpProviderRuntime(descriptor, {
        settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd: runCwd,
        clientInfo: { ...THREADLINES_ACP_CLIENT_INFO, name: "threadlines-git-text" },
      });
      // Text generation needs no tools: every request is refused.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );

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
        const started = yield* runtime.start();
        openedSessionId = started.sessionId;
        const modeState = yield* runtime.getModeState;
        yield* Effect.ignore(
          runtime.setMode(
            descriptor.agentModeFor?.({
              runtimeMode: "approval-required",
              interactionMode: undefined,
              availableModeIds: modeState?.availableModes.map((mode) => mode.id) ?? [],
            }) ?? ACP_TEXT_GENERATION_MODE_ID,
          ),
        );
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
        // Short title and branch runs do not need high thinking; lower the
        // live reasoning option when the caller did not choose one explicitly.
        const hasExplicitReasoning = (modelSelection.options ?? []).some((option) =>
          REASONING_CONFIG_ID.test(option.id),
        );
        if (
          !hasExplicitReasoning &&
          (operation === "generateThreadTitle" || operation === "generateBranchName")
        ) {
          const liveConfigOptions = yield* runtime.getConfigOptions;
          const reasoningOption = liveConfigOptions.find(
            (candidate) =>
              candidate.type === "select" &&
              (candidate.category === "thought_level" || REASONING_CONFIG_ID.test(candidate.id)),
          );
          if (reasoningOption) {
            const choices = flattenSessionConfigSelectOptions(reasoningOption);
            const effort = selectSuggestionEffort(choices.map((choice) => choice.value));
            const currentValue = selectConfigOptionCurrentValue(reasoningOption);
            if (effort !== undefined && effort !== currentValue) {
              yield* Effect.ignore(runtime.setConfigOption(reasoningOption.id, effort));
            }
          }
        }

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
      Effect.ensuring(
        Effect.suspend(() =>
          openedSessionId !== undefined && descriptor.onEphemeralSessionClosed
            ? descriptor.onEphemeralSessionClosed(openedSessionId).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
  };

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
      includeBranch: input.includeBranch === true,
      policy: input.policy,
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
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeBranchFragment(generated.branch) }
        : {}),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

/**
 * Runs a short, isolated, tool-free ACP turn to sample a next-message prompt
 * suggestion, then tears down the throwaway session and cleans up any on-disk
 * session artifacts via `descriptor.onEphemeralSessionClosed`.
 */
export function sampleAcpPromptSuggestion<Settings extends AcpProviderSettings>(input: {
  readonly descriptor: AcpProviderDescriptor<Settings>;
  readonly settings: Settings;
  readonly environment: NodeJS.ProcessEnv;
  readonly commandSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection>;
  /**
   * Optional gate run against the live session's active model when `model` was
   * not pinned up front, so a session's default model can be quota-checked
   * before sending the prompt.
   */
  readonly allowLiveModel?: (model: {
    readonly slug: string;
    readonly name: string;
  }) => Effect.Effect<boolean>;
}): Effect.Effect<string | undefined> {
  const { descriptor } = input;
  let openedSessionId: string | undefined;
  return Effect.gen(function* () {
    const outputRef = yield* Ref.make("");
    let sawToolCall = false;
    const runCwd = descriptor.isolateTextGeneration
      ? yield* input.fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-suggestion-" })
      : input.cwd;
    const runtime = yield* makeAcpProviderRuntime(descriptor, {
      settings: input.settings,
      environment: input.environment,
      childProcessSpawner: input.commandSpawner,
      cwd: runCwd,
      clientInfo: { ...THREADLINES_ACP_CLIENT_INFO, name: "threadlines-prompt-suggestion" },
    });
    // Prompt suggestions never run tools or touch files.
    yield* runtime.handleRequestPermission(() => {
      sawToolCall = true;
      return Effect.succeed({ outcome: { outcome: "cancelled" as const } });
    });
    yield* runtime.handleSessionUpdate((notification) => {
      if (openedSessionId === undefined && notification.sessionId) {
        openedSessionId = notification.sessionId;
      }
      const update = notification.update;
      if (update.sessionUpdate === "tool_call") {
        sawToolCall = true;
        return runtime.cancel.pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid);
      }
      if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
      const content = update.content;
      if (content.type !== "text") return Effect.void;
      return Ref.update(outputRef, (current) => current + content.text);
    });

    const promptResult = yield* Effect.gen(function* () {
      const started = yield* runtime.start();
      openedSessionId = started.sessionId;
      const modeState = yield* runtime.getModeState;
      const availableModeIds = modeState?.availableModes.map((mode) => mode.id) ?? [];
      const targetMode =
        descriptor.agentModeFor?.({
          runtimeMode: "approval-required",
          interactionMode: undefined,
          availableModeIds,
        }) ?? ACP_TEXT_GENERATION_MODE_ID;
      // When the session advertises the requested supervised/read-only mode,
      // require switching to it before prompting so a failed mode switch never
      // runs the prompt in a more permissive mode.
      if (availableModeIds.includes(targetMode)) {
        if (modeState?.currentModeId !== targetMode) {
          yield* runtime.setMode(targetMode);
        }
      } else {
        yield* Effect.ignore(runtime.setMode(targetMode));
      }

      // Require the requested suggestion model to actually be selected; if the
      // live session does not offer it or rejects it, abort instead of spending
      // quota from the session's default model pool. When no model was named,
      // check the live session's active default model before prompting.
      const initialConfigOptions = yield* runtime.getConfigOptions;
      const initialModelOption = findModelConfigOption(initialConfigOptions);
      const modelChoices = flattenSessionConfigSelectOptions(initialModelOption);
      if (input.model !== undefined) {
        const resolveModelId = descriptor.resolveModelId ?? defaultResolveAcpModelId;
        const resolvedModel = resolveModelId(input.model, {
          selections: input.options,
          configOptions: initialConfigOptions,
        });
        if (
          resolvedModel === undefined ||
          (modelChoices.length > 0 &&
            !modelChoices.some((choice) => choice.value === resolvedModel))
        ) {
          return undefined;
        }
        yield* runtime.setModel(resolvedModel);
      } else if (input.allowLiveModel !== undefined) {
        const currentSlug = selectConfigOptionCurrentValue(initialModelOption);
        if (currentSlug !== undefined) {
          const currentChoice = modelChoices.find((choice) => choice.value === currentSlug);
          const allowed = yield* input.allowLiveModel({
            slug: currentSlug,
            name: currentChoice?.name || currentSlug,
          });
          if (!allowed) return undefined;
        }
      }

      // Always check the live session's reasoning/thought_level option after
      // model selection so a stale catalog cannot leave a model at high effort.
      const liveConfigOptions = yield* runtime.getConfigOptions;
      const reasoningOption = liveConfigOptions.find(
        (candidate) =>
          candidate.type === "select" &&
          (candidate.category === "thought_level" || REASONING_CONFIG_ID.test(candidate.id)),
      );
      if (reasoningOption) {
        const choices = flattenSessionConfigSelectOptions(reasoningOption);
        const effort = selectSuggestionEffort(choices.map((choice) => choice.value));
        const currentValue = selectConfigOptionCurrentValue(reasoningOption);
        if (effort !== undefined && effort !== currentValue) {
          yield* Effect.ignore(runtime.setConfigOption(reasoningOption.id, effort));
        }
      } else if ((input.options?.length ?? 0) > 0) {
        yield* Effect.ignore(
          applyAcpModelSelection({
            descriptor,
            runtime,
            model: undefined,
            selections: input.options,
            mapError: ({ cause }) => cause,
          }),
        );
      }
      return yield* runtime.prompt({
        prompt: [{ type: "text", text: input.prompt }],
      });
    }).pipe(Effect.timeoutOption(ACP_PROMPT_SUGGESTION_TIMEOUT_MS));

    if (
      sawToolCall ||
      Option.isNone(promptResult) ||
      promptResult.value === undefined ||
      promptResult.value.stopReason === "cancelled"
    ) {
      return undefined;
    }
    const raw = (yield* Ref.get(outputRef)).trim();
    return raw.length > 0 ? raw : undefined;
  }).pipe(
    Effect.scoped,
    Effect.ensuring(
      Effect.suspend(() =>
        openedSessionId !== undefined && descriptor.onEphemeralSessionClosed
          ? descriptor.onEphemeralSessionClosed(openedSessionId).pipe(Effect.ignore)
          : Effect.void,
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logDebug("ACP prompt suggestion failed", {
        provider: descriptor.driverKind,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
}
