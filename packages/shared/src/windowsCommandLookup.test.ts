import { describe, expect, it } from "vite-plus/test";

import {
  WORKING_FOLDER_LOOKUP_VARIABLE,
  stopWorkingFolderCommandLookup,
  withUsualCommandLookup,
} from "./windowsCommandLookup.ts";

describe("windowsCommandLookup", () => {
  it("stops the working-folder lookup on Windows and gives children the user's environment back", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    stopWorkingFolderCommandLookup(env, "win32");

    expect(env[WORKING_FOLDER_LOOKUP_VARIABLE]).toBeDefined();
    expect(withUsualCommandLookup({ ...env, EXTRA: "1" })).toEqual({
      Path: "C:\\Windows",
      EXTRA: "1",
    });
  });

  it("still gives the user's environment back after the Claude SDK sets the variable too", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    stopWorkingFolderCommandLookup(env, "win32");
    // What @anthropic-ai/claude-agent-sdk does while loading.
    env.NoDefaultCurrentDirectoryInExePath = "1";

    expect(withUsualCommandLookup(env)).toEqual({ Path: "C:\\Windows" });
  });

  it("leaves a variable the user set, in any casing, for them and their programs", () => {
    const env: NodeJS.ProcessEnv = { nodefaultcurrentdirectoryinexepath: "" };
    stopWorkingFolderCommandLookup(env, "win32");

    expect(env).toEqual({ nodefaultcurrentdirectoryinexepath: "" });
    expect(withUsualCommandLookup(env)).toBe(env);
  });

  it("changes nothing off Windows", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    stopWorkingFolderCommandLookup(env, "darwin");

    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(withUsualCommandLookup(env)).toBe(env);
  });
});
