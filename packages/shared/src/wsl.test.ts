import { describe, expect, it } from "vite-plus/test";

import { toWslPath, wslCommand, wslShellCommand } from "./wsl.ts";

describe("wsl", () => {
  it("maps drive-rooted Windows paths to /mnt mounts and leaves others alone", () => {
    expect(toWslPath("C:\\Users\\me\\repo\\")).toBe("/mnt/c/Users/me/repo");
    expect(toWslPath("d:/work/app")).toBe("/mnt/d/work/app");
    expect(toWslPath("/home/me/repo")).toBe("/home/me/repo");
  });

  it("runs commands in a WSL login shell with quoted words", () => {
    expect(wslCommand("fx", ["acp"])).toEqual({
      file: "wsl.exe",
      args: ["--", "bash", "-lc", "fx acp"],
    });
    expect(wslCommand("/opt/my fx/fx", ["login"]).args[3]).toBe("'/opt/my fx/fx' login");
    expect(wslShellCommand("curl -fsSL https://fx.sh/setup.sh | bash").args).toEqual([
      "--",
      "bash",
      "-lc",
      "curl -fsSL https://fx.sh/setup.sh | bash",
    ]);
  });
});
