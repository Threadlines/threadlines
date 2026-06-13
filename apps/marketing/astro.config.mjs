import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.threadlines.dev",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
