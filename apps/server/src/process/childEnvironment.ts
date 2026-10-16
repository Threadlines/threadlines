import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveCommandOutsideWorkingFolder } from "@threadlines/shared/shell";
import { withUsualCommandLookup } from "@threadlines/shared/windowsCommandLookup";

/**
 * The command as the server should start it (@threadlines/shared/windowsCommandLookup):
 * the program gets the user's own command lookup back, so its scripts find
 * programs as they would outside Threadlines. A command run through a shell
 * is left as it is: there cmd.exe looks up the command for us, and so does
 * the batch launcher it runs. Null when the command would only be found in
 * the working folder (resolveCommandOutsideWorkingFolder).
 */
export function withChildEnvironment(
  command: ChildProcess.Command,
  platform: NodeJS.Platform = process.platform,
): ChildProcess.Command | null {
  if (command._tag === "PipedCommand") {
    const left = withChildEnvironment(command.left, platform);
    const right = withChildEnvironment(command.right, platform);
    if (left === null || right === null) return null;
    return left === command.left && right === command.right
      ? command
      : ChildProcess.pipeTo(left, right, command.options);
  }
  const options = command.options;
  if (options.shell) return command;
  const env = options.extendEnv ? { ...process.env, ...options.env } : (options.env ?? process.env);
  const childEnv = withUsualCommandLookup(env);
  const program = resolveCommandOutsideWorkingFolder(command.command, childEnv, platform);
  if (program === null) return null;
  if (childEnv === env && program === command.command) return command;
  return ChildProcess.make(program, command.args, { ...options, env: childEnv, extendEnv: false });
}

/**
 * Wraps the spawner so every command the server starts through it goes
 * through {@link withChildEnvironment}.
 */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      const prepared = withChildEnvironment(command);
      return prepared === null
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description:
                "Found only through a relative PATH entry, which means the working folder",
            }),
          )
        : spawner.spawn(prepared);
    });
  }),
);
