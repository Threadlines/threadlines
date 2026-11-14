import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  DEFAULT_GIT_TEXT_GENERATION_REASONING_EFFORT,
  DEFAULT_MODEL,
  type CodexSettings,
  type ModelSelection,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@threadlines/shared/git";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import type { CodexModelProviderLaunch } from "../provider/codexModelProviderLaunch.ts";
import { TextGenerationError } from "@threadlines/contracts";
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
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { resolveCodexCliServiceTier } from "../codexServiceTier.ts";
import { planCliSpawn } from "../cliSpawn.ts";

const CODEX_DEFAULT_TIMEOUT_MS = 180_000;
// Identical commit prompts have been observed taking 11s-42s wall time
// (server-side queue variance), so 60s left too little tail headroom.
const CODEX_COMMIT_MESSAGE_TIMEOUT_MS = 120_000;
// Codex one-shot responses have been observed to take 15-20s even for tiny
// prompts (server-side floor), so the title budget needs tail headroom.
const CODEX_THREAD_TITLE_TIMEOUT_MS = 90_000;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  /** The gateway to run on, asked once for the whole generation. */
  providerLaunch?: CodexModelProviderLaunch | undefined;
};

function isCodexModelCapacityError(error: TextGenerationError): boolean {
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("selected model is at capacity") ||
    (detail.includes("model is at capacity") && detail.includes("try a different model"))
  );
}

/**
 * Whether Codex ran and the service refused the model: its closing `ERROR:`
 * line names the model. A failed sign-in or a broken config ends on another
 * line, and another model would not help those. Only the last line counts:
 * Codex prints the prompt above it, which can hold anything.
 */
function isCodexModelRefusal(error: TextGenerationError): boolean {
  const prefix = "Codex CLI command failed: ";
  if (!error.detail.startsWith(prefix)) return false;
  const lastLine = error.detail.slice(prefix.length).trimEnd().split("\n").at(-1)?.trim() ?? "";
  return /^ERROR:.*\bmodel\b/iu.test(lastLine);
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
  textGenerationOptions?: {
    /**
     * The provider Codex's chats run on when it is not OpenAI, as the last
     * status check found it, asked at each run. Without it a run goes to
     * OpenAI, which is where `--ignore-user-config` leaves it.
     */
    readonly modelProviderLaunch?: Effect.Effect<CodexModelProviderLaunch | undefined>;
  },
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
      const tempFileId = yield* randomUUIDv4;
      return yield* fileSystem
        .makeTempFileScoped({
          prefix: `threadlines-${prefix}-${process.pid}-${tempFileId}.tmp`,
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
    providerLaunch: gatewayLaunch,
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
        DEFAULT_GIT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolveCodexCliServiceTier(modelSelection);
      const baseEnv = {
        ...environment,
        ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
      };
      const planFor = (providerLaunch: CodexModelProviderLaunch | undefined) => {
        const env = { ...baseEnv, ...providerLaunch?.environment };
        return {
          env,
          plan: planCliSpawn(
            codexConfig.binaryPath || "codex",
            [
              "exec",
              "--ephemeral",
              // One-shot text generation should not inherit agent-oriented user
              // config (MCP servers, notify hooks, memories) from
              // $CODEX_HOME/config.toml; auth still uses CODEX_HOME.
              ...(options.ignoreUserConfig ? ["--ignore-user-config"] : []),
              ...(providerLaunch?.args ?? []),
              "--skip-git-repo-check",
              ...(operation === "generateCommitMessage" ? ["--ignore-rules"] : []),
              "-s",
              "read-only",
              "--model",
              modelSelection.model,
              "--config",
              `model_reasoning_effort="${reasoningEffort}"`,
              ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
              "--output-schema",
              schemaPath,
              "--output-last-message",
              outputPath,
              ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
              "-",
            ],
            env,
          ),
        };
      };
      // The gateway goes along only beside --ignore-user-config: a run without
      // the flag loads the user's own config, provider and all.
      const { env, plan } = planFor(options.ignoreUserConfig ? gatewayLaunch : undefined);
      const command = ChildProcess.make(
        plan.command,
        [...plan.args],
        hideWindowsConsole({
          ...plan.options,
          env,
          cwd,
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        }),
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
          ).pipe(Effect.andThen(runCodexCommand({ ignoreUserConfig: false }).pipe(Effect.scoped))),
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
    const knownLaunch = textGenerationOptions?.modelProviderLaunch
      ? yield* textGenerationOptions.modelProviderLaunch
      : undefined;
    // A batch file that only cmd.exe can start takes its arguments as one
    // command line, where the quotes in the gateway's settings would let an
    // `&` or a `%NAME%` in them (or in its model's name) act as a command.
    // Such a Codex runs without the gateway, as it did before.
    const startsThroughShell =
      knownLaunch !== undefined &&
      planCliSpawn(codexConfig.binaryPath || "codex", [], {
        ...environment,
        ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
      }).options.shell === true;
    const providerLaunch = startsThroughShell ? undefined : knownLaunch;
    const run = { ...input, providerLaunch };
    // On a gateway, the model picked for titles and commit messages may be one
    // only OpenAI serves (the built-in pick is). The model Codex's config names
    // is known to work there, so a run refused for its model is tried once
    // more on that one.
    const gatewayModel = providerLaunch?.model;
    return yield* runCodexJson(run).pipe(
      Effect.catchIf(
        (error) =>
          gatewayModel !== undefined &&
          input.modelSelection.model !== gatewayModel &&
          isCodexModelRefusal(error),
        () =>
          Effect.logWarning("retrying Codex text generation with the gateway's model", {
            operation: input.operation,
            failedModel: input.modelSelection.model,
            fallbackModel: gatewayModel,
          }).pipe(
            Effect.andThen(
              runCodexJson({
                ...run,
                modelSelection: { ...input.modelSelection, model: gatewayModel ?? DEFAULT_MODEL },
              }),
            ),
          ),
      ),
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
                ...run,
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
      policy: input.policy,
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
      policy: input.policy,
      prTemplate: input.prTemplate,
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
      policy: input.policy,
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
