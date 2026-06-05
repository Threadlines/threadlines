import type {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryBucket,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProcessResourceHistorySummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  aggregateProcessDiagnostics,
  buildDescendantEntries,
  isDiagnosticsQueryProcess,
  type ProcessRow,
  readProcessRows,
} from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL_MS = 5_000;
const SAMPLE_FAILURE_BACKOFF_MS = 30_000;
const RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_SAMPLES = 20_000;

export interface ProcessResourceSample {
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
  readonly processKey: string;
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly depth: number;
  readonly isServerRoot: boolean;
}

interface MonitorState {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly lastError: string | null;
  readonly latestRows: ReadonlyArray<ProcessRow> | null;
  readonly latestSampledAt: DateTime.Utc | null;
}

export interface ProcessResourceMonitorShape {
  readonly readCurrent: Effect.Effect<ServerProcessDiagnosticsResult>;
  readonly readHistory: (
    input: ServerProcessResourceHistoryInput,
  ) => Effect.Effect<ServerProcessResourceHistoryResult>;
}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  ProcessResourceMonitorShape
>()("t3/diagnostics/ProcessResourceMonitor") {}

function dateTimeFromMillis(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function sampleKey(row: Pick<ProcessRow, "pid" | "command">): string {
  return `${row.pid}:${row.command}`;
}

function findServerRootRow(rows: ReadonlyArray<ProcessRow>, serverPid: number): ProcessRow | null {
  return rows.find((row) => row.pid === serverPid) ?? null;
}

export function collectMonitoredSamples(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly serverPid: number;
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
}): ReadonlyArray<ProcessResourceSample> {
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const root = findServerRootRow(rows, input.serverPid);
  const descendants = buildDescendantEntries(rows, input.serverPid);
  const samples: ProcessResourceSample[] = [];

  if (root) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(root),
      pid: root.pid,
      ppid: root.ppid,
      command: root.command,
      cpuPercent: root.cpuPercent,
      rssBytes: root.rssBytes,
      depth: 0,
      isServerRoot: true,
    });
  }

  for (const process of descendants) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(process),
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      depth: process.depth + 1,
      isServerRoot: false,
    });
  }

  return samples;
}

function trimSamples(
  samples: ReadonlyArray<ProcessResourceSample>,
  nowMs: number,
): ReadonlyArray<ProcessResourceSample> {
  const minSampledAtMs = nowMs - RETENTION_MS;
  const retained = samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  return retained.length <= MAX_RETAINED_SAMPLES
    ? retained
    : retained.slice(retained.length - MAX_RETAINED_SAMPLES);
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessResourceSample>,
): ReadonlyArray<ServerProcessResourceHistorySummary> {
  interface SummaryAccumulator {
    readonly processKey: string;
    first: ProcessResourceSample;
    latest: ProcessResourceSample;
    cpuPercentTotal: number;
    maxCpuPercent: number;
    maxRssBytes: number;
    cpuSecondsApprox: number;
    sampleCount: number;
  }

  const groups = new Map<string, SummaryAccumulator>();
  for (const sample of samples) {
    const existing = groups.get(sample.processKey);
    if (!existing) {
      groups.set(sample.processKey, {
        processKey: sample.processKey,
        first: sample,
        latest: sample,
        cpuPercentTotal: sample.cpuPercent,
        maxCpuPercent: sample.cpuPercent,
        maxRssBytes: sample.rssBytes,
        cpuSecondsApprox: (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
        sampleCount: 1,
      });
      continue;
    }

    if (sample.sampledAtMs < existing.first.sampledAtMs) {
      existing.first = sample;
    }
    if (sample.sampledAtMs >= existing.latest.sampledAtMs) {
      existing.latest = sample;
    }
    existing.cpuPercentTotal += sample.cpuPercent;
    existing.maxCpuPercent = Math.max(existing.maxCpuPercent, sample.cpuPercent);
    existing.maxRssBytes = Math.max(existing.maxRssBytes, sample.rssBytes);
    existing.cpuSecondsApprox += (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000);
    existing.sampleCount += 1;
  }

  return [...groups.values()]
    .map((summary) => {
      const first = summary.first;
      const latest = summary.latest;
      return {
        processKey: summary.processKey,
        pid: latest.pid,
        ppid: latest.ppid,
        command: latest.command,
        depth: latest.depth,
        isServerRoot: latest.isServerRoot,
        firstSeenAt: first.sampledAt,
        lastSeenAt: latest.sampledAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: summary.cpuPercentTotal / summary.sampleCount,
        maxCpuPercent: summary.maxCpuPercent,
        cpuSecondsApprox: summary.cpuSecondsApprox,
        currentRssBytes: latest.rssBytes,
        maxRssBytes: summary.maxRssBytes,
        sampleCount: summary.sampleCount,
      } satisfies ServerProcessResourceHistorySummary;
    })
    .toSorted((left, right) => right.cpuSecondsApprox - left.cpuSecondsApprox);
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ServerProcessResourceHistoryBucket> {
  const bucketMs = Math.max(1_000, input.bucketMs);
  const windowStartMs = input.nowMs - input.windowMs;
  const bucketBounds: Array<{ readonly startedAtMs: number; readonly endedAtMs: number }> = [];
  const samplesByBucketRead: Array<
    Map<number, { cpuPercent: number; rssBytes: number; processCount: number }>
  > = [];

  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + bucketMs);
    bucketBounds.push({ startedAtMs, endedAtMs });
    samplesByBucketRead.push(new Map());
  }

  for (const sample of input.samples) {
    if (sample.sampledAtMs < windowStartMs || sample.sampledAtMs > input.nowMs) {
      continue;
    }

    const bucketIndex = Math.min(
      samplesByBucketRead.length - 1,
      Math.floor((sample.sampledAtMs - windowStartMs) / bucketMs),
    );
    const samplesByRead = samplesByBucketRead[bucketIndex];
    if (!samplesByRead) {
      continue;
    }

    const read = samplesByRead.get(sample.sampledAtMs) ?? {
      cpuPercent: 0,
      rssBytes: 0,
      processCount: 0,
    };
    read.cpuPercent += sample.cpuPercent;
    read.rssBytes += sample.rssBytes;
    read.processCount += 1;
    samplesByRead.set(sample.sampledAtMs, read);
  }

  return bucketBounds.map((bucket, index) => {
    const readTotals = samplesByBucketRead[index]?.values() ?? [];
    let readCount = 0;
    let cpuPercentTotal = 0;
    let maxCpuPercent = 0;
    let maxRssBytes = 0;
    let maxProcessCount = 0;

    for (const read of readTotals) {
      readCount += 1;
      cpuPercentTotal += read.cpuPercent;
      maxCpuPercent = Math.max(maxCpuPercent, read.cpuPercent);
      maxRssBytes = Math.max(maxRssBytes, read.rssBytes);
      maxProcessCount = Math.max(maxProcessCount, read.processCount);
    }

    return {
      startedAt: dateTimeFromMillis(bucket.startedAtMs),
      endedAt: dateTimeFromMillis(bucket.endedAtMs),
      avgCpuPercent: readCount === 0 ? 0 : cpuPercentTotal / readCount,
      maxCpuPercent,
      maxRssBytes,
      maxProcessCount,
    };
  });
}

