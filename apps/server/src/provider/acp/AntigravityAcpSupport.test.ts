// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RUNTIME_MODES } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import { antigravityEnvironment } from "../antigravity/AntigravityProfile.ts";
import { removeAntigravitySessionFiles } from "../antigravity/AntigravitySessionLog.ts";
import { supportedMcpServers } from "./AcpSessionRuntime.ts";
import {
  antigravityAgentMode,
  antigravityAgentProblem,
  antigravityModelsFromCatalog,
  antigravityModelsFromChoices,
  extractAntigravityElicitationForm,
  isAntigravityCatalogComplete,
  isAntigravityPlanFileEdit,
  isLegacyAntigravityServerPath,
  nextAntigravityCatalog,
  parseAntigravitySignInUrl,
  probeAntigravityModelOptions,
  resolveAntigravityModelId,
} from "./AntigravityAcpSupport.ts";

// The model list a free-tier account got from agy-acp-server 1.3.0, which
// named the reasoning level in the model.
const RECORDED_CHOICES = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-pro-agent", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
].map(([value, name]) => ({ value: value!, name: name! }));

const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash-high",
    options: RECORDED_CHOICES.map((choice) => ({ ...choice, description: choice.value })),
  },
];

describe("Antigravity models", () => {
  it("lists each family once, with its efforts as a Reasoning option", () => {
    const models = antigravityModelsFromChoices(RECORDED_CHOICES);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["gemini-3.8-flash", "Gemini 3.8 Flash"],
      ["gemini-3.7-flash", "Gemini 3.7 Flash"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro"],
    ]);
    const efforts = models[0]?.capabilities?.optionDescriptors?.[0];
    // Lowest first, as the effort meter fills; High stays the default.
    expect(efforts?.type === "select" ? efforts.options.map((option) => option.id) : []).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(efforts?.type === "select" ? efforts.currentValue : undefined).toBe("high");
  });

  it("sends the agent's own id for a family and effort, irregular ids included", () => {
    const resolve = (model: string, effort?: string) =>
      resolveAntigravityModelId(model, {
        selections: effort ? [{ id: "effort", value: effort }] : [],
        configOptions,
      });
    expect(resolve("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolve("gemini-3.8-flash")).toBe("gemini-3.8-flash-high");
    expect(resolve("gemini-3.1-pro", "high")).toBe("gemini-pro-agent");
    expect(resolve("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolve("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-high");
  });
});

describe("antigravityAgentMode", () => {
  const CLI_MODES = ["default", "accept-edits", "plan", "auto"];

  it("maps each access level onto the CLI's modes, never to one it refuses", () => {
    expect(
      RUNTIME_MODES.map((mode) => [mode, antigravityAgentMode(mode, "default", CLI_MODES)]),
    ).toEqual([
      ["approval-required", "default"],
      ["auto-accept-edits", "accept-edits"],
      ["auto", "auto"],
      // Full access has no CLI mode: Threadlines answers each request.
      ["full-access", "default"],
    ]);
    expect(antigravityAgentMode("full-access", "plan", CLI_MODES)).toBe("default");
  });

  it("runs Auto as Auto-accept edits where the session offers no Auto", () => {
    const withoutAuto = CLI_MODES.filter((mode) => mode !== "auto");
    expect(antigravityAgentMode("auto", "default", withoutAuto)).toBe("accept-edits");
    for (const mode of RUNTIME_MODES) {
      expect(withoutAuto, mode).toContain(antigravityAgentMode(mode, "default", withoutAuto));
    }
  });
});

describe("antigravityAgentProblem", () => {
  const problem = (version: string | undefined) =>
    antigravityAgentProblem({
      agentInfo: version === undefined ? null : { name: "Antigravity ACP Server", version },
    });

  it("refuses an agent older than the minimum, or one that won't say its version", () => {
    expect(problem("1.5.14")).toBeUndefined();
    expect(problem("1.6.0")).toBeUndefined();
    expect(problem("1.5.13")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.2")).toContain("is 1.5.2");
    // Build tags and prereleases don't lift a version over the minimum.
    expect(problem("1.5.9+local")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.14-rc.1")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.14+build.7")).toBeUndefined();
    expect(problem(undefined)).toContain("doesn't say its version");
  });

  it("knows a path to Google's old server, which the CLI replaced", () => {
    expect(isLegacyAntigravityServerPath("/opt/agy/agy_acp_server.par")).toBe(true);
    expect(isLegacyAntigravityServerPath("C:\\agy\\agy_acp_server.exe")).toBe(true);
    expect(isLegacyAntigravityServerPath("/usr/local/bin/agy")).toBe(false);
  });
});

describe("Antigravity reasoning levels", () => {
  const thought = (current: string, values: ReadonlyArray<string>) =>
    ({
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: values.map((value) => ({ value, name: value[0]!.toUpperCase() + value.slice(1) })),
    }) satisfies EffectAcpSchema.SessionConfigOption;
  const model = (current: string) =>
    ({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current,
      options: [
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { value: "gpt-6-1", name: "GPT-6.1" },
      ],
    }) satisfies EffectAcpSchema.SessionConfigOption;

  it("remembers each model's own levels as sessions report them", () => {
    const first = nextAntigravityCatalog(undefined, [
      model("gemini-4-argon"),
      thought("high", ["low", "medium", "high"]),
    ]);
    // Claude has no reasoning option of its own in this session.
    const second = nextAntigravityCatalog(first as never, [model("claude-sonnet-4-6")]);
    const models = antigravityModelsFromCatalog(second!);
    const levels = (slug: string) => {
      const descriptor = models.find((entry) => entry.slug === slug)?.capabilities
        ?.optionDescriptors?.[0];
      return descriptor?.type === "select"
        ? [descriptor.id, descriptor.options.map((option) => option.id)]
        : undefined;
    };
    // Models keep the agent's own ids, so they are sent back unchanged.
    expect(models.map((entry) => entry.slug)).toEqual([
      "gemini-4-argon",
      "claude-sonnet-4-6",
      "gpt-6-1",
    ]);
    expect(levels("gemini-4-argon")).toEqual(["thought_level", ["low", "medium", "high"]]);
    expect(levels("claude-sonnet-4-6")).toBeUndefined();
    // Not seen yet: the current model's levels stand in (here, none).
    expect(levels("gpt-6-1")).toBeUndefined();
  });

  it("does not mistake a single parenthesized model name like GPT-OSS 120B (Medium) for a legacy effort-in-name catalog", async () => {
    const choices = [
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ];
    expect(
      isAntigravityCatalogComplete({
        choices,
        currentValue: "gemini-4-neon",
        thoughtLevels: {
          "gemini-4-neon": {
            configId: "thought_level",
            name: "Thinking Level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        },
      }),
    ).toBe(false);

    let current = "gemini-4-neon";
    const optionsFor = (slug: string): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: slug,
        options: choices,
      },
      ...(slug === "gemini-4-neon" ? [thought("high", ["low", "high"])] : []),
    ];
    const probed = await Effect.runPromise(
      probeAntigravityModelOptions({
        getConfigOptions: Effect.sync(() => optionsFor(current)),
        setConfigOption: (_configId, value) =>
          Effect.sync(() => {
            current = String(value);
            return { configOptions: [...optionsFor(current)] };
          }),
      }),
    );
    expect(probed?.thoughtLevels["gemini-4-neon"]?.options.map((o) => o.value)).toEqual([
      "low",
      "high",
    ]);
    expect(probed?.thoughtLevels["gpt-oss-120b-medium"]).toBeNull();
  });

  it("falls back to folding names when the agent names the level in the model", () => {
    const next = nextAntigravityCatalog(undefined, configOptions);
    expect(next?.thoughtLevels).toBeUndefined();
    expect(antigravityModelsFromCatalog(next!).map((entry) => entry.slug)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro",
    ]);
  });
});

describe("parseAntigravitySignInUrl", () => {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A53789%2F&state=8Jy4kHH5&code_challenge_method=S256";

  it("takes Google's sign-in URL from the agent's stderr line", () => {
    expect(
      parseAntigravitySignInUrl(`Open the following link to authenticate the ACP server: ${url}`),
    ).toBe(url);
  });

  it("refuses a URL that is not Google's OAuth page with a loopback redirect", () => {
    const prefix = "Open the following link to authenticate the ACP server: ";
    expect(parseAntigravitySignInUrl(`${prefix}https://evil.example/o/oauth2/v2/auth?x=1`)).toBe(
      undefined,
    );
    expect(
      parseAntigravitySignInUrl(
        `${prefix}${url.replace("127.0.0.1%3A53789", "attacker.example%3A443")}`,
      ),
    ).toBe(undefined);
    expect(parseAntigravitySignInUrl("I1003 server.py] Starting AGY ACP Server...")).toBe(
      undefined,
    );
  });
});

describe("isAntigravityPlanFileEdit", () => {
  const brain = "/profile/antigravity-acp/brain";
  const edit = (path: string) => ({
    toolCallId: "call_plan",
    kind: "edit",
    data: {
      content: [{ type: "diff", path, oldText: "", newText: "# Plan" }],
      locations: [{ path }],
    },
  });

  it("takes only the asking session's own plan, never a path with dot steps", () => {
    expect(isAntigravityPlanFileEdit(edit(`${brain}/s1/plan.md`), brain, "s1")).toBe(true);
    // Through a link inside the session's folder these open another file.
    expect(isAntigravityPlanFileEdit(edit(`${brain}/s1/link/../plan.md`), brain, "s1")).toBe(false);
    expect(isAntigravityPlanFileEdit(edit(`${brain}/s1/./plan.md`), brain, "s1")).toBe(false);
    expect(isAntigravityPlanFileEdit(edit(`${brain}/s2/plan.md`), brain, "s1")).toBe(false);
  });
});

describe("Antigravity audit improvements", () => {
  it("folds Extra High and XHigh effort names", () => {
    const models = antigravityModelsFromChoices([
      { value: "gemini-4-pro-xhigh", name: "Gemini 4 Pro (XHigh)" },
      { value: "gemini-4-pro-high", name: "Gemini 4 Pro (High)" },
      { value: "gemini-4-flash-extra", name: "Gemini 4 Flash (Extra High)" },
      { value: "gemini-4-flash-low", name: "Gemini 4 Flash (Low)" },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["gemini-4-pro", "gemini-4-flash"]);
    const proEffort = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(proEffort?.type === "select" ? proEffort.options.map((o) => o.id) : []).toEqual([
      "high",
      "xhigh",
    ]);
  });

  it("probes each model's thought_level options in one session and restores the initial model", async () => {
    const levelsByModel: Record<string, ReadonlyArray<string> | undefined> = {
      "gemini-4-argon": ["low", "high"],
      "claude-sonnet": undefined,
      "gpt-6": ["minimal", "medium", "xhigh"],
    };
    let current = "gemini-4-argon";
    const switched: Array<string> = [];
    const optionsFor = (slug: string): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: slug,
        options: Object.keys(levelsByModel).map((value) => ({ value, name: value })),
      },
      ...(levelsByModel[slug]
        ? [
            {
              id: "thought_level",
              name: "Thinking",
              category: "thought_level" as const,
              type: "select" as const,
              currentValue: levelsByModel[slug]![0]!,
              options: levelsByModel[slug]!.map((value) => ({ value, name: value })),
            },
          ]
        : []),
    ];
    const probed = await Effect.runPromise(
      probeAntigravityModelOptions({
        getConfigOptions: Effect.sync(() => optionsFor(current)),
        setConfigOption: (_configId, value) =>
          Effect.sync(() => {
            current = String(value);
            switched.push(current);
            return { configOptions: [...optionsFor(current)] };
          }),
      }),
    );
    expect(probed?.thoughtLevels["gemini-4-argon"]?.options.map((o) => o.value)).toEqual([
      "low",
      "high",
    ]);
    expect(probed?.thoughtLevels["claude-sonnet"]).toBeNull();
    expect(probed?.thoughtLevels["gpt-6"]?.options.map((o) => o.value)).toEqual([
      "minimal",
      "medium",
      "xhigh",
    ]);
    expect(switched).toEqual(["claude-sonnet", "gpt-6", "gemini-4-argon"]);
    expect(current).toBe("gemini-4-argon");
    expect(
      isAntigravityCatalogComplete({
        choices: probed!.choices,
        thoughtLevels: { "gemini-4-argon": probed!.thoughtLevels["gemini-4-argon"]! },
      }),
    ).toBe(false);
    expect(
      isAntigravityCatalogComplete({
        choices: probed!.choices,
        thoughtLevels: probed!.thoughtLevels,
        probed: true,
      }),
    ).toBe(true);
  });

  it("folds ask_question elicitations numerically and rejects non-ask_question forms", () => {
    const form = extractAntigravityElicitationForm({
      mode: "form",
      message: "The agent has 3 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q10: {
            type: "string",
            title: "Tenth?",
            oneOf: [{ const: "1", title: "Yes" }],
          },
          q10_other: { type: "string", title: "Other" },
          q2: {
            type: "array",
            title: "Pick many",
            items: {
              anyOf: [
                { const: "a", title: "Alpha" },
                { const: "b", title: "Beta" },
              ],
            },
          },
          q2_other: { type: "string", title: "Other" },
          q1: {
            type: "string",
            title: "First?",
            oneOf: [
              { const: "1", title: "One", description: "First choice" },
              { const: "2", title: "Two" },
            ],
          },
          q1_other: { type: "string", title: "Other" },
        },
      },
    });
    expect(form?.questions.map((q) => [q.id, q.header, q.multiSelect])).toEqual([
      ["q1", "Question 1", false],
      ["q2", "Question 2", true],
      ["q10", "Question 3", false],
    ]);
    expect(form?.responseForAnswers({ q1: "One", q2: ["Alpha", "Beta"], q10: "Maybe" })).toEqual({
      action: "accept",
      content: { q1: "1", q2: ["a", "b"], q10_other: "Maybe" },
    });
    expect(form?.responseForAnswers({})).toEqual({ action: "cancel" });
    // Required fields or extra keys fall back to the generic elicitation form.
    expect(
      extractAntigravityElicitationForm({
        mode: "form",
        message: "Login",
        requestedSchema: {
          type: "object",
          required: ["q1"],
          properties: {
            q1: { type: "string", title: "First?", oneOf: [{ const: "1", title: "One" }] },
            q1_other: { type: "string", title: "Other" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps HTTP MCP servers when assumeHttpMcp is set, and falls back to stdio bridge otherwise", () => {
    const servers = [
      {
        type: "http" as const,
        name: "room",
        url: "http://127.0.0.1:9999/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret-tok" }],
      },
    ];
    const fallback = supportedMcpServers(servers, undefined, false);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      name: "room",
      command: process.execPath,
    });
    expect("type" in fallback[0]!).toBe(false);
    const stdio = fallback[0] as {
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    };
    expect(stdio.args.join(" ")).not.toContain("secret-tok");
    expect(stdio.env).toEqual(
      expect.arrayContaining([
        { name: "THREADLINES_MCP_URL", value: "http://127.0.0.1:9999/mcp" },
        { name: "THREADLINES_MCP_AUTHORIZATION", value: "Bearer secret-tok" },
      ]),
    );
    expect(supportedMcpServers(servers, undefined, true)).toEqual(servers);
  });

  it("hardens Antigravity child env and sets Linux SSL_CERT_FILE when unset", () => {
    const env = antigravityEnvironment({
      base: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
        CHROME_CRASHPAD_PIPE_NAME: "/tmp/pipe",
        NIX_SSL_CERT_FILE: "/nix/ca-bundle.crt",
      },
      profileDir: "/tmp/profile",
      tempDir: "/tmp/run",
      platform: "linux",
      pathExists: (candidate) => candidate === "/nix/ca-bundle.crt",
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    expect(env.PAGER).toBe("cat");
    expect(env.GH_PAGER).toBe("cat");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.SSL_CERT_FILE).toBe("/nix/ca-bundle.crt");
  });

  it("removes ephemeral session artifacts inside the profile without following symlinks", async () => {
    const dir = await NodeFS.mkdtemp(path.join(os.tmpdir(), "agy-cleanup-"));
    try {
      const appDir = path.join(dir, "antigravity-acp");
      await NodeFS.mkdir(path.join(appDir, "conversations"), { recursive: true });
      await NodeFS.mkdir(path.join(appDir, "brain", "ephemeral-1"), { recursive: true });
      await NodeFS.mkdir(path.join(appDir, "annotations"), { recursive: true });
      await NodeFS.writeFile(path.join(appDir, "conversations", "ephemeral-1.db"), "db");
      await NodeFS.writeFile(path.join(appDir, "conversations", "ephemeral-1.db-wal"), "wal");
      await NodeFS.writeFile(path.join(appDir, "conversations", "keep.db"), "keep");
      await NodeFS.writeFile(path.join(appDir, "brain", "ephemeral-1", "plan.md"), "plan");
      await NodeFS.writeFile(path.join(appDir, "annotations", "ephemeral-1.pbtxt"), "note");

      await Effect.runPromise(removeAntigravitySessionFiles(dir, "ephemeral-1"));

      expect(await NodeFS.readdir(path.join(appDir, "conversations"))).toEqual(["keep.db"]);
      expect(await NodeFS.readdir(path.join(appDir, "brain"))).toEqual([]);
      expect(await NodeFS.readdir(path.join(appDir, "annotations"))).toEqual([]);
    } finally {
      await NodeFS.rm(dir, { recursive: true, force: true });
    }
  });
});
