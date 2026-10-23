/**
 * Where the `threadlines` command finds Threadlines on this computer
 * (docs/design/outside-agents.md, "Finding Threadlines"): the data folder
 * (`--base-dir`, else THREADLINES_HOME, else `~/.threadlines`), its
 * `userdata` folder (`dev` with `--dev`), the running server's port from
 * `server-runtime.json`, and the command's own sign-ins beside it.
 */
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

/** The running Threadlines this command talks to, always over loopback. */
export interface ConnectTarget {
  readonly origin: string;
  /** The agent address, which a sign-in's token is bound to. */
  readonly resource: string;
}

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
  return { origin, resource: outsideAgentResource(origin) } satisfies ConnectTarget;
});
