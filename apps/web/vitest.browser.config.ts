import { fileURLToPath } from "node:url";
import { playwright } from "vite-plus/test/browser-playwright";
import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import viteConfig, { createWebPlugins } from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const browserViteConfig = {
  ...viteConfig,
  // Eager routes in tests: route code-splitting is a production-bundle
  // concern, and split routes turn the first full-app mount into a cold
  // chunk load that can outlive waitFor timeouts on shared CI runners.
  plugins: createWebPlugins({ routerAutoCodeSplitting: false }),
  test: undefined,
};

export default mergeConfig(
  browserViteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    server: {
      // The app dev server uses a fixed port, but browser tests need to allow
      // concurrent runs to claim the next available port.
      strictPort: false,
    },
    test: {
      include: ["src/components/**/*.browser.tsx"],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [
          {
            browser: "chromium",
            viewport: { width: 1_600, height: 1_300 },
          },
        ],
        headless: true,
        api: {
          strictPort: false,
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
