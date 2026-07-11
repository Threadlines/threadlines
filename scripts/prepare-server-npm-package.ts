#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse as parseYamlValue } from "yaml";

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const SERVER_NPM_RUNTIME_DEPENDENCIES = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/sql-sqlite-bun",
  "effect",
  "node-pty",
]);

interface PackageJson {
  readonly [key: string]: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

interface WorkspaceConfig {
  readonly catalog?: Record<string, string>;
}

export interface PrepareServerNpmPackageOptions {
  readonly rootDir?: string;
  readonly outputDir?: string;
}

const DEFAULT_OUTPUT_DIR = "release/npm-server";

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readWorkspaceCatalog(rootDir: string): Record<string, string> {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  const workspace = parseYamlValue(readFileSync(workspacePath, "utf8")) as WorkspaceConfig;
  return workspace.catalog ?? {};
}

function omitWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
): Record<string, string> {
  if (!dependencies) return {};

  return Object.fromEntries(
    Object.entries(dependencies).filter(
      ([name, spec]) => SERVER_NPM_RUNTIME_DEPENDENCIES.has(name) && !spec.startsWith("workspace:"),
    ),
  );
}

export function createServerNpmPackageJson(
  packageJson: PackageJson,
  catalog: Record<string, string>,
): PackageJson {
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    ...publishPackageJson
  } = packageJson;
  const dependencies = resolveCatalogDependencies(
    omitWorkspaceDependencies(packageJson.dependencies),
    catalog,
    "apps/server",
  );

  return {
    ...publishPackageJson,
    dependencies,
  };
}

function copyDistRuntimeFiles(sourceDir: string, targetDir: string) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyDistRuntimeFiles(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".mjs")) {
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    if (entry.name === "bin.mjs") {
      chmodSync(targetPath, 0o755);
    }
  }
}

function parseArgs(argv: ReadonlyArray<string>): PrepareServerNpmPackageOptions {
  const options: { rootDir?: string; outputDir?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--root") {
      if (!next) throw new Error("--root requires a value.");
      options.rootDir = next;
      index += 1;
      continue;
    }

    if (arg === "--output") {
      if (!next) throw new Error("--output requires a value.");
      options.outputDir = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function prepareServerNpmPackage(options: PrepareServerNpmPackageOptions = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outputDir = path.resolve(rootDir, options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const serverDir = path.join(rootDir, "apps/server");
  const distDir = path.join(serverDir, "dist");
  const packageJson = readJsonFile<PackageJson>(path.join(serverDir, "package.json"));
  const catalog = readWorkspaceCatalog(rootDir);
  const preparedPackageJson = createServerNpmPackageJson(packageJson, catalog);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(path.join(outputDir, "dist"), { recursive: true });

  copyFileSync(path.join(serverDir, "README.md"), path.join(outputDir, "README.md"));
  copyFileSync(path.join(serverDir, "LICENSE"), path.join(outputDir, "LICENSE"));
  copyDistRuntimeFiles(distDir, path.join(outputDir, "dist"));
  writeFileSync(
    path.join(outputDir, "package.json"),
    `${JSON.stringify(preparedPackageJson, null, 2)}\n`,
  );

  return { outputDir };
}

if (import.meta.main) {
  try {
    const result = prepareServerNpmPackage(parseArgs(process.argv.slice(2)));
    console.log(`Prepared npm package at ${result.outputDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
