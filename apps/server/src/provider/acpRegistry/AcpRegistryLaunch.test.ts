import { describe, expect, it } from "vite-plus/test";

import { type AcpRegistryLaunchInput, planAcpRegistryLaunch } from "./AcpRegistryLaunch.ts";

const base: AcpRegistryLaunchInput = {
  launch: { program: "/tools/node/bin/node", prefixArgs: ["/payload/cli.js"], needsShell: false },
  args: ["--acp"],
  recipeEnv: { AGENT_NO_UPDATE: "1", API_BASE: "https://registry.example" },
  environment: { PATH: "/usr/bin", HOME: "/home/me", API_BASE: "https://mine.example" },
  instanceVariableNames: new Set(["API_BASE"]),
  nodeBinDir: "/tools/node/bin",
  platform: "linux",
};

describe("planAcpRegistryLaunch", () => {
  it("starts the agent with no shell, the user's variables over the registry's", () => {
    expect(planAcpRegistryLaunch(base)).toEqual({
      ok: true,
      command: "/tools/node/bin/node",
      args: ["/payload/cli.js", "--acp"],
      shell: false,
      env: {
        // The agent's own Node comes first; HOME is the server's.
        PATH: "/tools/node/bin:/usr/bin",
        HOME: "/home/me",
        // The registry turns the agent's updater off; the user's own
        // setting for the same variable would win.
        AGENT_NO_UPDATE: "1",
        API_BASE: "https://mine.example",
      },
    });
  });

  it("lets a sign-in method add variables, under the user's own", () => {
    const planned = planAcpRegistryLaunch({
      ...base,
      args: ["login"],
      extraEnv: { LOGIN_MODE: "device", API_BASE: "https://method.example" },
    });
    expect(planned.ok && [planned.args, planned.env.LOGIN_MODE, planned.env.API_BASE]).toEqual([
      ["/payload/cli.js", "login"],
      "device",
      "https://mine.example",
    ]);
  });

  it("goes through cmd.exe only for a .cmd bin, and only with plain arguments", () => {
    const cmdBin: AcpRegistryLaunchInput = {
      ...base,
      launch: {
        program: "C:\\Users\\A B\\tools\\node_modules\\.bin\\agent.cmd",
        prefixArgs: [],
        needsShell: true,
      },
      environment: { Path: "C:\\Windows" },
      nodeBinDir: "C:\\tools\\node",
      platform: "win32",
    };
    expect(planAcpRegistryLaunch({ ...cmdBin, args: ["acp", "--port=0", "a/b:c@d,e+f"] })).toEqual({
      ok: true,
      // Quoted: the path may hold spaces.
      command: '"C:\\Users\\A B\\tools\\node_modules\\.bin\\agent.cmd"',
      args: ["acp", "--port=0", "a/b:c@d,e+f"],
      shell: true,
      env: { AGENT_NO_UPDATE: "1", Path: "C:\\tools\\node;C:\\Windows" },
    });
    for (const argument of ["a b", "x&calc", "%PATH%", '"q"', "a|b", "^", "(x)", "a;b", "é"]) {
      expect(planAcpRegistryLaunch({ ...cmdBin, args: [argument] }).ok, argument).toBe(false);
    }
    expect(
      planAcpRegistryLaunch({
        ...cmdBin,
        launch: { ...cmdBin.launch, program: "C:\\%TEMP%\\agent.cmd" },
      }).ok,
    ).toBe(false);
  });
});
