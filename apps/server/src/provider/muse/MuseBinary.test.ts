import { describe, expect, it } from "vite-plus/test";

import { museMaintenanceCapabilities, parseMuseVersion } from "./MuseBinary.ts";

describe("parseMuseVersion", () => {
  it("reads the release from `muse --version`", () => {
    expect(parseMuseVersion("Muse Code 1.4.9 (1.4.9-R6297.1)")).toBe("1.4.9");
    expect(parseMuseVersion("no version here")).toBeNull();
  });
});

describe("museMaintenanceCapabilities", () => {
  const base = {
    commandPath: "/home/me/.local/bin/muse",
    realCommandPath: "/home/me/.local/bin/muse",
    installed: true,
    env: {},
    platform: "linux" as const,
  };

  it("updates through the launcher, Homebrew or the installer, by how Muse was installed", () => {
    const launcher = museMaintenanceCapabilities({ ...base, isLauncher: true });
    expect(launcher.update).toMatchObject({
      executable: "/home/me/.local/bin/muse",
      args: ["--version"],
      environmentPatch: { MUSE_SYNC_UPDATE: "1", MUSE_NO_AUTO_UPDATE: "0" },
    });
    const cask = museMaintenanceCapabilities({
      ...base,
      commandPath: "/opt/homebrew/bin/muse",
      realCommandPath: "/opt/homebrew/Caskroom/muse-code/1.4.9/muse",
      isLauncher: false,
      platform: "darwin",
    });
    expect(cask.update).toMatchObject({
      executable: "brew",
      args: ["upgrade", "--cask", "muse-code"],
    });
    const windows = museMaintenanceCapabilities({ ...base, isLauncher: false, platform: "win32" });
    expect(windows.update?.executable).toBe("powershell.exe");
    // Something Threadlines did not install is updated by hand.
    expect(museMaintenanceCapabilities({ ...base, isLauncher: false }).update).toBeNull();
  });

  it("reinstalls a copy that cannot start the way it was installed, in the same place", () => {
    const env = { HOME: "/home/me", MUSE_CHANNEL: "beta" };
    // Meta's installer over its own launcher, on the same channel, under the update's lock.
    const launcher = museMaintenanceCapabilities({ ...base, env, isLauncher: true });
    expect(launcher.repair).toMatchObject({
      command: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      lockKey: launcher.update?.lockKey,
      environmentPatch: { MUSE_CHANNEL: "beta", HOME: "/home/me" },
    });
    const cask = museMaintenanceCapabilities({
      ...base,
      commandPath: "/opt/homebrew/bin/muse",
      realCommandPath: "/opt/homebrew/Caskroom/muse-code/1.4.9/muse",
      isLauncher: false,
      platform: "darwin",
    });
    expect(cask.repair?.args).toEqual(["reinstall", "--cask", "muse-code"]);
    // A launcher somewhere the installer would not write is not its to replace.
    const elsewhere = museMaintenanceCapabilities({
      ...base,
      env,
      commandPath: "/opt/tools/muse",
      realCommandPath: "/opt/tools/muse",
      isLauncher: true,
    });
    expect(elsewhere.repair).toBeUndefined();

    // Windows: the installer's own folder, wherever this instance keeps it.
    const localAppData = "D:\\Profiles\\me\\AppData\\Local";
    const windows = {
      ...base,
      isLauncher: false,
      platform: "win32" as const,
      env: { LOCALAPPDATA: localAppData },
    };
    expect(
      museMaintenanceCapabilities({
        ...windows,
        commandPath: `${localAppData}\\Programs\\muse\\muse.cmd`,
      }).repair,
    ).toMatchObject({
      executable: "powershell.exe",
      environmentPatch: { LOCALAPPDATA: localAppData },
    });
    expect(
      museMaintenanceCapabilities({ ...windows, commandPath: "D:\\tools\\muse.cmd" }).repair,
    ).toBeUndefined();
  });

  it("installs with Meta's installer when Muse is missing", () => {
    const missing = museMaintenanceCapabilities({ ...base, installed: false, isLauncher: false });
    expect(missing.install).toMatchObject({
      executable: "bash",
      command: "curl -fsSL https://dev.meta.ai/install.sh | bash",
    });
    expect(missing.update).toBeNull();
  });
});
