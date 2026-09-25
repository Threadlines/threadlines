import { describe, expect, it } from "vite-plus/test";

import {
  describeWslLaunchFailure,
  toWslPath,
  withWslForwardedEnv,
  wslCommand,
  wslShellCommand,
} from "./wsl.ts";

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

  it("forwards set credentials into WSL without dropping existing WSLENV entries", () => {
    expect(
      withWslForwardedEnv({ AI_GATEWAY_API_KEY: "key", WSLENV: "USERPROFILE/p" }, [
        "AI_GATEWAY_API_KEY",
        "FX_API_KEY",
      ]).WSLENV,
    ).toBe("USERPROFILE/p:AI_GATEWAY_API_KEY/u");
    // Nothing set: the environment passes through untouched.
    const env = { PATH: "C:\\Windows" };
    expect(withWslForwardedEnv(env, ["AI_GATEWAY_API_KEY"])).toBe(env);
  });

  it("recognizes wsl.exe's own launch failures in its UTF-16 output", () => {
    // Captured from `wsl.exe -d NoSuchDistro -- bash -lc "fx --version"`,
    // read as UTF-8 the way a child process collector sees it.
    const utf16 = (text: string) => [...text].map((char) => `${char}\0`).join("");
    expect(
      describeWslLaunchFailure(
        utf16(
          "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n",
        ),
      ),
    ).toBe("There is no distribution with the supplied name.");
    expect(
      describeWslLaunchFailure(
        utf16("Windows Subsystem for Linux has no installed distributions."),
      ),
    ).toBe("Windows Subsystem for Linux has no installed distributions.");
    // Output from the Linux side is the command's own business.
    expect(describeWslLaunchFailure("bash: fx: command not found")).toBeUndefined();
    expect(describeWslLaunchFailure("0.0.10")).toBeUndefined();
  });
});
