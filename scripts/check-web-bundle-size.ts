// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * Fails when the built web entry chunk exceeds the gzip budget.
 *
 * The entry chunk is the JS every client parses before first paint, so it is
 * the number that regresses silently as imports accrete. Run after
 * `vp run --filter @threadlines/web build`:
 *
 *   node scripts/check-web-bundle-size.ts
 *
 * Override the budget with THREADLINES_WEB_ENTRY_GZIP_BUDGET_BYTES when a
 * deliberate increase lands (adjust the default here in the same change).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Measured 232 KB gzip after route code-splitting (2026-07); budget leaves
// ~10% headroom. Raise deliberately, never reactively.
const DEFAULT_ENTRY_GZIP_BUDGET_BYTES = 260_000;

const budgetBytes = Number(
  process.env.THREADLINES_WEB_ENTRY_GZIP_BUDGET_BYTES ?? DEFAULT_ENTRY_GZIP_BUDGET_BYTES,
);

const assetsDir = join(import.meta.dirname, "..", "apps", "web", "dist", "assets");

let entryFiles: string[];
try {
  entryFiles = readdirSync(assetsDir).filter(
    (name) => name.startsWith("index-") && name.endsWith(".js"),
  );
} catch {
  console.error(`check-web-bundle-size: missing ${assetsDir} — build @threadlines/web first.`);
  process.exit(1);
}

if (entryFiles.length !== 1) {
  console.error(
    `check-web-bundle-size: expected exactly one entry chunk (index-*.js), found ${entryFiles.length}: ${entryFiles.join(", ")}`,
  );
  process.exit(1);
}

const entryFile = entryFiles[0]!;
const raw = readFileSync(join(assetsDir, entryFile));
const gzipBytes = gzipSync(raw, { level: 9 }).byteLength;

const summary = `entry ${entryFile}: raw ${raw.byteLength.toLocaleString()} B, gzip ${gzipBytes.toLocaleString()} B (budget ${budgetBytes.toLocaleString()} B)`;

if (gzipBytes > budgetBytes) {
  console.error(`check-web-bundle-size: FAIL — ${summary}`);
  console.error(
    "The web entry chunk grew past its gzip budget. Move the new dependency behind a route or lazy() boundary, or raise the budget intentionally in scripts/check-web-bundle-size.ts.",
  );
  process.exit(1);
}

console.log(`check-web-bundle-size: OK — ${summary}`);
