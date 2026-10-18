import { describe, expect, it } from "vite-plus/test";

import {
  PI_EXTENSION_ENV,
  parsePiLaunchArgs,
  piAccessLevel,
  piProcessArgs,
  piProcessEnvironment,
} from "./PiLaunch.ts";

const managed = { command: "/node", prefixArgs: ["/pi/cli.js"] };

describe("piProcessArgs", () => {
  it("gives each kind of process its flags", () => {
    expect(
      piProcessArgs(managed, {
        purpose: "chat",
        session: { kind: "resume", sessionFile: "/s/a.jsonl" },
        launchArgs: ["--no-mcp"],
        extensionPath: "/ext.ts",
        instructionsPath: "/instructions.md",
      }),
    ).toEqual([
      "/pi/cli.js",
      "--mode",
      "rpc",
      "--no-mcp",
      "--session",
      "/s/a.jsonl",
      "--extension",
      "/ext.ts",
      "--append-system-prompt",
      "/instructions.md",
    ]);
    expect(
      piProcessArgs(
        { command: "pi", prefixArgs: [] },
        { purpose: "fork", sessionFile: "/s/a.jsonl" },
      ),
    ).toEqual(["--mode", "rpc", "--no-extensions", "--no-tools", "--fork", "/s/a.jsonl"]);
    expect(piProcessArgs(managed, { purpose: "utility", launchArgs: [] })).toEqual([
      "/pi/cli.js",
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
    ]);
  });
});

describe("parsePiLaunchArgs", () => {
  it("passes Pi's own flags through, quotes included", () => {
    expect(parsePiLaunchArgs(`--no-mcp --model "anthropic/claude sonnet" -e ./x.ts`)).toEqual({
      args: ["--no-mcp", "--model", "anthropic/claude sonnet", "-e", "./x.ts"],
    });
  });

  it("refuses flags Threadlines owns, prompts, keys on the command line and a lone --provider", () => {
    for (const raw of [
      "--session=x",
      "-c",
      "--approve",
      "--api-key sk",
      "hello",
      "--provider google",
      `--model "x`,
    ]) {
      expect(parsePiLaunchArgs(raw), raw).toHaveProperty("error");
    }
    expect(parsePiLaunchArgs("--provider google --model gemini-2.5-pro")).toHaveProperty("args");
  });
});

describe("piProcessEnvironment", () => {
  it("drops inherited extension settings and sets them only for chat", () => {
    const env = piProcessEnvironment({
      instanceEnvironment: [{ name: "GEMINI_API_KEY", value: "k", sensitive: true }],
      baseEnv: { PATH: "/bin", [PI_EXTENSION_ENV.token]: "leaked" },
    });
    expect(env[PI_EXTENSION_ENV.token]).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBe("k");
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");

    const chat = piProcessEnvironment({
      instanceEnvironment: undefined,
      baseEnv: {},
      extension: {
        access: piAccessLevel("auto"),
        plan: true,
        toolServers: [],
        token: "t",
        nonce: "n",
      },
    });
    expect(chat[PI_EXTENSION_ENV.access]).toBe("approval-required");
    expect(chat[PI_EXTENSION_ENV.plan]).toBe("1");
  });
});
