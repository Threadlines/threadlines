import { defineConfig } from "vite-plus";

// The desktop shell sends its own startup-failure telemetry (the backend is
// not running to send anything), so it bakes in the same PostHog key the
// server build does. Keep in sync with resolveBundledTelemetryConfig in
// apps/server/vite.config.ts; importing it here would breach the tsconfig
// project boundary.
function resolveBundledTelemetryConfig(env: NodeJS.ProcessEnv = process.env): {
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

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  dts: false,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig({
  pack: [
    {
      ...shared,
      entry: ["src/main.ts"],
      clean: true,
      define: {
        __THREADLINES_BUNDLED_POSTHOG_KEY__: JSON.stringify(bundledTelemetryConfig.posthogKey),
        __THREADLINES_BUNDLED_POSTHOG_HOST__: JSON.stringify(bundledTelemetryConfig.posthogHost),
      },
      deps: {
        alwaysBundle: (id) => id.startsWith("@threadlines/"),
      },
    },
    {
      ...shared,
      entry: ["src/preload.ts"],
    },
  ],
});
