import { describe, expect, it } from "vitest";

import { classifyAssets, type ReleaseAsset } from "./releases";

function asset(name: string): ReleaseAsset {
  return { name, browser_download_url: `https://example.test/${name}`, size: 1 };
}

describe("classifyAssets", () => {
  it("picks one installer per platform from the published release assets", () => {
    const installers = classifyAssets([
      asset("Threadlines-0.4.0-win-x64.exe"),
      asset("Threadlines-0.4.0-win-x64.exe.blockmap"),
      asset("Threadlines-0.4.0-win-x64.zip"),
      asset("Threadlines-0.4.0-win-arm64.exe"),
      asset("Threadlines-0.4.0-mac-arm64.dmg"),
      asset("Threadlines-0.4.0-mac-arm64.zip"),
      asset("Threadlines-0.4.0-mac-x64.dmg"),
      asset("Threadlines-0.4.0-mac-x64.zip"),
      asset("Threadlines-0.4.0-linux-x86_64.AppImage"),
      asset("latest.yml"),
      asset("latest-mac.yml"),
    ]);

    expect(installers.winX64?.name).toBe("Threadlines-0.4.0-win-x64.exe");
    expect(installers.winArm?.name).toBe("Threadlines-0.4.0-win-arm64.exe");
    expect(installers.macArm?.name).toBe("Threadlines-0.4.0-mac-arm64.dmg");
    expect(installers.macX64?.name).toBe("Threadlines-0.4.0-mac-x64.dmg");
    expect(installers.linuxX64?.name).toBe("Threadlines-0.4.0-linux-x86_64.AppImage");
  });

  it("ignores updater and portable archives that share an installer's arch", () => {
    const installers = classifyAssets([
      asset("Threadlines-0.4.0-mac-arm64.zip"),
      asset("Threadlines-0.4.0-win-x64.zip"),
    ]);

    expect(installers).toEqual({});
  });
});
