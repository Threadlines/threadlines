import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vitest";

import {
  CodexSettings,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_MODEL,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
);

const CodexTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function batchQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeFakeCodexBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    forbidFastServiceTier?: boolean;
    requireIgnoreRules?: boolean;
    forbidIgnoreRules?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    requireModel?: string;
    failForModel?: string;
    failForModelStderr?: string;
    failForModelExitCode?: number;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    if (process.platform === "win32") {
      const fakeOutputPath = path.join(binDir, "fake-output.txt");
      const stderrPath = path.join(binDir, "fake-stderr.txt");
      const scriptPath = path.join(binDir, "fake-codex.cjs");
      yield* fs.writeFileString(fakeOutputPath, input.output);
      if (input.stderr !== undefined) {
        yield* fs.writeFileString(stderrPath, input.stderr);
      }
      yield* fs.writeFileString(
        scriptPath,
        [
          '"use strict";',
          'const fs = require("node:fs");',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `const fake = ${JSON.stringify({
            outputPath: fakeOutputPath,
            stderrPath: input.stderr !== undefined ? stderrPath : null,
            exitCode: input.exitCode ?? 0,
            requireImage: input.requireImage === true,
            requireFastServiceTier: input.requireFastServiceTier === true,
            forbidFastServiceTier: input.forbidFastServiceTier === true,
            requireIgnoreRules: input.requireIgnoreRules === true,
            forbidIgnoreRules: input.forbidIgnoreRules === true,
            requireReasoningEffort: input.requireReasoningEffort ?? null,
            forbidReasoningEffort: input.forbidReasoningEffort === true,
            requireModel: input.requireModel ?? null,
            failForModel: input.failForModel ?? null,
            failForModelStderr: input.failForModelStderr ?? "",
            failForModelExitCode: input.failForModelExitCode ?? 1,
            stdinMustContain: input.stdinMustContain ?? null,
            stdinMustNotContain: input.stdinMustNotContain ?? null,
          })};`,
          "const argv = process.argv.slice(2);",
          'let outputPath = "";',
          "let seenImage = false;",
          "let seenFastServiceTier = false;",
          "let seenIgnoreRules = false;",
          'let seenReasoningEffort = "";',
          'let seenModel = "";',
          "for (let index = 0; index < argv.length; index += 1) {",
          "  const arg = argv[index];",
          '  if (arg === "--ignore-rules") {',
          "    seenIgnoreRules = true;",
          "    continue;",
          "  }",
          '  if (arg === "--model") {',
          "    index += 1;",
          "    seenModel = argv[index] || '';",
          "    continue;",
          "  }",
          '  if (arg === "--image") {',
          "    index += 1;",
          "    if (index < argv.length && argv[index]) {",
          "      seenImage = true;",
          "    }",
          "    continue;",
          "  }",
          '  if (arg === "--config") {',
          "    index += 1;",
          "    if (index < argv.length) {",
          "      const normalizedConfig = argv[index].replaceAll('\"', '');",
          '      if (normalizedConfig === "service_tier=fast") {',
          "        seenFastServiceTier = true;",
          "      }",
          '      if (normalizedConfig.startsWith("model_reasoning_effort=")) {',
          "        seenReasoningEffort = normalizedConfig;",
          "      }",
          "    }",
          "    continue;",
          "  }",
          '  if (arg === "--output-last-message") {',
          "    index += 1;",
          "    if (index < argv.length) {",
          "      outputPath = argv[index];",
          "    }",
          "    continue",
          "  }",
          "}",
          'const stdinContent = fs.readFileSync(0, "utf8");',
          "if (fake.failForModel && seenModel === fake.failForModel) {",
          "  process.stderr.write(fake.failForModelStderr);",
          "  process.exit(fake.failForModelExitCode);",
          "}",
          "if (fake.requireModel && seenModel !== fake.requireModel) {",
          "  process.stderr.write(`unexpected model: ${seenModel}\\n`);",
          "  process.exit(8);",
          "}",
          ...(input.requireImage === true
            ? [
                "if (!seenImage) {",
                '  process.stderr.write("missing --image input\\n");',
                "  process.exit(2);",
                "}",
              ]
            : []),
          ...(input.requireFastServiceTier === true
            ? [
                "if (!seenFastServiceTier) {",
                '  process.stderr.write("missing fast service tier config\\n");',
                "  process.exit(5);",
                "}",
              ]
            : []),
          ...(input.forbidFastServiceTier === true
            ? [
                "if (seenFastServiceTier) {",
                '  process.stderr.write("fast service tier config should be omitted\\n");',
                "  process.exit(9);",
                "}",
              ]
            : []),
          ...(input.requireIgnoreRules === true
            ? [
                "if (!seenIgnoreRules) {",
                '  process.stderr.write("missing --ignore-rules\\n");',
                "  process.exit(10);",
                "}",
              ]
            : []),
          ...(input.forbidIgnoreRules === true
            ? [
                "if (seenIgnoreRules) {",
                '  process.stderr.write("--ignore-rules should be omitted\\n");',
                "  process.exit(11);",
                "}",
              ]
            : []),
          ...(input.requireReasoningEffort !== undefined
            ? [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `if (seenReasoningEffort !== ${JSON.stringify(`model_reasoning_effort=${input.requireReasoningEffort}`)}) {`,
                "  process.stderr.write(`unexpected reasoning effort config: ${seenReasoningEffort}\\n`);",
                "  process.exit(6);",
                "}",
              ]
            : []),
          ...(input.forbidReasoningEffort === true
            ? [
                "if (seenReasoningEffort) {",
                "  process.stderr.write(`reasoning effort config should be omitted: ${seenReasoningEffort}\\n`);",
                "  process.exit(7);",
                "}",
              ]
            : []),
          ...(input.stdinMustContain !== undefined
            ? [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `if (!stdinContent.includes(${JSON.stringify(input.stdinMustContain)})) {`,
                '  process.stderr.write("stdin missing expected content\\n");',
                "  process.exit(3);",
                "}",
              ]
            : []),
          ...(input.stdinMustNotContain !== undefined
            ? [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `if (stdinContent.includes(${JSON.stringify(input.stdinMustNotContain)})) {`,
                '  process.stderr.write("stdin contained forbidden content\\n");',
                "  process.exit(4);",
                "}",
              ]
            : []),
          "if (fake.stderrPath) {",
          '  process.stderr.write(fs.readFileSync(fake.stderrPath, "utf8"));',
          "}",
          "if (outputPath) {",
          '  fs.writeFileSync(outputPath, fs.readFileSync(fake.outputPath, "utf8"), "utf8");',
          "}",
          "process.exit(fake.exitCode);",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        codexPath,
        [
          "@echo off",
          `${batchQuote(process.execPath)} ${batchQuote(scriptPath)} %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      );
      return codexPath;
    }

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'seen_image="0"',
        'seen_fast_service_tier="0"',
        'seen_ignore_rules="0"',
        'seen_reasoning_effort=""',
        'seen_model=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--ignore-rules" ]; then',
        '    seen_ignore_rules="1"',
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--model" ]; then',
        "    shift",
        '    seen_model="$1"',
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "service_tier=\\"fast\\"" ]; then',
        '      seen_fast_service_tier="1"',
        "    fi",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.failForModel !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if [ "$seen_model" = ${JSON.stringify(input.failForModel)} ]; then`,
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  printf "%s" ${JSON.stringify(input.failForModelStderr ?? "")} >&2`,
              `  exit ${input.failForModelExitCode ?? 1}`,
              "fi",
            ]
          : []),
        ...(input.requireModel !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if [ "$seen_model" != ${JSON.stringify(input.requireModel)} ]; then`,
              '  printf "%s\\n" "unexpected model: $seen_model" >&2',
              `  exit 8`,
              "fi",
            ]
          : []),
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireFastServiceTier
          ? [
              'if [ "$seen_fast_service_tier" != "1" ]; then',
              '  printf "%s\\n" "missing fast service tier config" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.forbidFastServiceTier
          ? [
              'if [ "$seen_fast_service_tier" = "1" ]; then',
              '  printf "%s\\n" "fast service tier config should be omitted" >&2',
              `  exit 9`,
              "fi",
            ]
          : []),
        ...(input.requireIgnoreRules
          ? [
              'if [ "$seen_ignore_rules" != "1" ]; then',
              '  printf "%s\\n" "missing --ignore-rules" >&2',
              `  exit 10`,
              "fi",
            ]
          : []),
        ...(input.forbidIgnoreRules
          ? [
              'if [ "$seen_ignore_rules" = "1" ]; then',
              '  printf "%s\\n" "--ignore-rules should be omitted" >&2',
              `  exit 11`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`,
            ]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__T3CODE_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__T3CODE_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return codexPath;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    forbidFastServiceTier?: boolean;
    requireIgnoreRules?: boolean;
    forbidIgnoreRules?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    requireModel?: string;
    failForModel?: string;
    failForModelStderr?: string;
    failForModelExitCode?: number;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath });
    const textGeneration = yield* makeCodexTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "fastMode", value: true },
            ]),
          }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("skips rules by default for commit messages", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireIgnoreRules: true,
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("does not use fast service tier unless selected for commit messages", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        forbidFastServiceTier: true,
        requireIgnoreRules: true,
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini", [
            { id: "fastMode", value: false },
          ]),
        }),
    ),
  );

  it.effect("keeps rules enabled for PR content generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "Improve orchestration flow",
          body: "## Summary\n- improve flow\n\n## Testing\n- Not run",
        }),
        forbidIgnoreRules: true,
      },
      (textGeneration) =>
        textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("retries default mini capacity failures with the standard Codex model", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add reliable text generation fallback",
          body: "",
        }),
        failForModel: DEFAULT_GIT_TEXT_GENERATION_MODEL,
        failForModelStderr: "ERROR: Selected model is at capacity. Please try a different model.",
        requireModel: DEFAULT_MODEL,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-fallback",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add reliable text generation fallback");
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});
