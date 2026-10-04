// @effect-diagnostics nodeBuiltinImport:off
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";

import { checkAcpProviderStatus } from "./AcpProvider.ts";
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

  it("runs the update with the agent CLI a session would find", () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), "acp-update-bin-"));
    const agentFile = path.join(binDir, process.platform === "win32" ? "agent.cmd" : "agent");
    writeFileSync(agentFile, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    chmodSync(agentFile, 0o755);

    const update = makeAcpProviderMaintenanceResolver(CURSOR_ACP_DESCRIPTOR).resolve({
      binaryPath: "agent",
      platform: process.platform,
      env: { PATH: binDir },
    }).update;
    expect(update?.executable.toLowerCase()).toBe(agentFile.toLowerCase());
    expect(update?.args).toEqual(["update"]);
  });

  it("never offers an install for an explicit binary path", () => {
    const resolver = makeAcpProviderMaintenanceResolver(FX_ACP_DESCRIPTOR);
    expect(
      resolver.resolve({ binaryPath: "/opt/missing/fx", platform: "linux", env: { PATH: "" } })
        .install,
    ).toBeNull();
  });
});

describe("checkAcpProviderStatus while turned off", () => {
  it("looks for the agent on disk without starting it, and leaves fx inside WSL alone", async () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), "acp-detect-bin-"));
    const agentFile = path.join(binDir, process.platform === "win32" ? "agent.cmd" : "agent");
    writeFileSync(agentFile, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    chmodSync(agentFile, 0o755);
    const spawned: string[] = [];
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | NodeServices.NodeServices
      >,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              spawned.push(String(command));
              return Effect.die("A turned-off agent must not be started");
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("A turned-off agent must not reach the network")),
          ),
          Effect.provide(NodeServices.layer),
        ),
      );
    const env = { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    const cursor = await run(
      checkAcpProviderStatus(
        CURSOR_ACP_DESCRIPTOR,
        { enabled: false, binaryPath: "agent", apiEndpoint: "", customModels: [] },
        env,
      ),
    );
    expect(cursor.status).toBe("disabled");
    expect(cursor.detection?.status).toBe("found");
    expect(cursor.detection?.path?.toLowerCase()).toBe(agentFile.toLowerCase());

    const fx = await run(
      checkAcpProviderStatus(
        FX_ACP_DESCRIPTOR,
        { enabled: false, binaryPath: "fx", customModels: [] },
        env,
        "win32",
      ),
    );
    expect(fx.detection).toEqual({
      status: "unknown",
      reason: "fx runs inside WSL on Windows. Turn it on to check.",
    });
    expect(spawned).toEqual([]);
  });
});
