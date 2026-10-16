// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * Fails when the built web app's startup code exceeds its gzip budgets.
 *
 * Two numbers regress silently as imports accrete:
 *
 * - the entry chunk (index-*.js), which every client parses first;
 * - the startup closure: every file dist/index.html loads before the app can
 *   run, meaning its entry script, everything that script imports statically
 *   (transitively), its modulepreloads and its stylesheets. Each file counts
 *   once. The bundler is free to hoist shared code from the entry into a
 *   statically imported chunk, which leaves the entry small while startup
 *   grows, so the closure is the number that matches what a client downloads
 *   and parses before first paint.
 *
 * Run after `vp run --filter @threadlines/web build`:
 *
 *   node scripts/check-web-bundle-size.ts
 *
 * Override the budgets with THREADLINES_WEB_ENTRY_GZIP_BUDGET_BYTES and
 * THREADLINES_WEB_STARTUP_GZIP_BUDGET_BYTES when a deliberate increase lands
 * (adjust the defaults here in the same change).
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";

// Measured 190 KB gzip (2026-10); budget leaves ~10% headroom. Raise
// deliberately, never reactively.
const DEFAULT_ENTRY_GZIP_BUDGET_BYTES = 210_000;
// Measured 719 KB gzip (2026-10): 54 JS files (667 KB) and 1 CSS file
// (52 KB). Budget leaves ~10% headroom. Raise deliberately, never reactively.
const DEFAULT_STARTUP_GZIP_BUDGET_BYTES = 790_000;

const entryBudgetBytes = Number(
  process.env.THREADLINES_WEB_ENTRY_GZIP_BUDGET_BYTES ?? DEFAULT_ENTRY_GZIP_BUDGET_BYTES,
);
const startupBudgetBytes = Number(
  process.env.THREADLINES_WEB_STARTUP_GZIP_BUDGET_BYTES ?? DEFAULT_STARTUP_GZIP_BUDGET_BYTES,
);

const distDir = join(import.meta.dirname, "..", "apps", "web", "dist");

function fail(message: string): never {
  console.error(`check-web-bundle-size: ${message}`);
  process.exit(1);
}

let indexHtml: string;
try {
  indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
} catch {
  fail(`missing ${join(distDir, "index.html")} — build @threadlines/web first.`);
}

/** Dist-relative paths of the `attr` values on tags matching `tagPattern`. */
function htmlReferences(tagPattern: RegExp, attr: "src" | "href"): string[] {
  const attrPattern = new RegExp(`\\s${attr}="([^"]+)"`);
  return [...indexHtml.matchAll(tagPattern)].flatMap(([tag]) => {
    const url = attrPattern.exec(tag)?.[1];
    // Only files this build emitted; absolute URLs belong to someone else.
    return url && url.startsWith("/") && !url.startsWith("//") ? [url.slice(1)] : [];
  });
}

const entryScripts = htmlReferences(/<script\b[^>]*\btype="module"[^>]*>/g, "src");
const modulePreloads = htmlReferences(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, "href");
const stylesheets = htmlReferences(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, "href");

if (entryScripts.length !== 1 || !/^assets\/index-[^/]+\.js$/.test(entryScripts[0]!)) {
  fail(
    `expected exactly one entry script (assets/index-*.js) in index.html, found: ${entryScripts.join(", ") || "none"}`,
  );
}
const entryFile = entryScripts[0]!;

const fileCache = new Map<string, Buffer>();
function readDistFile(file: string): Buffer {
  let contents = fileCache.get(file);
  if (!contents) {
    try {
      contents = readFileSync(join(distDir, file));
    } catch {
      fail(`index.html references ${file}, which is not in ${distDir}.`);
    }
    fileCache.set(file, contents);
  }
  return contents;
}

// Static `import … from "./x.js"`, `import "./x.js"` and `export … from
// "./x.js"` in the bundler's output. Dynamic `import("./x.js")` is a lazy
// boundary and deliberately not followed.
const STATIC_IMPORT_PATTERN =
  /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;

/** The entry plus everything it imports statically, transitively. */
function staticImportClosure(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    const source = readDistFile(file).toString("utf8");
    for (const [, specifier] of source.matchAll(STATIC_IMPORT_PATTERN)) {
      const imported = posix.normalize(posix.join(posix.dirname(file), specifier!));
      if (!seen.has(imported)) {
        seen.add(imported);
        pending.push(imported);
      }
    }
  }
  return [...seen];
}

const gzipBytes = (file: string): number => gzipSync(readDistFile(file), { level: 9 }).byteLength;

const startupScripts = new Set([...staticImportClosure(entryFile), ...modulePreloads]);
const startupStyles = new Set(stylesheets);
let startupJsGzip = 0;
for (const file of startupScripts) startupJsGzip += gzipBytes(file);
let startupCssGzip = 0;
for (const file of startupStyles) startupCssGzip += gzipBytes(file);
const startupGzip = startupJsGzip + startupCssGzip;
const entryRaw = readDistFile(entryFile).byteLength;
const entryGzip = gzipBytes(entryFile);

const entrySummary = `entry ${entryFile}: raw ${entryRaw.toLocaleString()} B, gzip ${entryGzip.toLocaleString()} B (budget ${entryBudgetBytes.toLocaleString()} B)`;
const startupSummary = `startup closure: ${startupScripts.size} JS + ${startupStyles.size} CSS files, gzip ${startupGzip.toLocaleString()} B (JS ${startupJsGzip.toLocaleString()} B, CSS ${startupCssGzip.toLocaleString()} B; budget ${startupBudgetBytes.toLocaleString()} B)`;

let failed = false;
if (entryGzip > entryBudgetBytes) {
  failed = true;
  console.error(`check-web-bundle-size: FAIL — ${entrySummary}`);
} else {
  console.log(`check-web-bundle-size: OK — ${entrySummary}`);
}
if (startupGzip > startupBudgetBytes) {
  failed = true;
  console.error(`check-web-bundle-size: FAIL — ${startupSummary}`);
  const largest = [...startupScripts, ...startupStyles]
    .map((file) => [file, gzipBytes(file)] as const)
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 8);
  console.error("Largest startup files (gzip):");
  for (const [file, bytes] of largest) {
    console.error(`  ${bytes.toLocaleString().padStart(10)} B  ${file}`);
  }
} else {
  console.log(`check-web-bundle-size: OK — ${startupSummary}`);
}

if (failed) {
  console.error(
    "Startup code grew past its gzip budget. Move the new dependency behind a route or lazy() boundary, or raise the budget intentionally in scripts/check-web-bundle-size.ts.",
  );
  process.exit(1);
}
