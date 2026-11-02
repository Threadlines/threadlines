import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import {
  hideWindowsConsole,
  makeCommandWithShell,
  type WindowsHiddenCommandOptions,
} from "./childProcess.ts";

describe("hideWindowsConsole", () => {
  it("adds windowsHide on Windows", () => {
    const options = hideWindowsConsole({ shell: true }, "win32") as WindowsHiddenCommandOptions;

    expect(options).toEqual({ shell: true, windowsHide: true });
  });

  it("leaves non-Windows options untouched", () => {
    const input = { shell: true } as const;

    expect(hideWindowsConsole(input, "linux")).toBe(input);
  });
});

describe("makeCommandWithShell", () => {
  effectIt.effect("starts a command with arguments through a shell", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        makeCommandWithShell("echo", ["hello", "world"], { shell: true }),
      );

      expect(output.trim()).toBe("hello world");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
