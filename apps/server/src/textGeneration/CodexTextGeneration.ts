import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_MODEL, type CodexSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { TextGenerationError } from "@t3tools/contracts";
import {
  type BranchNameGenerationInput,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
} from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

const CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT = "low";
const CODEX_DEFAULT_TIMEOUT_MS = 180_000;
// Identical commit prompts have been observed taking 11s-42s wall time
// (server-side queue variance), so 60s left too little tail headroom.
const CODEX_COMMIT_MESSAGE_TIMEOUT_MS = 120_000;
// Codex one-shot responses have been observed to take 15-20s even for tiny
// prompts (server-side floor), so the title budget needs tail headroom.
const CODEX_THREAD_TITLE_TIMEOUT_MS = 90_000;
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

type CodexTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

type RunCodexJsonInput<S extends Schema.Top> = {
  operation: CodexTextGenerationOperation;
  cwd: string;
  prompt: string;
  outputSchemaJson: S;
  imagePaths?: ReadonlyArray<string>;
  cleanupPaths?: ReadonlyArray<string>;
  modelSelection: ModelSelection;
};

function isCodexModelCapacityError(error: TextGenerationError): boolean {
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("selected model is at capacity") ||
    (detail.includes("model is at capacity") && detail.includes("try a different model"))
  );
}

function isUnsupportedIgnoreUserConfigFlagError(error: TextGenerationError): boolean {
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("--ignore-user-config") &&
    (detail.includes("unexpected argument") || detail.includes("wasn't expected"))
  );
}

function shouldRetryWithDefaultCodexModel(
  modelSelection: ModelSelection,
  error: TextGenerationError,
): boolean {
  return modelSelection.model !== DEFAULT_MODEL && isCodexModelCapacityError(error);
}

function withDefaultCodexModel(modelSelection: ModelSelection): ModelSelection {
  return {
    ...modelSelection,
    model: DEFAULT_MODEL,
  };
}

/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> => {
    return Effect.gen(function* () {
      const tempFileId = yield* Random.nextUUIDv4;
      return yield* fileSystem
        .makeTempFileScoped({
          prefix: `t3code-${prefix}-${process.pid}-${tempFileId}.tmp`,
        })
        .pipe(Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `Failed to write temp file`,
            cause,
          }),
      ),
    );
  };

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const encodeJsonForOperation = (
    operation: CodexTextGenerationOperation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation: CodexTextGenerationOperation,
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem
        .stat(resolvedPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    modelSelection,
  }: RunCodexJsonInput<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const timeoutMs =
      operation === "generateCommitMessage"
        ? CODEX_COMMIT_MESSAGE_TIMEOUT_MS
        : operation === "generateThreadTitle"
          ? CODEX_THREAD_TITLE_TIMEOUT_MS
          : CODEX_DEFAULT_TIMEOUT_MS;
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "");

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* (options: {
      readonly ignoreUserConfig: boolean;
    }) {
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT;
      const command = ChildProcess.make(
        codexConfig.binaryPath || "codex",
        [
          "exec",
          "--ephemeral",
          // One-shot text generation should not inherit agent-oriented user
          // config (MCP servers, notify hooks, memories) from
          // $CODEX_HOME/config.toml; auth still uses CODEX_HOME.
          ...(options.ignoreUserConfig ? ["--ignore-user-config"] : []),
          "--skip-git-repo-check",
          ...(operation === "generateCommitMessage" ? ["--ignore-rules"] : []),
          "-s",
          "read-only",
          "--model",
          modelSelection.model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true
            ? ["--config", `service_tier="fast"`]
            : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        {
          env: {
            ...environment,
            ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
          },
          cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all(
      [schemaPath, outputPath, ...cleanupPaths].map((filePath) => safeUnlink(filePath)),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand({ ignoreUserConfig: true }).pipe(
        Effect.scoped,
        Effect.catchIf(isUnsupportedIgnoreUserConfigFlagError, () =>
          Effect.logWarning(
            "Codex CLI does not support --ignore-user-config; retrying without it",
            { operation },
          ).pipe(
            Effect.andThen(runCodexCommand({ ignoreUserConfig: false }).pipe(Effect.scoped)),
          ),
        ),
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const runCodexJsonWithCapacityFallback = Effect.fn("runCodexJsonWithCapacityFallback")(function* <
    S extends Schema.Top,
  >(
    input: RunCodexJsonInput<S>,
  ): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    return yield* runCodexJson(input).pipe(
      Effect.catchIf(
        (error) => shouldRetryWithDefaultCodexModel(input.modelSelection, error),
        () =>
          Effect.logWarning("retrying Codex text generation with default model", {
            operation: input.operation,
            failedModel: input.modelSelection.model,
            fallbackModel: DEFAULT_MODEL,
          }).pipe(
            Effect.andThen(
              runCodexJson({
                ...input,
                modelSelection: withDefaultCodexModel(input.modelSelection),
              }),
            ),
          ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CodexTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runCodexJsonWithCapacityFallback({
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
    "CodexTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runCodexJsonWithCapacityFallback({
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
    "CodexTextGeneration.generateBranchName",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      "generateBranchName",
      input.attachments,
    );
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runCodexJsonWithCapacityFallback({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CodexTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      "generateThreadTitle",
      input.attachments,
    );
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runCodexJsonWithCapacityFallback({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
