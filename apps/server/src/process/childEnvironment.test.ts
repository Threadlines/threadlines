// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  SERVER_ADDED_VARIABLE,
  WORKING_FOLDER_LOOKUP_VARIABLE,
  stopWorkingFolderCommandLookup,
} from "@threadlines/shared/windowsCommandLookup";

import * as ChildEnvironment from "./childEnvironment.ts";

function envOf(command: ChildProcess.Command | null) {
  if (command?._tag !== "StandardCommand") throw new Error("expected a standard command");
  return command.options.env;
}

describe("childEnvironment", () => {
  // Some hosts set the variable themselves (Claude Code's shell does), which
  // would leave nothing of the server's to remove.
  const hostValue = process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
  beforeEach(() => {
    delete process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
    // What the server does at startup on Windows.
    stopWorkingFolderCommandLookup(process.env, "win32");
  });
  afterEach(() => {
    delete process.env[SERVER_ADDED_VARIABLE];
    if (hostValue === undefined) delete process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
    else process.env[WORKING_FOLDER_LOOKUP_VARIABLE] = hostValue;
  });

  it("gives a started program the user's environment, inherited or extended", () => {
    const inherited = ChildEnvironment.withChildEnvironment(ChildProcess.make("git", ["status"]));
    const extended = ChildEnvironment.withChildEnvironment(
      ChildProcess.make("git", ["status"], { env: { GIT_OPTIONAL_LOCKS: "0" }, extendEnv: true }),
    );

    expect(envOf(inherited)?.[WORKING_FOLDER_LOOKUP_VARIABLE]).toBeUndefined();
    expect(envOf(inherited)?.[SERVER_ADDED_VARIABLE]).toBeUndefined();
    expect(envOf(inherited)?.PATH).toBe(process.env.PATH);
    expect(envOf(extended)).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", PATH: process.env.PATH });
    expect(envOf(extended)?.[WORKING_FOLDER_LOOKUP_VARIABLE]).toBeUndefined();
  });

  it("leaves a command run through cmd.exe as it is, since cmd.exe looks it up itself", () => {
    const command = ChildProcess.make("codex.cmd", ["--version"], { shell: true });

    expect(ChildEnvironment.withChildEnvironment(command)).toBe(command);
  });

  it("takes a bare command from full-path PATH entries when PATH has a relative one", () => {
    const tools = mkdtempSync(join(tmpdir(), "tl-child-env-"));
    try {
      writeFileSync(join(tools, "git.exe"), "");
      const command = ChildProcess.make("git", ["status"], {
        env: { PATH: `.;${tools}` },
      });
      const started = ChildEnvironment.withChildEnvironment(command, "win32");
      const plain = ChildEnvironment.withChildEnvironment(
        ChildProcess.make("git", ["status"], { env: { PATH: tools } }),
        "win32",
      );

      const missing = ChildEnvironment.withChildEnvironment(
        ChildProcess.make("gh", ["auth", "status"], { env: { PATH: `.;${tools}` } }),
        "win32",
      );

      expect(started?._tag === "StandardCommand" && started.command).toBe(join(tools, "git.exe"));
      expect(plain?._tag === "StandardCommand" && plain.command).toBe("git");
      // Only `.` could hold it, and `.` is the working folder.
      expect(missing).toBeNull();
    } finally {
      rmSync(tools, { recursive: true, force: true });
    }
  });

  it.effect("applies to both sides of a pipe started through the spawner", () => {
    const spawned: Array<Record<string, string | undefined> | undefined> = [];
    const collect = (command: ChildProcess.Command): void => {
      if (command._tag === "PipedCommand") {
        collect(command.left);
        collect(command.right);
      } else {
        spawned.push(command.options.env);
      }
    };
    const inner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        collect(command);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      }),
    );
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner
        .spawn(ChildProcess.make("git", ["log"]).pipe(ChildProcess.pipeTo(ChildProcess.make("gh"))))
        .pipe(Effect.scoped, Effect.ignore);

      expect(spawned).toHaveLength(2);
      for (const env of spawned) {
        expect(env?.PATH).toBe(process.env.PATH);
        expect(env?.[WORKING_FOLDER_LOOKUP_VARIABLE]).toBeUndefined();
      }
    }).pipe(Effect.provide(ChildEnvironment.layer.pipe(Layer.provide(inner))));
  });
});
