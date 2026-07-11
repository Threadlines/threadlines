// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  claudeProjectDirectoryName,
  ensureClaudeSessionTranscript,
  resolveClaudeConfigDir,
} from "./ClaudeSessionTranscripts.ts";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeConfigDir(): { readonly configDir: string; readonly cleanup: () => void } {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-session-transcripts-"));
  return {
    configDir,
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

it.layer(NodeServices.layer)("ClaudeSessionTranscripts", (it) => {
  describe("claudeProjectDirectoryName", () => {
    it.effect("replaces every non-alphanumeric character with a dash", () =>
      Effect.sync(() => {
        assert.equal(claudeProjectDirectoryName("/Users/will/repo"), "-Users-will-repo");
        assert.equal(
          claudeProjectDirectoryName("/Users/will/repo/.claude-worktrees/effect-beta-97"),
          "-Users-will-repo--claude-worktrees-effect-beta-97",
        );
        assert.equal(
          claudeProjectDirectoryName("/Users/will/Git Repo's/app"),
          "-Users-will-Git-Repo-s-app",
        );
      }),
    );
  });

  describe("resolveClaudeConfigDir", () => {
    it.effect("prefers CLAUDE_CONFIG_DIR, then HOME, then the OS home directory", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        assert.equal(
          resolveClaudeConfigDir(
            { CLAUDE_CONFIG_DIR: "/custom/claude-config", HOME: "/home/someone" },
            pathService,
          ),
          pathService.resolve("/custom/claude-config"),
        );
        assert.equal(
          resolveClaudeConfigDir({ HOME: "/home/someone" }, pathService),
          pathService.join("/home/someone", ".claude"),
        );
        assert.equal(
          resolveClaudeConfigDir({}, pathService),
          pathService.join(os.homedir(), ".claude"),
        );
      }),
    );
  });

  describe("ensureClaudeSessionTranscript", () => {
    it.effect("reports a transcript already stored under the cwd's project directory", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const projectDir = path.join(configDir, "projects", claudeProjectDirectoryName(cwd));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), "");
      return Effect.gen(function* () {
        const resolution = yield* ensureClaudeSessionTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
        });
        assert.deepEqual(resolution, {
          outcome: "present",
          transcriptPath: path.join(projectDir, `${SESSION_ID}.jsonl`),
        });
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
    });

    it.effect("copies the transcript when it lives under another project directory", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const staleWorktreeCwd = "/repo/main/.claude-worktrees/feature";
      const sourceDir = path.join(
        configDir,
        "projects",
        claudeProjectDirectoryName(staleWorktreeCwd),
      );
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(path.join(sourceDir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n');
      return Effect.gen(function* () {
        const expectedPath = path.join(
          configDir,
          "projects",
          claudeProjectDirectoryName(cwd),
          `${SESSION_ID}.jsonl`,
        );

        const resolution = yield* ensureClaudeSessionTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
        });
        assert.deepEqual(resolution, {
          outcome: "relocated",
          transcriptPath: expectedPath,
          sourcePath: path.join(sourceDir, `${SESSION_ID}.jsonl`),
        });

        // The relocated transcript resolves as present from now on.
        const secondResolution = yield* ensureClaudeSessionTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
        });
        assert.deepEqual(secondResolution, {
          outcome: "present",
          transcriptPath: expectedPath,
        });
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
    });

    it.effect("reports missing when no project directory holds the transcript", () => {
      const { configDir, cleanup } = makeConfigDir();
      return Effect.gen(function* () {
        const resolution = yield* ensureClaudeSessionTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd: "/repo/main",
          sessionId: SESSION_ID,
        });
        assert.deepEqual(resolution, { outcome: "missing" });
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
    });

    it.effect("reports missing when the projects directory does not exist", () =>
      Effect.gen(function* () {
        const resolution = yield* ensureClaudeSessionTranscript({
          environment: {
            CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "claude-session-transcripts-nonexistent"),
          },
          cwd: "/repo/main",
          sessionId: SESSION_ID,
        });
        assert.deepEqual(resolution, { outcome: "missing" });
      }),
    );
  });
});
