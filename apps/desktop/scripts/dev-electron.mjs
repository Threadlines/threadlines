import { spawn, spawnSync } from "node:child_process";
import { unwatchFile, watch, watchFile } from "node:fs";
import { join } from "node:path";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const watchPollIntervalMs = 500;
const restartOnRebuild = readBooleanEnv(
  [
    "THREADLINES_DESKTOP_RESTART_ON_REBUILD",
    "BADCODE_DESKTOP_RESTART_ON_REBUILD",
    "T3CODE_DESKTOP_RESTART_ON_REBUILD",
  ],
  true,
);
const devInstance = readStringEnv([
  "THREADLINES_DEV_INSTANCE",
  "BADCODE_DEV_INSTANCE",
  "T3CODE_DEV_INSTANCE",
]);
const devProcessIdentity = devInstance
  ? `${desktopDir}::${devInstance.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}`
  : desktopDir;
const desktopAppDataDirectory = readStringEnv([
  "THREADLINES_DESKTOP_APP_DATA_DIR",
  "BADCODE_DESKTOP_APP_DATA_DIR",
  "T3CODE_DESKTOP_APP_DATA_DIR",
]);
const configuredUserDataDirName = readStringEnv([
  "THREADLINES_DESKTOP_USER_DATA_DIR_NAME",
  "BADCODE_DESKTOP_USER_DATA_DIR_NAME",
  "T3CODE_DESKTOP_USER_DATA_DIR_NAME",
]);
const userDataDirName =
  configuredUserDataDirName === null ||
  (/^[a-zA-Z0-9._-]+$/.test(configuredUserDataDirName) &&
    configuredUserDataDirName !== "." &&
    configuredUserDataDirName !== "..")
    ? (configuredUserDataDirName ?? "threadlines-dev")
    : "threadlines-dev";
if (configuredUserDataDirName !== null && userDataDirName !== configuredUserDataDirName) {
  console.warn(
    "[desktop-dev] Ignoring unsafe desktop user-data directory name: " + configuredUserDataDirName,
  );
}
const desktopUserDataDirectory =
  desktopAppDataDirectory === null ? null : join(desktopAppDataDirectory, userDataDirName);
const configuredRemoteDebuggingPort = readStringEnv(["THREADLINES_CAPTURE_DEBUG_PORT"]);
const parsedRemoteDebuggingPort = configuredRemoteDebuggingPort
  ? Number.parseInt(configuredRemoteDebuggingPort, 10)
  : null;
const remoteDebuggingPort =
  parsedRemoteDebuggingPort !== null &&
  Number.isInteger(parsedRemoteDebuggingPort) &&
  parsedRemoteDebuggingPort > 0 &&
  parsedRemoteDebuggingPort <= 65_535
    ? parsedRemoteDebuggingPort
    : null;
if (configuredRemoteDebuggingPort !== null && remoteDebuggingPort === null) {
  console.warn(
    "[desktop-dev] Ignoring invalid THREADLINES_CAPTURE_DEBUG_PORT=" +
      configuredRemoteDebuggingPort,
  );
}

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];
const polledFiles = [];

function readBooleanEnv(names, defaultValue) {
  const entry = names
    .map((name) => [name, process.env[name]?.trim()])
    .find(([, value]) => value !== undefined && value.length > 0);

  if (!entry) {
    return defaultValue;
  }

  const [name, rawValue] = entry;
  const value = rawValue.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  console.warn(`[desktop-dev] Ignoring invalid ${name}=${rawValue}; expected true/false or 1/0.`);
  return defaultValue;
}

function readStringEnv(names) {
  return (
    names
      .map((name) => process.env[name]?.trim())
      .find((value) => value !== undefined && value.length > 0) ?? null
  );
}

function killChildTreeByPid(pid, signal) {
  if (typeof pid !== "number") {
    return;
  }

  if (process.platform === "win32") {
    // taskkill /T takes the whole tree (incl. the spawned server); /F is
    // the force-kill analogue of KILL. Without /T, killing the Electron
    // main orphans the backend it spawned.
    spawnSync(
      "taskkill",
      signal === "KILL" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"],
      { stdio: "ignore" },
    );
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  const needle = `--threadlines-dev-root=${devProcessIdentity}`;

  if (process.platform === "win32") {
    // Match only Electron mains carrying our dev-root flag, then take each
    // tree down so their spawned servers go with them.
    const escapedNeedle = needle.replaceAll("'", "''");
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -like '*${escapedNeedle}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F } | Out-Null`,
      ],
      { stdio: "ignore" },
    );
    return;
  }

  spawnSync("pkill", ["-f", "--", needle], { stdio: "ignore" });
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const launchArgs = [
    "--threadlines-dev-root=" + devProcessIdentity,
    ...(desktopUserDataDirectory === null ? [] : ["--user-data-dir=" + desktopUserDataDirectory]),
    ...(remoteDebuggingPort === null ? [] : ["--remote-debugging-port=" + remoteDebuggingPort]),
    "dist-electron/main.cjs",
  ];
  const app = spawn(resolveElectronPath(), launchArgs, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    if (process.platform === "win32") {
      // Tree first: once the root is gone, Windows reparents its children
      // and /T can no longer reach them.
      killChildTreeByPid(app.pid, "TERM");
      app.kill("SIGTERM");
    } else {
      app.kill("SIGTERM");
      killChildTreeByPid(app.pid, "TERM");
    }

    setTimeout(() => {
      if (settled) {
        return;
      }

      if (process.platform === "win32") {
        killChildTreeByPid(app.pid, "KILL");
        app.kill("SIGKILL");
      } else {
        app.kill("SIGKILL");
        killChildTreeByPid(app.pid, "KILL");
      }
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  if (!restartOnRebuild) {
    console.warn(
      "[desktop-dev] Electron auto-restart on rebuilt main/preload/server bundles is disabled.",
    );
    return;
  }

  for (const { directory, files } of watchedDirectories) {
    const directoryPath = join(desktopDir, directory);

    if (process.platform === "win32") {
      // fs.watch on Windows misses atomic-rename bundle writes (events
      // arrive with a null filename or the directory handle goes stale),
      // which left rebuilt bundles running stale. Poll the exact files
      // instead; a restart is heavyweight anyway, so the added latency
      // is irrelevant.
      for (const file of files) {
        const filePath = join(directoryPath, file);
        watchFile(filePath, { interval: watchPollIntervalMs }, (current, previous) => {
          const fileMissing = current.mtimeMs === 0;
          const unchanged = current.mtimeMs === previous.mtimeMs && current.size === previous.size;
          if (fileMissing || unchanged) {
            return;
          }
          scheduleRestart();
        });
        polledFiles.push(filePath);
      }
      continue;
    }

    const watcher = watch(directoryPath, { persistent: true }, (_eventType, filename) => {
      // A null filename means "something in this directory changed";
      // restarting spuriously beats running a stale bundle.
      if (typeof filename === "string" && !files.has(filename)) {
        return;
      }

      scheduleRestart();
    });

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (process.platform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], { stdio: "ignore" });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }
  for (const filePath of polledFiles) {
    unwatchFile(filePath);
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
