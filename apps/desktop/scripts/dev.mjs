import { spawn } from "node:child_process";

const commands = [
  ["vp", ["run", "--filter", "t3", "dev:bundle"]],
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
