// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { mapClaudeSubagentTranscriptRecords } from "../Layers/ClaudeAdapter.ts";
import {
  clearClaudeSubagentTranscriptCaches,
  locateClaudeSubagentMeta,
  locateClaudeSubagentTranscript,
  readClaudeSubagentTranscriptEntries,
} from "./ClaudeSubagentTranscripts.ts";
import { claudeProjectDirectoryName } from "./ClaudeSessionTranscripts.ts";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeConfigDir(): { readonly configDir: string; readonly cleanup: () => void } {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-subagent-transcripts-"));
  return {
    configDir,
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

function subagentsDirectory(configDir: string, projectCwd: string): string {
  return path.join(
    configDir,
    "projects",
    claudeProjectDirectoryName(projectCwd),
    SESSION_ID,
    "subagents",
  );
}

function transcriptLine(text: string, timestamp?: string, model?: string): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { content: text, ...(model ? { model } : {}) },
    ...(timestamp ? { timestamp } : {}),
  })}\n`;
}

it.layer(NodeServices.layer)("ClaudeSubagentTranscripts", (it) => {
  describe("locateClaudeSubagentTranscript", () => {
    it.effect("resolves a transcript by its on-disk agent id", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const directory = subagentsDirectory(configDir, cwd);
      const transcriptPath = path.join(directory, "agent-agent-123.jsonl");
      mkdirSync(directory, { recursive: true });
      writeFileSync(transcriptPath, transcriptLine("hello"));
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const location = yield* locateClaudeSubagentTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: "agent-123",
        });
        assert.deepEqual(location, { transcriptPath, agentId: "agent-123" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("resolves a spawning tool_use id and returns its sidecar metadata", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const directory = subagentsDirectory(configDir, cwd);
      const transcriptPath = path.join(directory, "agent-a720e4804f5b5953a.jsonl");
      const meta = {
        agentType: "Explore",
        description: "Research browser control internals",
        toolUseId: "toolu_01DL1vhTz3MADJXec2wnawbi",
        spawnDepth: 1,
        model: "fable",
      };
      mkdirSync(directory, { recursive: true });
      writeFileSync(transcriptPath, transcriptLine("hello"));
      writeFileSync(
        path.join(directory, "agent-a720e4804f5b5953a.meta.json"),
        JSON.stringify(meta),
      );
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const location = yield* locateClaudeSubagentTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: meta.toolUseId,
        });
        assert.deepEqual(location, {
          transcriptPath,
          agentId: "a720e4804f5b5953a",
          meta,
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("resolves from a project directory other than the cwd slug", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main/.claude/worktrees/feature";
      const originalCwd = "/repo/main";
      const directory = subagentsDirectory(configDir, originalCwd);
      const transcriptPath = path.join(directory, "agent-original.jsonl");
      mkdirSync(directory, { recursive: true });
      writeFileSync(transcriptPath, transcriptLine("hello"));
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const location = yield* locateClaudeSubagentTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: "original",
        });
        assert.deepEqual(location, { transcriptPath, agentId: "original" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("resolves a transcript nested under a workflow directory", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const directory = path.join(subagentsDirectory(configDir, cwd), "workflows", "wf-123");
      const transcriptPath = path.join(directory, "agent-workflow-agent.jsonl");
      mkdirSync(directory, { recursive: true });
      writeFileSync(transcriptPath, transcriptLine("hello"));
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const location = yield* locateClaudeSubagentTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: "workflow-agent",
        });
        assert.deepEqual(location, { transcriptPath, agentId: "workflow-agent" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("returns null when no transcript matches", () => {
      const { configDir, cleanup } = makeConfigDir();
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const location = yield* locateClaudeSubagentTranscript({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd: "/repo/main",
          sessionId: SESSION_ID,
          agentId: "missing",
        });
        assert.equal(location, null);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });
  });

  describe("locateClaudeSubagentMeta", () => {
    it.effect("reports the isolation worktree before the transcript exists", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const directory = subagentsDirectory(configDir, cwd);
      mkdirSync(directory, { recursive: true });
      // Only the sidecar is written: Claude creates it when the subagent is
      // spawned, before the agent has produced a single transcript record.
      writeFileSync(
        path.join(directory, "agent-a720e4804f5b5953a.meta.json"),
        JSON.stringify({
          agentType: "Explore",
          toolUseId: "toolu_01DL1vhTz3MADJXec2wnawbi",
          worktreePath: "/repo/main/.claude/worktrees/agent-a72",
          worktreeBranch: "agent/explore",
        }),
      );
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const meta = yield* locateClaudeSubagentMeta({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: "toolu_01DL1vhTz3MADJXec2wnawbi",
        });
        assert.equal(meta?.worktreePath, "/repo/main/.claude/worktrees/agent-a72");
        assert.equal(meta?.worktreeBranch, "agent/explore");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("omits worktree fields for a subagent spawned without isolation", () => {
      const { configDir, cleanup } = makeConfigDir();
      const cwd = "/repo/main";
      const directory = subagentsDirectory(configDir, cwd);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "agent-plain.meta.json"),
        JSON.stringify({ agentType: "Explore", toolUseId: "toolu_plain" }),
      );
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const meta = yield* locateClaudeSubagentMeta({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd,
          sessionId: SESSION_ID,
          agentId: "toolu_plain",
        });
        assert.equal(meta?.agentType, "Explore");
        assert.equal(meta?.worktreePath, undefined);
        assert.equal(meta?.worktreeBranch, undefined);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("returns null when no sidecar matches", () => {
      const { configDir, cleanup } = makeConfigDir();
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const meta = yield* locateClaudeSubagentMeta({
          environment: { CLAUDE_CONFIG_DIR: configDir },
          cwd: "/repo/main",
          sessionId: SESSION_ID,
          agentId: "toolu_missing",
        });
        assert.equal(meta, null);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });
  });

  describe("readClaudeSubagentTranscriptEntries", () => {
    it.effect("reports the model the agent's own records were produced by", () => {
      const { configDir, cleanup } = makeConfigDir();
      const transcriptPath = path.join(configDir, "agent-model.jsonl");
      writeFileSync(transcriptPath, transcriptLine("first", undefined, "claude-opus-5"));
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const read = yield* readClaudeSubagentTranscriptEntries({
          transcriptPath,
          mapLines: mapClaudeSubagentTranscriptRecords,
        });
        assert.equal(read.model, "claude-opus-5");

        // The model survives a cached read and an incremental append.
        assert.equal(
          (yield* readClaudeSubagentTranscriptEntries({
            transcriptPath,
            mapLines: mapClaudeSubagentTranscriptRecords,
          })).model,
          "claude-opus-5",
        );
        appendFileSync(transcriptPath, transcriptLine("second"));
        assert.equal(
          (yield* readClaudeSubagentTranscriptEntries({
            transcriptPath,
            mapLines: mapClaudeSubagentTranscriptRecords,
          })).model,
          "claude-opus-5",
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });

    it.effect("reads appended lines incrementally and re-reads a rewritten file", () => {
      const { configDir, cleanup } = makeConfigDir();
      const transcriptPath = path.join(configDir, "agent-incremental.jsonl");
      writeFileSync(transcriptPath, transcriptLine("first", "2026-07-26T12:00:00.000Z"));
      clearClaudeSubagentTranscriptCaches();

      return Effect.gen(function* () {
        const first = yield* readClaudeSubagentTranscriptEntries({
          transcriptPath,
          mapLines: mapClaudeSubagentTranscriptRecords,
        });
        assert.deepEqual(first, {
          entries: [
            {
              role: "assistant",
              text: "first",
              at: "2026-07-26T12:00:00.000Z",
              toolUses: [],
            },
          ],
          droppedEntries: 0,
        });

        appendFileSync(transcriptPath, transcriptLine("second") + transcriptLine("third"));
        const appended = yield* readClaudeSubagentTranscriptEntries({
          transcriptPath,
          mapLines: mapClaudeSubagentTranscriptRecords,
        });
        assert.deepEqual(
          appended.entries.map((entry) => entry.text),
          ["first", "second", "third"],
        );

        writeFileSync(transcriptPath, transcriptLine("rewritten"));
        const rewritten = yield* readClaudeSubagentTranscriptEntries({
          transcriptPath,
          mapLines: mapClaudeSubagentTranscriptRecords,
        });
        assert.deepEqual(
          rewritten.entries.map((entry) => entry.text),
          ["rewritten"],
        );
        assert.equal(rewritten.droppedEntries, 0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearClaudeSubagentTranscriptCaches();
            cleanup();
          }),
        ),
      );
    });
  });
});
