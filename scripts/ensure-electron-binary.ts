// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(resolve(repoRoot, "apps/desktop/package.json"));
const electronPackagePath = desktopRequire.resolve("electron/package.json");
const electronPackageRoot = dirname(electronPackagePath);
const electronRequire = createRequire(electronPackagePath);
const electronPackage = desktopRequire("electron/package.json") as { version: string };
const checksums = electronRequire("./checksums.json") as Record<string, string>;
const pathFile = resolve(electronPackageRoot, "path.txt");
const distPath = resolve(electronPackageRoot, "dist");
const distVersionPath = resolve(distPath, "version");
const platform = process.platform;
const arch = process.arch;

function log(message: string): void {
  Effect.runSync(Console.log(message));
}

function clearSkipEnvironment(): void {
  const clearedKeys: string[] = [];

  for (const key of Object.keys(process.env)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "electron_skip_binary_download" ||
      normalizedKey === "npm_config_electron_skip_binary_download"
    ) {
      delete process.env[key];
      clearedKeys.push(key);
    }
  }

  if (clearedKeys.length > 0) {
    log(`Cleared Electron binary skip env: ${clearedKeys.join(", ")}`);
  }
}

function getPlatformPath(): string {
  switch (platform) {
    case "aix":
    case "android":
    case "cygwin":
    case "haiku":
    case "netbsd":
    case "sunos":
      throw new Error(`Electron builds are not available on platform: ${platform}`);
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "linux":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
  }
}

log(`Ensuring Electron ${electronPackage.version} binary for ${platform}/${arch}`);

clearSkipEnvironment();

const packageRelativeBinaryPath = getPlatformPath();
const expectedBinaryPath = resolve(distPath, packageRelativeBinaryPath);

function hasExpectedDist(): boolean {
  if (!existsSync(expectedBinaryPath) || !existsSync(distVersionPath)) {
    return false;
  }

  return readFileSync(distVersionPath, "utf8").replace(/^v/, "") === electronPackage.version;
}

function writePathFile(): void {
  writeFileSync(pathFile, packageRelativeBinaryPath);
}

function hasCompleteInstall(): boolean {
  if (!hasExpectedDist() || !existsSync(pathFile)) {
    return false;
  }

  return readFileSync(pathFile, "utf8") === packageRelativeBinaryPath;
}

async function installElectronBinary(): Promise<void> {
  const artifactVersion = `v${electronPackage.version}`;
  const fileName = `electron-${artifactVersion}-${platform}-${arch}.zip`;
  const artifactUrl = `https://github.com/electron/electron/releases/download/${artifactVersion}/${fileName}`;
  const tempDirectory = mkdtempSync(resolve(tmpdir(), "threadlines-electron-"));
  const zipPath = resolve(tempDirectory, fileName);

  try {
    log(`Downloading ${artifactUrl}`);

    const response = await fetch(artifactUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
      throw new Error(
        `Electron artifact download failed: ${response.status} ${response.statusText}`,
      );
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    log(`Downloaded ${zipBuffer.byteLength} bytes`);

    const expectedSha256 = checksums[fileName];
    if (expectedSha256) {
      const actualSha256 = createHash("sha256").update(zipBuffer).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Electron artifact checksum mismatch for ${fileName}: expected ${expectedSha256}, got ${actualSha256}`,
        );
      }
    }

    writeFileSync(zipPath, zipBuffer);
    log(`Saved artifact to ${zipPath}`);

    rmSync(distPath, { recursive: true, force: true });
    mkdirSync(distPath, { recursive: true });
    extractArchive(zipPath);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }

  const extractedTypesPath = resolve(distPath, "electron.d.ts");
  if (existsSync(extractedTypesPath)) {
    renameSync(extractedTypesPath, resolve(electronPackageRoot, "electron.d.ts"));
  }

  writePathFile();
}

function extractArchive(zipPath: string): void {
  log(`Extracting artifact to ${distPath}`);

  if (platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:THREADLINES_ELECTRON_ZIP -DestinationPath $env:THREADLINES_ELECTRON_DIST -Force",
      ],
      {
        env: {
          ...process.env,
          THREADLINES_ELECTRON_DIST: distPath,
          THREADLINES_ELECTRON_ZIP: zipPath,
        },
        stdio: "inherit",
      },
    );
    return;
  }

  try {
    execFileSync("unzip", ["-q", zipPath, "-d", distPath], { stdio: "inherit" });
  } catch (unzipError) {
    log(`unzip failed, falling back to Python zipfile: ${String(unzipError)}`);
    execFileSync("python3", ["-m", "zipfile", "-e", zipPath, distPath], {
      stdio: "inherit",
    });
  }
}

if (!hasCompleteInstall()) {
  if (hasExpectedDist()) {
    log("Electron binary exists; repairing path.txt");
    writePathFile();
  } else {
    log("Electron binary missing; downloading artifact");
    await installElectronBinary();
  }
}

const electronBinaryPath = desktopRequire("electron") as string;

if (!existsSync(electronBinaryPath)) {
  throw new Error(`Electron binary resolved to a missing path: ${electronBinaryPath}`);
}

log(`Electron path.txt: ${readFileSync(pathFile, "utf8")}`);
log(`Electron binary: ${electronBinaryPath}`);
