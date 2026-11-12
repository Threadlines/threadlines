// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkLinuxAppLibraryFloor } from "./lib/linux-library-floor.ts";

/**
 * Proves a built Linux AppImage works on older systems than the machine that
 * built it. Unpacks the AppImage, then:
 *
 * 1. reads every binary in it, and the AppImage's own launcher, and fails if
 *    one asks for newer system libraries than we support
 *    (scripts/lib/linux-library-floor.ts). The build checks the app it
 *    packaged the same way; this covers the finished file, including the
 *    libraries electron-builder adds while assembling it.
 * 2. opens a terminal with the bundled node-pty inside an Ubuntu 22.04
 *    container (glibc 2.35), so one native module is loaded for real.
 *
 * The AppImage boot check runs on the build machine, whose glibc is always new
 * enough for what it just compiled, so it cannot catch a native module that
 * older systems refuse to load. Needs Linux and Docker.
 *
 * Usage: node scripts/verify-linux-app-on-old-system.ts [AppImage or its folder]
 */

const OLD_SYSTEM_IMAGE = "ubuntu:22.04";
const PULL_ATTEMPTS = 3;

/**
 * Runs inside the container. node-pty reports only the last folder it tried
 * when its native module fails to load, which hides the real reason, so the
 * module is loaded directly first.
 */
const TERMINAL_PROBE = `
const moduleDir = "/app/resources/app.asar.unpacked/node_modules/node-pty";
try {
  require(moduleDir + "/build/Release/pty.node");
} catch (error) {
  console.error("The terminal's native module did not load: " + error.message);
  process.exit(1);
}
const terminal = require(moduleDir).spawn("/bin/sh", ["-c", "echo terminal-ok"], {});
let output = "";
terminal.onData((data) => {
  output += data;
});
terminal.onExit(() => {
  if (output.includes("terminal-ok")) {
    console.log("The bundled terminal works here.");
    process.exit(0);
  }
  console.error("The terminal started but printed: " + JSON.stringify(output));
  process.exit(1);
});
setTimeout(() => {
  console.error("The terminal did not finish within 30 seconds.");
  process.exit(1);
}, 30000);
`;

function resolveAppImage(input: string): string {
  const target = resolve(input);
  if (!statSync(target).isDirectory()) return target;
  const appImages = readdirSync(target).filter((name) => name.endsWith(".AppImage"));
  const [only] = appImages;
  if (only === undefined || appImages.length > 1) {
    throw new Error(`Expected one AppImage in ${target}, found ${appImages.length}.`);
  }
  return join(target, only);
}

function pullOldSystemImage(): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync("docker", ["pull", "--quiet", OLD_SYSTEM_IMAGE], { stdio: "inherit" });
      return;
    } catch (cause) {
      if (attempt === PULL_ATTEMPTS) throw cause;
      console.warn(`Pulling ${OLD_SYSTEM_IMAGE} failed (attempt ${attempt}); trying again.`);
    }
  }
}

function main(): void {
  if (process.platform !== "linux") {
    throw new Error("This check unpacks and runs a Linux AppImage, so it needs Linux.");
  }
  const appImage = resolveAppImage(process.argv[2] ?? "release");
  const workDir = mkdtempSync(join(tmpdir(), "threadlines-old-system-"));
  try {
    chmodSync(appImage, 0o755);
    // Unpacks into ./squashfs-root without needing FUSE.
    execFileSync(appImage, ["--appimage-extract"], {
      cwd: workDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const appDir = join(workDir, "squashfs-root");
    const problem = checkLinuxAppLibraryFloor(appDir, [appImage]);
    if (problem !== null) throw new Error(problem);
    console.log("Every binary in the AppImage loads on the oldest supported systems.");

    pullOldSystemImage();
    console.log(`Opening a terminal from ${appImage} on ${OLD_SYSTEM_IMAGE}...`);
    // The container has no Node of its own, so it borrows this one. No network:
    // nothing here should need it.
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${realpathSync(process.execPath)}:/usr/local/bin/node:ro`,
        "--volume",
        `${appDir}:/app:ro`,
        OLD_SYSTEM_IMAGE,
        "node",
        "-e",
        TERMINAL_PROBE,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
}
