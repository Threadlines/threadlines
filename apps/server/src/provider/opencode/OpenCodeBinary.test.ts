import { describe, expect, it } from "vite-plus/test";

import { openCodeMaintenanceResolver, openCodeOneMigrationCapabilities } from "./OpenCodeBinary.ts";

describe("openCodeMaintenanceResolver", () => {
  // Homebrew carries OpenCode 2 as core `opencode` and as the tap's
  // `opencode-v2`; upgrading the one that is not installed fails.
  it.each([
    ["/opt/homebrew/Cellar/opencode/2.0.20/bin/opencode", "opencode"],
    ["/opt/homebrew/Cellar/opencode-v2/2.0.22/bin/opencode", "anomalyco/tap/opencode-v2"],
    [
      "/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.0.22/bin/opencode",
      "anomalyco/tap/opencode-v2",
    ],
  ])("upgrades the Homebrew formula %s belongs to", (realCommandPath, formula) => {
    const capabilities = openCodeMaintenanceResolver({ PATH: "" }, "opencode").resolve({
      binaryPath: "/opt/homebrew/bin/opencode",
      platform: "darwin",
      env: { PATH: "" },
      realCommandPath,
    });
    expect(capabilities.update?.args).toEqual(["upgrade", formula]);
  });

  // OpenCode 2 is a separate package: Update on a 1.x binary swaps the install
  // using the method that put 1.x there.
  const move = (input: {
    readonly commandPath: string;
    readonly realCommandPath?: string;
    readonly platform: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    /** What the regular resolution saw; a bare name that resolved nowhere falls back to npm. */
    readonly resolvedAs?: string;
  }) => {
    const env = input.env ?? { PATH: process.env.PATH };
    const base = openCodeMaintenanceResolver(env, input.commandPath).resolve({
      binaryPath: input.resolvedAs ?? input.commandPath,
      platform: input.platform,
      env: { PATH: "" },
      realCommandPath: input.realCommandPath ?? input.commandPath,
    });
    return openCodeOneMigrationCapabilities(base, {
      commandPath: input.commandPath,
      realCommandPath: input.realCommandPath ?? input.commandPath,
      env,
      platform: input.platform,
    }).update;
  };

  it.each([
    [
      "OpenCode's installer",
      { commandPath: "/Users/me/.opencode/bin/opencode", platform: "darwin" },
      "curl -fsSL https://opencode.ai/v2/install | bash",
    ],
    [
      "npm",
      {
        commandPath: "/usr/local/bin/opencode",
        realCommandPath: "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe",
        platform: "linux",
      },
      "npm uninstall -g opencode-ai ; npm install -g @opencode/cli@latest",
    ],
    [
      "pnpm",
      { commandPath: "/Users/me/Library/pnpm/opencode", platform: "darwin" },
      "pnpm remove -g opencode-ai ; pnpm add -g @opencode/cli@latest --allow-build=@opencode/cli || pnpm add -g @opencode/cli@latest",
    ],
    [
      "bun",
      {
        commandPath: "/Users/me/.bun/bin/opencode",
        realCommandPath: "/Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode",
        platform: "darwin",
      },
      "bun remove -g opencode-ai ; bun i -g @opencode/cli@latest && bun pm -g trust @opencode/cli",
    ],
    [
      "Homebrew",
      {
        commandPath: "/opt/homebrew/bin/opencode",
        realCommandPath: "/opt/homebrew/Cellar/opencode/1.18.34/bin/opencode",
        platform: "darwin",
      },
      "brew uninstall opencode ; brew install anomalyco/tap/opencode-v2",
    ],
  ] as const)("moves a 1.x install from %s to OpenCode 2", (_method, input, script) => {
    const update = move(input);
    expect(update ? [update.executable, ...update.args] : null).toEqual(["/bin/sh", "-c", script]);
  });

  it.each([
    [
      "OpenCode's installer on Windows",
      { commandPath: "C:/Users/me/.opencode/bin/opencode.exe", platform: "win32" },
    ],
    [
      "a download the npm fallback guessed at",
      { commandPath: "/srv/tools/opencode", platform: "linux", resolvedAs: "opencode" },
    ],
    [
      "a path inside the keg the move deletes",
      { commandPath: "/opt/homebrew/Cellar/opencode/1.18.34/bin/opencode", platform: "darwin" },
    ],
    [
      "Homebrew's per-formula link, which the move deletes",
      {
        commandPath: "/opt/homebrew/opt/opencode/bin/opencode",
        realCommandPath: "/opt/homebrew/Cellar/opencode/1.18.34/bin/opencode",
        platform: "darwin",
      },
    ],
  ] as const)("offers no move for %s", (_case, input) => {
    expect(move(input)).toBeNull();
  });

  it("runs the move with the instance's own PATH", () => {
    const update = move({
      commandPath: "/Users/me/.bun/bin/opencode",
      platform: "darwin",
      env: { PATH: "/opt/node-20/bin:/usr/bin" },
    });
    expect(update?.environmentPatch).toEqual({ PATH: "/opt/node-20/bin:/usr/bin" });
  });
});
