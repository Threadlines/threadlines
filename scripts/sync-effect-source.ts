// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
/**
 * Vendors the Effect source that matches the installed `effect` into
 * `.repos/effect`, so agents read the real library instead of guessing Effect 4
 * APIs from older training data. The Effect team recommends the same setup.
 *
 *   node scripts/sync-effect-source.ts [--check]
 *
 * Run it after every Effect upgrade; it clones the `effect@<version>` tag.
 * `--check` is what CI runs: it fails when the copy was made for another
 * version or was edited by hand, and it needs no network.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/Effect-TS/effect.git";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".repos", "effect");
const manifestPath = join(target, "SOURCE.json");

// Repo-level guides for agents: the LLM guide, curated examples, the Effect
// team's API conventions and the Effect 3 to 4 migration notes.
const TOP_LEVEL_ENTRIES = [
  "LICENSE",
  "README.md",
  "LLMS.md",
  "MIGRATION.md",
  ".agents/skills/effect-development",
  "ai-docs/README.md",
  "ai-docs/src",
  "migration",
];

// The packages Threadlines installs. From each one: its source, the docs at its
// root, and package.json (saved as package.upstream.json), whose exports map
// shows the import paths.
const PACKAGES = [
  "effect",
  "platform/node",
  "platform/node-shared",
  "platform/bun",
  "sql/sqlite-bun",
  "sql/sqlite-node",
  "vitest",
  "atom/react",
  "tools/openapi-generator",
];
const isPackageEntry = (name: string) =>
  name === "src" || name === "package.json" || name === "LICENSE" || name.endsWith(".md");

const SKIPPED = new Set([
  // Generated data behind the migration notes, about 3 MB.
  "migration/annotations",
  // The Scalar and Swagger pages HttpApi serves, about 5 MB of minified
  // bundles in string literals. Unused here, and they swamp search results.
  "packages/effect/src/http-api/internal/httpApiScalar.ts",
  "packages/effect/src/http-api/internal/httpApiSwagger.ts",
]);

interface Manifest {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly effectVersion: string;
  readonly files: number;
  readonly sha256: string;
}

// Resolved from a package that depends on effect, so this is the version the
// lockfile actually installed.
function installedEffectVersion(): string {
  const require = createRequire(join(root, "packages", "contracts", "package.json"));
  const packageJson = readFileSync(require.resolve("effect/package.json"), "utf8");
  return (JSON.parse(packageJson) as { version: string }).version;
}

function listFiles(dir: string): Array<string> {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path !== "SOURCE.json")
    .sort();
}

function digest(dir: string, files: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(dir, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

function copyEntry(source: string, destination: string, entry: string) {
  const from = join(source, entry);
  if (!existsSync(from)) {
    throw new Error(`${entry} is missing from the Effect repo; update the list in this script.`);
  }
  cpSync(from, join(destination, entry), {
    recursive: true,
    // Upstream links some files (such as a package LICENSE) to the repo root.
    dereference: true,
    filter: (path) => !SKIPPED.has(relative(source, path).split(sep).join("/")),
  });
}

// GitHub's dependency graph reads every file named package.json as a manifest,
// so a copied one turns the dev tools pinned in Effect's own repo into
// Dependabot alerts and security PRs against Threadlines (PR #524). The renamed
// copy keeps its exact contents for agents to read.
function hideManifests(dir: string) {
  for (const file of listFiles(dir)) {
    if (file === "package.json" || file.endsWith("/package.json")) {
      renameSync(join(dir, file), join(dir, dirname(file), "package.upstream.json"));
    }
  }
}

function check() {
  const version = installedEffectVersion();
  if (!existsSync(manifestPath)) {
    console.error(`.repos/effect is missing. Run: node scripts/sync-effect-source.ts`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.effectVersion !== version) {
    console.error(
      `.repos/effect holds Effect ${manifest.effectVersion}, but ${version} is installed.\n` +
        `Run: node scripts/sync-effect-source.ts`,
    );
    process.exit(1);
  }
  const files = listFiles(target);
  if (files.length !== manifest.files || digest(target, files) !== manifest.sha256) {
    console.error(
      `.repos/effect no longer matches the ${manifest.tag} copy it was made from.\n` +
        `It is read-only reference material. Run: node scripts/sync-effect-source.ts`,
    );
    process.exit(1);
  }
  console.log(`.repos/effect matches the installed Effect ${version}.`);
}

function sync() {
  const version = installedEffectVersion();
  const tag = `effect@${version}`;
  const clone = mkdtempSync(join(tmpdir(), "threadlines-effect-source-"));
  let staged: string | undefined;
  try {
    execFileSync(
      "git",
      [
        "-c",
        "advice.detachedHead=false",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        tag,
        REPOSITORY,
        clone,
      ],
      {
        stdio: "inherit",
      },
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" });

    // Built beside the old copy and swapped in only once complete, so a
    // failed sync leaves the previous copy in place.
    mkdirSync(dirname(target), { recursive: true });
    staged = mkdtempSync(join(dirname(target), ".effect-staging-"));
    for (const entry of TOP_LEVEL_ENTRIES) copyEntry(clone, staged, entry);
    for (const name of PACKAGES) {
      const packageDir = join("packages", name);
      if (!existsSync(join(clone, packageDir))) {
        throw new Error(`${packageDir} is missing from ${tag}; update the list in this script.`);
      }
      for (const entry of readdirSync(join(clone, packageDir)).filter(isPackageEntry)) {
        copyEntry(clone, staged, join(packageDir, entry));
      }
    }
    hideManifests(staged);

    const files = listFiles(staged);
    const manifest: Manifest = {
      repository: REPOSITORY,
      tag,
      commit: commit.trim(),
      effectVersion: version,
      files: files.length,
      sha256: digest(staged, files),
    };
    writeFileSync(join(staged, "SOURCE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
    staged = undefined;
    console.log(`Copied ${files.length} files from ${tag} into .repos/effect.`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}

if (process.argv.includes("--check")) {
  check();
} else {
  sync();
}
