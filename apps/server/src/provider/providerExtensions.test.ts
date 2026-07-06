import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerSettings as ServerSettingsContract,
} from "@threadlines/contracts";

import {
  codexMcpLoginCommandForDisplay,
  codexSkillConfigWriteParams,
  derivePluginBackedSkillBundle,
  isCodexAppsDirectoryAccessDeniedError,
  mapCodexMcpServers,
  parseClaudeMcpList,
  parseClaudePluginList,
  getProviderExtensionOperationStatus,
  readProviderInstructionFiles,
  readProviderExtensionsInventory,
  refreshProviderExtensionPluginMarketplaces,
  startProviderExtensionMcpOAuth,
  writeInstructionFile,
} from "./providerExtensions.ts";

const encoder = new TextEncoder();
const decodeServerSettings = Schema.decodeSync(ServerSettings);

function makeNeverFinishingProcess() {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { cause?: unknown; code?: unknown; reason?: unknown };
  if (typeof record.code === "string") return record.code;
  if (record.cause && typeof record.cause === "object") {
    const causeCode = (record.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  if (record.reason && typeof record.reason === "object") {
    const reason = record.reason as { cause?: unknown; code?: unknown };
    if (typeof reason.code === "string") return reason.code;
    if (reason.cause && typeof reason.cause === "object") {
      const reasonCauseCode = (reason.cause as { code?: unknown }).code;
      if (typeof reasonCauseCode === "string") return reasonCauseCode;
    }
  }
  return undefined;
}

function isUnavailableWindowsSymlink(error: unknown) {
  return process.platform === "win32" && getErrorCode(error) === "EPERM";
}

function makeProcessResult(stdout: string, stderr = "", code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(456),
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeSettings(overrides: Record<string, unknown> = {}): ServerSettingsContract {
  return decodeServerSettings({
    providers: {
      codex: { enabled: true, binaryPath: "codex" },
      claudeAgent: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
    },
    ...overrides,
  });
}

function claudeInventoryProcessFor(args: ReadonlyArray<string>) {
  if (args[0] === "plugin" && args[1] === "list") {
    return makeProcessResult('{"installed":[],"available":[]}');
  }
  if (args[0] === "mcp" && args[1] === "list") {
    return makeProcessResult("");
  }
  return makeProcessResult("", `unexpected claude command: ${args.join(" ")}`, 1);
}

describe("provider extensions inventory", () => {
  it("treats Codex app-directory 403s as optional inventory misses", () => {
    assert.equal(
      isCodexAppsDirectoryAccessDeniedError(
        new Error("failed to list apps: Request failed with status 403 Forbidden: <html>"),
      ),
      true,
    );
    assert.equal(
      isCodexAppsDirectoryAccessDeniedError(
        new Error("failed to list apps: Request failed with status 500 Internal Server Error"),
      ),
      false,
    );
  });

  it("parses Claude plugin JSON inventory with installed and marketplace entries", () => {
    const plugins = parseClaudePluginList(
      JSON.stringify({
        installed: [
          {
            id: "supabase@claude-plugins-official",
            version: "0.1.9",
            scope: "user",
            enabled: false,
            installPath: "C:\\Users\\wilfr\\.claude\\plugins\\cache\\supabase\\0.1.9",
            installedAt: "2026-04-20T08:59:41.934Z",
            lastUpdated: "2026-05-29T03:28:06.201Z",
          },
        ],
        available: [
          {
            pluginId: "supabase@claude-plugins-official",
            name: "supabase",
            description: "Supabase MCP integration",
            marketplaceName: "claude-plugins-official",
            source: { url: "https://github.com/supabase-community/supabase-plugin.git" },
            installCount: 100599,
          },
          {
            pluginId: "vercel@claude-plugins-official",
            name: "vercel",
            description: "Vercel integration",
            marketplaceName: "claude-plugins-official",
          },
        ],
      }),
    );

    assert.equal(plugins[0]?.id, "supabase@claude-plugins-official");
    assert.equal(plugins[0]?.name, "supabase");
    assert.equal(plugins[0]?.enabled, false);
    assert.equal(plugins[0]?.installed, true);
    assert.equal(plugins[0]?.description, "Supabase MCP integration");
    assert.equal(plugins[0]?.installCount, 100599);
    assert.equal(plugins[1]?.id, "vercel@claude-plugins-official");
    assert.equal(plugins[1]?.installed, false);
  });

  it("maps Codex MCP auth status without treating unsupported auth as server failure", () => {
    const servers = mapCodexMcpServers({
      data: [
        {
          name: "playwright",
          authStatus: "unsupported",
          tools: {
            browser_click: {
              name: "browser_click",
              description: "Click",
              inputSchema: {},
            },
          },
          resources: [],
          resourceTemplates: [],
        },
        {
          name: "supabase",
          authStatus: "notLoggedIn",
          tools: {},
          resources: [],
          resourceTemplates: [],
        },
      ],
    });

    assert.equal(servers[0]?.name, "playwright");
    assert.equal(servers[0]?.status, "Ready");
    assert.equal(servers[0]?.authStatus, "No auth required");
    assert.equal(servers[0]?.toolCount, 1);
    assert.equal(servers[1]?.name, "supabase");
    assert.equal(servers[1]?.status, "Needs auth");
    assert.equal(servers[1]?.authStatus, "Not logged in");
  });

  it("parses Claude plugin MCP entries without collapsing the name to plugin", () => {
    const servers = parseClaudeMcpList(
      [
        "Checking MCP server health...",
        "plugin:supabase:supabase: https://mcp.supabase.com/mcp (HTTP) - ! Needs authentication",
      ].join("\n"),
    );

    assert.equal(servers[0]?.name, "supabase");
    assert.equal(servers[0]?.status, "Needs authentication");
    assert.equal(servers[0]?.authStatus, "Needs authentication");
    assert.equal(servers[0]?.transport, "HTTP");
    assert.equal(servers[0]?.detail, "https://mcp.supabase.com/mcp");
  });

  it("derives plugin bundle metadata from cached skill paths", () => {
    assert.deepEqual(
      derivePluginBackedSkillBundle(
        "C:\\Users\\wilfr\\.codex\\plugins\\cache\\openai-curated\\vercel\\3fdeeb49\\skills\\ai-sdk\\SKILL.md",
      ),
      {
        bundleId: "vercel@openai-curated",
        bundleName: "vercel",
      },
    );

    assert.deepEqual(
      derivePluginBackedSkillBundle(
        "/Users/wilfr/.codex/plugins/cache/claude-plugins-official/cloudflare/1.0.0/skills/wrangler/SKILL.md",
      ),
      {
        bundleId: "cloudflare@claude-plugins-official",
        bundleName: "cloudflare",
      },
    );

    assert.equal(
      derivePluginBackedSkillBundle("/Users/wilfr/.codex/skills/openai-docs/SKILL.md"),
      null,
    );
  });

  it("renders Codex MCP login fallback with provider binary and CODEX_HOME", () => {
    const command = codexMcpLoginCommandForDisplay({
      binaryPath: "custom-codex",
      codexHomePath: "/tmp/codex work",
      serverName: "supabase",
      scopes: ["projects:read", "projects:write"],
    });

    assert.equal(
      command,
      process.platform === "win32"
        ? "$env:CODEX_HOME='/tmp/codex work'; custom-codex mcp login supabase --scopes projects:read,projects:write"
        : "CODEX_HOME='/tmp/codex work' custom-codex mcp login supabase --scopes projects:read,projects:write",
    );
  });

  it("builds Codex skill config writes with exactly one selector", () => {
    assert.deepEqual(
      codexSkillConfigWriteParams({
        enabled: false,
        name: "vercel:nextjs",
        path: "C:\\Users\\wilfr\\.codex\\plugins\\cache\\openai-curated\\vercel\\skills\\nextjs\\SKILL.md",
      }),
      {
        enabled: false,
        path: "C:\\Users\\wilfr\\.codex\\plugins\\cache\\openai-curated\\vercel\\skills\\nextjs\\SKILL.md",
      },
    );

    assert.deepEqual(codexSkillConfigWriteParams({ enabled: true, name: "openai-docs" }), {
      enabled: true,
      name: "openai-docs",
    });
    assert.equal(codexSkillConfigWriteParams({ enabled: true }), null);
  });

  it.effect(
    "returns a Codex provider error instead of hanging when app-server never responds",
    () => {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
      const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
      const layer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          readProviderExtensionsInventory({
            request: { cwd: process.cwd() },
            settings: makeSettings(),
            providers: [],
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(20));

        const result = yield* Fiber.join(fiber);
        const codex = result.providers.find(
          (provider) => provider.instanceId === ProviderInstanceId.make("codex"),
        );

        assert.equal(codex?.driver, ProviderDriverKind.make("codex"));
        assert.equal(codex?.status, "error");
        assert.equal(codex?.message, "Timed out reading Codex extension inventory.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps disabled provider inventory local without spawning provider commands", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeProcessResult("", "unexpected spawn", 1)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const result = yield* readProviderExtensionsInventory({
        request: { cwd: process.cwd() },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        providers: [],
      });
      const codex = result.providers.find(
        (provider) => provider.instanceId === ProviderInstanceId.make("codex"),
      );

      assert.equal(codex?.status, "disabled");
      assert.equal(codex?.message, "Provider is disabled.");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("filters inventory to the requested provider instance", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeProcessResult("", "unexpected spawn", 1)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const result = yield* readProviderExtensionsInventory({
        request: {
          cwd: process.cwd(),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        providers: [],
      });

      assert.deepEqual(
        result.providers.map((provider) => provider.instanceId),
        [ProviderInstanceId.make("claudeAgent")],
      );
      assert.equal(result.providers[0]?.status, "disabled");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("discovers Claude skills from user, ancestor, current, and nested roots", () => {
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(claudeInventoryProcessFor(childProcess.args));
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-skills-repo-",
      });
      const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-skills-home-",
      });
      const packageDir = path.join(repoDir, "packages", "api");

      const writeSkill = (skillPath: string, contents: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(skillPath), { recursive: true });
          yield* fileSystem.writeFileString(skillPath, contents);
        });

      yield* writeSkill(
        path.join(claudeHome, ".claude", "skills", "user-only", "SKILL.md"),
        [
          "---",
          "name: user-only",
          "display-name: User Skill",
          "short-description: From user home",
          "---",
          "Use this from the user skill root.",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(repoDir, ".claude", "skills", "shared", "SKILL.md"),
        ["---", "name: shared", "displayName: Repo Shared", "---", "Parent project skill."].join(
          "\n",
        ),
      );
      yield* writeSkill(
        path.join(packageDir, ".claude", "skills", "shared", "SKILL.md"),
        [
          "---",
          "name: shared",
          "display-name: Package Shared",
          "shortDescription: Closest project wins",
          "default-enabled: false",
          "---",
          "Package project skill.",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(packageDir, ".claude", "skills", "category", "deploy", "SKILL.md"),
        [
          "---",
          "name: deploy",
          "displayName: Deploy Skill",
          "short-description: Nested under the skills root",
          "defaultEnabled: true",
          "---",
          "Nested skill directory.",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(packageDir, "feature", ".claude", "skills", "shared", "SKILL.md"),
        [
          "---",
          "name: shared",
          "display-name: Feature Shared",
          "---",
          "Nested project skill.",
        ].join("\n"),
      );

      const result = yield* readProviderExtensionsInventory({
        request: {
          cwd: packageDir,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: true, binaryPath: "claude", homePath: claudeHome },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        providers: [],
      });

      const claude = result.providers[0];
      const skillsByName = new Map(claude?.skills.map((skill) => [skill.name, skill]));

      assert.deepEqual(
        [...skillsByName.keys()].toSorted((left, right) => left.localeCompare(right)),
        ["deploy", "feature:shared", "shared", "user-only"],
      );
      assert.equal(skillsByName.get("shared")?.displayName, "Package Shared");
      assert.equal(skillsByName.get("shared")?.shortDescription, "Closest project wins");
      assert.equal(skillsByName.get("shared")?.enabled, false);
      assert.equal(skillsByName.get("feature:shared")?.displayName, "Feature Shared");
      assert.equal(skillsByName.get("deploy")?.displayName, "Deploy Skill");
      assert.equal(skillsByName.get("deploy")?.shortDescription, "Nested under the skills root");
      assert.equal(skillsByName.get("deploy")?.enabled, true);
      assert.equal(skillsByName.get("user-only")?.scope, "user");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("starts Claude MCP login through the configured Claude CLI", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string | undefined;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly cwd?: string };
      };
      calls.push({
        command: childProcess.command,
        args: childProcess.args,
        cwd: childProcess.options.cwd,
      });
      if (childProcess.args[0] === "mcp" && childProcess.args[1] === "list") {
        return Effect.succeed(
          makeProcessResult(
            "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 (HTTP) - Connected",
          ),
        );
      }
      return Effect.succeed(makeProcessResult("Login completed"));
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-mcp-login-",
      });
      const result = yield* startProviderExtensionMcpOAuth({
        request: {
          cwd,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          serverName: "claude.ai Google Drive",
          timeoutSecs: 30,
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: true, binaryPath: "custom-claude" },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      });

      yield* Effect.yieldNow;

      const status = yield* getProviderExtensionOperationStatus({
        operationId: result.operationId,
      });

      assert.equal(result.authorizationUrl, undefined);
      assert.equal(result.terminalCommand, 'claude mcp login "claude.ai Google Drive"');
      assert.equal(calls[0]?.command, "custom-claude");
      assert.deepEqual(calls[0]?.args, [
        "mcp",
        "login",
        process.platform === "win32" ? '"claude.ai Google Drive"' : "claude.ai Google Drive",
      ]);
      assert.equal(calls[0]?.cwd, cwd);
      assert.deepEqual(calls[1]?.args, ["mcp", "list"]);
      assert.equal(status.status, "completed");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("keeps Claude MCP login failed when post-login status still needs auth", () => {
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly args: ReadonlyArray<string>;
      };
      if (childProcess.args[0] === "mcp" && childProcess.args[1] === "list") {
        return Effect.succeed(
          makeProcessResult(
            "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 (HTTP) - ! Needs authentication",
          ),
        );
      }
      return Effect.succeed(makeProcessResult("Login completed"));
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-mcp-login-cancelled-",
      });
      const result = yield* startProviderExtensionMcpOAuth({
        request: {
          cwd,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          serverName: "claude.ai Google Drive",
          timeoutSecs: 30,
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: true, binaryPath: "custom-claude" },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      });

      yield* Effect.yieldNow;

      const runningStatus = yield* getProviderExtensionOperationStatus({
        operationId: result.operationId,
      });

      assert.equal(runningStatus.status, "running");
      assert.match(runningStatus.message ?? "", /Waiting for .*browser sign-in/i);

      yield* TestClock.adjust(Duration.seconds(30));

      const status = yield* getProviderExtensionOperationStatus({
        operationId: result.operationId,
      });

      assert.equal(status.status, "failed");
      assert.match(status.message ?? "", /not completed/i);
      assert.match(status.error ?? "", /still needs authentication after waiting/i);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer())));
  });

  it.effect("explains Claude MCP approval failures", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeProcessResult(
          "",
          [
            'No MCP server named "claude.ai".',
            "Configured servers: claude.ai Google Drive (.mcp.json servers are awaiting approval — run `claude` in this directory to review them.)",
          ].join(" "),
          1,
        ),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-mcp-login-failed-",
      });
      const result = yield* startProviderExtensionMcpOAuth({
        request: {
          cwd,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          serverName: "claude.ai Google Drive",
          timeoutSecs: 30,
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: true, binaryPath: "custom-claude" },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      });

      yield* Effect.yieldNow;

      const status = yield* getProviderExtensionOperationStatus({
        operationId: result.operationId,
      });

      assert.equal(status.status, "failed");
      assert.match(status.error ?? "", /approve the MCP configuration/i);
      assert.match(status.error ?? "", /retry authorization in Threadlines/i);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("refreshes Codex plugin marketplaces through the configured binary", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string | undefined;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly cwd?: string };
      };
      calls.push({
        command: childProcess.command,
        args: childProcess.args,
        cwd: childProcess.options.cwd,
      });
      return Effect.succeed(makeProcessResult("marketplace updated"));
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const result = yield* refreshProviderExtensionPluginMarketplaces({
        request: {
          cwd: process.cwd(),
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        settings: makeSettings({
          providers: {
            codex: { enabled: true, binaryPath: "custom-codex" },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      });

      assert.equal(result.refreshed, true);
      assert.equal(result.output, "marketplace updated");
      assert.equal(calls[0]?.command, "custom-codex");
      assert.deepEqual(calls[0]?.args, ["plugin", "marketplace", "upgrade"]);
      assert.equal(calls[0]?.cwd, process.cwd());
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it.effect("creates missing project instruction files at the canonical path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-provider-instructions-",
      });

      const result = yield* writeInstructionFile({
        cwd,
        kind: "claude-instructions",
        contents: "Use concise responses.\n",
      });

      assert.equal(result.file.relativePath, "CLAUDE.md");
      assert.equal(result.file.exists, true);
      assert.equal(result.file.editable, true);
      assert.equal(
        yield* fileSystem.readFileString(path.join(cwd, "CLAUDE.md")),
        "Use concise responses.\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not write through symlinked project instruction files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-provider-instructions-",
      });
      const symlinkTarget = "@AGENTS.md\n";

      const symlinkCreated = yield* fileSystem
        .symlink(symlinkTarget, path.join(cwd, "CLAUDE.md"))
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            isUnavailableWindowsSymlink(error) ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
      if (!symlinkCreated) return;

      const files = yield* readProviderInstructionFiles({ cwd });
      const claudeFile = files.instructionFiles.find((file) => file.kind === "claude-instructions");

      assert.equal(claudeFile?.relativePath, "CLAUDE.md");
      assert.equal(claudeFile?.exists, true);
      assert.equal(claudeFile?.editable, false);
      assert.equal(claudeFile?.readOnlyReason, "symbolic-link");

      const writeError = yield* writeInstructionFile({
        cwd,
        kind: "claude-instructions",
        contents: "Use concise responses.\n",
      }).pipe(Effect.flip);

      assert.equal(
        writeError.message,
        "CLAUDE.md is a symbolic link and cannot be edited from settings.",
      );
      assert.equal(yield* fileSystem.exists(path.join(cwd, symlinkTarget)), false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
