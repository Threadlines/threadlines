// @effect-diagnostics globalJsonInEffect:off - JSON string literals embed paths safely into generated JavaScript.
/**
 * The `agent-device` launcher `device_open` hands an agent
 * (docs/design/devices.md). One per thread and device, at
 * `<stateDir>/device/bin/<thread>/<device>/agent-device`, with that thread's
 * agent-device session, config and target flags built in, so the agent passes
 * none and no provider's PATH changes. Ported from T3 Code's AgentDeviceShim:
 * the launcher leaves out flags a command refuses, refuses the commands that
 * would replace Threadlines' connection, and checks the connection first so a
 * sandboxed shell and a dead daemon get different messages.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deviceStateDir } from "./DeviceToolchain.ts";

const STALE_RUNTIME =
  "This agent-device command is out of date because Threadlines moved or updated its runtime. Call device_open again for a fresh one.";

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** agent-device 0.21.36's flags that take a value, so the launcher can find the command past them. */
const VALUE_FLAGS: ReadonlyArray<string> = [
  "--activity",
  "--all",
  "--android-device-allowlist",
  "--app",
  "--appium-version",
  "--artifact",
  "--artifacts-dir",
  "--aws-app-arn",
  "--aws-device-arn",
  "--aws-interaction-mode",
  "--aws-project-arn",
  "--aws-region",
  "-b",
  "--baseline",
  "--bearer-token",
  "--bundle-url",
  "--button",
  "--config",
  "--count",
  "--crop-on",
  "--custom-network",
  "-d",
  "--daemon-auth-token",
  "--daemon-base-url",
  "--daemon-server-mode",
  "--daemon-transport",
  "--delay-ms",
  "--depth",
  "--device",
  "--device-orientation",
  "--dsym",
  "--duration-ms",
  "--fps",
  "--from",
  "--geo-location",
  "--github-actions-artifact",
  "--header",
  "--hold-ms",
  "--host",
  "--image-tag",
  "--in-app",
  "--include",
  "--interval-ms",
  "--ios-simulator-device-set",
  "--ios-xctest-derived-data-path",
  "--ios-xctest-env-dir",
  "--ios-xctestrun-file",
  "--jitter-px",
  "--keyframes",
  "--kind",
  "--language",
  "--launch-args",
  "--launch-console",
  "--launch-url",
  "--lease-backend",
  "--lease-id",
  "--level",
  "--listen-host",
  "--locale",
  "--max-passes",
  "--max-steps",
  "--metro-host",
  "--metro-kind",
  "--metro-port",
  "--network-profile",
  "--on-error",
  "--os",
  "--os-version",
  "--out",
  "--pattern",
  "--pause-ms",
  "--pixel-density",
  "--pixels",
  "--plan-digest",
  "--platform",
  "--pointer-count",
  "--port",
  "--probe-timeout-ms",
  "--project-root",
  "--provider",
  "--provider-app",
  "--provider-appium-version",
  "--provider-build",
  "--provider-custom-network",
  "--provider-device-orientation",
  "--provider-device-type",
  "--provider-geo-location",
  "--provider-language",
  "--provider-locale",
  "--provider-network-hosts",
  "--provider-network-profile",
  "--provider-os-version",
  "--provider-project",
  "--provider-session",
  "--provider-session-name",
  "--provider-timezone",
  "--proxy-base-url",
  "--public-base-url",
  "--quality",
  "--record-as",
  "--remote-config",
  "--reporter",
  "--report-junit",
  "--retention-ms",
  "--retries",
  "--run-id",
  "--runtime-file",
  "-s",
  "--scale",
  "--scope",
  "--search-path",
  "--serial",
  "--session",
  "--session-isolation",
  "--session-lock",
  "--settle-quiet",
  "--shard-all",
  "--shard-split",
  "--startup-timeout-ms",
  "--state-dir",
  "--status-host",
  "--steps",
  "--steps-file",
  "--surface",
  "--system",
  "--target",
  "--target-app",
  "--template",
  "--tenant",
  "--threshold",
  "--timeout",
  "--timezone",
  "--udid",
  "--until",
  "--wait",
];

