import { constants } from "node:fs";

import type { CommandFileSystem } from "@threadlines/shared/shell";
import { describe, expect, it } from "vite-plus/test";

import { detectProviderBinary } from "./providerDetection.ts";

/** A filesystem holding exactly `executables` (and `plainFiles`, which cannot run). */
function fakeFileSystem(
  executables: ReadonlyArray<string>,
  plainFiles: ReadonlyArray<string> = [],
): CommandFileSystem {
  return {
    isFile: (filePath) => executables.includes(filePath) || plainFiles.includes(filePath),
    canAccess: (filePath, mode) => {
      if (mode === constants.X_OK && !executables.includes(filePath)) {
        throw new Error("EACCES");
      }
      return true;
    },
  };
}

describe("detectProviderBinary", () => {
  it("finds a bare name in the Windows CLI installer folders only for drivers that search them", () => {
    const input = {
      binaryPath: "agent",
      env: {
        PATH: "C:\\Windows",
        PATHEXT: ".EXE;.CMD",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      platform: "win32" as const,
      fileSystem: fakeFileSystem(["C:\\Users\\me\\AppData\\Local\\cursor-agent\\agent.exe"]),
    };

    expect(detectProviderBinary({ ...input, knownCliDirs: true })).toEqual({
      status: "found",
      path: "C:\\Users\\me\\AppData\\Local\\cursor-agent\\agent.exe",
    });
    expect(detectProviderBinary(input)).toEqual({ status: "notFound" });
  });

  it("requires a configured path to be an executable file, as spawning does", () => {
    const fileSystem = fakeFileSystem(["/opt/codex/bin/codex"], ["/opt/codex/README"]);

    expect(
      detectProviderBinary({
        binaryPath: "/opt/codex/bin/codex",
        env: { PATH: "" },
        platform: "linux",
        fileSystem,
      }),
    ).toEqual({ status: "found", path: "/opt/codex/bin/codex" });
    expect(
      detectProviderBinary({
        binaryPath: "/opt/codex/README",
        env: { PATH: "" },
        platform: "linux",
        fileSystem,
      }),
    ).toEqual({ status: "notFound" });
  });

  it("asks the driver's own fallback only for a bare name PATH lacks", () => {
    const fallback = () => "/home/me/.opencode/bin/opencode";
    const input = { env: { PATH: "/usr/bin" }, platform: "linux" as const, fallback };

    expect(
      detectProviderBinary({ ...input, binaryPath: "opencode", fileSystem: fakeFileSystem([]) }),
    ).toEqual({ status: "found", path: "/home/me/.opencode/bin/opencode" });
    expect(
      detectProviderBinary({
        ...input,
        binaryPath: "opencode",
        fileSystem: fakeFileSystem(["/usr/bin/opencode"]),
      }),
    ).toEqual({ status: "found", path: "/usr/bin/opencode" });
    expect(
      detectProviderBinary({
        ...input,
        binaryPath: "/missing/opencode",
        fileSystem: fakeFileSystem([]),
      }),
    ).toEqual({ status: "notFound" });
  });
});
