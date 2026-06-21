import { defineConfig } from "vite-plus";

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
