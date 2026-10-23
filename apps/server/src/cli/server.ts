import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { isolateThrowawayClaudeSignIn } from "../provider/claudeThrowawayIsolation.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import { CommandExit, EXIT } from "./connectExit.ts";

/**
 * Set by the `threadlines` command the desktop app puts on PATH
 * (apps/desktop/src/cliCommand/). That copy runs the app's own server code,
 * and a server it started would be a second one on the app's data folder.
 */
const COMMAND_ONLY = Config.boolean("THREADLINES_CLI_ONLY").pipe(Config.withDefault(false));

const refuseServerInCommandOnlyCopy = Effect.gen(function* () {
  if (!(yield* COMMAND_ONLY)) return;
  yield* Console.error(
    "This threadlines command doesn't start a server: the Threadlines app runs its own. Run threadlines connect to sign it in, or threadlines --help to see what it does.",
  );
  return yield* new CommandExit({ code: EXIT.failed });
});

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    yield* refuseServerInCommandOnlyCopy;
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    // Before any provider starts: a throwaway run must not touch the real
    // Claude sign-in.
    yield* isolateThrowawayClaudeSignIn(config.baseDir);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Threadlines server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Threadlines server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
