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

  it("installs with Meta's installer when Muse is missing", () => {
    const missing = museMaintenanceCapabilities({ ...base, installed: false, isLauncher: false });
    expect(missing.install).toMatchObject({
      executable: "bash",
      command: "curl -fsSL https://dev.meta.ai/install.sh | bash",
    });
    expect(missing.update).toBeNull();
  });
});
