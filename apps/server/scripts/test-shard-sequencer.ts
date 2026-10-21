// @effect-diagnostics nodeBuiltinImport:off - vitest loads this sequencer from the
// config, outside any Effect runtime, and it only needs path.relative.
import * as NodePath from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

import recordedWeights from "./test-shard-weights.json" with { type: "json" };

export interface WeightedTestFile {
  /** The file's path relative to the server package, with forward slashes. */
  readonly key: string;
  readonly seconds: number;
}

/**
 * Picks shard `index` (1-based) of `count` by recorded duration: the longest
 * file goes to the lightest shard first, ties broken by path. Every shard runs
 * the same deterministic split over the same file list, so each file lands in
 * exactly one shard.
 */
export function pickWeightedShard<T extends WeightedTestFile>(
  files: ReadonlyArray<T>,
  index: number,
  count: number,
): Array<T> {
  const ordered = files.toSorted(
    (a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const loads = Array.from({ length: count }, () => 0);
  const picked: Array<T> = [];
  for (const file of ordered) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + file.seconds;
    if (lightest === index - 1) picked.push(file);
  }
  return picked;
}

const weights: Readonly<Record<string, number>> = recordedWeights;
// A file added since the last weights update counts as the median recorded file.
const fallbackSeconds =
  Object.values(weights).toSorted((a, b) => a - b)[Math.floor(Object.keys(weights).length / 2)] ??
  1;

/**
 * Splits the server suite across CI's `--shard` jobs by recorded file time.
 * Vitest's default split hashes paths into equal-count shards, which put the
 * slowest orchestration files together and left one shard ~40% heavier.
 * Weights are each file's wall time in a serial run, imports included; refresh
 * them with `node --run test:shard-weights` when the shards drift apart.
 */
export class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weighted = files.map((spec) => {
      const key = NodePath.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
      return { spec, key, seconds: weights[key] ?? fallbackSeconds };
    });
    return pickWeightedShard(weighted, index, count).map((file) => file.spec);
  }
}