export function aggregateProcessResourceHistory(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly readAt: DateTime.Utc;
  readonly readAtMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly lastError: string | null;
}): ServerProcessResourceHistoryResult {
  const windowMs = Math.max(1_000, input.windowMs);
  const bucketMs = Math.max(1_000, input.bucketMs);
  const minSampledAtMs = input.readAtMs - windowMs;
  const samples = input.samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  const topProcesses = summarizeProcesses(samples);
  const totalCpuSecondsApprox = samples.reduce(
    (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
    0,
  );

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    retainedSampleCount: input.samples.length,
    totalCpuSecondsApprox,
    buckets: buildBuckets({ samples, nowMs: input.readAtMs, windowMs, bucketMs }),
    topProcesses,
    error: input.lastError ? Option.some({ message: input.lastError }) : Option.none(),
  };
}

export const make = Effect.fn("makeProcessResourceMonitor")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make<MonitorState>({
    samples: [],
    lastError: null,
    latestRows: null,
    latestSampledAt: null,
  });

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtMs = DateTime.toEpochMillis(sampledAt);
    const rows = yield* readProcessRows().pipe(
      Effect.withTracerEnabled(false),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const samples = collectMonitoredSamples({
      rows,
      serverPid: process.pid,
      sampledAt,
      sampledAtMs,
    });
    yield* Ref.update(state, (current) => ({
      samples: trimSamples([...current.samples, ...samples], sampledAtMs),
      lastError: null,
      latestRows: rows,
      latestSampledAt: sampledAt,
    }));
    return true;
  }).pipe(
    Effect.catch((error: unknown) =>
      Ref.update(state, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "Failed to sample process resources.",
      })).pipe(Effect.as(false)),
    ),
  );

  yield* Effect.forever(
    sampleOnce.pipe(
      Effect.flatMap((succeeded) =>
        Effect.sleep(succeeded ? SAMPLE_INTERVAL_MS : SAMPLE_FAILURE_BACKOFF_MS),
      ),
    ),
  ).pipe(Effect.forkScoped);

  const readHistory: ProcessResourceMonitorShape["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const current = yield* Ref.get(state);
      return aggregateProcessResourceHistory({
        samples: current.samples,
        readAt,
        readAtMs,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        lastError: current.lastError,
      });
    });

  const readCurrent: ProcessResourceMonitorShape["readCurrent"] = Effect.gen(function* () {
    let current = yield* Ref.get(state);
    if (!current.latestRows) {
      yield* sampleOnce;
      current = yield* Ref.get(state);
    }
    const readAt = current.latestSampledAt ?? (yield* DateTime.now);
    return aggregateProcessDiagnostics({
      serverPid: process.pid,
      rows: current.latestRows ?? [],
      readAt,
      ...(current.lastError ? { error: current.lastError } : {}),
    });
  });

  return ProcessResourceMonitor.of({ readCurrent, readHistory });
});

export const layer = Layer.effect(ProcessResourceMonitor, make());
