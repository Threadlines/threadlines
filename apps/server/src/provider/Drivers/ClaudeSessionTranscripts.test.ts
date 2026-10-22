// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  claudeProjectDirectoryName,
  ensureClaudeSessionTranscript,
  readClaudeTranscriptGoalRecords,
  readClaudeTranscriptResumeFacts,
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

  describe("readClaudeTranscriptResumeFacts", () => {
    const worktreeState = (worktreePath: string | null) =>
      JSON.stringify({
        type: "worktree-state",
        worktreeSession: worktreePath === null ? null : { worktreePath, originalCwd: "/repo" },
        sessionId: SESSION_ID,
      });
    const writeTranscript = (lines: ReadonlyArray<string>) => {
      const { configDir, cleanup } = makeConfigDir();
      const transcriptPath = path.join(configDir, `${SESSION_ID}.jsonl`);
      writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
      return { transcriptPath, cleanup };
    };
    const message = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });

    it.effect("returns the worktree the last worktree-state record names", () => {
      const { transcriptPath, cleanup } = writeTranscript([
        message,
        worktreeState("/repo/.claude/worktrees/old"),
        message,
        worktreeState("/repo/.claude/worktrees/current"),
        message,
      ]);
      return Effect.gen(function* () {
        assert.strictEqual(
          (yield* readClaudeTranscriptResumeFacts(transcriptPath))?.worktreePath,
          "/repo/.claude/worktrees/current",
        );
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
    });

    it.effect("returns null once the session left its worktree, or never entered one", () => {
      const left = writeTranscript([
        worktreeState("/repo/.claude/worktrees/old"),
        worktreeState(null),
      ]);
      const never = writeTranscript([message]);
      return Effect.gen(function* () {
        assert.strictEqual(
          (yield* readClaudeTranscriptResumeFacts(left.transcriptPath))?.worktreePath,
          null,
        );
        assert.strictEqual(
          (yield* readClaudeTranscriptResumeFacts(never.transcriptPath))?.worktreePath,
          null,
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            left.cleanup();
            never.cleanup();
          }),
        ),
      );
    });

    it.effect("reads goal records once on resume, then only complete lines appended after", () => {
      const goal = (attachment: Record<string, unknown>) =>
        JSON.stringify({
          type: "attachment",
          timestamp: "2026-10-18T07:17:18.371Z",
          attachment: { type: "goal_status", ...attachment },
        });
      const { transcriptPath, cleanup } = writeTranscript([
        message,
        goal({ met: false, sentinel: true, condition: "tests pass" }),
        message,
      ]);
      return Effect.gen(function* () {
        const facts = yield* readClaudeTranscriptResumeFacts(transcriptPath);
        assert.deepEqual(facts?.goalRecords, [
          { kind: "set", condition: "tests pass", at: "2026-10-18T07:17:18.371Z" },
        ]);
        const offset = facts?.size ?? 0n;

        // A resume that lands while Claude is mid-line picks the line up later.
        const midLine = writeTranscript([message]);
        appendFileSync(midLine.transcriptPath, '{"type":"attachment","attach');
        const midFacts = yield* readClaudeTranscriptResumeFacts(midLine.transcriptPath);
        appendFileSync(
          midLine.transcriptPath,
          `ment":{"type":"goal_status","met":false,"sentinel":true,"condition":"later"}}\n`,
        );
        const finished = yield* readClaudeTranscriptGoalRecords({
          transcriptPath: midLine.transcriptPath,
          offset: midFacts?.size ?? 0n,
        });
        midLine.cleanup();
        assert.deepEqual(finished?.records, [{ kind: "set", condition: "later" }]);

        // A check line and the start of the next one, still being written.
        const checkLine = goal({ met: false, condition: "tests pass", reason: "2 failing" });
        appendFileSync(transcriptPath, `${checkLine}\n{"type":"attach`);
        const first = yield* readClaudeTranscriptGoalRecords({ transcriptPath, offset });
        assert.deepEqual(first?.records, [
          {
            kind: "check-failed",
            condition: "tests pass",
            reason: "2 failing",
            at: "2026-10-18T07:17:18.371Z",
          },
        ]);

        appendFileSync(
          transcriptPath,
          `${goal({ met: true, condition: "tests pass", reason: "all green", iterations: 2, durationMs: 9000, tokens: 1200 }).slice('{"type":"attach'.length)}\n`,
        );
        const second = yield* readClaudeTranscriptGoalRecords({
          transcriptPath,
          offset: first?.nextOffset ?? offset,
        });
        assert.deepEqual(
          second?.records.map((record) => record.kind),
          ["met"],
        );
        assert.isUndefined(
          yield* readClaudeTranscriptGoalRecords({
            transcriptPath: `${transcriptPath}.missing`,
            offset: 0n,
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
    });
  });
});
