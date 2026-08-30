import { describe, expect, it } from "vite-plus/test";

import { makeAcpProviderMaintenanceResolver, resolveAcpBinaryPath } from "./AcpProviderDriver.ts";
import { CURSOR_ACP_DESCRIPTOR } from "./CursorAcpSupport.ts";
import { FX_ACP_DESCRIPTOR } from "./FxAcpSupport.ts";

describe("resolveAcpBinaryPath", () => {
  it("keeps explicit paths and unresolvable names untouched", () => {
    expect(
      resolveAcpBinaryPath(CURSOR_ACP_DESCRIPTOR, "/opt/cursor/agent", { PATH: "" }, "linux"),
    ).toBe("/opt/cursor/agent");
    expect(resolveAcpBinaryPath(CURSOR_ACP_DESCRIPTOR, "agent", { PATH: "" }, "linux")).toBe(
      "agent",
    );
  });

  it("leaves fx bare on Windows because it resolves inside WSL", () => {
    expect(
      resolveAcpBinaryPath(FX_ACP_DESCRIPTOR, "fx", { PATH: process.env.PATH ?? "" }, "win32"),
    ).toBe("fx");
  });
});

describe("makeAcpProviderMaintenanceResolver", () => {
  it("offers the platform install only while the bare binary is missing from PATH", () => {
    const resolver = makeAcpProviderMaintenanceResolver(FX_ACP_DESCRIPTOR);
    const missing = resolver.resolve({ binaryPath: "fx", platform: "linux", env: { PATH: "" } });
    expect(missing.install).toMatchObject({
      executable: "bash",
      command: "curl -fsSL https://fx.sh/setup.sh | bash",
    });

    const resolved = resolver.resolve({
      binaryPath: "fx",
      platform: "linux",
      env: { PATH: "" },
      realCommandPath: "/home/me/.local/bin/fx",
    });
    expect(resolved.install).toBeNull();
    // The update executable depends on the host (WSL on Windows); the shown command does not.
    expect(resolved.update?.command).toBe("fx upgrade");
  });

  it("installs through WSL on Windows for fx and natively for Cursor", () => {
    const resolver = makeAcpProviderMaintenanceResolver(FX_ACP_DESCRIPTOR);
    expect(
      resolver.resolve({ binaryPath: "fx", platform: "win32", env: { PATH: "" } }).install,
    ).toMatchObject({
      executable: "wsl.exe",
      args: ["--", "bash", "-lc", "curl -fsSL https://fx.sh/setup.sh | bash"],
    });
    expect(
      makeAcpProviderMaintenanceResolver(CURSOR_ACP_DESCRIPTOR).resolve({
        binaryPath: "agent",
        platform: "win32",
        env: { PATH: "" },
      }).install,
    ).toMatchObject({ executable: "powershell.exe" });
  });

  it("never offers an install for an explicit binary path", () => {
    const resolver = makeAcpProviderMaintenanceResolver(FX_ACP_DESCRIPTOR);
    expect(
      resolver.resolve({ binaryPath: "/opt/missing/fx", platform: "linux", env: { PATH: "" } })
        .install,
    ).toBeNull();
  });
});
