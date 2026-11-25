import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@threadlines/contracts";

import {
  ANTIGRAVITY_MARKETPLACES,
  annotateAntigravityPluginSkills,
  antigravityProfileConfigPath,
  antigravityProfileMcpCacheDir,
  antigravityProfileMcpConfigPath,
  antigravityProfileMcpRemoteAuthDir,
  antigravityProfilePluginsDir,
  clearAntigravityMcpRemoteCredentials,
  extractMcpRemoteAuthorizationUrl,
  hasAntigravityMcpRemoteTokens,
  installAntigravityPlugin,
  invalidateAntigravityPluginCatalogCache,
  listAntigravityMcpServers,
  listAntigravityPlugins,
  mcpRemoteServerUrlHash,
  parseJsoncObject,
  readAntigravityPluginDetail,
  removeAntigravityMcpServer,
  resolveAntigravityMcpOAuthTarget,
  saveAntigravityMcpServer,
  setAntigravityMcpServerEnabled,
  setAntigravityPluginEnabled,
  uninstallAntigravityPlugin,
} from "./AntigravityExtensions.ts";

async function withTempProfile(
  run: (ctx: { profileDir: string; tempRoot: string; root: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(join(tmpdir(), "tl-agy-ext-"));
  const profileDir = join(root, "profile");
  const tempRoot = join(root, "tmp");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  try {
    await run({ profileDir, tempRoot, root });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("AntigravityExtensions", () => {
  it("strips BOM, JSONC comments, and trailing commas without corrupting URLs", () => {
    const parsed = parseJsoncObject(`\uFEFF{
      // remote server
      "mcpServers": {
        "api": {
          "serverUrl": "https://example.com/mcp", /* inline comment */
        },
      },
    }`);
    assert.deepEqual(parsed, {
      mcpServers: {
        api: {
          serverUrl: "https://example.com/mcp",
        },
      },
    });
    assert.deepEqual(parseJsoncObject("   "), {});
  });

  it("saves, edits with secret preservation, toggles, and removes stdio, http, and oauth MCP servers per profile", async () => {
    await withTempProfile(async ({ profileDir }) => {
      const instanceId = ProviderInstanceId.make("antigravity");

      // 1. Add a Streamable HTTP server with secret header and timeoutSeconds
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "internal-api",
          mode: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer super-secret-token" },
          timeoutSeconds: 90,
        },
      });

      // 2. Add a Remote OAuth server (PostHog) via mcp-remote
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "posthog",
          mode: "oauth",
          url: "https://mcp.posthog.com/mcp",
        },
      });

      // 3. Add a local stdio server with env var
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "sqlite",
          mode: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sqlite", "/tmp/db.sqlite"],
          env: { DB_KEY: "secret-db-key" },
        },
      });

      // Write cached tool schema to verify tool discovery from `<profile>/antigravity-acp/mcp/<name>`
      const cacheDir = join(antigravityProfileMcpCacheDir(profileDir), "internal-api");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, "query.json"),
        JSON.stringify({ name: "query", description: "Run query", parameters: { type: "object" } }),
      );

      const initial = await listAntigravityMcpServers({
        profileDir,
        installedPlugins: [],
      });
      assert.equal(initial.errors.length, 0);
      assert.equal(initial.servers.length, 3);

      const api = initial.servers.find((s) => s.name === "internal-api")!;
      assert.equal(api.transport, "http");
      assert.equal(api.status, "Ready");
      assert.equal(api.authStatus, "Custom headers");
      assert.equal(api.toolCount, 1);
      assert.deepEqual(api.tools, ["query"]);
      assert.equal(api.canEdit, true);
      assert.equal(api.canToggle, true);
      assert.deepEqual(api.config?.headerKeys, ["Authorization"]);

      const posthog = initial.servers.find((s) => s.name === "posthog")!;
      assert.equal(posthog.transport, "oauth (mcp-remote)");
      assert.equal(posthog.status, "Needs auth");
      assert.equal(posthog.authStatus, "Not logged in");
      assert.equal(posthog.config?.mode, "oauth");
      assert.equal(posthog.config?.url, "https://mcp.posthog.com/mcp");

      // Simulate `mcp-remote` writing OAuth tokens inside the profile's auth dir
      const oauthTarget = await resolveAntigravityMcpOAuthTarget({
        profileDir,
        serverName: "posthog",
      });
      assert.equal(oauthTarget.url, "https://mcp.posthog.com/mcp");
      assert.equal(oauthTarget.authDir, antigravityProfileMcpRemoteAuthDir(profileDir));
      assert.equal(oauthTarget.urlHash, mcpRemoteServerUrlHash("https://mcp.posthog.com/mcp"));
      const tokenDir = join(oauthTarget.authDir, "mcp-remote-v1");
      await fs.mkdir(tokenDir, { recursive: true });
      await fs.writeFile(
        join(tokenDir, `${oauthTarget.urlHash}_tokens.json`),
        JSON.stringify({ access_token: "live-token" }),
      );
      assert.equal(await hasAntigravityMcpRemoteTokens(profileDir, oauthTarget.urlHash), true);

      const afterAuth = await listAntigravityMcpServers({ profileDir, installedPlugins: [] });
      assert.equal(afterAuth.servers.find((s) => s.name === "posthog")?.status, "Ready");
      assert.equal(afterAuth.servers.find((s) => s.name === "posthog")?.authStatus, "OAuth");

      // Adding a server with an existing name without previousName must fail instead of overwriting.
      let duplicateError: unknown;
      try {
        await saveAntigravityMcpServer({
          profileDir,
          request: {
            providerInstanceId: instanceId,
            name: "internal-api",
            mode: "http",
            url: "https://overwrite.example.com/mcp",
          },
        });
      } catch (error) {
        duplicateError = error;
      }
      assert.isTrue(duplicateError instanceof Error);
      assert.include((duplicateError as Error).message, "already exists");

      // Edit internal-api while keeping Authorization secret and timeoutSeconds without resending them
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "internal-api",
          previousName: "internal-api",
          mode: "http",
          url: "https://api-v2.example.com/mcp",
          keepHeaderKeys: ["Authorization"],
        },
      });
      const rawAfterEdit = JSON.parse(
        await fs.readFile(antigravityProfileMcpConfigPath(profileDir), "utf8"),
      ) as {
        mcpServers: Record<
          string,
          { serverUrl?: string; headers?: Record<string, string>; timeoutSeconds?: number }
        >;
      };
      assert.equal(
        rawAfterEdit.mcpServers["internal-api"]?.serverUrl,
        "https://api-v2.example.com/mcp",
      );
      assert.equal(
        rawAfterEdit.mcpServers["internal-api"]?.headers?.Authorization,
        "Bearer super-secret-token",
      );
      assert.equal(rawAfterEdit.mcpServers["internal-api"]?.timeoutSeconds, 90);

      // Disable sqlite
      const toggleRes = await setAntigravityMcpServerEnabled({
        profileDir,
        serverName: "sqlite",
        enabled: false,
      });
      assert.equal(toggleRes.effectiveEnabled, false);
      const afterDisable = await listAntigravityMcpServers({ profileDir, installedPlugins: [] });
      assert.equal(afterDisable.servers.find((s) => s.name === "sqlite")?.enabled, false);
      assert.equal(afterDisable.servers.find((s) => s.name === "sqlite")?.status, "Disabled");

      // Remove posthog and verify its mcp-remote tokens are cleared too
      await removeAntigravityMcpServer({ profileDir, serverName: "posthog" });
      assert.equal(await hasAntigravityMcpRemoteTokens(profileDir, oauthTarget.urlHash), false);
      await clearAntigravityMcpRemoteCredentials(profileDir, oauthTarget.urlHash);
      const afterRemove = await listAntigravityMcpServers({ profileDir, installedPlugins: [] });
      assert.equal(
        afterRemove.servers.find((s) => s.name === "posthog"),
        undefined,
      );
    });
  });

  it("extracts authorization URLs from mcp-remote output", () => {
    const url = extractMcpRemoteAuthorizationUrl(
      "[1234] Please authorize this client by visiting: https://app.posthog.com/oauth/authorize?client_id=abc&state=xyz\n",
    );
    assert.equal(url, "https://app.posthog.com/oauth/authorize?client_id=abc&state=xyz");
  });

  it("lists, inspects, toggles, installs from verified catalog archive, and uninstalls plugins", async () => {
    await withTempProfile(async ({ profileDir, tempRoot, root }) => {
      invalidateAntigravityPluginCatalogCache();

      // Build a real zip archive for a catalog plugin using python3 or zip if available.
      const srcDir = join(root, "pkg-src");
      await fs.mkdir(join(srcDir, "skills", "hello-skill"), { recursive: true });
      await fs.mkdir(join(srcDir, "rules"), { recursive: true });
      await fs.writeFile(
        join(srcDir, "plugin.json"),
        JSON.stringify({
          name: "demo-kit",
          displayName: "Demo Kit",
          version: "1.2.0",
          description: "Bundled test kit",
          author: { name: "Test Org" },
        }),
      );
      await fs.writeFile(
        join(srcDir, "skills", "hello-skill", "SKILL.md"),
        "---\nname: hello-skill\ndescription: Greets the user\n---\nHello\n",
      );
      await fs.writeFile(
        join(srcDir, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            docs: { serverUrl: "https://docs.example.com/mcp" },
          },
        }),
      );
      await fs.writeFile(join(srcDir, "rules", "AGENTS.md"), "# Rule\n");

      const zipPath = join(root, "demo-kit.zip");
      execFileSync("python3", [
        "-c",
        `import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w") as zf:
  for r, _, files in os.walk(src):
    for f in files:
      full = os.path.join(r, f)
      zf.write(full, os.path.relpath(full, src))`,
        srcDir,
        zipPath,
      ]);
      const zipBytes = await fs.readFile(zipPath);
      const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");
      const archiveUrl = "https://www.gstatic.com/antigravity/plugins/demo-kit/demo-kit.zip";

      const mockFetch = async (input: string | URL | Request) => {
        const url = String(input);
        if (url === ANTIGRAVITY_MARKETPLACES[0]!.url) {
          return new Response(
            JSON.stringify({
              name: "antigravity-plugins-official",
              plugins: [
                {
                  name: "demo-kit",
                  displayName: "Demo Kit",
                  version: "1.2.0",
                  description: "Bundled test kit",
                  author: { name: "Test Org" },
                  source: { type: "archive", url: archiveUrl, sha256: zipSha256 },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === ANTIGRAVITY_MARKETPLACES[1]!.url) {
          return new Response(
            JSON.stringify({ name: "antigravity-plugins-partners", plugins: [] }),
            {
              status: 200,
            },
          );
        }
        if (url === archiveUrl) {
          return new Response(new Uint8Array(zipBytes), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      };

      // Catalog listing before install shows demo-kit as uninstalled
      const before = await listAntigravityPlugins({
        profileDir,
        includeCatalog: true,
        fetch: mockFetch,
      });
      assert.equal(before.pluginCatalogStatus, "ready");
      assert.equal(before.plugins.length, 1);
      assert.equal(before.plugins[0]?.installed, false);
      assert.equal(before.plugins[0]?.marketplaceName, "antigravity-plugins-official");

      // Install from verified catalog archive
      const installed = await installAntigravityPlugin({
        profileDir,
        tempRoot,
        env: process.env,
        pluginName: "demo-kit",
        remoteMarketplaceName: "antigravity-plugins-official",
        fetch: mockFetch,
      });
      assert.equal(installed.pluginName, "demo-kit");

      // Inventory now shows installed plugin + components + plugin-contributed MCP server + linked skill
      const after = await listAntigravityPlugins({
        profileDir,
        includeCatalog: false,
      });
      assert.equal(after.plugins.length, 1);
      assert.equal(after.plugins[0]?.installed, true);
      assert.equal(after.plugins[0]?.enabled, true);
      assert.equal(
        after.plugins[0]?.installPath,
        join(antigravityProfilePluginsDir(profileDir), "demo-kit"),
      );

      const detail = await readAntigravityPluginDetail({
        profileDir,
        pluginName: "demo-kit",
      });
      assert.deepEqual(
        detail.components.map((c) => `${c.kind}:${c.name}`),
        ["skill:hello-skill", "mcpServer:docs", "rule:AGENTS"],
      );

      const mcpList = await listAntigravityMcpServers({
        profileDir,
        installedPlugins: after.installedRecords,
      });
      assert.equal(mcpList.servers.length, 1);
      assert.equal(mcpList.servers[0]?.name, "docs");
      assert.equal(mcpList.servers[0]?.configuredName, "demo-kit_docs");
      assert.equal(mcpList.servers[0]?.origin?.kind, "plugin");
      assert.equal(mcpList.servers[0]?.origin?.pluginId, "demo-kit");

      const skillPath = join(
        antigravityProfilePluginsDir(profileDir),
        "demo-kit",
        "skills",
        "hello-skill",
        "SKILL.md",
      );
      const annotated = annotateAntigravityPluginSkills(
        [{ name: "hello-skill", path: skillPath, enabled: true, scope: "user" }],
        after.installedRecords,
      );
      assert.equal(annotated[0]?.bundleId, "demo-kit");

      // Disable plugin -> config.json records disabled & hides its MCP server from active Connections
      await setAntigravityPluginEnabled({ profileDir, pluginId: "demo-kit", enabled: false });
      const configRaw = JSON.parse(
        await fs.readFile(antigravityProfileConfigPath(profileDir), "utf8"),
      ) as {
        plugins: Record<string, { enabled: boolean }>;
      };
      assert.equal(configRaw.plugins["demo-kit"]?.enabled, false);
      const afterDisable = await listAntigravityPlugins({ profileDir, includeCatalog: false });
      assert.equal(afterDisable.plugins[0]?.enabled, false);
      const mcpAfterDisable = await listAntigravityMcpServers({
        profileDir,
        installedPlugins: afterDisable.installedRecords,
      });
      assert.equal(mcpAfterDisable.servers.length, 0);

      // Uninstall plugin
      await uninstallAntigravityPlugin({ profileDir, pluginId: "demo-kit" });
      const afterUninstall = await listAntigravityPlugins({ profileDir, includeCatalog: false });
      assert.equal(afterUninstall.plugins.length, 0);
    });
  });

  it("enforces profile isolation, redacts OAuth header secrets, tracks shared token hashes, and confines workspace reads", async () => {
    await withTempProfile(async ({ profileDir, root }) => {
      const instanceId = ProviderInstanceId.make("antigravity");
      const profileB = join(root, "profile-b");
      await fs.mkdir(join(profileB, "config", "plugins", "victim-plugin"), { recursive: true });
      await fs.writeFile(
        join(profileB, "config", "plugins", "victim-plugin", "plugin.json"),
        JSON.stringify({ name: "victim-plugin" }),
      );

      // 1. Symlinked config/plugins must NEVER allow uninstall to delete into profileB.
      await fs.mkdir(join(profileDir, "config"), { recursive: true });
      await fs.symlink(
        join(profileB, "config", "plugins"),
        antigravityProfilePluginsDir(profileDir),
      );
      let uninstallErr: unknown;
      try {
        await uninstallAntigravityPlugin({ profileDir, pluginId: "victim-plugin" });
      } catch (error) {
        uninstallErr = error;
      }
      assert.isTrue(uninstallErr instanceof Error);
      const victimStillExists = await fs
        .stat(join(profileB, "config", "plugins", "victim-plugin", "plugin.json"))
        .then(() => true)
        .catch(() => false);
      assert.isTrue(victimStillExists);
      await fs.unlink(antigravityProfilePluginsDir(profileDir));

      // 2. Copied MCP entry pointing MCP_REMOTE_CONFIG_DIR at profileB must NOT touch profileB tokens.
      const url = "https://mcp.posthog.com/mcp";
      const hash = mcpRemoteServerUrlHash(url);
      const profileBTokenDir = join(antigravityProfileMcpRemoteAuthDir(profileB), "mcp-remote-v1");
      await fs.mkdir(profileBTokenDir, { recursive: true });
      const profileBTokenFile = join(profileBTokenDir, `${hash}_tokens.json`);
      await fs.writeFile(profileBTokenFile, JSON.stringify({ access_token: "profile-b-token" }));

      await fs.writeFile(
        antigravityProfileMcpConfigPath(profileDir),
        JSON.stringify({
          mcpServers: {
            copied: {
              command: "npx",
              args: ["-y", "mcp-remote", url],
              env: { MCP_REMOTE_CONFIG_DIR: antigravityProfileMcpRemoteAuthDir(profileB) },
            },
          },
        }),
      );
      // Profile A must not see profile B's tokens as logged in, and removing must leave profile B intact.
      const listBeforeRemove = await listAntigravityMcpServers({
        profileDir,
        installedPlugins: [],
      });
      assert.equal(listBeforeRemove.servers[0]?.status, "Needs auth");
      await removeAntigravityMcpServer({ profileDir, serverName: "copied" });
      assert.isTrue(
        await fs
          .stat(profileBTokenFile)
          .then(() => true)
          .catch(() => false),
      );

      // 3. Redact secret headers in OAuth terminalCommand while keeping real args server-side.
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "secret-oauth",
          mode: "oauth",
          url: "https://mcp.vercel.com",
          headers: { Authorization: "Bearer super-secret-oauth-value" },
        },
      });
      const oauthTarget = await resolveAntigravityMcpOAuthTarget({
        profileDir,
        serverName: "secret-oauth",
      });
      assert.isFalse(oauthTarget.terminalCommand.includes("super-secret-oauth-value"));
      assert.include(oauthTarget.terminalCommand, "Authorization: <redacted>");
      assert.isTrue(oauthTarget.args.some((arg) => arg.includes("super-secret-oauth-value")));

      // 4. Shared OAuth token hash: removing one of two entries keeps tokens; editing URL retires old hash.
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "ph-one",
          mode: "oauth",
          url,
        },
      });
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "ph-two",
          mode: "oauth",
          url,
        },
      });
      const profileATokenDir = join(
        antigravityProfileMcpRemoteAuthDir(profileDir),
        "mcp-remote-v1",
      );
      await fs.mkdir(profileATokenDir, { recursive: true });
      await fs.writeFile(
        join(profileATokenDir, `${hash}_tokens.json`),
        JSON.stringify({ access_token: "shared-token" }),
      );
      await removeAntigravityMcpServer({ profileDir, serverName: "ph-one" });
      assert.equal(await hasAntigravityMcpRemoteTokens(profileDir, hash), true);
      // Editing ph-two's URL retires the old hash since no remaining server uses it.
      await saveAntigravityMcpServer({
        profileDir,
        request: {
          providerInstanceId: instanceId,
          name: "ph-two",
          previousName: "ph-two",
          mode: "oauth",
          url: "https://mcp-eu.posthog.com/mcp",
        },
      });
      assert.equal(await hasAntigravityMcpRemoteTokens(profileDir, hash), false);

      // 5. Upstream mcp-remote hash parity for --resource and ${ENV_VAR} expansion in --header.
      const resourceHash = mcpRemoteServerUrlHash(
        "https://api.example.com/mcp",
        { Authorization: "Bearer expanded-42" },
        { authorizeResource: "https://api.example.com" },
      );
      await fs.writeFile(
        antigravityProfileMcpConfigPath(profileDir),
        JSON.stringify({
          mcpServers: {
            resourced: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                "https://api.example.com/mcp",
                "--resource",
                "https://api.example.com",
                "--header",
                "Authorization: Bearer ${MY_API_TOK}",
              ],
              env: { MY_API_TOK: "expanded-42" },
            },
          },
        }),
      );
      const resourcedTarget = await resolveAntigravityMcpOAuthTarget({
        profileDir,
        serverName: "resourced",
      });
      assert.equal(resourcedTarget.urlHash, resourceHash);

      // 6. Workspace path traversal / symlink escapes are blocked for tool cache and plugin components.
      const outsideDir = join(root, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(
        join(outsideDir, "secret-tool.json"),
        JSON.stringify({ name: "leaked-tool", description: "Should never be read" }),
      );
      await fs.writeFile(
        join(outsideDir, "secret-agent.md"),
        "---\nname: leaked-agent\ndescription: Outside\n---\n",
      );
      await fs.writeFile(join(outsideDir, "plugin.json"), JSON.stringify({ name: "leaked" }));

      const projectDir = join(root, "repo");
      await fs.mkdir(join(projectDir, ".agents", "plugins", "escape-manifest"), {
        recursive: true,
      });
      await fs.symlink(
        join(outsideDir, "plugin.json"),
        join(projectDir, ".agents", "plugins", "escape-manifest", "plugin.json"),
      );
      await fs.mkdir(join(projectDir, ".agents", "plugins", "escape-agents"), { recursive: true });
      await fs.writeFile(
        join(projectDir, ".agents", "plugins", "escape-agents", "plugin.json"),
        JSON.stringify({ name: "escape-agents" }),
      );
      await fs.symlink(
        outsideDir,
        join(projectDir, ".agents", "plugins", "escape-agents", "agents"),
      );
      await fs.writeFile(
        join(projectDir, ".agents", "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            "../../outside": { serverUrl: "https://example.com/mcp" },
          },
        }),
      );

      const realProject = await fs.realpath(projectDir);
      const workspacePlugins = await listAntigravityPlugins({
        profileDir,
        projectCwd: projectDir,
        projectBoundary: realProject,
        includeCatalog: false,
      });
      // escape-manifest is skipped completely; escape-agents loads without reading symlinked outside agents.
      assert.equal(
        workspacePlugins.installedRecords.find((r) => r.dirName === "escape-manifest"),
        undefined,
      );
      const escapeAgents = workspacePlugins.installedRecords.find(
        (r) => r.dirName === "escape-agents",
      );
      assert.isDefined(escapeAgents);
      assert.equal(escapeAgents!.components.length, 0);

      const workspaceMcp = await listAntigravityMcpServers({
        profileDir,
        projectCwd: projectDir,
        projectBoundary: realProject,
        installedPlugins: [],
      });
      const traversalServer = workspaceMcp.servers.find((s) => s.name === "../../outside");
      assert.equal(traversalServer?.toolCount, 0);
    });
  });
});
