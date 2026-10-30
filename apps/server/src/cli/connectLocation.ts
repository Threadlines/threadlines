/**
 * Where the `threadlines` command finds Threadlines on this computer
 * (docs/design/outside-agents.md, "Finding Threadlines"): the data folder
 * (`--base-dir`, else THREADLINES_HOME, else `~/.threadlines`), its
 * `userdata` folder (`dev` with `--dev`), the running server's port from
 * `server-runtime.json`, and the command's own sign-ins beside it.
 *
 * Or another computer's Threadlines, through the assistants door
 * (docs/design/assistants.md): `THREADLINES_URL` (or `connect --url`) names
 * its address, and `THREADLINES_KEY` or the key `connect --key` kept signs
 * the calls.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { serverStateDirName } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { outsideAgentResource } from "../outsideAgents/OutsideAgentConnections.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { threadlinesHomeConfig } from "./config.ts";
import { ConnectError, NOT_RUNNING_MESSAGE } from "./connectExit.ts";

export interface ConnectLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly dev: boolean;
}

export interface ConnectLocation {
  readonly runtimeStatePath: string;
  /** The command's sign-ins on this computer, one per resource. */
  readonly credentialsPath: string;
}

export const resolveConnectLocation = Effect.fn("cli.connect.resolveLocation")(function* (
  flags: ConnectLocationFlags,
) {
  const path = yield* Path.Path;
  const envHome = yield* threadlinesHomeConfig;
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir) ?? envHome);
  const stateDir = path.join(baseDir, serverStateDirName(flags.dev));
  return {
    runtimeStatePath: path.join(stateDir, "server-runtime.json"),
    credentialsPath: path.join(stateDir, "cli", "connections.json"),
  } satisfies ConnectLocation;
});

/** The Threadlines this command talks to: this computer's over loopback, or one through the assistants door. */
export interface ConnectTarget {
  readonly origin: string;
  /** The agent address, which a sign-in's token is bound to. */
  readonly resource: string;
  /** Reached through the assistants door with a key, not this computer's `/mcp/connect`. */
  readonly remote: boolean;
}

/** `THREADLINES_URL`: the assistants door's address to use instead of this computer's Threadlines. */
export const remoteAddressConfig = Config.String("THREADLINES_URL").pipe(
  Config.option,
  Config.map((value) => Option.filter(value, (url) => url.trim().length > 0)),
);

/** `THREADLINES_KEY`: a key to sign the calls with instead of the one `connect --key` kept. */
export const remoteKeyConfig = Config.String("THREADLINES_KEY").pipe(
  Config.option,
  Config.map((value) => Option.filter(value, (key) => key.trim().length > 0)),
);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * An assistants door's address as a target, or why it can't be one: https
 * (plain http only to this computer, for trying a relay out locally), with
 * no user name, password, query or fragment.
 */
export const remoteTarget = (raw: string): ConnectTarget | { readonly invalid: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { invalid: `${raw.trim()} isn't a web address.` };
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) return { invalid: "The address must start with https://." };
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return { invalid: "Give the address as Threadlines shows it, with nothing after it." };
  }
  return { origin: url.origin, resource: url.href, remote: true };
};

/** The running server's address, or `not_running` when it has written none. */
export const findThreadlines = Effect.fn("cli.connect.findThreadlines")(function* (
  location: ConnectLocation,
) {
  const state = yield* readPersistedServerRuntimeState(location.runtimeStatePath);
  if (Option.isNone(state)) {
    return yield* new ConnectError({ reason: "not_running", message: NOT_RUNNING_MESSAGE });
  }
  // `/mcp/connect` takes calls only over loopback, whatever address the
  // server advertises to other devices.
  const origin = `http://127.0.0.1:${state.value.port}`;
  return { origin, resource: outsideAgentResource(origin), remote: false } satisfies ConnectTarget;
});
