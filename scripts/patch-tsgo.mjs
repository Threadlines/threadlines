// The root `prepare` step: runs `effect-tsgo patch` without letting backups pile up.
//
// @effect/tsgo 0.13 moves the current tsgo binary to a new `tsgo.original.N` on
// every patch, even when it is already patched, and refuses once 100 exist. Hosts
// that keep node_modules between installs (Vercel's build cache) reach that limit
// and every install fails. `tsgo.original` is the unpatched binary, so it stays;
// the numbered files are earlier patched copies (about 30 MB each) and go.
//
// Plain JavaScript on purpose: `prepare` runs on whatever Node does the install.
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`;

let libDir = null;
try {
  const nativePreview = require.resolve("@typescript/native-preview/package.json");
  const platformPackageJson = createRequire(nativePreview).resolve(
    `${platformPackage}/package.json`,
  );
  libDir = path.join(path.dirname(platformPackageJson), "lib");
} catch {
  // Not installed for this platform; `effect-tsgo patch` explains what is missing.
}

if (libDir) {
  for (const name of readdirSync(libDir)) {
    if (/^tsgo(\.exe)?\.original\.\d+$/.test(name)) {
      rmSync(path.join(libDir, name));
    }
  }
}

const effectTsgo = path.join(
  path.dirname(require.resolve("@effect/tsgo/package.json")),
  "dist/effect-tsgo.js",
);
execFileSync(process.execPath, [effectTsgo, "patch"], { stdio: "inherit" });
