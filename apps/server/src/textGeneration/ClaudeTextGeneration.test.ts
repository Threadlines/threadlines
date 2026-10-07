import { ClaudeSettings, ProviderInstanceId } from "@threadlines/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@threadlines/shared/model";
import { expect } from "vite-plus/test";

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
            ? "--settings {alwaysThinkingEnabled:false,workflowKeywordTriggerEnabled:false}"
            : '--settings {"alwaysThinkingEnabled":false,"workflowKeywordTriggerEnabled":false}',
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
            ? "--effort max --settings {fastMode:true,workflowKeywordTriggerEnabled:false}"
            : '--effort max --settings {"fastMode":true,"workflowKeywordTriggerEnabled":false}',
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

  // Ultracode runs whole workflows of agents, which a commit message or PR
  // title never needs. A thread saved on the old "ultracode" level keeps its
  // Extra High effort here, and the word in a diff cannot start workflows.
  it.effect("runs a saved Claude ultracode choice at xhigh without ultracode", () =>
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
            ? "--effort xhigh --settings {workflowKeywordTriggerEnabled:false}"
            : '--effort xhigh --settings {"workflowKeywordTriggerEnabled":false}',
        argsMustNotContain: "ultracode",
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

  it.effect("forwards Claude Opus 5 model and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Use Opus 5",
            body: "Body",
          },
        }),
        argsMustContain: "--model claude-opus-5 --effort max",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/opus-5",
            commitSummary: "Use Opus 5",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
                { id: "effort", value: "max" },
              ]),
            },
          });

          expect(generated.title).toBe("Use Opus 5");
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

  // Haiku 5.5 thinks at medium unless told otherwise; titles and commit
  // messages say so explicitly instead of leaving it to the CLI.
  it.effect("forwards Claude Haiku 5.5 model with its default effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Use Haiku 5.5",
            body: "Body",
          },
        }),
        argsMustContain: "--model claude-haiku-5-5 --effort medium",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/haiku-5-5",
            commitSummary: "Use Haiku 5.5",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              "claude-haiku-5-5",
            ),
          });

          expect(generated.title).toBe("Use Haiku 5.5");
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

  // A short run that loads the user's MCP servers can exit mid OAuth refresh
  // and lose a server's rotated refresh token, signing the user out.
  it.effect("runs Claude text generation without the user's MCP servers", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Fix reconnect" } }),
        argsMustContain: "--strict-mcp-config",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix reconnect failures.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("Fix reconnect");
        }),
    ),
  );

  // The prompt quotes the user's message; with Bash or Edit available, a
  // message that asks for work would get it done by the title writer too.
  it.effect("runs Claude text generation with no tools", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Delete the build folder" } }),
        // The fake CLI joins argv with spaces, so the empty value shows as a
        // double space; PowerShell can drop an empty argument, so Windows
        // checks the flag alone.
        argsMustContain: process.platform === "win32" ? "--tools" : "--tools  --strict-mcp-config",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Delete the build folder and run the tests.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("Delete the build folder");
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
