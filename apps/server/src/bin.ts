// Before every other import (see the module).
import "./process/startupEnvironment.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { Command } from "effect/unstable/cli";

import { FOREIGN_DATABASE_EXIT_CODE } from "@threadlines/contracts";
import * as NetService from "@threadlines/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
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
    dictationWorkerCommand,
  ]),
);

/**
 * The default exit codes, except that a run stopped by another app's database
 * exits with FOREIGN_DATABASE_EXIT_CODE so the desktop can tell it from a
 * crash.
 */
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && isForeignDatabaseCause(exit.cause)) {
    onExit(FOREIGN_DATABASE_EXIT_CODE);
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
