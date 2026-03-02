#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PRODUCTION_ICON_SOURCE = path.join(repoRoot, "assets/macos-icon-1024.png");
const DIRECT_EXECUTION_PATH = process.argv[1] ? path.resolve(process.argv[1]) : null;

const PLATFORM_CONFIG = {
  mac: {
    hostPlatform: "darwin",
    description: "macOS",
    cliFlag: "--mac",
    defaultTarget: "dmg",
    targetChoices: ["dmg"],
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    hostPlatform: "linux",
    description: "Linux",
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    targetChoices: ["AppImage"],
    archChoices: ["x64", "arm64"],
  },
  win: {
    hostPlatform: "win32",
    description: "Windows",
    cliFlag: "--win",
    defaultTarget: "nsis",
    targetChoices: ["nsis"],
    archChoices: ["x64", "arm64"],
  },
};

function printUsage() {
  console.log(`Build a desktop artifact for T3 Code.

Usage:
  node scripts/build-desktop-artifact.mjs [options]

Options:
  --platform <mac|linux|win>     Target platform (default: current host platform)
  --target <target>              Target format (mac: dmg, linux: AppImage, win: nsis)
  --arch <arm64|x64|universal>   Target arch (platform-dependent default)
  --version <semver>             App version in artifact metadata (default: apps/server version)
  --output-dir <path>            Output folder for final artifacts (default: release)
  --skip-build                   Skip 'bun run build:desktop' (requires existing dist artifacts)
  --keep-stage                   Keep temporary staging directory
  --signed                       Enable signing/notarization auto-discovery in electron-builder
                                 (Windows uses Azure Trusted Signing)
  --help                         Show this message
`);
}

function fail(message) {
  console.error(`[desktop-artifact] ${message}`);
  process.exit(1);
}

function detectHostBuildPlatform(hostPlatform) {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return null;
}

function normalizePlatform(value) {
  const normalized = value.toLowerCase();
  if (normalized === "mac" || normalized === "macos" || normalized === "darwin") return "mac";
  if (normalized === "linux") return "linux";
  if (normalized === "win" || normalized === "windows" || normalized === "win32") return "win";
  return null;
}

function normalizeChoice(inputValue, choices) {
  const normalized = inputValue.toLowerCase();
  for (const choice of choices) {
    if (choice.toLowerCase() === normalized) {
      return choice;
    }
  }
  return null;
}

function formatChoices(values) {
  return values.join(", ");
}

function readRequiredEnvironmentVariable(name, contextMessage) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`Missing ${name}${contextMessage ? ` (${contextMessage})` : ""}.`);
  }
  return value.trim();
}

function readOptionalEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getAzureTrustedSigningOptions() {
  return {
    publisherName: readRequiredEnvironmentVariable(
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
      "required for Windows --signed",
    ),
    endpoint: readRequiredEnvironmentVariable(
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "required for Windows --signed",
    ),
    certificateProfileName: readRequiredEnvironmentVariable(
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "required for Windows --signed",
    ),
    codeSigningAccountName: readRequiredEnvironmentVariable(
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "required for Windows --signed",
    ),
    fileDigest: readOptionalEnvironmentVariable("AZURE_TRUSTED_SIGNING_FILE_DIGEST") ?? "SHA256",
    timestampDigest:
      readOptionalEnvironmentVariable("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST") ?? "SHA256",
    timestampRfc3161:
      readOptionalEnvironmentVariable("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161") ??
      "http://timestamp.acs.microsoft.com",
  };
}

