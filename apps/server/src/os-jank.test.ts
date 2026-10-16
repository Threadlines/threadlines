import { SHELL_ENVIRONMENT_HYDRATED_ENV_NAME } from "@threadlines/shared/shell";
import { describe, expect, it } from "vite-plus/test";

import { fixPath } from "./os-jank.ts";

describe("fixPath", () => {
  it("probes the login shell and merges its PATH ahead of the inherited one", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const probed: string[] = [];

    fixPath({
      env,
      platform: "darwin",
      userShell: "",
      readPath: (shell) => {
        probed.push(shell);
        return "/opt/homebrew/bin:/usr/bin";
      },
    });

    expect(probed).toEqual(["/bin/zsh"]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("trusts a desktop parent that already read the login shell, and drops its flag", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/opt/homebrew/bin:/usr/bin",
      [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1",
    };
    const probed: string[] = [];

    fixPath({
      env,
      platform: "linux",
      userShell: "",
      readPath: (shell) => {
        probed.push(shell);
        return "/elsewhere/bin";
      },
    });

    expect(probed).toEqual([]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    // Provider processes inherit this environment; the flag must not reach them.
    expect(SHELL_ENVIRONMENT_HYDRATED_ENV_NAME in env).toBe(false);
  });

  it("keeps the Windows repair even when the flag is set", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1",
    };
    const probes: string[] = [];

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment: (names) => {
        probes.push(names.join(","));
        return { PATH: "C:\\Custom\\Bin" };
      },
      isWindowsCommandAvailable: () => true,
    });

    expect(probes).toEqual(["PATH"]);
    expect(env.PATH?.split(";")).toContain("C:\\Custom\\Bin");
    expect(SHELL_ENVIRONMENT_HYDRATED_ENV_NAME in env).toBe(false);
  });
});
