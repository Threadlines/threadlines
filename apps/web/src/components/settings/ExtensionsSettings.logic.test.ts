import { describe, expect, it } from "vite-plus/test";

import {
  buildExtensionJsonSchemaFormArguments,
  createExtensionInventoryMemoryCache,
  deriveDetectedProviderThreadId,
  deriveExtensionJsonSchemaFormFields,
  deriveExtensionPluginGroupLabel,
  deriveExtensionSkillBundleKey,
  deriveExtensionSkillBundleLabel,
  extensionMcpNeedsAuthStatus,
  extensionMcpOAuthActionIntent,
  extensionMcpOAuthActionLabel,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  formatExtensionGroupLabel,
  isLikelyLocalPath,
  makeExtensionInventoryCacheKey,
  formatSkillDisplayName,
  formatTokenCount,
  groupPluginComponents,
  makeExtensionJsonSchemaFormDefaults,
  resolvePluginComponentTarget,
  selectCuratedPlugins,
  shouldCuratePluginBrowse,
  shouldRenderExtensionBrowserGroups,
  summarizePluginDetail,
} from "./ExtensionsSettings.logic";

describe("ExtensionsSettings logic", () => {
  it("matches extension records case-insensitively across provided fields", () => {
    expect(extensionTextMatchesFilter(["Browser", "Control the in-app browser"], "BROW")).toBe(
      true,
    );
    expect(extensionTextMatchesFilter(["GitHub", "Triages PRs"], "browser")).toBe(false);
  });

  it("treats empty filters as a match", () => {
    expect(extensionTextMatchesFilter([], "   ")).toBe(true);
  });

  it("groups plugin components by kind in display order with counted labels", () => {
    const groups = groupPluginComponents([
      { kind: "mcpServer", name: "supabase", detail: "http" },
      { kind: "skill", name: "supabase-postgres-best-practices" },
      { kind: "hook", name: "pre-commit", detail: "preToolUse" },
      { kind: "skill", name: "supabase" },
    ]);

    expect(groups.map((group) => [group.label, group.components.length])).toEqual([
      ["Skills", 2],
      ["MCP server", 1],
      ["Hook", 1],
    ]);
    expect(groups[0]?.components.map((component) => component.name)).toEqual([
      "supabase-postgres-best-practices",
      "supabase",
    ]);
  });

  it("curates an unsearched plugin catalog and steps aside once you search", () => {
    expect(shouldCuratePluginBrowse(2227, "  ")).toBe(true);
    expect(shouldCuratePluginBrowse(2227, "supa")).toBe(false);
    expect(shouldCuratePluginBrowse(12, "")).toBe(false);

    const catalog = [
      { name: "unpopular", installCount: 3 },
      { name: "already-installed", installed: true, installCount: 100_000 },
      { name: "popular", installCount: 9000 },
      { name: "featured", featured: true },
      { name: "middling", installCount: 400 },
    ];

    // Installed plugins are listed on the page already, so the discovery view leaves them out.
    expect(selectCuratedPlugins(catalog, (entry) => entry).map((entry) => entry.name)).toEqual([
      "featured",
      "popular",
      "middling",
      "unpopular",
    ]);

    // A catalog with nothing left to discover still shows something rather than going blank.
    expect(
      selectCuratedPlugins([{ name: "only", installed: true }], (entry) => entry).map(
        (entry) => entry.name,
      ),
    ).toEqual(["only"]);
  });

  it("drops a plugin prefix from a bundled skill name without mangling others", () => {
    expect(formatSkillDisplayName("chrome:control-chrome", "chrome")).toBe("control-chrome");
    expect(formatSkillDisplayName("computer-use:computer-use", "computer-use")).toBe(
      "computer-use",
    );
    expect(formatSkillDisplayName("supabase", "supabase")).toBe("supabase");
    expect(formatSkillDisplayName("a:b", "other")).toBe("a:b");
    expect(formatSkillDisplayName("chrome:", "chrome")).toBe("chrome:");
    expect(formatSkillDisplayName("review:pr", undefined)).toBe("review:pr");
  });

  it("formats token counts compactly across magnitudes", () => {
    expect(formatTokenCount(298)).toBe("298");
    expect(formatTokenCount(4100)).toBe("4.1k");
    expect(formatTokenCount(2000)).toBe("2k");
    expect(formatTokenCount(1_200_000)).toBe("1.2m");
  });

  it("resolves plugin components to inventory entries by path, name, and server suffix", () => {
    const provider = {
      skills: [
        { name: "supabase", path: "/plugins/supabase/skills/supabase/SKILL.md" },
        { name: "renamed-on-disk", path: "/plugins/supabase/skills/postgres/SKILL.md" },
      ],
      mcpServers: [{ name: "plugin:supabase:supabase" }],
      apps: [{ id: "app-1", name: "Notion" }],
    };

    expect(
      resolvePluginComponentTarget(
        { kind: "skill", name: "postgres", path: "/plugins/supabase/skills/postgres/SKILL.md" },
        provider,
      ),
    ).toEqual({ kind: "skill", skill: provider.skills[1] });

    expect(resolvePluginComponentTarget({ kind: "skill", name: "Supabase" }, provider)).toEqual({
      kind: "skill",
      skill: provider.skills[0],
    });

    expect(resolvePluginComponentTarget({ kind: "mcpServer", name: "supabase" }, provider)).toEqual(
      {
        kind: "mcp",
        server: provider.mcpServers[0],
      },
    );

    expect(resolvePluginComponentTarget({ kind: "hook", name: "pre-commit" }, provider)).toBeNull();
    expect(resolvePluginComponentTarget({ kind: "skill", name: "absent" }, provider)).toBeNull();
  });

  it("summarizes a plugin detail as readable text rather than JSON", () => {
    expect(
      summarizePluginDetail({
        pluginId: "supabase@claude-plugins-official",
        name: "supabase",
        version: "0.1.12",
        description: "Official Supabase plugin.",
        components: [
          { kind: "skill", name: "supabase" },
          { kind: "mcpServer", name: "supabase", detail: "http" },
        ],
        tokenCost: { alwaysOnTokens: 298, components: [] },
      }),
    ).toBe(
      [
        "supabase 0.1.12",
        "Official Supabase plugin.",
        "Skill (1): supabase",
        "MCP server (1): supabase",
        "Always-on cost: ~298 tok per session",
      ].join("\n"),
    );
  });

  it("detects local file paths without treating URLs as paths", () => {
    expect(isLikelyLocalPath("C:\\Users\\wilfr\\.codex\\skills\\foo\\SKILL.md")).toBe(true);
    expect(isLikelyLocalPath("/Users/wilfr/.codex/skills/foo/SKILL.md")).toBe(true);
    expect(isLikelyLocalPath("https://example.com/plugin")).toBe(false);
  });

  it("sorts Codex providers before Claude providers", () => {
    const providers = ["claudeAgent", "codex", "other"].toSorted(
      (left, right) =>
        extensionProviderDriverSortRank(left) - extensionProviderDriverSortRank(right),
    );

    expect(providers).toEqual(["codex", "claudeAgent", "other"]);
  });

  it("derives plugin browser groups from stable metadata instead of descriptions", () => {
    const longMarketplaceDescription =
      "Automate API security directly in Claude Code with 42Crunch";

    expect(formatExtensionGroupLabel("project-local")).toBe("Project Local");
    expect(
      deriveExtensionPluginGroupLabel({
        scope: "user",
        isOfficial: true,
        isLocal: true,
      }),
    ).toBe("User");
    expect(
      deriveExtensionPluginGroupLabel({
        isOfficial: true,
        isLocal: false,
        availability: longMarketplaceDescription,
      }),
    ).toBe("Official catalog");
    expect(
      deriveExtensionPluginGroupLabel({
        marketplaceName: "team-marketplace",
        isOfficial: false,
        isLocal: false,
      }),
    ).toBe("Team Marketplace");
  });

  it("renders browser group headers only when grouping is meaningfully dense", () => {
    expect(
      shouldRenderExtensionBrowserGroups(
        [{ items: ["a"] }, { items: ["b"] }, { items: ["c"] }, { items: ["d"] }],
        "category",
      ),
    ).toBe(false);
    expect(
      shouldRenderExtensionBrowserGroups(
        [{ items: ["user-plugin"] }, { items: ["official-a", "official-b", "official-c"] }],
        "category",
      ),
    ).toBe(true);
    expect(
      shouldRenderExtensionBrowserGroups([{ items: ["official-a", "official-b"] }], "category"),
    ).toBe(false);
    expect(
      shouldRenderExtensionBrowserGroups(
        [{ items: ["user-plugin"] }, { items: ["official-a", "official-b", "official-c"] }],
        "recommended",
      ),
    ).toBe(false);
    // Ranked orders stay flat: grouping them would scatter the ranking across headings.
    expect(
      shouldRenderExtensionBrowserGroups(
        [{ items: ["user-plugin"] }, { items: ["official-a", "official-b", "official-c"] }],
        "popular",
      ),
    ).toBe(false);
  });

  it("derives stable skill bundle labels and keys", () => {
    expect(
      deriveExtensionSkillBundleLabel({
        bundleId: "cloudflare@openai-curated",
        bundleName: "cloudflare",
      }),
    ).toBe("Cloudflare (openai-curated)");
    expect(
      deriveExtensionSkillBundleLabel({
        bundleId: "vercel@openai-curated",
        bundleDisplayName: "Vercel",
      }),
    ).toBe("Vercel (openai-curated)");
    expect(deriveExtensionSkillBundleLabel({ scope: "user" })).toBe("User");
    expect(
      deriveExtensionSkillBundleKey({
        bundleId: "Cloudflare@OpenAI-Curated",
        scope: "user",
      }),
    ).toBe("bundle:cloudflare@openai-curated");
  });

  it("builds stable extension inventory cache keys from project, provider, and context", () => {
    expect(
      makeExtensionInventoryCacheKey({
        cwd: "C:\\Repo\\BadCode",
        providerInstanceId: "codex",
        providerThreadId: "thread-1",
      }),
    ).toBe(
      makeExtensionInventoryCacheKey({
        cwd: "c:/repo/badcode",
        providerInstanceId: "codex",
        providerThreadId: "thread-1",
      }),
    );

    expect(
      makeExtensionInventoryCacheKey({
        cwd: "/Users/demo/project",
        providerInstanceId: "",
      }),
    ).toBeNull();
  });

  it("keeps extension inventory cache entries fresh by ttl", () => {
    let nowMs = 1_000;
    const cache = createExtensionInventoryMemoryCache<string>({
      maxEntries: 2,
      ttlMs: 500,
      nowMs: () => nowMs,
    });

    cache.set("codex", "inventory", 10);
    expect(cache.get("codex")?.value).toBe("inventory");

    nowMs = 1_501;
    expect(cache.get("codex")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("evicts least recently used extension inventory cache entries", () => {
    let nowMs = 1_000;
    const cache = createExtensionInventoryMemoryCache<string>({
      maxEntries: 2,
      ttlMs: 10_000,
      nowMs: () => nowMs,
    });

    cache.set("first", "one", 1);
    nowMs += 1;
    cache.set("second", "two", 2);
    expect(cache.get("first")?.value).toBe("one");
    nowMs += 1;
    cache.set("third", "three", 3);

    expect(cache.get("first")?.value).toBe("one");
    expect(cache.get("second")).toBeNull();
    expect(cache.get("third")?.value).toBe("three");
  });

  it("treats OAuth as an auth mechanism instead of a missing-auth state", () => {
    const readyOAuthServer = {
      authStatus: "OAuth",
      status: "Ready",
    };

    expect(extensionMcpNeedsAuthStatus(readyOAuthServer)).toBe(false);
    expect(extensionMcpOAuthActionIntent(readyOAuthServer)).toBe("reauth");
    expect(extensionMcpOAuthActionLabel(extensionMcpOAuthActionIntent(readyOAuthServer))).toBe(
      "Re-auth",
    );
  });

  it("marks missing or expired MCP auth as an authorize action", () => {
    for (const server of [
      { authStatus: "Not logged in", status: "Needs auth" },
      { authStatus: "Not authenticated", status: "Failed" },
      { authStatus: "OAuth", detail: "Token expired" },
    ]) {
      expect(extensionMcpNeedsAuthStatus(server)).toBe(true);
      expect(extensionMcpOAuthActionIntent(server)).toBe("authorize");
      expect(extensionMcpOAuthActionLabel(extensionMcpOAuthActionIntent(server))).toBe("Authorize");
    }
  });

  it("hides OAuth actions for MCP servers that do not support OAuth login", () => {
    expect(
      extensionMcpOAuthActionIntent({
        authStatus: "No auth required",
        status: "Ready",
      }),
    ).toBeNull();
    expect(
      extensionMcpOAuthActionIntent({
        authStatus: "Bearer token",
        status: "Ready",
      }),
    ).toBeNull();
  });

  it("detects the most recently visited matching provider thread", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "c:/repo/badcode",
          },
        ],
        threads: [
          {
            key: "local:thread-old",
            environmentId: "local",
            id: "thread-old",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "codex-thread-old",
            updatedAt: "2026-05-30T10:00:00.000Z",
          },
          {
            key: "local:thread-new",
            environmentId: "local",
            id: "thread-new",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "codex-thread-new",
            updatedAt: "2026-05-30T09:00:00.000Z",
          },
        ],
        threadLastVisitedAtById: {
          "local:thread-new": "2026-05-30T11:00:00.000Z",
        },
      }),
    ).toBe("codex-thread-new");
  });

  it("prefers exact provider instance matches over legacy unscoped thread sessions", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex-personal",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "C:\\Repo\\BadCode",
          },
        ],
        threads: [
          {
            key: "local:thread-legacy",
            environmentId: "local",
            id: "thread-legacy",
            projectId: "project-a",
            provider: "codex",
            providerThreadId: "legacy-thread",
            updatedAt: "2026-05-30T12:00:00.000Z",
          },
          {
            key: "local:thread-exact",
            environmentId: "local",
            id: "thread-exact",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex-personal",
            providerThreadId: "exact-thread",
            updatedAt: "2026-05-30T10:00:00.000Z",
          },
        ],
        threadLastVisitedAtById: {},
      }),
    ).toBe("exact-thread");
  });

  it("ignores mismatched projects and providers", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "C:\\Repo\\BadCode",
          },
        ],
        threads: [
          {
            key: "local:thread-other-project",
            environmentId: "local",
            id: "thread-other-project",
            projectId: "project-b",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "other-project-thread",
          },
          {
            key: "local:thread-other-provider",
            environmentId: "local",
            id: "thread-other-provider",
            projectId: "project-a",
            provider: "claudeAgent",
            providerInstanceId: "claude",
            providerThreadId: "other-provider-thread",
          },
        ],
        threadLastVisitedAtById: {},
      }),
    ).toBe("");
  });

  it("derives a compact form from simple JSON object schemas", () => {
    const fields = deriveExtensionJsonSchemaFormFields({
      type: "object",
      required: ["projectId", "dryRun"],
      properties: {
        projectId: {
          type: "string",
          description: "Supabase project ref",
        },
        limit: {
          type: "integer",
          default: 25,
        },
        dryRun: {
          type: "boolean",
          default: true,
        },
        filter: {
          type: "object",
          default: { schema: "public" },
        },
      },
    });

    expect(fields?.map((field) => [field.name, field.type, field.required])).toEqual([
      ["projectId", "string", true],
      ["limit", "number", false],
      ["dryRun", "boolean", true],
      ["filter", "json", false],
    ]);
    expect(makeExtensionJsonSchemaFormDefaults(fields ?? [])).toEqual({
      projectId: "",
      limit: "25",
      dryRun: true,
      filter: '{\n  "schema": "public"\n}',
    });
  });

  it("builds MCP tool arguments from schema form values", () => {
    const fields = deriveExtensionJsonSchemaFormFields({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
        options: { type: "object" },
      },
    });

    expect(
      buildExtensionJsonSchemaFormArguments(fields ?? [], {
        name: "demo",
        count: "2",
        enabled: false,
        options: '{"safe":true}',
      }),
    ).toEqual({
      name: "demo",
      count: 2,
      enabled: false,
      options: { safe: true },
    });
  });

  it("falls back to raw JSON for schemas that are too large for the inline form", () => {
    expect(
      deriveExtensionJsonSchemaFormFields({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 25 }, (_, index) => [`field${index}`, { type: "string" }]),
        ),
      }),
    ).toBeNull();
  });
});
