/**
 * The bundles desktop dev runs from, relative to apps/desktop. dev.mjs's watch
 * builds write them; dev-electron.mjs launches Electron once all of them exist
 * and restarts it whenever one is rebuilt.
 */
export const devBundles = [
  { directory: "dist-electron", files: ["main.cjs", "preload.cjs"] },
  { directory: "../server/dist", files: ["bin.mjs"] },
];
