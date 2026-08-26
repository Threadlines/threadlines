// Production build of the streaming benchmark page, so timings reflect what
// users run rather than React dev-mode overhead.
//
//   vite build --config bench/vite.bench.config.ts
//   vite preview --config bench/vite.bench.config.ts --port 5798
//   node bench/record.mjs <label> --url http://localhost:5798/bench/stream.html
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";

import baseConfig from "../vite.config";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: webRoot,
    build: {
      outDir: path.join(webRoot, "bench", "dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: { bench: path.join(webRoot, "bench", "stream.html") },
      },
    },
    preview: { port: 5798, strictPort: true },
  }),
);
