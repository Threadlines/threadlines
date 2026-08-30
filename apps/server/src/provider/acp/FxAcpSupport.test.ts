import { describe, expect, it } from "vite-plus/test";

import { buildFxAcpSpawnInput, buildFxCommand, parseFxStatusOutput } from "./FxAcpSupport.ts";

describe("buildFxCommand", () => {
  it("runs the binary directly on Linux and macOS", () => {
    expect(buildFxCommand({ binaryPath: "/opt/fx/bin/fx" }, ["acp"], "linux")).toEqual({
      file: "/opt/fx/bin/fx",
      args: ["acp"],
    });
  });

  it("routes through a WSL login shell on Windows", () => {
    expect(buildFxCommand(null, ["status", "--json"], "win32")).toEqual({
      file: "wsl.exe",
      args: ["--", "bash", "-lc", "fx status --json"],
    });
  });
});

describe("buildFxAcpSpawnInput", () => {
  it("keeps the host cwd for the spawn (WSL maps it itself)", () => {
    const input = buildFxAcpSpawnInput({ binaryPath: "fx" }, "/tmp/project");
    expect(input.cwd).toBe("/tmp/project");
    expect(input.args[input.args.length - 1]).toMatch(/acp$/);
  });
});

describe("parseFxStatusOutput", () => {
  // Captured from `fx status --json` (fx 0.0.7) with no credential configured.
  const missingAuthLine =
    '{"kind":"status","model":"moonshotai/kimi-k3","update_channel":"stable","build_channel":"stable","build_revision":"cef08aa0f178","auth":"missing","auth_refreshable":false,"auth_help":"fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.","permission_mode":"auto","workspace":"/tmp","history_turns":0}';

  it("reports missing credentials as unauthenticated with fx's own guidance", () => {
    expect(parseFxStatusOutput({ stdout: missingAuthLine, stderr: "", code: 0 })).toEqual({
      auth: { status: "unauthenticated" },
      defaultModel: "moonshotai/kimi-k3",
      message:
        "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
    });
  });

  it("treats any active credential source as authenticated", () => {
    expect(
      parseFxStatusOutput({
        stdout: '{"kind":"status","model":"gpt-5.6-sol","auth":"chatgpt_subscription"}\n',
        stderr: "",
        code: 0,
      }),
    ).toEqual({
      auth: {
        status: "authenticated",
        type: "chatgpt_subscription",
        label: "fx · chatgpt_subscription",
      },
      defaultModel: "gpt-5.6-sol",
      message: undefined,
    });
  });

  it("returns undefined when stdout carries no status object", () => {
    expect(parseFxStatusOutput({ stdout: "fx 0.0.7\n", stderr: "", code: 0 })).toBeUndefined();
  });
});
