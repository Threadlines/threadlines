import { ClaudeSettings, ProviderInstanceId } from "@threadlines/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@threadlines/shared/model";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "threadlines-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function batchQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const claudePath = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    yield* fs.makeDirectory(binDir, { recursive: true });

    if (process.platform === "win32") {
      const ps1Path = path.join(binDir, "fake-claude.ps1");
      yield* fs.writeFileString(
        ps1Path,
        [
          "$argsText = $args -join ' '",
          "$stdinContent = [Console]::In.ReadToEnd()",
          "if ($env:T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN) {",
          "  if (-not $argsText.Contains($env:T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN)) {",
          '    [Console]::Error.WriteLine("args missing expected content: $argsText")',
          "    exit 2",
          "  }",
          "}",
          "if ($env:T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN) {",
          "  if ($argsText.Contains($env:T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN)) {",
          '    [Console]::Error.WriteLine("args contained forbidden content: $argsText")',
          "    exit 3",
          "  }",
          "}",
          "if ($env:T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN) {",
          "  if (-not $stdinContent.Contains($env:T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN)) {",
          "    [Console]::Error.WriteLine('stdin missing expected content')",
          "    exit 4",
          "  }",
          "}",
          "if ($env:T3_FAKE_CLAUDE_HOME_MUST_BE -and $env:HOME -ne $env:T3_FAKE_CLAUDE_HOME_MUST_BE) {",
          '  [Console]::Error.WriteLine("HOME was $env:HOME")',
          "  exit 5",
          "}",
          "if ($env:T3_FAKE_CLAUDE_STDERR) {",
          "  [Console]::Error.WriteLine($env:T3_FAKE_CLAUDE_STDERR)",
          "}",
          "[Console]::Out.Write($env:T3_FAKE_CLAUDE_OUTPUT)",
          "if ($env:T3_FAKE_CLAUDE_EXIT_CODE) { exit [int]$env:T3_FAKE_CLAUDE_EXIT_CODE }",
          "exit 0",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        claudePath,
        [
          "@echo off",
          `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${batchQuote(ps1Path)} %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      );
      return binDir;
    }

    yield* fs.writeFileString(
      claudePath,
      [
        "#!/bin/sh",
        'args="$*"',
        'stdin_content="$(cat)"',
        'if [ -n "$T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN" ]; then',
        '  printf "%s" "$args" | grep -F -- "$T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "args missing expected content" >&2',
        "    exit 2",
        "  }",
        "fi",
        'if [ -n "$T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$args" | grep -F -- "$T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "args contained forbidden content" >&2',
        "    exit 3",
        "  fi",
        "fi",
        'if [ -n "$T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 4",
        "  }",
        "fi",
        'if [ -n "$T3_FAKE_CLAUDE_HOME_MUST_BE" ] && [ "$HOME" != "$T3_FAKE_CLAUDE_HOME_MUST_BE" ]; then',
        '  printf "%s\\n" "HOME was $HOME" >&2',
        "  exit 5",
        "fi",
        'if [ -n "$T3_FAKE_CLAUDE_STDERR" ]; then',
        '  printf "%s\\n" "$T3_FAKE_CLAUDE_STDERR" >&2',
        "fi",
        'printf "%s" "$T3_FAKE_CLAUDE_OUTPUT"',
        'exit "${T3_FAKE_CLAUDE_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(claudePath, 0o755);
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    homeMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "threadlines-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousHomeMustBe = process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.homeMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_HOME_MUST_BE = input.homeMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousHomeMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_HOME_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_HOME_MUST_BE = previousHomeMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain:
          process.platform === "win32"
            ? "--settings {alwaysThinkingEnabled:false}"
            : '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain:
          process.platform === "win32"
            ? "--effort max --settings {fastMode:true}"
            : '--effort max --settings {"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("forwards Claude ultracode as xhigh effort and CLI settings", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Coordinate deeper agent work",
            body: "Body",
          },
        }),
        argsMustContain:
          process.platform === "win32"
            ? "--effort xhigh --settings {ultracode:true}"
            : '--effort xhigh --settings {"ultracode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-ultracode",
            commitSummary: "Coordinate deeper agent work",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-8", [
                { id: "effort", value: "ultracode" },
              ]),
            },
          });

          expect(generated.title).toBe("Coordinate deeper agent work");
        }),
    ),
  );

  it.effect("forwards Claude Sonnet 5 model and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Use Sonnet 5",
            body: "Body",
          },
        }),
        argsMustContain: "--model claude-sonnet-5 --effort max",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/sonnet-5",
            commitSummary: "Use Sonnet 5",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet-5", [
                { id: "effort", value: "max" },
              ]),
            },
          });

          expect(generated.title).toBe("Use Sonnet 5");
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHome = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          homeMustBe: claudeHome,
          claudeConfig: { homePath: claudeHome },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
