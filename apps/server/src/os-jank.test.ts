import { describe, expect, it } from "vite-plus/test";

import { fixPath } from "./os-jank.ts";

describe("fixPath", () => {
  // Under the desktop app the backend inherits the environment the desktop
  // read from the user's shell; probing again would block startup.
  it("runs no probe when the desktop already prepared the environment", () => {
    const probes: string[] = [];
    const windowsEnv: NodeJS.ProcessEnv = {
      PATH: "D:\\Configured;C:\\Windows",
      USERPROFILE: "C:\\Users\\testuser",
    };
    fixPath({
      env: windowsEnv,
      platform: "win32",
      shellEnvironmentPrepared: true,
      readWindowsEnvironment: () => {
        probes.push("powershell");
        return {};
      },
    });
    // Known CLI folders still come first, as after a probe.
    expect(windowsEnv.PATH?.split(";").slice(0, 1)).toEqual(["C:\\Users\\testuser\\.local\\bin"]);
    expect(windowsEnv.PATH?.split(";")).toContain("D:\\Configured");

    const macEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    fixPath({
      env: macEnv,
      platform: "darwin",
      shellEnvironmentPrepared: true,
      readPath: () => {
        probes.push("login shell");
        return "/opt/homebrew/bin";
      },
      readLaunchctlPath: () => {
        probes.push("launchctl");
        return undefined;
      },
    });
    expect(macEnv.PATH).toBe("/usr/bin");
    expect(probes).toEqual([]);
  });

  it("probes the login shell for a server started on its own", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    fixPath({ env, platform: "darwin", readPath: () => "/opt/homebrew/bin:/usr/bin" });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });
});