// Help gets no bound flags (agent-device reads --config even for help); only args before `--` are flags.
// agent-device 0.21.31 refuses some bound flags per command; connect/disconnect/auth/daemon would
// replace Threadlines' connection; device status reads this machine's claims. It reports a sandboxed shell and a
// dropped tunnel alike, so check first, at --daemon-base-url if given, as agent-device prefers it.
const launcherSource = (node: string, entryPath: string, boundArgs: ReadonlyArray<string>) =>
  `import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
const entry = ${JSON.stringify(entryPath)};
const bound = ${JSON.stringify(boundArgs)};
const refused = new Map([["cdp", ["--platform", "--udid", "--config", "--session"]], ["connection", ["--platform", "--udid"]]]);
const managed = ["connect", "disconnect", "auth", "daemon"];
const args = process.argv.slice(2);
const end = args.indexOf("--");
const options = end < 0 ? args : args.slice(0, end);
const valued = new Set(${JSON.stringify(VALUE_FLAGS)});
let name = "";
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--") { name = args[index + 1] ?? ""; break; }
  if (!arg.startsWith("-")) { name = arg; break; }
  if (!arg.includes("=") && valued.has(arg)) index++;
}
const informational = args.length === 0 || ["help", "--help", "-h", "--version", "version"].includes(args[0]) || options.includes("--help") || options.includes("-h");
if (!informational && managed.includes(name)) {
  console.error("Threadlines manages this command's connection to the device, so \`" + name + "\` is not available through it.");
  process.exit(1);
}
if (!informational && name === "device") {
  console.error("\`device status\` reads this machine's device claims, not those on the device's host, so it is not available through this command. Quote the DEVICE_IN_USE error instead.");
  process.exit(1);
}
const skip = refused.get(name) ?? [];
if (!informational) for (let index = 0; index + 1 < bound.length; index += 2) if (!skip.includes(bound[index]) && !options.some(arg => arg === bound[index] || arg.startsWith(bound[index] + "="))) options.push(bound[index], bound[index + 1]);
const command = end < 0 ? options : [...options, ...args.slice(end)];
const hasValue = flag => { const index = options.indexOf(flag); return options.some(arg => arg.startsWith(flag + "=") && arg.length > flag.length + 1) || (index >= 0 && !!options[index + 1] && !options[index + 1].startsWith("--")); };
if (!informational && !skip.includes("--session") && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and run the agent-device command it returns.");
  process.exit(1);
}
if (!existsSync(entry)) {
  console.error(${JSON.stringify(STALE_RUNTIME)});
  process.exit(1);
}
const valueOf = flag => { const inline = options.find(arg => arg.startsWith(flag + "=")); if (inline) return inline.slice(flag.length + 1); const index = options.indexOf(flag); return index >= 0 ? options[index + 1] : undefined; };
const endpoint = () => { try { const url = new URL(valueOf("--daemon-base-url") ?? JSON.parse(readFileSync(valueOf("--config"), "utf8")).daemonBaseUrl); return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port ? url : undefined; } catch { return undefined; } };
const local = informational || refused.has(name) ? undefined : endpoint();
if (local) {
  const failure = await new Promise(resolve => {
    const socket = connect({ host: local.hostname.replace(/^\\[|\\]$/g, ""), port: Number(local.port) });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("ETIMEDOUT"); });
    socket.once("connect", () => { socket.destroy(); resolve(undefined); });
    socket.once("error", error => resolve(error.code ?? "ERROR"));
  });
  if (failure === "EPERM" || failure === "EACCES") {
    console.error("This shell cannot reach Threadlines' device connection at " + local.host + " (connect " + failure + "): a network sandbox is blocking localhost. Run this command again with network access, outside the sandbox.");
    process.exit(1);
  }
  if (failure) {
    console.error("Threadlines' device connection at " + local.host + " is not reachable from this shell (connect " + failure + "). Call device_open again to reconnect; if that succeeds and this repeats, this shell runs in a network sandbox, so run the command with network access, outside the sandbox.");
    process.exit(1);
  }
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(node)}, [entry, ...command], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`;

