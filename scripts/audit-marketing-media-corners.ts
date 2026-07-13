#!/usr/bin/env node
// @effect-diagnostics globalConsole:off nodeBuiltinImport:off

import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCH_ROOT = NodePath.join(
  REPO_ROOT,
  "apps",
  "marketing",
  "public",
  "Screenshots",
  "launch",
);
const POSTER_ROOT = NodePath.join(LAUNCH_ROOT, "Posters");
const EDGE_SAMPLE_LENGTH = 96;
const ANTIALIAS_THRESHOLD = 5;
const SOLID_EDGE_THRESHOLD = 60;

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface EdgeMetrics {
  readonly antialiasStart: number;
  readonly solidStart: number;
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.SpawnSyncOptions = {},
): ChildProcess.SpawnSyncReturns<Buffer> => {
  const result = ChildProcess.spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    encoding: null,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
    throw new Error(`${command} failed for ${args.at(-1) ?? "input"}: ${stderr.trim()}`);
  }

  return result;
};

const probeDimensions = (filePath: string): Dimensions => {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0:s=x",
    filePath,
  ]);
  const output = result.stdout.toString("utf8").trim();
  const [widthText, heightText] = output.split("x");
  const width = Number(widthText);
  const height = Number(heightText);

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Could not read media dimensions for ${filePath}`);
  }

  return { width, height };
};

const readFirstFrame = (filePath: string, dimensions: Dimensions): Buffer => {
  const result = run("ffmpeg", [
    "-v",
    "error",
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    "format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  const expectedBytes = dimensions.width * dimensions.height;

  if (result.stdout.length !== expectedBytes) {
    throw new Error(
      `Expected ${String(expectedBytes)} grayscale bytes for ${filePath}, received ${String(result.stdout.length)}`,
    );
  }

  return result.stdout;
};

const metricFor = (edge: Uint8Array): EdgeMetrics => {
  const firstAtLeast = (threshold: number): number => {
    const sampleLength = Math.min(edge.length, EDGE_SAMPLE_LENGTH);
    for (let index = 0; index < sampleLength; index += 1) {
      if ((edge[index] ?? 0) >= threshold) {
        return index;
      }
    }
    return -1;
  };

  return {
    antialiasStart: firstAtLeast(ANTIALIAS_THRESHOLD),
    solidStart: firstAtLeast(SOLID_EDGE_THRESHOLD),
  };
};

const reverse = (value: Uint8Array): Uint8Array => Uint8Array.from(value).reverse();

const edgeMetrics = (frame: Buffer, dimensions: Dimensions) => {
  const { width, height } = dimensions;
  const top = frame.subarray(0, width);
  const left = new Uint8Array(height);
  const right = new Uint8Array(height);

  for (let y = 0; y < height; y += 1) {
    left[y] = frame[y * width] ?? 0;
    right[y] = frame[y * width + width - 1] ?? 0;
  }

  return {
    topLeft: metricFor(top),
    topRight: metricFor(reverse(top)),
    left: metricFor(left),
    right: metricFor(right),
  };
};

const formatMetrics = (metrics: EdgeMetrics): string =>
  `${String(metrics.antialiasStart)}/${String(metrics.solidStart)}`;

const difference = (left: number, right: number): number => {
  if (left === right) {
    return 0;
  }
  if (left < 0 || right < 0) {
    return 0;
  }
  return Math.abs(left - right);
};

const listMedia = (): ReadonlyArray<string> => {
  const posters = FileSystem.readdirSync(POSTER_ROOT)
    .filter((name) => name.endsWith(".png"))
    .map((name) => NodePath.join(POSTER_ROOT, name));
  const motion = FileSystem.readdirSync(LAUNCH_ROOT)
    .filter((name) => name.endsWith(".mp4") || name.endsWith(".webm"))
    .map((name) => NodePath.join(LAUNCH_ROOT, name));
  const standaloneStills = FileSystem.readdirSync(LAUNCH_ROOT)
    .filter((name) => name.endsWith(".png") && name !== "poster-contact-sheet.png")
    .map((name) => NodePath.join(LAUNCH_ROOT, name));

  return [...posters, ...motion, ...standaloneStills].sort();
};

let failed = false;

for (const filePath of listMedia()) {
  const dimensions = probeDimensions(filePath);
  const metrics = edgeMetrics(readFirstFrame(filePath, dimensions), dimensions);
  // Chroma subsampling can move the first low-luma antialias pixel by several samples,
  // especially in the light-theme and opaque-file-viewer encodes. The defective hard
  // plate differed by 10–14 px at 1600 and 15–24 px at 3200, so this remains strict
  // enough to catch it without treating codec noise as geometry.
  const tolerance = Math.ceil((dimensions.width / 1600) * 6);
  const comparisons = [
    difference(metrics.topLeft.antialiasStart, metrics.topRight.antialiasStart),
    difference(metrics.topLeft.solidStart, metrics.topRight.solidStart),
    difference(metrics.left.antialiasStart, metrics.right.antialiasStart),
    difference(metrics.left.solidStart, metrics.right.solidStart),
  ];
  const passes = comparisons.every((value) => value <= tolerance);
  const relativePath = NodePath.relative(REPO_ROOT, filePath);

  console.log(
    `${passes ? "PASS" : "FAIL"} ${relativePath} ` +
      `TL=${formatMetrics(metrics.topLeft)} TR=${formatMetrics(metrics.topRight)} ` +
      `L=${formatMetrics(metrics.left)} R=${formatMetrics(metrics.right)}`,
  );
  failed ||= !passes;
}

if (failed) {
  console.error(
    "Marketing media corner symmetry failed. Preserve the system-rendered corner curve or derive a replacement from the untouched opposite corner.",
  );
  process.exitCode = 1;
}
