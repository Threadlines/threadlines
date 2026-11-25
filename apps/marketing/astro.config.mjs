import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import { build } from "esbuild";

const THREADS_ENTRY = fileURLToPath(new URL("./src/scripts/threads/boot.ts", import.meta.url));
const THREADS_MODULE = "virtual:threads-boot";

/**
 * The homepage's threads drawing, compiled into one string the page inlines
 * right after the hero (src/scripts/threads/boot.ts). A deferred module would
 * wait for the whole document; inline, the drawing starts as the hero paints.
 */
function threadsBoot() {
  const resolved = `\0${THREADS_MODULE}`;
  return {
    name: "threadlines-threads-boot",
    resolveId(id) {
      return id === THREADS_MODULE ? resolved : undefined;
    },
    async load(id) {
      if (id !== resolved) return undefined;
      const result = await build({
        entryPoints: [THREADS_ENTRY],
        bundle: true,
        write: false,
        format: "iife",
        minify: true,
        target: "es2022",
        metafile: true,
        legalComments: "none",
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        this.addWatchFile(fileURLToPath(new URL(input, `file://${process.cwd()}/`)));
      }
      const code = result.outputFiles[0].text;
      // The source goes into a <script> element as is: it must not be able to end it.
      if (/<\/script|<!--/i.test(code)) throw new Error("The threads script can't be inlined.");
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

export default defineConfig({
  site: "https://www.threadlines.dev",
  redirects: {
    // The redesigned homepage lived at /preview while it was being built.
    "/preview": "/",
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    plugins: [threadsBoot()],
  },
});
