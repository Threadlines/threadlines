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
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerSettings as ServerSettingsContract,
} from "@threadlines/contracts";

import {
  codexMarketplaceLoadErrorMessage,
  codexMcpLoginCommandForDisplay,
  codexSkillConfigWriteParams,
  deriveClaudePluginGitHubOwner,
  claudePluginSkillRoots,
  derivePluginBackedSkillBundle,
  isCodexAppsDirectoryAccessDeniedError,
  mapCodexMcpServers,
  mapCodexPluginInventory,
  mapCodexPluginDetail,
  parseClaudeMarketplaceManifest,
  parseClaudeMarketplaceList,
  parseClaudeMcpList,
  parseClaudePluginDetails,
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

  it("maps Codex marketplaces, featured plugins, and plugin icons", () => {
    const inventory = mapCodexPluginInventory({
      featuredPluginIds: ["analytics"],
      marketplaceLoadErrors: [
        {
          marketplacePath: "/plugins/catalog/marketplace.json",
          message: " stale catalog ",
        },
      ],
      marketplaces: [
        {
          name: "catalog",
          path: "/plugins/catalog/marketplace.json",
          interface: { displayName: " Example Catalog " },
          plugins: [
            {
              id: "analytics",
              name: "Analytics",
              authPolicy: "ON_USE",
              enabled: true,
              installed: true,
              installPolicy: "AVAILABLE",
              source: { type: "remote" },
              version: "2.0.0",
              localVersion: "1.5.0",
              keywords: [" metrics ", "", "insights"],
              interface: {
                capabilities: [],
                screenshotUrls: [],
                screenshots: [],
                developerName: " Example Labs ",
                category: "Data",
                websiteUrl: " https://example.com/analytics ",
                shortDescription: "Understand product usage",
                logoUrl: " https://example.com/analytics.png ",
                logo: "/plugins/catalog/analytics/logo.png",
              },
            },
            {
              id: "category-only",
              name: "Category Only",
              authPolicy: "ON_INSTALL",
              enabled: false,
              installed: false,
              installPolicy: "AVAILABLE",
              source: { type: "remote" },
              version: "3.0.0",
              interface: {
                capabilities: [],
                screenshotUrls: [],
                screenshots: [],
                category: "Productivity",
              },
            },
          ],
        },
      ],
    });

    assert.deepEqual(inventory.plugins, [
      {
        id: "analytics",
        name: "Analytics",
        displayName: undefined,
        description: "Understand product usage",
        enabled: true,
        installed: true,
        source: "Remote catalog",
        authPolicy: "ON_USE",
        installPolicy: "AVAILABLE",
        availability: undefined,
        marketplaceName: "catalog",
        marketplacePath: "/plugins/catalog/marketplace.json",
        version: "1.5.0",
        availableVersion: "2.0.0",
        developerName: "Example Labs",
        category: "Data",
        websiteUrl: "https://example.com/analytics",
        keywords: ["metrics", "insights"],
        iconUrl: "https://example.com/analytics.png",
        iconPath: "/plugins/catalog/analytics/logo.png",
        featured: true,
      },
      {
        id: "category-only",
        name: "Category Only",
        displayName: undefined,
        description: undefined,
        enabled: false,
        installed: false,
        source: "Remote catalog",
        authPolicy: "ON_INSTALL",
        installPolicy: "AVAILABLE",
        availability: undefined,
        marketplaceName: "catalog",
        marketplacePath: "/plugins/catalog/marketplace.json",
        version: "3.0.0",
        category: "Productivity",
      },
    ]);
    assert.deepEqual(inventory.marketplaces, [
      {
        name: "catalog",
        displayName: "Example Catalog",
        source: "/plugins/catalog/marketplace.json",
        path: "/plugins/catalog/marketplace.json",
        pluginCount: 2,
        installedPluginCount: 1,
        remote: false,
        removable: true,
        loadError: "stale catalog",
      },
    ]);
  });

  it("maps typed Codex plugin detail and sorts its component inventory", () => {
    const detail = mapCodexPluginDetail({
      appTemplates: [
        {
          templateId: "warehouse-template",
          name: "Warehouse",
          category: "Data",
          description: "Connect a warehouse",
          materializedAppIds: [],
        },
      ],
      apps: [
        {
          id: "dashboard-app",
          name: "Dashboard",
          category: "Analytics",
          description: "Open dashboards",
        },
      ],
      description: "Installed analytics toolkit",
      hooks: [{ eventName: "postToolUse", key: "record-usage" }],
      marketplaceName: "catalog",
      marketplacePath: "/plugins/catalog",
      mcpServers: ["metrics-api"],
      scheduledTasks: [
        {
          key: "weekly-report",
          name: "Weekly report",
          prompt: "Summarize usage",
          schedule: { type: "weekly", days: ["MO", "FR"], time: "09:00" },
        },
      ],
      shareUrl: null,
      skills: [
        {
          name: "summarize",
          description: "Summarize product usage",
          enabled: true,
          path: "/plugins/analytics/skills/summarize/SKILL.md",
          shortDescription: "Summarize usage",
        },
        {
          name: "analyze",
          description: "Analyze funnels",
          enabled: false,
        },
      ],
      summary: {
        authPolicy: "ON_USE",
        enabled: true,
        id: "analytics",
        installPolicy: "AVAILABLE",
        installed: true,
        interface: {
          capabilities: [],
          screenshotUrls: [],
          screenshots: [],
          displayName: "Analytics Toolkit",
          developerName: "Example Labs",
          websiteUrl: "https://example.com/analytics",
          shortDescription: "Remote description",
        },
        localVersion: "1.5.0",
        name: "Analytics",
        shareContext: {
          remotePluginId: "remote-analytics",
          shareUrl: "https://example.com/share/analytics",
        },
        source: { type: "remote" },
        version: "2.0.0",
      },
    } satisfies CodexSchema.V2PluginReadResponse__PluginDetail);

    assert.deepEqual(detail, {
      pluginId: "analytics",
      name: "Analytics",
      displayName: "Analytics Toolkit",
      description: "Installed analytics toolkit",
      version: "1.5.0",
      developerName: "Example Labs",
      websiteUrl: "https://example.com/analytics",
      marketplaceName: "catalog",
      marketplacePath: "/plugins/catalog",
      shareUrl: "https://example.com/share/analytics",
      components: [
        {
          kind: "skill",
          name: "analyze",
          description: "Analyze funnels",
          enabled: false,
        },
        {
          kind: "skill",
          name: "summarize",
          description: "Summarize usage",
          path: "/plugins/analytics/skills/summarize/SKILL.md",
          enabled: true,
        },
        { kind: "hook", name: "record-usage", detail: "postToolUse" },
        { kind: "mcpServer", name: "metrics-api" },
        {
          kind: "app",
          name: "Dashboard",
          description: "Open dashboards",
          detail: "Analytics",
        },
        {
          kind: "appTemplate",
          name: "Warehouse",
          description: "Connect a warehouse",
          detail: "Data",
        },
        {
          kind: "scheduledTask",
          name: "Weekly report",
          detail: "MO, FR at 09:00",
        },
      ],
    });
  });

  it("summarizes and sanitizes Codex marketplace load failures", () => {
    const message = codexMarketplaceLoadErrorMessage({
      marketplaceLoadErrors: [
        { marketplacePath: "/path/one", message: "bad\nmanifest" },
        { marketplacePath: "/path/two", message: "not found" },
        { marketplacePath: "/path/three", message: "permission denied" },
        { marketplacePath: "/path/four", message: "invalid source" },
      ],
      marketplaces: [],
    });

    assert.equal(
      message,
      "Failed to load 4 plugin marketplaces: /path/one (bad manifest), /path/two (not found), /path/three (permission denied), +1 more.",
    );
    assert.equal(codexMarketplaceLoadErrorMessage({ marketplaces: [] }), undefined);
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

  it("parses Claude marketplaces and derives plugin counts from plugin inventory", () => {
    const plugins = parseClaudePluginList(
      JSON.stringify({
        installed: [
          {
            id: "supabase@claude-plugins-official",
            enabled: true,
          },
        ],
        available: [
          {
            pluginId: "supabase@claude-plugins-official",
            name: "supabase",
          },
          {
            pluginId: "vercel@claude-plugins-official",
            name: "vercel",
          },
        ],
      }),
    );

    assert.deepEqual(
      parseClaudeMarketplaceList(
        JSON.stringify([
          {
            name: "claude-plugins-official",
            source: "github",
            repo: "anthropics/claude-plugins-official",
            installLocation: "/Users/will/.claude/plugins/marketplaces/claude-plugins-official",
          },
        ]),
        plugins,
      ),
      [
        {
          name: "claude-plugins-official",
          source: "anthropics/claude-plugins-official",
          path: "/Users/will/.claude/plugins/marketplaces/claude-plugins-official",
          pluginCount: 2,
          installedPluginCount: 1,
          remote: false,
          removable: true,
        },
      ],
    );
  });

  it("parses Claude marketplace manifest metadata with optional authors", () => {
    const manifest = parseClaudeMarketplaceManifest({
      name: "claude-plugins-official",
      plugins: [
        {
          name: "acrobat",
          displayName: "Adobe Acrobat",
          description: "Work with PDF documents.",
          author: { name: "Adobe", email: "plugins@example.com" },
          category: "productivity",
          homepage: "https://www.adobe.com/acrobat",
          keywords: [" pdf ", "", "documents"],
          source: {
            source: "git-subdir",
            url: "https://github.com/adobe/acrobat-claude-plugin.git",
          },
        },
        {
          name: "agent-sdk-dev",
          description: "Build Claude agents.",
          source: "./plugins/agent-sdk-dev",
        },
      ],
    });

    assert.deepEqual(
      manifest,
      new Map([
        [
          "acrobat",
          {
            displayName: "Adobe Acrobat",
            description: "Work with PDF documents.",
            category: "productivity",
            developerName: "Adobe",
            websiteUrl: "https://www.adobe.com/acrobat",
            keywords: ["pdf", "documents"],
            source: { url: "https://github.com/adobe/acrobat-claude-plugin.git" },
          },
        ],
        [
          "agent-sdk-dev",
          {
            description: "Build Claude agents.",
            source: "./plugins/agent-sdk-dev",
          },
        ],
      ]),
    );
    assert.deepEqual(parseClaudeMarketplaceManifest({ plugins: "invalid" }), new Map());
  });

  it("derives Claude plugin GitHub owners from plugin and marketplace sources", () => {
    assert.equal(
      deriveClaudePluginGitHubOwner(
        {
          source: "git-subdir",
          url: "https://github.com/42Crunch-AI/claude-plugins.git",
        },
        "anthropics/claude-plugins-official",
      ),
      "42Crunch-AI",
    );
    assert.equal(
      deriveClaudePluginGitHubOwner(
        "./plugins/agent-sdk-dev",
        "anthropics/claude-plugins-official",
      ),
      "anthropics",
    );
    assert.equal(
      deriveClaudePluginGitHubOwner(
        { url: "https://gitlab.com/example/claude-plugin.git" },
        "anthropics/claude-plugins-official",
      ),
      undefined,
    );
  });

  it.effect("enriches Claude inventory without replacing an installed plugin description", () => {
    let pluginInstallPath = "";
    let marketplacePath = "";
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly args: ReadonlyArray<string>;
      };
      const args = childProcess.args;
      if (args[0] === "plugin" && args[1] === "list") {
        return Effect.succeed(
          makeProcessResult(
            JSON.stringify({
              installed: [
                {
                  id: "agent-sdk-dev@claude-plugins-official",
                  enabled: true,
                  installPath: pluginInstallPath,
                },
              ],
              available: [
                {
                  pluginId: "agent-sdk-dev@claude-plugins-official",
                  name: "agent-sdk-dev",
                  marketplaceName: "claude-plugins-official",
                },
              ],
            }),
          ),
        );
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
        return Effect.succeed(
          makeProcessResult(
            JSON.stringify([
              {
                name: "claude-plugins-official",
                repo: "anthropics/claude-plugins-official",
                installLocation: marketplacePath,
              },
            ]),
          ),
        );
      }
      if (args[0] === "mcp" && args[1] === "list") {
        return Effect.succeed(makeProcessResult(""));
      }
      return Effect.succeed(
        makeProcessResult("", `unexpected claude command: ${args.join(" ")}`, 1),
      );
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-claude-marketplace-",
      });
      const claudeHome = path.join(workspace, "home");
      pluginInstallPath = path.join(workspace, "installed", "agent-sdk-dev");
      marketplacePath = path.join(workspace, "marketplace");
      yield* fileSystem.makeDirectory(path.join(pluginInstallPath, ".claude-plugin"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(path.join(marketplacePath, ".claude-plugin"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(pluginInstallPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ description: "Installed plugin description." }),
      );
      yield* fileSystem.writeFileString(
        path.join(marketplacePath, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [
            {
              name: "agent-sdk-dev",
              description: "Marketplace description.",
              category: "development",
              source: "./plugins/agent-sdk-dev",
            },
          ],
        }),
      );

      const result = yield* readProviderExtensionsInventory({
        request: {
          cwd: workspace,
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
      const plugin = result.providers[0]?.plugins[0];

      assert.equal(plugin?.description, "Installed plugin description.");
      assert.equal(plugin?.category, "development");
      assert.equal(plugin?.iconUrl, "https://github.com/anthropics.png?size=80");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, spawnerLayer)));
  });

  it("parses Claude plugin component inventory and projected token cost", () => {
    const details = parseClaudePluginDetails(`supabase 0.1.12
  Official Supabase plugin for Claude Code with bundled Supabase skills and MCP access for project management, database work, auth, storage, and Postgres best practices.
  Source: supabase@inline

Component inventory
  Skills (2)  supabase, supabase-postgres-best-practices
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~298 tok   added to every session

Per-component (rounded)
  component                         always-on  on-invoke
  supabase-postgres-best-practices        ~90       ~640
  supabase                               ~210      ~4.1k

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.`);

    assert.deepEqual(details, {
      name: "supabase",
      version: "0.1.12",
      description:
        "Official Supabase plugin for Claude Code with bundled Supabase skills and MCP access for project management, database work, auth, storage, and Postgres best practices.",
      components: [
        { kind: "skill", name: "supabase" },
        { kind: "skill", name: "supabase-postgres-best-practices" },
      ],
      tokenCost: {
        alwaysOnTokens: 298,
        components: [
          {
            name: "supabase-postgres-best-practices",
            alwaysOnTokens: 90,
            onInvokeTokens: 640,
          },
          {
            name: "supabase",
            alwaysOnTokens: 210,
            onInvokeTokens: 4100,
          },
        ],
      },
    });
  });

  it("degrades malformed Claude plugin details to empty enrichment", () => {
    assert.deepEqual(parseClaudePluginDetails("unexpected output without stable sections"), {
      components: [],
    });
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

  it("maps Claude MCP origins from plugin prefixes and plugin inventories", () => {
    const servers = parseClaudeMcpList(
      [
        "Checking MCP server health...",
        "plugin:supabase:supabase: https://mcp.supabase.com/mcp (HTTP) - ! Needs authentication",
        "figma: https://mcp.figma.com/mcp (HTTP) - Connected",
        "local-tools: npx local-tools (stdio) - Connected",
      ].join("\n"),
      [
        {
          plugin: {
            id: "supabase@openai-curated",
            name: "supabase",
            installed: true,
          },
          mcpServers: {},
        },
        {
          plugin: {
            id: "design@openai-curated",
            name: "design",
            installed: true,
          },
          mcpServers: { figma: { type: "http" } },
        },
      ],
    );

    // The CLI keys off the configured name, so collapsing it for display must not lose it:
    // `claude mcp login supabase` fails for a server configured as `plugin:supabase:supabase`.
    assert.deepEqual(
      servers.map((server) => ({ name: server.name, configuredName: server.configuredName })),
      [
        { name: "figma", configuredName: undefined },
        { name: "local-tools", configuredName: undefined },
        { name: "supabase", configuredName: "plugin:supabase:supabase" },
      ],
    );

    assert.deepEqual(
      servers.map((server) => ({ name: server.name, origin: server.origin })),
      [
        {
          name: "figma",
          origin: {
            kind: "plugin",
            pluginId: "design@openai-curated",
            pluginName: "design",
          },
        },
        { name: "local-tools", origin: { kind: "user" } },
        {
          name: "supabase",
          origin: {
            kind: "plugin",
            pluginId: "supabase@openai-curated",
            pluginName: "supabase",
          },
        },
      ],
    );
  });

  it("maps Codex MCP servers to the installed plugin that provides them", () => {
    const servers = mapCodexMcpServers(
      {
        data: [
          {
            name: "figma",
            authStatus: "oAuth",
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
          {
            name: "local-tools",
            authStatus: "unsupported",
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
        ],
      },
      [
        {
          pluginId: "design@openai-curated",
          pluginName: "Design",
          mcpServers: ["figma"],
        },
      ],
    );

    assert.deepEqual(
      servers.map((server) => ({ name: server.name, origin: server.origin })),
      [
        {
          name: "figma",
          origin: {
            kind: "plugin",
            pluginId: "design@openai-curated",
            pluginName: "Design",
          },
        },
        { name: "local-tools", origin: { kind: "user" } },
      ],
    );
  });

  it.effect("scans skills only for plugins a session would actually load", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const roots = claudePluginSkillRoots(path, [
        {
          id: "supabase@official",
          name: "supabase",
          installed: true,
          installPath: "/plugins/supabase",
        },
        {
          id: "off@official",
          name: "off",
          installed: true,
          enabled: false,
          installPath: "/plugins/off",
        },
        {
          id: "absent@official",
          name: "absent",
          installed: false,
          installPath: "/plugins/absent",
        },
        { id: "nopath@official", name: "nopath", installed: true },
      ]);

      assert.deepEqual(
        roots.map((root) => root.root),
        [path.join("/plugins/supabase", "skills")],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it.effect("refreshes Claude plugin marketplaces through the configured binary", () => {
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
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          marketplaceName: "team plugins",
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

      assert.equal(result.refreshed, true);
      assert.equal(result.output, "marketplace updated");
      assert.deepEqual(result.refreshedMarketplaces, ["team plugins"]);
      assert.deepEqual(result.errors, []);
      assert.equal(calls[0]?.command, "custom-claude");
      assert.deepEqual(calls[0]?.args, [
        "plugin",
        "marketplace",
        "update",
        process.platform === "win32" ? '"team plugins"' : "team plugins",
      ]);
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