function getDefaultArch(platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

function parseArgs(argv) {
  const hostPlatform = detectHostBuildPlatform(process.platform);
  const parsed = {
    platform: hostPlatform,
    target: null,
    arch: null,
    version: null,
    skipBuild: false,
    keepStage: false,
    signed: false,
    outputDir: path.join(repoRoot, "release"),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (arg === "--keep-stage") {
      parsed.keepStage = true;
      continue;
    }
    if (arg === "--signed") {
      parsed.signed = true;
      continue;
    }

    if (
      arg === "--platform" ||
      arg === "--target" ||
      arg === "--arch" ||
      arg === "--version" ||
      arg === "--output-dir"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`Missing value for ${arg}`);
      }
      index += 1;

      if (arg === "--platform") {
        const platform = normalizePlatform(value);
        if (!platform) {
          fail(`Invalid platform '${value}'. Expected one of: mac, linux, win`);
        }
        parsed.platform = platform;
        continue;
      }

      if (arg === "--target") {
        parsed.target = value;
        continue;
      }

      if (arg === "--arch") {
        parsed.arch = value;
        continue;
      }

      if (arg === "--version") {
        parsed.version = value;
        continue;
      }

      if (arg === "--output-dir") {
        parsed.outputDir = path.resolve(repoRoot, value);
        continue;
      }
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (!parsed.platform) {
    const hosts = ["darwin", "linux", "win32"].join(", ");
    fail(`Unsupported host platform '${process.platform}'. Supported hosts: ${hosts}`);
  }

  const config = PLATFORM_CONFIG[parsed.platform];
  if (!config) {
    fail(`Unsupported platform '${parsed.platform}'`);
  }

  const target =
    parsed.target === null
      ? config.defaultTarget
      : normalizeChoice(parsed.target, config.targetChoices);
  if (!target) {
    fail(
      `Invalid target '${parsed.target}'. Supported targets for ${parsed.platform}: ${formatChoices(
        config.targetChoices,
      )}`,
    );
  }

  const arch = parsed.arch === null ? getDefaultArch(parsed.platform) : normalizeChoice(parsed.arch, config.archChoices);
  if (!arch) {
    fail(
      `Invalid arch '${parsed.arch}'. Supported arches for ${parsed.platform}: ${formatChoices(
        config.archChoices,
      )}`,
    );
  }

  return {
    ...parsed,
    target,
    arch,
  };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { cwd, env = process.env, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function generateMacIconSet(sourcePng, targetIcns, tmpRoot) {
  const iconsetDir = path.join(tmpRoot, "icon.iconset");
  await fs.mkdir(iconsetDir, { recursive: true });

  const iconSizes = [16, 32, 128, 256, 512];
  for (const size of iconSizes) {
    await run(
      "sips",
      [
        "-z",
        String(size),
        String(size),
        sourcePng,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}.png`),
      ],
      { stdio: "ignore" },
    );

    const retinaSize = size * 2;
    await run(
      "sips",
      [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourcePng,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ],
      { stdio: "ignore" },
    );
  }

  await run("iconutil", ["-c", "icns", iconsetDir, "-o", targetIcns], { stdio: "ignore" });
}

async function stageMacIcons(stageResourcesDir) {
  if (!(await exists(PRODUCTION_ICON_SOURCE))) {
    fail(`Production icon source is missing at ${PRODUCTION_ICON_SOURCE}`);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-icon-build-"));

  try {
    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    await run("sips", ["-z", "512", "512", PRODUCTION_ICON_SOURCE, "--out", iconPngPath], {
      stdio: "ignore",
    });

    await generateMacIconSet(PRODUCTION_ICON_SOURCE, iconIcnsPath, tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function validateBundledClientAssets(clientDir) {
  const indexPath = path.join(clientDir, "index.html");
  const indexHtml = await fs.readFile(indexPath, "utf8");
  const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
  const missing = [];

  for (const ref of refs) {
    const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
    if (!normalizedRef) continue;
    if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
    if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

    const ext = path.extname(normalizedRef);
    if (!ext) continue;

    const relativePath = normalizedRef.replace(/^\/+/, "");
    const assetPath = path.join(clientDir, relativePath);
    if (!(await exists(assetPath))) {
      missing.push(normalizedRef);
    }
  }

  if (missing.length > 0) {
    const preview = missing.slice(0, 6).join(", ");
    const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
    fail(
      `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
    );
  }
}

function readWorkspaceCatalog(rootPackageJson) {
  const workspaces = rootPackageJson?.workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return {};
  }

  const catalog = workspaces.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return {};
  }

  return catalog;
}

function resolveCatalogDependencies(dependencies, catalog, dependencySourceLabel) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([dependencyName, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [dependencyName, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : dependencyName;
      const resolvedSpec = catalog[lookupKey];
      if (typeof resolvedSpec !== "string" || resolvedSpec.length === 0) {
        fail(
          `Unable to resolve '${spec}' for ${dependencySourceLabel} dependency '${dependencyName}'. ` +
            `Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [dependencyName, resolvedSpec];
    }),
  );
}

function createBuildConfig(platform, target, productName, signed) {
  const buildConfig = {
    appId: "com.t3tools.t3code",
    productName,
    artifactName: "T3-Code-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };

  if (platform === "mac") {
    buildConfig.mac = {
      target: [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      icon: "icon.png",
      category: "Development",
    };
  }

  if (platform === "win") {
    const winConfig = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = getAzureTrustedSigningOptions();
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
}

async function assertPlatformBuildResources(platform, stageResourcesDir) {
  if (platform === "mac") {
    await stageMacIcons(stageResourcesDir);
    return;
  }

  if (platform === "linux") {
    const iconPath = path.join(stageResourcesDir, "icon.png");
    if (!(await exists(iconPath))) {
      fail(`Missing Linux icon at ${iconPath}`);
    }
    return;
  }

  if (platform === "win") {
    const iconPath = path.join(stageResourcesDir, "icon.ico");
    if (!(await exists(iconPath))) {
      fail(`Missing Windows icon at ${iconPath}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const hostBuildPlatform = detectHostBuildPlatform(process.platform);
  if (!hostBuildPlatform) {
    fail(`Unsupported host platform '${process.platform}'.`);
  }

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    fail(`Unsupported platform '${options.platform}'.`);
  }

  if (hostBuildPlatform !== options.platform) {
    fail(
      `Platform '${options.platform}' must run on ${platformConfig.description} (${platformConfig.hostPlatform}). ` +
        `Current host is ${process.platform}.`,
    );
  }

  const rootPkg = await readJson(path.join(repoRoot, "package.json"));
  const desktopPkg = await readJson(path.join(repoRoot, "apps/desktop/package.json"));
  const serverPkg = await readJson(path.join(repoRoot, "apps/server/package.json"));

  const electronVersion = desktopPkg.dependencies?.electron;
  if (typeof electronVersion !== "string" || electronVersion.length === 0) {
    fail("Could not resolve apps/desktop electron dependency version.");
  }

  const dependencies = serverPkg.dependencies;
  if (!dependencies || Object.keys(dependencies).length === 0) {
    fail("Could not resolve production dependencies from apps/server/package.json.");
  }

  const resolvedDependencies = resolveCatalogDependencies(
    dependencies,
    readWorkspaceCatalog(rootPkg),
    "apps/server",
  );

  const appVersion = options.version ?? serverPkg.version ?? "0.1.0";
  const stageRoot = path.join(os.tmpdir(), `t3code-desktop-${options.platform}-stage`);
  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    console.log("[desktop-artifact] Building desktop/server/web artifacts...");
    await run("bun", ["run", "build:desktop"], { cwd: repoRoot });
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(await exists(dir))) {
      fail(`Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`);
    }
  }

  if (!(await exists(bundledClientEntry))) {
    fail(`Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`);
  }

  await validateBundledClientAssets(path.dirname(bundledClientEntry));

  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  await fs.mkdir(path.join(stageAppDir, "apps/server"), { recursive: true });

  console.log("[desktop-artifact] Staging release app...");
  await fs.cp(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"), {
    recursive: true,
  });
  await fs.cp(distDirs.desktopResources, stageResourcesDir, {
    recursive: true,
  });
  await fs.cp(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"), { recursive: true });

  await assertPlatformBuildResources(options.platform, stageResourcesDir);

  const stagePackageJson = {
    name: "t3-code-desktop",
    version: appVersion,
    private: true,
    description: "T3 Code desktop build",
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/main.js",
    build: createBuildConfig(
      options.platform,
      options.target,
      desktopPkg.productName ?? "T3 Code",
      options.signed,
    ),
    dependencies: resolvedDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  await fs.writeFile(
    path.join(stageAppDir, "package.json"),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`,
    "utf8",
  );

  console.log("[desktop-artifact] Installing staged production dependencies...");
  await run("bun", ["install", "--production"], { cwd: stageAppDir });

  const buildEnv = {
    ...process.env,
  };
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }

  const buildArgs = [
    "--bun",
    "electron-builder",
    platformConfig.cliFlag,
    options.target,
    `--${options.arch}`,
    "--publish",
    "never",
  ];

  console.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  await run("bunx", buildArgs, { cwd: stageAppDir, env: buildEnv });

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(await exists(stageDistDir))) {
    fail(`Build completed but dist directory was not found at ${stageDistDir}`);
  }

  const stageEntries = await fs.readdir(stageDistDir, { withFileTypes: true });
  await fs.mkdir(options.outputDir, { recursive: true });

  const copiedArtifacts = [];
  for (const entry of stageEntries) {
    if (!entry.isFile()) continue;

    const from = path.join(stageDistDir, entry.name);
    const to = path.join(options.outputDir, entry.name);
    await fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    fail(`Build completed but no files were produced in ${stageDistDir}`);
  }

  if (!options.keepStage) {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }

  console.log("[desktop-artifact] Done. Artifacts:");
  for (const artifact of copiedArtifacts) {
    console.log(`  - ${artifact}`);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
const isDirectExecution = DIRECT_EXECUTION_PATH === scriptPath;

if (isDirectExecution) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  });
}
