// @effect-diagnostics nodeBuiltinImport:off - Vitest loads these from test
// configs, outside any Effect runtime; they only need path and a file write.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BaseSequencer,
  type Reporter,
  type TestModule,
  type TestSpecification,
} from "vite-plus/test/node";

/**
 * Test sharding for CI's split suites (the server tests and the web browser
 * tests). Vitest's default `--shard` hashes paths into equal-count shards,
 * which piles slow files onto one runner. These split by recorded time
 * instead. Each suite keeps its weights in a JSON file next to its config;
 * CI uploads fresh timings from every shard, and
 * `node --run test:shard-weights -- <suite> [run-id]` rebuilds the weights.
 */

export type ShardWeights = Readonly<Record<string, number>>;

export interface WeightedTestFile {
  /** The file's path relative to the suite's root, with forward slashes. */
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

const suiteKey = (root: string, file: string): string =>
  NodePath.relative(root, file).replaceAll("\\", "/");

/** A Vitest sequencer whose `--shard` split follows `weights`. */
export function createWeightedShardSequencer(weights: ShardWeights): typeof BaseSequencer {
  // A file added since the last weights update counts as the median recorded file.
  const recorded = Object.values(weights).toSorted((a, b) => a - b);
  const fallbackSeconds = recorded[Math.floor(recorded.length / 2)] ?? 1;

  return class WeightedShardSequencer extends BaseSequencer {
    override async shard(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
      const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
      const weighted = files.map((spec) => {
        const key = suiteKey(this.ctx.config.root, spec.moduleId);
        return { spec, key, seconds: weights[key] ?? fallbackSeconds };
      });
      return pickWeightedShard(weighted, index, count).map((file) => file.spec);
    }
  };
}

/**
 * Writes each test file's time, in seconds, to `outputFile`: imports, setup
 * and every test and hook. The weights refresh reads these from CI.
 * `prepareDuration` stays out: in browser mode it includes the wait for the
 * browser session to start (~45s), counted again for every file.
 */
class ShardTimingsReporter implements Reporter {
  readonly outputFile: string;

  constructor(outputFile: string) {
    this.outputFile = outputFile;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const timings = testModules
      .map((testModule) => {
        const d = testModule.diagnostic();
        const ms = d.environmentSetupDuration + d.collectDuration + d.setupDuration + d.duration;
        return [suiteKey(testModule.project.config.root, testModule.moduleId), ms] as const;
      })
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, ms]) => [key, Math.max(0.1, Math.round(ms / 100) / 10)] as const);
    NodeFS.mkdirSync(NodePath.dirname(this.outputFile), { recursive: true });
    NodeFS.writeFileSync(
      this.outputFile,
      `${JSON.stringify(Object.fromEntries(timings), null, 2)}\n`,
    );
  }
}

/**
 * Test config a sharded suite spreads in. When THREADLINES_SHARD_TIMINGS_FILE
 * is set (CI's shard jobs), it runs Vitest's usual reporters plus one that
 * records file times there; otherwise it changes nothing.
 */
export function shardTimingsConfig(): { reporters?: Array<string | Reporter> } {
  const outputFile = process.env.THREADLINES_SHARD_TIMINGS_FILE;
  if (!outputFile) return {};
  // Naming any reporter drops Vitest's defaults, so they are named too.
  return {
    reporters: [
      "default",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
      new ShardTimingsReporter(outputFile),
    ],
  };
}
