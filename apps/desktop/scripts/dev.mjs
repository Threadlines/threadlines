import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

import { devBundles } from "./dev-bundles.mjs";

// dev-electron launches as soon as every bundle exists, so copies left by the
// last session would start Electron on stale code and then restart it once
// per rebuilt bundle. Clear them before the watch builds start.
for (const { directory, files } of devBundles) {
  for (const file of files) {
    rmSync(new URL(`../${directory}/${file}`, import.meta.url), { force: true });
  }
}

const commands = [
  ["vp", ["run", "--filter", "@threadlines/server", "dev:bundle"]],
  ["vp", ["pack", "--watch"]],
  ["node", ["scripts/dev-electron.mjs"]],
];

const children = commands.map(([command, args]) =>
  spawn(command, args, {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
);

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

for (const child of children) {
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;

    if (signal) {
      shutdown(signal);
      process.kill(process.pid, signal);
      return;
    }

    if (code !== 0) {
      shutdown("SIGTERM");
      process.exit(code ?? 1);
    }
  });
}
