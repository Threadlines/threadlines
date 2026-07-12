import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

const bundledPackagePrefixes = [
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
      entry: ["src/bin.ts"],
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
      fileParallelism: false,
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
