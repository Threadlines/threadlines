import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.threadlines.dev",
  redirects: {
    // The redesigned homepage lived at /preview while it was being built.
    "/preview": "/",
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
