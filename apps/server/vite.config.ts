import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import { createWeightedShardSequencer, shardTimingsConfig } from "../../scripts/lib/test-shards.ts";
import baseConfig from "../../vite.config.ts";
import shardWeights from "./vitest.shard-weights.json" with { type: "json" };

const bundledPackagePrefixes = [
  // Muse Code's protocol client: ESM with no dependencies of its own.
  "@muse-code/",
  // OpenCode 2's client (with its schema and protocol packages): bundled so a
  // packed server never installs the client's own copy of effect.
  "@opencode/",
  "@pierre/diffs",
  "@threadlines/",
  "effect-acp",
  "effect-codex-app-server",
];

export function resolveBundledTelemetryConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly posthogKey: string;
  readonly posthogHost: string;
} {
  const telemetryEnabled = env.THREADLINES_TELEMETRY_ENABLED?.trim().toLowerCase() !== "false";
  return {
    posthogKey: telemetryEnabled ? (env.THREADLINES_POSTHOG_KEY?.trim() ?? "") : "",
    posthogHost: env.THREADLINES_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
  };
}

const bundledTelemetryConfig = resolveBundledTelemetryConfig();

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@threadlines/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      define: {
        __THREADLINES_BUNDLED_POSTHOG_KEY__: JSON.stringify(bundledTelemetryConfig.posthogKey),
        __THREADLINES_BUNDLED_POSTHOG_HOST__: JSON.stringify(bundledTelemetryConfig.posthogHost),
      },
      // Built as dist/bin.mjs: the launcher checks the Node version, then loads src/bin.ts.
      entry: { bin: "src/launcher.ts" },
      outDir: "dist",
      sourcemap: true,
      clean: true,
      dts: false,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily; running files in parallel brings load-sensitive flakes.
      // CI splits it across `--shard` jobs instead.
      fileParallelism: false,
      sequence: { sequencer: createWeightedShardSequencer(shardWeights) },
      ...shardTimingsConfig(),
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
