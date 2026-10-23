// Before every other import (see the module).
import "./process/startupEnvironment.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { Command } from "effect/unstable/cli";

import { FOREIGN_DATABASE_EXIT_CODE } from "@threadlines/contracts";
import * as NetService from "@threadlines/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import {
  agentsCommand,
  connectCommand,
  disconnectCommand,
  projectsCommand,
  threadCommand,
} from "./cli/connectCommands.ts";
import { CommandExit } from "./cli/connectExit.ts";
import { dictationWorkerCommand } from "./cli/dictationWorker.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { assertSingleEffectRuntime } from "./cli/effectRuntimeCheck.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { isForeignDatabaseCause } from "./persistence/MigrationHistory.ts";
import * as ChildEnvironment from "./process/childEnvironment.ts";

const CliRuntimeLayer = Layer.mergeAll(
  ChildEnvironment.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  NetService.layer,
);

export const cli = Command.make("threadlines", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Threadlines server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    projectCommand,
    connectCommand,
    disconnectCommand,
    projectsCommand,
    agentsCommand,
    threadCommand,
    dictationWorkerCommand,
  ]),
);

/** How long an ending command waits for its output to reach a pipe. */
const OUTPUT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Calls `done` once everything written to stdout and stderr so far has been
 * handed to the OS. `process.exit` drops output still queued for a pipe,
 * which a script reading a command's answer would lose.
 */
function afterOutputFlushed(done: () => void): void {
  let pending = 2;
  const timer = setTimeout(done, OUTPUT_FLUSH_TIMEOUT_MS);
  const flushed = () => {
    pending -= 1;
    if (pending === 0) {
      clearTimeout(timer);
      done();
    }
  };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
}

/**
 * The default exit codes, except that a run stopped by another app's database
 * exits with FOREIGN_DATABASE_EXIT_CODE so the desktop can tell it from a
 * crash, and a command that ended with its own code (connectExit.ts) exits
 * with it once its output is out.
 */
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && isForeignDatabaseCause(exit.cause)) {
    onExit(FOREIGN_DATABASE_EXIT_CODE);
    return;
  }
  if (Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CommandExit) {
    Runtime.defaultTeardown(exit, (code) => afterOutputFlushed(() => onExit(code)));
    return;
  }
  Runtime.defaultTeardown(exit, onExit);
};

/**
 * Runs the `threadlines` command. The published build enters through
 * `launcher.ts`, which checks the Node version first; `node src/bin.ts` in dev
 * runs it directly.
 */
export function runCli(): void {
  assertSingleEffectRuntime();
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain({ teardown }),
  );
}

if (import.meta.main) {
  runCli();
}
