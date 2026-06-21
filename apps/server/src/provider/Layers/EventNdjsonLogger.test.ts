// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { cleanupProviderEventLogDirectory, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("removes old provider log files without touching unrelated files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-cleanup-"));
      const nowMs = Date.parse("2026-06-17T12:00:00.000Z");
      const oldLogPath = path.join(tempDir, "thread-old.log");
      const recentLogPath = path.join(tempDir, "thread-recent.log");
      const unrelatedPath = path.join(tempDir, "state.sqlite");

      try {
        fs.writeFileSync(oldLogPath, "old");
        fs.writeFileSync(recentLogPath, "recent");
        fs.writeFileSync(unrelatedPath, "database");
        const oldTimeSeconds = (nowMs - 31 * 24 * 60 * 60 * 1_000) / 1_000;
        const recentTimeSeconds = (nowMs - 60_000) / 1_000;
        fs.utimesSync(oldLogPath, oldTimeSeconds, oldTimeSeconds);
        fs.utimesSync(recentLogPath, recentTimeSeconds, recentTimeSeconds);
        fs.utimesSync(unrelatedPath, oldTimeSeconds, oldTimeSeconds);

        const result = yield* cleanupProviderEventLogDirectory(tempDir, {
          nowMs,
          maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
          maxTotalBytes: 1_000,
        });

        assert.equal(result.scannedFiles, 2);
        assert.equal(result.deletedFiles, 1);
        assert.equal(fs.existsSync(oldLogPath), false);
        assert.equal(fs.existsSync(recentLogPath), true);
        assert.equal(fs.existsSync(unrelatedPath), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("shrinks provider logs by deleting older unprotected files first", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-cleanup-"));
      const nowMs = Date.parse("2026-06-17T12:00:00.000Z");
      const oldestLogPath = path.join(tempDir, "thread-oldest.log");
      const olderLogPath = path.join(tempDir, "thread-older.log.1");
      const recentLogPath = path.join(tempDir, "thread-recent.log");

      try {
        fs.writeFileSync(oldestLogPath, "x".repeat(80));
        fs.writeFileSync(olderLogPath, "y".repeat(80));
        fs.writeFileSync(recentLogPath, "z".repeat(80));
        const oldestTimeSeconds = (nowMs - 7 * 24 * 60 * 60 * 1_000) / 1_000;
        const olderTimeSeconds = (nowMs - 6 * 24 * 60 * 60 * 1_000) / 1_000;
        const recentTimeSeconds = (nowMs - 60_000) / 1_000;
        fs.utimesSync(oldestLogPath, oldestTimeSeconds, oldestTimeSeconds);
        fs.utimesSync(olderLogPath, olderTimeSeconds, olderTimeSeconds);
        fs.utimesSync(recentLogPath, recentTimeSeconds, recentTimeSeconds);

        const result = yield* cleanupProviderEventLogDirectory(tempDir, {
          nowMs,
          maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
          maxTotalBytes: 120,
          protectRecentMs: 24 * 60 * 60 * 1_000,
        });

        assert.equal(result.scannedFiles, 3);
        assert.equal(result.deletedFiles, 2);
        assert.equal(fs.existsSync(oldestLogPath), false);
        assert.equal(fs.existsSync(olderLogPath), false);
        assert.equal(fs.existsSync(recentLogPath), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.log");
        const threadTwoPath = path.join(tempDir, "thread-2.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
      const basePath = path.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = path.join(tempDir, "_global.log");
        assert.equal(fs.existsSync(globalPath), true);
        const lines = fs
          .readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
