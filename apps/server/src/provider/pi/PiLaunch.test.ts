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
    // A tools list would win over `--no-tools`, so titles never take one.
    expect(
      piProcessArgs(managed, {
        purpose: "utility",
        launchArgs: ["--tools", "bash,read", "--model", "x/y", "-xt=ask", "-nbt"],
      }),
    ).toEqual(["/pi/cli.js", "--mode", "rpc", "--model", "x/y", "--no-session", "--no-tools"]);
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
      baseEnv: {
        PATH: "/bin",
        [PI_EXTENSION_ENV.secretsFile]: "/leaked",
        THREADLINES_PI_TOOL_TOKEN: "leaked by an older Threadlines",
      },
    });
    expect(env[PI_EXTENSION_ENV.secretsFile]).toBeUndefined();
    expect(env.THREADLINES_PI_TOOL_TOKEN).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBe("k");
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");

    const chat = piProcessEnvironment({
      instanceEnvironment: undefined,
      baseEnv: {},
      extension: {
        access: piAccessLevel("auto"),
        plan: true,
        toolServers: [],
        secretsFile: "/tmp/secrets.json",
      },
    });
    // Pi has no Auto: it runs at the next safer level, Auto-accept edits.
    expect(chat[PI_EXTENSION_ENV.access]).toBe("auto-accept-edits");
    expect(chat[PI_EXTENSION_ENV.plan]).toBe("1");
  });
});
