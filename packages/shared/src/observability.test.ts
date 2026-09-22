// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vitest";

import {
  compactTraceAttributes,
  makeLocalFileTracer,
  makeTraceSink,
  type TraceRecord,
} from "./observability.ts";

const TraceRecordLine = Schema.Struct({
  name: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  exit: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
    }),
  ),
});

const decodeTraceRecordLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecordLine));

const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

const readTraceRecords = Effect.fn("readTraceRecords")(function* (tracePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* fileSystem.readFileString(tracePath))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeTraceRecordLine(line));
});

const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const nodeServicesIt = it.layer(NodeServices.layer);

describe("observability", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    // @effect-diagnostics-next-line globalDate:off
    const invalidDate = new Date("not-a-real-date");
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate,
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  nodeServicesIt("node services", (it) => {
    it.effect("flushes buffered trace records on close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        }),
      ),
    );

    it.effect("flushes traces after the batch window and re-arms for later records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 1_000,
          });

          sink.push(makeRecord("first"));
          assert.equal(fs.existsSync(tracePath), false);
          yield* TestClock.adjust("999 millis");
          yield* Effect.yieldNow;
          assert.equal(fs.existsSync(tracePath), false);
          yield* TestClock.adjust("1 millis");
          yield* Effect.yieldNow;
          assert.equal(fs.existsSync(tracePath), true);

          sink.push(makeRecord("second"));
          assert.equal(fs.readFileSync(tracePath, "utf8").includes('"name":"second"'), false);
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;

          const records = yield* readTraceRecords(tracePath);
          assert.deepStrictEqual(
            records.map((record) => record.name),
            ["first", "second"],
          );
          yield* sink.close();
        }),
      ),
    );

    it.effect("applies local tracer record filters after a span ends", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const tracer = yield* makeLocalFileTracer({
                filePath: tracePath,
                maxBytes: 1024,
                maxFiles: 2,
                batchWindowMs: 10_000,
                shouldRecord: (record) => record.name !== "filtered-span",
              });
              const layer = Layer.mergeAll(
                Layer.succeed(Tracer.Tracer, tracer),
                Layer.succeed(References.MinimumLogLevel, "Info"),
              );

              yield* Effect.void.pipe(Effect.withSpan("kept-span"), Effect.provide(layer));
              yield* Effect.void.pipe(Effect.withSpan("filtered-span"), Effect.provide(layer));
            }),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.deepStrictEqual(
            records.map((record) => record.name),
            ["kept-span"],
          );
        }),
      ),
    );

    it.effect("rotates the trace file when the configured max size is exceeded", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const record = makeRecord("rotate", `0-${"x".repeat(48)}`);
          const recordBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: recordBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = (yield* fileSystem.readDirectory(tempDir))
            .filter(
              (entry) =>
                entry === "shared.trace.ndjson" || entry.startsWith("shared.trace.ndjson."),
            )
            .toSorted();

          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.3"),
            false,
          );
          for (const entry of matchingFiles) {
            assert.equal(fs.statSync(path.join(tempDir, entry)).size <= recordBytes, true);
          }
        }),
      ),
    );

    it.effect("chunks buffered trace records without exceeding the rotation size", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const first = makeRecord("first", "\u{1F642}".repeat(32));
          const second = makeRecord("second", "\u{1F642}".repeat(32));
          const maxBytes = Math.max(
            Buffer.byteLength(`${JSON.stringify(first)}\n`),
            Buffer.byteLength(`${JSON.stringify(second)}\n`),
          );

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(first);
          sink.push(second);
          yield* sink.close();

          const files = ["shared.trace.ndjson.1", "shared.trace.ndjson"].filter((entry) =>
            fs.existsSync(path.join(tempDir, entry)),
          );
          assert.deepStrictEqual(files, ["shared.trace.ndjson.1", "shared.trace.ndjson"]);
          for (const entry of files) {
            assert.equal(fs.statSync(path.join(tempDir, entry)).size <= maxBytes, true);
          }
          const names = files.flatMap((entry) =>
            fs
              .readFileSync(path.join(tempDir, entry), "utf8")
              .trim()
              .split("\n")
              .map((line) => decodeTraceRecordLine(line).name),
          );
          assert.deepStrictEqual(names, ["first", "second"]);
        }),
      ),
    );

    it.effect("drops an oversized trace record without dropping later records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const valid = makeRecord("valid");
          const maxBytes = Buffer.byteLength(`${JSON.stringify(valid)}\n`);

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("oversized", "x".repeat(maxBytes)));
          sink.push(valid);
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);
          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["valid"],
          );
          assert.equal(fs.statSync(tracePath).size <= maxBytes, true);
        }),
      ),
    );

    it.effect("bounds failed trace retries without duplicating earlier records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const first = makeRecord("first");
          const second = makeRecord("second");
          const third = makeRecord("third");
          const fourth = makeRecord("fourth");
          const recordBytes = (record: TraceRecord) =>
            Buffer.byteLength(`${JSON.stringify(record)}\n`);
          const maxBytes = Math.max(
            recordBytes(first),
            recordBytes(second),
            recordBytes(third),
            recordBytes(fourth),
          );
          const maxBufferedBytes = Math.max(
            recordBytes(second) + recordBytes(third),
            recordBytes(third) + recordBytes(fourth),
          );

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
            maxBufferedBytes,
          });

          const blockingBackup = `${tracePath}.2`;
          fs.mkdirSync(path.join(blockingBackup, "child"), { recursive: true });
          sink.push(first);
          sink.push(second);
          yield* sink.flush;
          sink.push(third);
          sink.push(fourth);
          fs.rmSync(blockingBackup, { recursive: true, force: true });
          yield* sink.flush;

          const names = [
            "shared.trace.ndjson.2",
            "shared.trace.ndjson.1",
            "shared.trace.ndjson",
          ].flatMap((entry) =>
            fs
              .readFileSync(path.join(tempDir, entry), "utf8")
              .trim()
              .split("\n")
              .map((line) => decodeTraceRecordLine(line).name),
          );
          assert.deepStrictEqual(names, ["first", "third", "fourth"]);
        }),
      ),
    );

    it.effect("leaves failed trace recovery to the retry timer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const first = makeRecord("first");
          const second = makeRecord("second");
          const third = makeRecord("third", "x");
          const recordBytes = (record: TraceRecord) =>
            Buffer.byteLength(`${JSON.stringify(record)}\n`);
          const maxBytes = Math.max(recordBytes(first), recordBytes(second), recordBytes(third));

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 1_000,
            maxBufferedBytes: recordBytes(second) + recordBytes(third),
          });

          const blockingBackup = `${tracePath}.2`;
          fs.mkdirSync(path.join(blockingBackup, "child"), { recursive: true });
          sink.push(first);
          sink.push(second);
          yield* sink.flush;

          fs.rmSync(blockingBackup, { recursive: true, force: true });
          sink.push(third);
          assert.equal(fs.existsSync(`${tracePath}.1`), false);
          assert.deepStrictEqual(
            (yield* readTraceRecords(tracePath)).map((record) => record.name),
            ["first"],
          );

          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;

          const names = ["shared.trace.ndjson.2", "shared.trace.ndjson.1", "shared.trace.ndjson"]
            .filter((entry) => fs.existsSync(path.join(tempDir, entry)))
            .flatMap((entry) =>
              fs
                .readFileSync(path.join(tempDir, entry), "utf8")
                .trim()
                .split("\n")
                .map((line) => decodeTraceRecordLine(line).name),
            );
          assert.deepStrictEqual(names, ["first", "second", "third"]);
        }),
      ),
    );

    it.effect("backs off persistent trace failures with an immediate batch window", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const realAppendFileSync = fs.appendFileSync.bind(fs);
          let appendAttempts = 0;
          let failWrites = true;
          const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation((...args) => {
            appendAttempts += 1;
            if (failWrites) {
              throw new Error("simulated trace write failure");
            }
            Reflect.apply(realAppendFileSync, fs, args);
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => appendSpy.mockRestore()));
          yield* TestClock.setTime(0);

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 4_096,
            maxFiles: 2,
            batchWindowMs: 0,
            maxBufferedBytes: 4_096,
          });

          sink.push(makeRecord("first"));
          assert.equal(appendAttempts, 1);
          sink.push(makeRecord("second"));
          assert.equal(appendAttempts, 1);

          yield* TestClock.adjust("199 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 1);
          yield* TestClock.adjust("1 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 2);

          sink.push(makeRecord("third"));
          assert.equal(appendAttempts, 2);
          yield* TestClock.adjust("399 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 2);
          yield* TestClock.adjust("1 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 3);

          let expectedAttempts = 3;
          for (const delayMs of [800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000]) {
            yield* TestClock.adjust(`${delayMs} millis`);
            yield* Effect.yieldNow;
            expectedAttempts += 1;
            assert.equal(appendAttempts, expectedAttempts);
          }
          assert.equal(appendAttempts, 10);
          yield* TestClock.adjust("29999 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 10);
          yield* TestClock.adjust("1 millis");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 11);
          yield* TestClock.adjust("30 seconds");
          yield* Effect.yieldNow;
          assert.equal(appendAttempts, 12);

          failWrites = false;
          yield* sink.close();
          const records = yield* readTraceRecords(tracePath);
          assert.deepStrictEqual(
            records.map((record) => record.name),
            ["first", "second", "third"],
          );
        }),
      ),
    );

    it.effect("drops only the invalid trace record when serialization fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        }),
      ),
    );

    it.effect("writes nested spans to disk and captures log messages as span events", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const program = Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.parent": true,
                });
                yield* Effect.logInfo("parent event");
                yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "demo.child": true,
                  });
                  yield* Effect.logInfo("child event");
                }).pipe(Effect.withSpan("child-span"));
              }).pipe(Effect.withSpan("parent-span"));

              yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
            }),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 2);

          const parent = records.find((record) => record.name === "parent-span");
          const child = records.find((record) => record.name === "child-span");

          assert.notEqual(parent, undefined);
          assert.notEqual(child, undefined);
          if (!parent || !child) {
            return;
          }

          assert.equal(child.parentSpanId, parent.spanId);
          assert.equal(parent.attributes["demo.parent"], true);
          assert.equal(child.attributes["demo.child"], true);
          assert.equal(
            parent.events.some((event) => event.name === "parent event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.name === "child event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
            true,
          );
        }),
      ),
    );

    it.effect("serializes interrupted spans with an interrupted exit status", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.exit(
              Effect.interrupt.pipe(
                Effect.withSpan("interrupt-span"),
                Effect.provide(makeTestLayer(tracePath)),
              ),
            ),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 1);
          assert.equal(records[0]?.name, "interrupt-span");
          assert.equal(records[0]?.exit?._tag, "Interrupted");
        }),
      ),
    );
  });
});
