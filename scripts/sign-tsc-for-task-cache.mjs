// The root `prepare` step, macOS only: lets `vp run --cache` see what `tsc` reads.
//
// vp's task cache learns a task's inputs by injecting a library into the
// processes it runs. TypeScript 7.0's `tsc` is a Go binary signed with the
// hardened runtime and without `com.apple.security.cs.allow-dyld-environment-variables`,
// so macOS strips that library. A typecheck then records no inputs and replays
// its last result forever, type errors included (voidzero-dev/vite-task#587).
// Re-signing the binary ad hoc drops the hardened runtime and the reads show up.
//
// TypeScript 7.1 ships with the entitlement (microsoft/typescript-go#4868), and
// a binary that has it is left alone, so this step goes quiet on its own. Delete
// it once every TypeScript 7 in the lockfile is 7.1 or newer.
//
// Plain JavaScript on purpose: `prepare` runs on whatever Node does the install.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ENTITLEMENT = "com.apple.security.cs.allow-dyld-environment-variables";

const codesign = (args) => spawnSync("codesign", args, { encoding: "utf8" });

// Every installed TypeScript 7 for this Mac, whichever workspace package asked for it.
const binaries = () => {
  const store = path.resolve("node_modules/.pnpm");
  if (!existsSync(store)) return [];
  const platformPackage = `typescript-darwin-${process.arch}`;
  return readdirSync(store)
    .filter((entry) => entry.startsWith(`@typescript+${platformPackage}@`))
    .map((entry) => path.join(store, entry, "node_modules/@typescript", platformPackage, "lib/tsc"))
    .filter((binary) => existsSync(binary));
};

// Hardened runtime without the entitlement: the case macOS strips the library in.
// `codesign -d` reports the flags on stderr and the entitlements on stdout.
const needsSigning = (binary) => {
  const { stderr = "" } = codesign(["-d", "--verbose=1", binary]);
  if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(stderr)) return false;
  const { stdout = "" } = codesign(["-d", "--entitlements", "-", "--xml", binary]);
  return !stdout.includes(ENTITLEMENT);
};

if (process.platform === "darwin") {
  for (const binary of binaries()) {
    if (!needsSigning(binary)) continue;
    const result = codesign(["--force", "--sign", "-", binary]);
    if (result.status === 0) {
      console.log(`Signed ${path.relative(process.cwd(), binary)} ad hoc for the vp task cache.`);
    } else {
      console.warn(
        `Could not re-sign ${binary} (${String(result.stderr || result.error).trim()}). ` +
          "`vp run --cache typecheck` may replay stale results on this Mac.",
      );
    }
  }
}
