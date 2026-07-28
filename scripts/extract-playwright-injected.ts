/**
 * Vendors Playwright's injected script into the desktop app.
 *
 * Run at build time rather than at runtime, so an upgrade that moves the
 * literal breaks here -- in CI, in front of whoever did the upgrade -- instead
 * of on a user's machine the first time an agent tries to click something.
 *
 *   node scripts/extract-playwright-injected.ts [--check]
 *
 * `--check` verifies the checked-in copy still matches what the installed
 * playwright-core would produce, and is what CI runs.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractInjectedScript,
  INJECTED_SCRIPT_MODULE_PATH,
  VENDOR_DIRECTORY_NAME,
  VENDORED_INJECTED_MANIFEST_FILENAME,
  VENDORED_INJECTED_SCRIPT_FILENAME,
} from "@threadlines/shared/previewInjectedScript";

const here = dirname(fileURLToPath(import.meta.url));
const vendoredPath = join(here, "..", "apps", "desktop", "src", "preview", VENDOR_DIRECTORY_NAME);
const scriptPath = join(vendoredPath, VENDORED_INJECTED_SCRIPT_FILENAME);
const manifestPath = join(vendoredPath, VENDORED_INJECTED_MANIFEST_FILENAME);

function resolveBundle(): { source: string; version: string } {
  // Resolved from the package that declares the dependency, so this reads the
  // copy the lockfile actually installed and the recorded version is the
  // truthful one.
  const require = createRequire(join(here, "..", "apps", "desktop", "package.json"));
  const packageJsonPath = require.resolve("playwright-core/package.json");
  const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;
  const bundlePath = join(dirname(packageJsonPath), "lib", "coreBundle.js");
  return { source: readFileSync(bundlePath, "utf8"), version };
}

const { source, version } = resolveBundle();
const script = extractInjectedScript(source);
const hash = createHash("sha256").update(script).digest("hex");
const manifest = {
  playwrightCoreVersion: version,
  modulePath: INJECTED_SCRIPT_MODULE_PATH,
  bytes: script.length,
  sha256: hash,
};

if (process.argv.includes("--check")) {
  const current = readFileSync(scriptPath, "utf8");
  const currentHash = createHash("sha256").update(current).digest("hex");
  if (currentHash !== hash) {
    console.error(
      `The vendored Playwright injected script is stale.\n` +
        `  playwright-core: ${version}\n` +
        `  checked in:      ${currentHash.slice(0, 16)}\n` +
        `  would extract:   ${hash.slice(0, 16)}\n` +
        `Run: node scripts/extract-playwright-injected.ts`,
    );
    process.exit(1);
  }
  console.log(`Vendored injected script matches playwright-core ${version}.`);
  process.exit(0);
}

writeFileSync(scriptPath, script, "utf8");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `Vendored ${script.length} bytes from playwright-core ${version} (sha256 ${hash.slice(0, 16)}).`,
);
