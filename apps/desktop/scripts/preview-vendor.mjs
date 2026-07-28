/**
 * Puts the vendored Playwright script next to the bundle that reads it.
 *
 * `vp pack` bundles code and nothing else, so a static asset under `src/` never
 * reaches `dist-electron/`. The bundled main resolves the script relative to
 * itself -- correct in a packaged app, where `src/` does not exist -- so without
 * this copy the file is only ever where the runtime is not looking.
 *
 * The symptom is quiet, which is the reason this exists as its own step rather
 * than a line in a build script: `browser_snapshot` fails with ENOENT, the model
 * shrugs and falls back to screenshots, and the agent still looks like it works.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VENDOR_DIRECTORY_NAME,
  VENDORED_INJECTED_MANIFEST_FILENAME,
  VENDORED_INJECTED_SCRIPT_FILENAME,
} from "@threadlines/shared/previewInjectedScript";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The manifest travels with the script so a shipped build can say which
 *  playwright-core it came from. */
const assets = [VENDORED_INJECTED_SCRIPT_FILENAME, VENDORED_INJECTED_MANIFEST_FILENAME];

export function copyPreviewVendor() {
  const from = join(desktopDir, "src", "preview", VENDOR_DIRECTORY_NAME);
  const to = join(desktopDir, "dist-electron", VENDOR_DIRECTORY_NAME);

  mkdirSync(to, { recursive: true });
  for (const asset of assets) {
    const source = join(from, asset);
    if (!existsSync(source)) {
      throw new Error(
        `Missing vendored preview asset ${source}. ` +
          `Run 'vp run --filter @threadlines/desktop vendor:playwright' to regenerate it.`,
      );
    }
    copyFileSync(source, join(to, asset));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  copyPreviewVendor();
}