/** Writes a launcher into `dir` and returns the executable agents run. */
const writeLauncher = Effect.fn("AgentDeviceShim.writeLauncher")(function* (input: {
  readonly dir: string;
  readonly node: string;
  readonly entryPath: string;
  readonly boundArgs: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = input.node;
  yield* fs.makeDirectory(input.dir, { recursive: true });
  const launcherPath = path.join(input.dir, "agent-device-launcher.mjs");
  yield* fs.writeFileString(launcherPath, launcherSource(node, input.entryPath, input.boundArgs));
  if (process.platform === "win32") {
    const script = `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nif not exist "${node}" (echo ${STALE_RUNTIME} 1>&2 & exit /b 1)\r\n"${node}" "${launcherPath}" %*\r\n`;
    const scriptPath = path.join(input.dir, "agent-device.cmd");
    yield* fs.writeFileString(scriptPath, script);
    return scriptPath;
  }
  const script = `#!/bin/sh\n[ -x ${quoteShell(node)} ] || { echo ${quoteShell(STALE_RUNTIME)} >&2; exit 1; }\nexec ${quoteShell(node)} ${quoteShell(launcherPath)} "$@"\n`;
  const scriptPath = path.join(input.dir, "agent-device");
  yield* fs.writeFileString(scriptPath, script);
  yield* fs.chmod(scriptPath, 0o755);
  return scriptPath;
});

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** A path segment for an id: the id itself when it is plain, else a digest of it. */
const segment = (id: string) =>
  SAFE_SEGMENT.test(id) && id !== "." && id !== ".."
    ? id
    : `x-${Buffer.from(id).toString("base64url").slice(0, 96)}`;

/** `<stateDir>/device/bin`. */
export const agentDeviceLaunchersDir = (path: Path.Path, stateDir: string) =>
  path.join(deviceStateDir(path, stateDir), "bin");

/** Where one thread's launcher for one device lives, relative to the launchers folder. */
export const agentDeviceLauncherKey = (threadId: string, deviceId: string) =>
  `${segment(threadId)}/${segment(deviceId)}`;

/**
 * A launcher for one agent-device session with its target flags built in, so
 * agents pass none, and a shell that does not word-split a variable cannot mangle them.
 */
export const bindAgentDeviceLauncher = Effect.fn("AgentDeviceShim.bind")(function* (input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly deviceId: string;
  readonly node: string;
  readonly entryPath: string;
  readonly targetArgs: ReadonlyArray<string>;
}) {
  const path = yield* Path.Path;
  return yield* writeLauncher({
    dir: path.join(
      agentDeviceLaunchersDir(path, input.stateDir),
      ...agentDeviceLauncherKey(input.threadId, input.deviceId).split("/"),
    ),
    node: input.node,
    entryPath: input.entryPath,
    boundArgs: input.targetArgs,
  });
});

/**
 * Removes every launcher whose `<thread>/<device>` key is not in `live`. Best
 * effort. A thread entry that is not a real directory (a symlink planted in
 * the state dir) is removed as itself and never followed, so pruning cannot
 * reach outside `device/bin`.
 */
export const pruneAgentDeviceLaunchers = Effect.fn("AgentDeviceShim.prune")(function* (input: {
  readonly stateDir: string;
  readonly live: ReadonlySet<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = agentDeviceLaunchersDir(path, input.stateDir);
  const threads = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  for (const thread of threads) {
    const threadDir = path.join(root, thread);
    const info = yield* fs.lstat(threadDir).pipe(Effect.option);
    if (info._tag === "None") continue;
    if (info.value.type !== "Directory") {
      yield* fs.remove(threadDir, { force: true }).pipe(Effect.ignore);
      continue;
    }
    const devices = yield* fs.readDirectory(threadDir).pipe(Effect.orElseSucceed(() => []));
    const stale = devices.filter((device) => !input.live.has(`${thread}/${device}`));
    yield* Effect.forEach(
      stale,
      (device) => fs.remove(path.join(threadDir, device), { recursive: true, force: true }),
      { discard: true },
    ).pipe(Effect.ignore);
    if (stale.length === devices.length) {
      yield* fs.remove(threadDir, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  }
});
