// @effect-diagnostics nodeBuiltinImport:off - reads and writes profile-local Antigravity plugin and MCP configs
/**
 * AntigravityExtensions — per-profile Plugins and MCP Connections management
 * for Antigravity instances inside Threadlines.
 *
 * Each Antigravity instance owns its own `profileDir` (`GEMINI_HOME` /
 * `--gemini-dir`), so global MCP servers (`<profileDir>/config/mcp_config.json`),
 * global plugins (`<profileDir>/config/plugins/`), plugin enablement
 * (`<profileDir>/config/config.json`), and `mcp-remote` OAuth tokens
 * (`<profileDir>/mcp-remote-auth/`) stay isolated per account and never touch
 * the user's standalone `~/.gemini/config`.
 *
 * Project-scoped `.agents/mcp_config.json`, `.agents/plugins/`, and
 * `.agents/plugins.json` are read-only and strictly confined to the canonical
 * repository boundary.
 *
 * @module provider/antigravity/AntigravityExtensions
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ProviderExtensionMarketplace,
  ProviderExtensionMcpServer,
  ProviderExtensionMcpServerAuthProviderType,
  ProviderExtensionMcpServerConfigSummary,
  ProviderExtensionMcpServerSaveInput,
  ProviderExtensionMcpServerSaveResult,
  ProviderExtensionMcpTool,
  ProviderExtensionPlugin,
  ProviderExtensionPluginComponent,
  ProviderExtensionPluginDetail,
  ProviderExtensionSkill,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import { ArchiveError, extractArchive } from "../managedRuntime/ArchiveExtractor.ts";
import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import { readRegularFile } from "./AntigravityFileReads.ts";
import { antigravityAgentDir } from "./AntigravityProfile.ts";
import { antigravityAssetKey } from "./AntigravityRelease.ts";

export interface AntigravityMarketplaceSpec {
  readonly name: string;
  readonly displayName: string;
  readonly url: string;
}

export const ANTIGRAVITY_CATALOG_HOST = "www.gstatic.com";

export const ANTIGRAVITY_MARKETPLACES: ReadonlyArray<AntigravityMarketplaceSpec> = [
  {
    name: "antigravity-plugins-official",
    displayName: "Antigravity Official",
    url: `https://${ANTIGRAVITY_CATALOG_HOST}/antigravity/plugins/marketplace.json`,
  },
  {
    name: "antigravity-plugins-partners",
    displayName: "Antigravity Partners",
    url: `https://${ANTIGRAVITY_CATALOG_HOST}/antigravity/plugins-partners/marketplace.json`,
  },
] as const;

const FEATURED_ANTIGRAVITY_PLUGINS = new Set([
  "firebase",
  "notion",
  "context7",
  "linear",
  "dynatrace",
  "stripe",
  "egm",
  "data-agent-kit-plugin",
  "chrome-devtools-plugin",
  "gemini-api",
]);

const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_PLUGIN_EXTRACTED_ENTRIES = 5_000;
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_CACHE_FILES = 200;
const MAX_TOOL_CACHE_FILE_BYTES = 64 * 1024;
const CLI_INSTALL_TIMEOUT_MS = 120_000;

const SAFE_ENTRY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  "plugin.json",
  ".antigravity-plugin/plugin.json",
  ".gemini-plugin/plugin.json",
] as const;
const PLUGIN_LOGO_CANDIDATES = [
  "assets/logo.svg",
  "assets/logo.png",
  "assets/icon.svg",
  "assets/icon.png",
] as const;

export const antigravityProfileMcpConfigPath = (profileDir: string) =>
  join(profileDir, "config", "mcp_config.json");

export const antigravityProfileConfigPath = (profileDir: string) =>
  join(profileDir, "config", "config.json");

export const antigravityProfilePluginsDir = (profileDir: string) =>
  join(profileDir, "config", "plugins");

export const antigravityProfilePluginsManifestPath = (profileDir: string) =>
  join(profileDir, "config", "plugins.json");

export const antigravityProfileImportManifestPath = (profileDir: string) =>
  join(profileDir, "config", "import_manifest.json");

export const antigravityProfileMcpRemoteAuthDir = (profileDir: string) =>
  join(profileDir, "mcp-remote-auth");

export const antigravityProfileMcpCacheDir = (profileDir: string) =>
  join(antigravityAgentDir(profileDir), "mcp");

export type AntigravityExtensionsFetch = DownloadFetch;

const defaultCatalogFetch: AntigravityExtensionsFetch = makeHttpsFetch({
  publicAddressesOnly: true,
  allowedHosts: [ANTIGRAVITY_CATALOG_HOST],
});

/** Per-profile mutation lock so concurrent saves, toggles, and installs never race. */
const profileWriteQueue = new Map<string, Promise<unknown>>();

function enqueueProfileWrite<T>(profileDir: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(profileDir);
  const previous = profileWriteQueue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const settled = next.catch(() => undefined);
  profileWriteQueue.set(key, settled);
  void settled.then(() => {
    if (profileWriteQueue.get(key) === settled) profileWriteQueue.delete(key);
  });
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizedPathKey(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function isSafeAntigravityEntryName(name: string): boolean {
  return SAFE_ENTRY_NAME_PATTERN.test(name);
}

function normalizePluginDirName(rawId: string): string {
  const trimmed = rawId.trim();
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex).trim() : trimmed;
}

/**
 * Strips a UTF-8 BOM, JSONC comments (`//` and `/* ... *\/`), and trailing commas
 * outside JSON string literals so configs written by Antigravity or users parse cleanly.
 */
export function stripJsoncAndBom(raw: string): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      withoutComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      withoutComments += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    withoutComments += ch;
    i += 1;
  }

  // Strip trailing commas before `}` or `]` outside strings.
  let out = "";
  inString = false;
  escaped = false;
  for (let idx = 0; idx < withoutComments.length; idx += 1) {
    const ch = withoutComments[idx]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let lookahead = idx + 1;
      while (lookahead < withoutComments.length && /\s/.test(withoutComments[lookahead]!)) {
        lookahead += 1;
      }
      if (withoutComments[lookahead] === "}" || withoutComments[lookahead] === "]") {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function parseJsoncObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripJsoncAndBom(raw).trim();
  if (cleaned.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsoncFile(
  filePath: string,
  options?: { readonly confineBoundary?: string | undefined },
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly message: string }
  | { readonly kind: "ok"; readonly doc: Record<string, unknown> }
  | { readonly kind: "error"; readonly message: string }
> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return { kind: "missing" };
  if (!stat.isFile()) return { kind: "error", message: `${filePath} is not a regular file.` };
  if (options?.confineBoundary) {
    const real = await fs.realpath(filePath).catch(() => null);
    if (!real || !isInside(options.confineBoundary, real)) {
      return {
        kind: "unsafe",
        message: `${filePath} points outside the repository boundary.`,
      };
    }
  }
  const bytes = await readRegularFile(filePath, {
    maxBytes: MAX_CONFIG_FILE_BYTES,
    followLink: true,
  });
  if (bytes === undefined) {
    return { kind: "error", message: `Could not read ${filePath}.` };
  }
  const doc = parseJsoncObject(bytes.toString("utf8"));
  if (!doc) {
    return { kind: "error", message: `${filePath} contains invalid JSON.` };
  }
  return { kind: "ok", doc };
}

/**
 * Ensures every directory component from `profileDir` down to `relPath`'s parent is a real
 * directory inside `profileDir` (never a symlink) and that the target file itself is not a symlink.
 */
async function ensureSafeProfileTarget(profileDir: string, relParts: ReadonlyArray<string>) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const realProfile = await fs.realpath(profileDir);
  let current = profileDir;
  for (const part of relParts.slice(0, -1)) {
    current = join(current, part);
    const lstat = await fs.lstat(current).catch(() => null);
    if (!lstat) {
      await fs.mkdir(current, { mode: 0o700 });
      continue;
    }
    if (!lstat.isDirectory()) {
      throw new Error(`Refusing to write through non-directory path: ${current}`);
    }
  }
  const realParent = await fs.realpath(current);
  if (realParent !== join(realProfile, ...relParts.slice(0, -1))) {
    throw new Error(`Refusing to write outside Antigravity profile: ${current}`);
  }
  const target = join(current, relParts[relParts.length - 1]!);
  const targetLstat = await fs.lstat(target).catch(() => null);
  if (targetLstat?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link: ${target}`);
  }
  return target;
}

async function writeProfileJsonAtomic(
  profileDir: string,
  relParts: ReadonlyArray<string>,
  doc: Record<string, unknown>,
): Promise<string> {
  const target = await ensureSafeProfileTarget(profileDir, relParts);
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

// ── MCP Remote OAuth helpers ─────────────────────────────────────────

export interface McpRemoteHashOptions {
  readonly authorizeResource?: string | undefined;
  readonly authorizeParams?: Readonly<Record<string, string>> | undefined;
  readonly clientMetadataUrl?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
}

/** Matches `mcp-remote`'s `getServerUrlHash` formula so token checks align with its cache. */
export function mcpRemoteServerUrlHash(
  serverUrl: string,
  headers?: Readonly<Record<string, string>>,
  options?: McpRemoteHashOptions,
): string {
  const parts = [serverUrl];
  if (options?.authorizeResource) {
    parts.push(options.authorizeResource);
  }
  if (options?.authorizeParams && Object.keys(options.authorizeParams).length > 0) {
    const sortedParams = Object.keys(options.authorizeParams).toSorted();
    parts.push(JSON.stringify(options.authorizeParams, sortedParams));
  }
  if (headers && Object.keys(headers).length > 0) {
    const sortedKeys = Object.keys(headers).toSorted();
    parts.push(JSON.stringify(headers, sortedKeys));
  }
  if (options?.clientMetadataUrl) {
    parts.push(options.clientMetadataUrl);
  }
  if (options?.tokenEndpoint) {
    parts.push(options.tokenEndpoint);
  }
  return createHash("md5").update(parts.join("|")).digest("hex");
}

function substituteMcpRemoteEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(/\$\{([^}]+)}/g, (match, envVarName: string) => {
    if (!Object.prototype.hasOwnProperty.call(env, envVarName)) {
      return match;
    }
    return env[envVarName] ?? "";
  });
}

function isValidMcpRemoteClientMetadataUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.pathname !== "/";
  } catch {
    return false;
  }
}

function parseMcpRemoteFlags(args: ReadonlyArray<string>): {
  readonly headers: Record<string, string>;
  readonly authorizeResource?: string | undefined;
  readonly authorizeParams: Record<string, string>;
  readonly clientMetadataUrl?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
} {
  const headers: Record<string, string> = {};
  const authorizeParams: Record<string, string> = {};
  let authorizeResource: string | undefined;
  let clientMetadataUrl: string | undefined;
  let tokenEndpoint: string | undefined;
  let skipResourceParameter = args.includes("--disable-resource-parameter");
  const useClientCredentials = args.includes("--client-credentials");

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--header" && i + 1 < args.length) {
      const raw = args[i + 1]!;
      const match = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match?.[1]) {
        headers[match[1]] = match[2] ?? "";
      }
      i += 1;
      continue;
    }
    if (arg === "--authorize-param" && i + 1 < args.length) {
      const raw = args[i + 1]!;
      const separator = raw.indexOf("=");
      if (separator >= 1) {
        const key = raw.slice(0, separator).trim();
        const value = raw.slice(separator + 1);
        if (key) authorizeParams[key] = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--resource" && i + 1 < args.length) {
      const value = args[i + 1]!.trim();
      if (value.length === 0) {
        skipResourceParameter = true;
      } else {
        authorizeResource = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--client-metadata-url" && i + 1 < args.length) {
      const value = args[i + 1]!.trim();
      if (isValidMcpRemoteClientMetadataUrl(value)) {
        clientMetadataUrl = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--token-endpoint" && i + 1 < args.length && useClientCredentials) {
      const value = args[i + 1]!.trim();
      try {
        tokenEndpoint = new URL(value).toString();
      } catch {
        // Leave undefined if invalid.
      }
      i += 1;
    }
  }

  if (skipResourceParameter) {
    authorizeResource = undefined;
  }

  return {
    headers,
    authorizeResource,
    authorizeParams,
    clientMetadataUrl,
    tokenEndpoint,
  };
}

interface ParsedMcpRemoteEntry {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly authDir: string;
  readonly urlHash: string;
}

function detectMcpRemoteEntry(
  rawEntry: Record<string, unknown>,
  profileDir: string,
  runtimeEnv?: NodeJS.ProcessEnv,
): ParsedMcpRemoteEntry | null {
  const command = optionalText(rawEntry.command);
  if (!command) return null;
  const args = Array.isArray(rawEntry.args)
    ? rawEntry.args.filter((value): value is string => typeof value === "string")
    : [];
  const baseCommand = basename(command).toLowerCase();
  const isNpx = baseCommand === "npx" || baseCommand === "npx.cmd" || baseCommand === "npx.exe";
  const isDirectMcpRemote =
    baseCommand === "mcp-remote" ||
    baseCommand === "mcp-remote.cmd" ||
    baseCommand === "mcp-remote.exe";

  let urlIndex = -1;
  if (isDirectMcpRemote) {
    urlIndex = args.findIndex((arg) => /^https?:\/\//i.test(arg.trim()));
  } else if (isNpx) {
    const pkgIndex = args.findIndex((arg) => {
      const cleaned = arg.trim();
      return cleaned === "mcp-remote" || cleaned.startsWith("mcp-remote@");
    });
    if (pkgIndex >= 0) {
      for (let i = pkgIndex + 1; i < args.length; i += 1) {
        if (/^https?:\/\//i.test(args[i]!.trim())) {
          urlIndex = i;
          break;
        }
      }
    }
  }
  if (urlIndex < 0) return null;
  const url = args[urlIndex]!.trim();
  const parsed = parseMcpRemoteFlags(args.slice(urlIndex + 1));
  const entryEnv = extractStringRecord(rawEntry.env);
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(runtimeEnv ?? {}),
    ...entryEnv,
  };
  const expandedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.headers)) {
    expandedHeaders[key] = substituteMcpRemoteEnvVars(value, mergedEnv);
  }
  // Always isolate OAuth credential storage inside the active Antigravity profile rather than
  // trusting an arbitrary `MCP_REMOTE_CONFIG_DIR` copied from another profile or machine.
  const authDir = antigravityProfileMcpRemoteAuthDir(profileDir);
  return {
    url,
    headers: parsed.headers,
    authDir,
    urlHash: mcpRemoteServerUrlHash(url, expandedHeaders, {
      authorizeResource: parsed.authorizeResource,
      authorizeParams: parsed.authorizeParams,
      clientMetadataUrl: parsed.clientMetadataUrl,
      tokenEndpoint: parsed.tokenEndpoint,
    }),
  };
}

/**
 * Verifies `<profileDir>/mcp-remote-auth` is a real directory inside the canonical `profileDir`
 * (never a symlink pointing outside). When `create` is true, creates it safely or throws if unsafe.
 */
async function resolveSafeProfileMcpRemoteAuthDir(
  profileDir: string,
  options?: { readonly create?: boolean },
): Promise<string | null> {
  if (options?.create) {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  }
  const realProfile = await fs.realpath(profileDir).catch(() => null);
  if (!realProfile) {
    if (options?.create) {
      throw new Error(`Could not resolve Antigravity profile directory: ${profileDir}`);
    }
    return null;
  }
  const authDir = antigravityProfileMcpRemoteAuthDir(profileDir);
  const lstat = await fs.lstat(authDir).catch(() => null);
  if (!lstat) {
    if (!options?.create) return null;
    await fs.mkdir(authDir, { mode: 0o700 });
  } else if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    if (options?.create) {
      throw new Error(`Refusing to use non-directory MCP OAuth path: ${authDir}`);
    }
    return null;
  }
  const realAuthDir = await fs.realpath(authDir).catch(() => null);
  if (realAuthDir !== join(realProfile, "mcp-remote-auth")) {
    if (options?.create) {
      throw new Error(`Refusing to use MCP OAuth directory outside profile: ${authDir}`);
    }
    return null;
  }
  return realAuthDir;
}

async function listSafeMcpRemoteAuthDirs(profileDir: string): Promise<Array<string>> {
  const realAuthDir = await resolveSafeProfileMcpRemoteAuthDir(profileDir);
  if (!realAuthDir) return [];
  const dirs: Array<string> = [realAuthDir];
  const entries = await fs.readdir(realAuthDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !entry.name.startsWith("mcp-remote-")) {
      continue;
    }
    const candidate = join(realAuthDir, entry.name);
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (realCandidate === join(realAuthDir, entry.name)) {
      dirs.push(realCandidate);
    }
  }
  return dirs;
}

/** Checks whether `mcp-remote` holds a valid OAuth token file for `urlHash` inside `profileDir`. */
export async function hasAntigravityMcpRemoteTokens(
  profileDir: string,
  urlHash: string,
): Promise<boolean> {
  const dirs = await listSafeMcpRemoteAuthDirs(profileDir);
  const targetFile = `${urlHash}_tokens.json`;
  for (const dir of dirs) {
    const tokenPath = join(dir, targetFile);
    const raw = await readRegularFile(tokenPath, { maxBytes: 128 * 1024, followLink: false });
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (
        isRecord(parsed) &&
        (optionalText(parsed.access_token) !== undefined ||
          optionalText(parsed.refresh_token) !== undefined)
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** Removes cached `mcp-remote` token and client registration files for `urlHash` inside `profileDir`. */
export async function clearAntigravityMcpRemoteCredentials(
  profileDir: string,
  urlHash: string,
): Promise<void> {
  const dirs = await listSafeMcpRemoteAuthDirs(profileDir);
  const prefix = `${urlHash}_`;
  for (const dir of dirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isSymbolicLink() && entry.isFile() && entry.name.startsWith(prefix)) {
        await fs.rm(join(dir, entry.name), { force: true }).catch(() => undefined);
      }
    }
  }
}

function isSinglePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

// ── Cached MCP tool discovery ────────────────────────────────────────

async function readCachedMcpTools(
  profileDir: string,
  serverName: string,
): Promise<Array<ProviderExtensionMcpTool>> {
  if (!isSinglePathSegment(serverName)) return [];
  const cacheRoot = antigravityProfileMcpCacheDir(profileDir);
  const realCacheRoot = await fs.realpath(cacheRoot).catch(() => null);
  if (!realCacheRoot) return [];
  const dir = join(realCacheRoot, serverName);
  const lstat = await fs.lstat(dir).catch(() => null);
  if (!lstat || lstat.isSymbolicLink() || !lstat.isDirectory()) return [];
  const realDir = await fs.realpath(dir).catch(() => null);
  if (!realDir || realDir !== join(realCacheRoot, serverName)) return [];

  const entries = await fs.readdir(realDir, { withFileTypes: true }).catch(() => []);
  const tools: Array<ProviderExtensionMcpTool> = [];
  for (const entry of entries.slice(0, MAX_TOOL_CACHE_FILES)) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = await readRegularFile(join(realDir, entry.name), {
      maxBytes: MAX_TOOL_CACHE_FILE_BYTES,
      followLink: false,
    });
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!isRecord(parsed)) continue;
      const name = optionalText(parsed.name) ?? entry.name.slice(0, -".json".length);
      if (!name) continue;
      const title = optionalText(parsed.title);
      const description = optionalText(parsed.description);
      const inputSchema = parsed.inputSchema ?? parsed.parameters;
      tools.push({
        name,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
      });
    } catch {
      continue;
    }
  }
  return tools.toSorted((left, right) => left.name.localeCompare(right.name));
}

// ── Antigravity Plugins ──────────────────────────────────────────────

interface AntigravityCatalogEntry {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly version?: string | undefined;
  readonly developerName?: string | undefined;
  readonly websiteUrl?: string | undefined;
  readonly repositoryUrl?: string | undefined;
  readonly license?: string | undefined;
  readonly category?: string | undefined;
  readonly keywords?: ReadonlyArray<string> | undefined;
  readonly iconUrl?: string | undefined;
  readonly marketplaceName: string;
  readonly archiveUrl?: string | undefined;
  readonly archiveSha256?: string | undefined;
}

interface CatalogCacheEntry {
  readonly fetchedAt: number;
  readonly entries: ReadonlyArray<AntigravityCatalogEntry>;
  readonly countByMarketplace: ReadonlyMap<string, number>;
  readonly errors: ReadonlyArray<string>;
}

let catalogCache: CatalogCacheEntry | null = null;

export function invalidateAntigravityPluginCatalogCache(): void {
  catalogCache = null;
}

function parseAuthorName(raw: unknown): string | undefined {
  if (typeof raw === "string") return optionalText(raw);
  if (isRecord(raw)) return optionalText(raw.name);
  return undefined;
}

function parseRepositoryUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return optionalText(raw);
  if (isRecord(raw)) return optionalText(raw.url);
  return undefined;
}

function parseKeywords(raw: unknown): Array<string> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((item) => optionalText(item))
    .filter((item): item is string => item !== undefined);
  return values.length > 0 ? values : undefined;
}

function parseCatalogEntries(
  marketplaceName: string,
  doc: Record<string, unknown>,
): Array<AntigravityCatalogEntry> {
  const rawPlugins = Array.isArray(doc.plugins) ? doc.plugins : [];
  const entries: Array<AntigravityCatalogEntry> = [];
  for (const raw of rawPlugins) {
    if (!isRecord(raw)) continue;
    const name = optionalText(raw.name);
    if (!name || !isSafeAntigravityEntryName(name)) continue;
    const source = isRecord(raw.source) ? raw.source : null;
    const archiveUrl = source?.type === "archive" ? optionalText(source.url) : undefined;
    const archiveSha256 = source?.type === "archive" ? optionalText(source.sha256) : undefined;
    const displayName = optionalText(raw.displayName);
    const description = optionalText(raw.description);
    const version = optionalText(raw.version);
    const developerName = parseAuthorName(raw.author);
    const websiteUrl = optionalText(raw.homepage);
    const repositoryUrl = parseRepositoryUrl(raw.repository);
    const license = optionalText(raw.license);
    const category = optionalText(raw.category);
    const keywords = parseKeywords(raw.keywords);
    const iconUrl = optionalText(raw.logo);
    entries.push({
      name,
      marketplaceName,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(developerName ? { developerName } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(license ? { license } : {}),
      ...(category ? { category } : {}),
      ...(keywords ? { keywords } : {}),
      ...(iconUrl && /^https:\/\//i.test(iconUrl) ? { iconUrl } : {}),
      ...(archiveUrl ? { archiveUrl } : {}),
      ...(archiveSha256 ? { archiveSha256 } : {}),
    });
  }
  return entries;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("Catalog response exceeded maximum size.");
    }
    return text;
  }
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Catalog response exceeded maximum size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchMarketplaceCatalogs(options?: {
  readonly fetch?: AntigravityExtensionsFetch | undefined;
  readonly forceRefresh?: boolean | undefined;
}): Promise<CatalogCacheEntry> {
  const useCustomFetch = options?.fetch !== undefined;
  if (
    !useCustomFetch &&
    !options?.forceRefresh &&
    catalogCache !== null &&
    Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS
  ) {
    return catalogCache;
  }

  const fetchImpl = options?.fetch ?? defaultCatalogFetch;
  const results = await Promise.all(
    ANTIGRAVITY_MARKETPLACES.map(async (spec) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await fetchImpl(spec.url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          return {
            spec,
            entries: [] as Array<AntigravityCatalogEntry>,
            error: `${spec.displayName}: HTTP ${response.status}`,
          };
        }
        const text = await readBoundedResponseText(response, MAX_CATALOG_BYTES);
        const doc = parseJsoncObject(text);
        if (!doc) {
          return {
            spec,
            entries: [] as Array<AntigravityCatalogEntry>,
            error: `${spec.displayName}: invalid JSON`,
          };
        }
        return {
          spec,
          entries: parseCatalogEntries(spec.name, doc),
          error: undefined as string | undefined,
        };
      } catch (error) {
        return {
          spec,
          entries: [] as Array<AntigravityCatalogEntry>,
          error: `${spec.displayName}: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const countByMarketplace = new Map<string, number>();
  const entries: Array<AntigravityCatalogEntry> = [];
  const errors: Array<string> = [];
  for (const result of results) {
    if (result.error) {
      errors.push(result.error);
    } else {
      countByMarketplace.set(result.spec.name, result.entries.length);
      entries.push(...result.entries);
    }
  }

  const snapshot: CatalogCacheEntry = {
    fetchedAt: Date.now(),
    entries,
    countByMarketplace,
    errors,
  };
  if (!useCustomFetch && errors.length < ANTIGRAVITY_MARKETPLACES.length) {
    catalogCache = snapshot;
  }
  return snapshot;
}

export interface AntigravityInstalledPluginRecord {
  readonly dirName: string;
  readonly installPath: string;
  readonly realInstallPath: string;
  readonly scope: "user" | "project";
  readonly removable: boolean;
  readonly plugin: ProviderExtensionPlugin;
  readonly repositoryUrl?: string | undefined;
  readonly license?: string | undefined;
  readonly components: ReadonlyArray<ProviderExtensionPluginComponent>;
  readonly mcpConfigServers: ReadonlyArray<{
    readonly name: string;
    readonly rawEntry: Record<string, unknown>;
    readonly configPath: string;
  }>;
}

interface ParsedImportManifest {
  readonly byName: ReadonlyMap<
    string,
    {
      readonly source?: string | undefined;
      readonly version?: string | undefined;
      readonly installedAt?: string | undefined;
    }
  >;
}

async function readImportManifest(profileDir: string): Promise<ParsedImportManifest> {
  const result = await readJsoncFile(antigravityProfileImportManifestPath(profileDir));
  const byName = new Map<
    string,
    {
      readonly source?: string | undefined;
      readonly version?: string | undefined;
      readonly installedAt?: string | undefined;
    }
  >();
  if (result.kind !== "ok") return { byName };

  // Support both `{ plugins: { [name]: { ... } } }` and `{ [name]: { ... } }`.
  const container = isRecord(result.doc.plugins) ? result.doc.plugins : result.doc;
  for (const [name, raw] of Object.entries(container)) {
    if (!isRecord(raw)) continue;
    const source = optionalText(raw.source) ?? optionalText(raw.marketplace);
    const version = optionalText(raw.version);
    const installedAt = optionalText(raw.installedAt);
    byName.set(name, {
      ...(source ? { source } : {}),
      ...(version ? { version } : {}),
      ...(installedAt ? { installedAt } : {}),
    });
  }
  return { byName };
}

async function readPluginEnabledStates(profileDir: string): Promise<ReadonlyMap<string, boolean>> {
  const states = new Map<string, boolean>();
  const result = await readJsoncFile(antigravityProfileConfigPath(profileDir));
  if (result.kind !== "ok") return states;
  const plugins = isRecord(result.doc.plugins) ? result.doc.plugins : null;
  if (!plugins) return states;
  for (const [name, raw] of Object.entries(plugins)) {
    if (isRecord(raw) && typeof raw.enabled === "boolean") {
      states.set(name, raw.enabled);
    }
  }
  return states;
}

async function findPluginManifest(
  pluginDir: string,
  confineBoundary: string,
): Promise<{ readonly path: string; readonly doc: Record<string, unknown> } | null> {
  for (const rel of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const candidate = join(pluginDir, ...rel.split("/"));
    const result = await readJsoncFile(candidate, { confineBoundary });
    if (result.kind === "ok") {
      return { path: candidate, doc: result.doc };
    }
  }
  return null;
}

async function resolvePluginIcon(
  pluginDir: string,
  realPluginDir: string,
  manifestLogo: string | undefined,
): Promise<{ readonly iconUrl?: string; readonly iconPath?: string }> {
  if (manifestLogo && /^https:\/\//i.test(manifestLogo)) {
    return { iconUrl: manifestLogo };
  }
  const candidates = [...(manifestLogo ? [manifestLogo] : []), ...PLUGIN_LOGO_CANDIDATES];
  for (const rel of candidates) {
    if (isAbsolute(rel)) continue;
    const candidate = resolve(pluginDir, rel);
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !isInside(realPluginDir, real)) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (stat?.isFile()) {
      return { iconPath: real };
    }
  }
  return {};
}

function parseFrontMatterNameDescription(contents: string): {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
} {
  const normalized = contents.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match?.[1]) return {};
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair?.[1]) continue;
    const key = pair[1].trim().toLowerCase();
    const rawValue = (pair[2] ?? "").trim();
    const unquoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1).trim()
        : rawValue;
    if (unquoted.length > 0) fields.set(key, unquoted);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

async function scanPluginComponents(
  pluginDir: string,
  realPluginDir: string,
  manifestDoc: Record<string, unknown>,
): Promise<{
  readonly components: Array<ProviderExtensionPluginComponent>;
  readonly mcpConfigServers: Array<{
    readonly name: string;
    readonly rawEntry: Record<string, unknown>;
    readonly configPath: string;
  }>;
}> {
  const components: Array<ProviderExtensionPluginComponent> = [];
  const mcpConfigServers: Array<{
    readonly name: string;
    readonly rawEntry: Record<string, unknown>;
    readonly configPath: string;
  }> = [];

  // 1. Skills
  const skillsDir = join(pluginDir, "skills");
  const realSkillsDir = await fs.realpath(skillsDir).catch(() => null);
  const skillEntries =
    realSkillsDir && isInside(realPluginDir, realSkillsDir)
      ? await fs.readdir(realSkillsDir, { withFileTypes: true }).catch(() => [])
      : [];
  for (const entry of skillEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const entryDir = join(realSkillsDir!, entry.name);
    const realEntryDir = await fs.realpath(entryDir).catch(() => null);
    if (!realEntryDir || !isInside(realPluginDir, realEntryDir)) continue;
    const stat = await fs.stat(realEntryDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(realEntryDir).catch(() => []);
    const skillFile = files.toSorted().find((f) => f.toLowerCase() === "skill.md");
    if (!skillFile) continue;
    const skillPath = join(realEntryDir, skillFile);
    const realSkillPath = await fs.realpath(skillPath).catch(() => null);
    if (!realSkillPath || !isInside(realPluginDir, realSkillPath)) continue;
    const raw = await readRegularFile(realSkillPath, { maxBytes: 32_000, followLink: false });
    const fm = raw ? parseFrontMatterNameDescription(raw.toString("utf8")) : {};
    components.push({
      kind: "skill",
      name: fm.name ?? entry.name,
      ...(fm.description ? { description: fm.description } : {}),
      path: realSkillPath,
    });
  }

  // 2. MCP servers (`mcp_config.json` or `mcp.json` when using Agent Plugins `$schema`)
  const usesAgentPluginsSchema =
    typeof manifestDoc.$schema === "string" && manifestDoc.$schema.includes("plugin.json");
  const mcpCandidates = usesAgentPluginsSchema
    ? ["mcp.json", "mcp_config.json"]
    : ["mcp_config.json", "mcp.json"];
  for (const rel of mcpCandidates) {
    const mcpPath = join(pluginDir, rel);
    const mcpDoc = await readJsoncFile(mcpPath, { confineBoundary: realPluginDir });
    if (mcpDoc.kind !== "ok") continue;
    const servers = isRecord(mcpDoc.doc.mcpServers) ? mcpDoc.doc.mcpServers : mcpDoc.doc;
    for (const [rawName, rawEntry] of Object.entries(servers)) {
      const serverName = optionalText(rawName);
      if (!serverName || !isRecord(rawEntry)) continue;
      if (rawName === "$schema") continue;
      const url = optionalText(rawEntry.serverUrl) ?? optionalText(rawEntry.url);
      const command = optionalText(rawEntry.command);
      if (!url && !command) continue;
      const transport = url ? "http" : "stdio";
      components.push({
        kind: "mcpServer",
        name: serverName,
        detail: transport,
      });
      mcpConfigServers.push({ name: serverName, rawEntry, configPath: mcpPath });
    }
    break;
  }

  // 3. Hooks (`hooks.json`)
  const hooksPath = join(pluginDir, "hooks.json");
  const hooksDoc = await readJsoncFile(hooksPath, { confineBoundary: realPluginDir });
  if (hooksDoc.kind === "ok") {
    const hooksRoot = isRecord(hooksDoc.doc.hooks) ? hooksDoc.doc.hooks : hooksDoc.doc;
    for (const [eventName, rawList] of Object.entries(hooksRoot)) {
      if (eventName === "$schema" || !Array.isArray(rawList)) continue;
      let idx = 0;
      for (const hookEntry of rawList) {
        if (!isRecord(hookEntry)) continue;
        idx += 1;
        const matcher = optionalText(hookEntry.matcher);
        const command = optionalText(hookEntry.command);
        components.push({
          kind: "hook",
          name: matcher ? `${eventName} (${matcher})` : `${eventName} #${idx}`,
          ...(command ? { description: command } : {}),
          detail: eventName,
        });
      }
    }
  }

  // 4. Agents (`agents/*.md`)
  const agentsDir = join(pluginDir, "agents");
  const realAgentsDir = await fs.realpath(agentsDir).catch(() => null);
  const agentEntries =
    realAgentsDir && isInside(realPluginDir, realAgentsDir)
      ? await fs.readdir(realAgentsDir, { withFileTypes: true }).catch(() => [])
      : [];
  for (const entry of agentEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const agentPath = join(realAgentsDir!, entry.name);
    const realAgentPath = await fs.realpath(agentPath).catch(() => null);
    if (!realAgentPath || !isInside(realPluginDir, realAgentPath)) continue;
    const raw = await readRegularFile(realAgentPath, { maxBytes: 32_000, followLink: false });
    if (!raw) continue;
    const fm = parseFrontMatterNameDescription(raw.toString("utf8"));
    components.push({
      kind: "agent",
      name: fm.name ?? entry.name.replace(/\.md$/i, ""),
      ...(fm.description ? { description: fm.description } : {}),
    });
  }

  // 5. Rules (`rules/*.md`)
  const rulesDir = join(pluginDir, "rules");
  const realRulesDir = await fs.realpath(rulesDir).catch(() => null);
  const ruleEntries =
    realRulesDir && isInside(realPluginDir, realRulesDir)
      ? await fs.readdir(realRulesDir, { withFileTypes: true }).catch(() => [])
      : [];
  for (const entry of ruleEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const rulePath = join(realRulesDir!, entry.name);
    const realRulePath = await fs.realpath(rulePath).catch(() => null);
    if (!realRulePath || !isInside(realPluginDir, realRulePath)) continue;
    const stat = await fs.stat(realRulePath).catch(() => null);
    if (!stat?.isFile()) continue;
    components.push({
      kind: "rule",
      name: entry.name.replace(/\.md$/i, ""),
    });
  }

  return { components, mcpConfigServers };
}

async function readInstalledPluginFromDir(input: {
  readonly pluginDir: string;
  readonly scope: "user" | "project";
  readonly removable: boolean;
  readonly enabledStates: ReadonlyMap<string, boolean>;
  readonly importManifest: ParsedImportManifest;
  readonly confineBoundary?: string | undefined;
}): Promise<AntigravityInstalledPluginRecord | null> {
  const realInstallPath = await fs.realpath(input.pluginDir).catch(() => null);
  if (!realInstallPath) return null;
  if (input.confineBoundary && !isInside(input.confineBoundary, realInstallPath)) return null;
  const stat = await fs.stat(realInstallPath).catch(() => null);
  if (!stat?.isDirectory()) return null;

  const manifest = await findPluginManifest(input.pluginDir, realInstallPath);
  if (!manifest) return null;

  const dirName = basename(input.pluginDir);
  const importInfo = input.importManifest.byName.get(dirName);
  const name = optionalText(manifest.doc.name) ?? dirName;
  const displayName = optionalText(manifest.doc.displayName);
  const description = optionalText(manifest.doc.description);
  const version = optionalText(manifest.doc.version) ?? importInfo?.version;
  const developerName = parseAuthorName(manifest.doc.author);
  const websiteUrl = optionalText(manifest.doc.homepage);
  const repositoryUrl = parseRepositoryUrl(manifest.doc.repository);
  const license = optionalText(manifest.doc.license);
  const category = optionalText(manifest.doc.category);
  const keywords = parseKeywords(manifest.doc.keywords);
  const icon = await resolvePluginIcon(
    input.pluginDir,
    realInstallPath,
    optionalText(manifest.doc.logo),
  );
  const defaultEnabled = manifest.doc.disabled !== true;
  const enabled = input.enabledStates.get(dirName) ?? defaultEnabled;
  const marketplaceName =
    importInfo?.source &&
    ANTIGRAVITY_MARKETPLACES.some((marketplace) => marketplace.name === importInfo.source)
      ? importInfo.source
      : undefined;

  const { components, mcpConfigServers } = await scanPluginComponents(
    input.pluginDir,
    realInstallPath,
    manifest.doc,
  );

  const plugin: ProviderExtensionPlugin = {
    id: dirName,
    name: dirName,
    ...(displayName ? { displayName } : name !== dirName ? { displayName: name } : {}),
    ...(description ? { description } : {}),
    enabled,
    installed: true,
    scope: input.scope,
    source:
      marketplaceName ??
      importInfo?.source ??
      (input.scope === "project" ? "Project (.agents/plugins)" : "Antigravity profile"),
    ...(marketplaceName ? { marketplaceName, remoteMarketplaceName: marketplaceName } : {}),
    ...(version ? { version } : {}),
    ...(developerName ? { developerName } : {}),
    ...(category ? { category } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(keywords ? { keywords } : {}),
    installPath: input.pluginDir,
    ...(importInfo?.installedAt ? { installedAt: importInfo.installedAt } : {}),
    ...(icon.iconUrl ? { iconUrl: icon.iconUrl } : {}),
    ...(icon.iconPath ? { iconPath: icon.iconPath } : {}),
    ...(FEATURED_ANTIGRAVITY_PLUGINS.has(dirName) ? { featured: true } : {}),
  };

  return {
    dirName,
    installPath: input.pluginDir,
    realInstallPath,
    scope: input.scope,
    removable: input.removable,
    plugin,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(license ? { license } : {}),
    components,
    mcpConfigServers,
  };
}

async function scanPluginsFolder(input: {
  readonly dir: string;
  readonly scope: "user" | "project";
  readonly removable: boolean;
  readonly enabledStates: ReadonlyMap<string, boolean>;
  readonly importManifest: ParsedImportManifest;
  readonly confineBoundary?: string | undefined;
}): Promise<Array<AntigravityInstalledPluginRecord>> {
  const entries = await fs.readdir(input.dir, { withFileTypes: true }).catch(() => []);
  const records: Array<AntigravityInstalledPluginRecord> = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const pluginDir = join(input.dir, entry.name);
    const record = await readInstalledPluginFromDir({
      pluginDir,
      scope: input.scope,
      removable: input.removable,
      enabledStates: input.enabledStates,
      importManifest: input.importManifest,
      ...(input.confineBoundary ? { confineBoundary: input.confineBoundary } : {}),
    });
    if (record) records.push(record);
  }
  return records;
}

async function scanPluginsManifest(input: {
  readonly manifestPath: string;
  readonly baseDir: string;
  readonly scope: "user" | "project";
  readonly enabledStates: ReadonlyMap<string, boolean>;
  readonly importManifest: ParsedImportManifest;
  readonly confineBoundary?: string | undefined;
}): Promise<Array<AntigravityInstalledPluginRecord>> {
  const result = await readJsoncFile(
    input.manifestPath,
    input.confineBoundary ? { confineBoundary: input.confineBoundary } : undefined,
  );
  if (result.kind !== "ok") return [];
  const entries = Array.isArray(result.doc.entries) ? result.doc.entries : [];
  const records: Array<AntigravityInstalledPluginRecord> = [];
  for (const rawEntry of entries) {
    if (!isRecord(rawEntry)) continue;
    const entryPath = optionalText(rawEntry.path);
    if (!entryPath) continue;
    const resolvedDir = isAbsolute(entryPath)
      ? resolve(entryPath)
      : resolve(input.baseDir, entryPath);
    const includeOnly = Array.isArray(rawEntry.include_only)
      ? rawEntry.include_only.filter((v): v is string => typeof v === "string")
      : null;
    const exclude = Array.isArray(rawEntry.exclude)
      ? rawEntry.exclude.filter((v): v is string => typeof v === "string")
      : [];
    const direct = await readInstalledPluginFromDir({
      pluginDir: resolvedDir,
      scope: input.scope,
      removable: false,
      enabledStates: input.enabledStates,
      importManifest: input.importManifest,
      ...(input.confineBoundary ? { confineBoundary: input.confineBoundary } : {}),
    });
    if (direct) {
      if (
        (!includeOnly || includeOnly.includes(direct.dirName)) &&
        !exclude.includes(direct.dirName)
      ) {
        records.push(direct);
      }
      continue;
    }
    const children = await scanPluginsFolder({
      dir: resolvedDir,
      scope: input.scope,
      removable: false,
      enabledStates: input.enabledStates,
      importManifest: input.importManifest,
      ...(input.confineBoundary ? { confineBoundary: input.confineBoundary } : {}),
    });
    for (const child of children) {
      if (
        (!includeOnly || includeOnly.includes(child.dirName)) &&
        !exclude.includes(child.dirName)
      ) {
        records.push(child);
      }
    }
  }
  return records;
}

async function listInstalledAntigravityPluginRecords(input: {
  readonly profileDir: string;
  readonly projectCwd?: string | undefined;
  readonly projectBoundary?: string | undefined;
}): Promise<Array<AntigravityInstalledPluginRecord>> {
  const [enabledStates, importManifest] = await Promise.all([
    readPluginEnabledStates(input.profileDir),
    readImportManifest(input.profileDir),
  ]);

  const [userPlugins, userManifestPlugins, projectPlugins, projectManifestPlugins] =
    await Promise.all([
      scanPluginsFolder({
        dir: antigravityProfilePluginsDir(input.profileDir),
        scope: "user",
        removable: true,
        enabledStates,
        importManifest,
      }),
      scanPluginsManifest({
        manifestPath: antigravityProfilePluginsManifestPath(input.profileDir),
        baseDir: dirname(antigravityProfilePluginsManifestPath(input.profileDir)),
        scope: "user",
        enabledStates,
        importManifest,
      }),
      input.projectCwd && input.projectBoundary
        ? scanPluginsFolder({
            dir: join(input.projectCwd, ".agents", "plugins"),
            scope: "project",
            removable: false,
            enabledStates,
            importManifest,
            confineBoundary: input.projectBoundary,
          })
        : Promise.resolve([]),
      input.projectCwd && input.projectBoundary
        ? scanPluginsManifest({
            manifestPath: join(input.projectCwd, ".agents", "plugins.json"),
            baseDir: input.projectCwd,
            scope: "project",
            enabledStates,
            importManifest,
            confineBoundary: input.projectBoundary,
          })
        : Promise.resolve([]),
    ]);

  // Project plugins take precedence over user plugins when names collide.
  const byDirName = new Map<string, AntigravityInstalledPluginRecord>();
  for (const record of [
    ...projectPlugins,
    ...projectManifestPlugins,
    ...userPlugins,
    ...userManifestPlugins,
  ]) {
    if (!byDirName.has(record.dirName)) {
      byDirName.set(record.dirName, record);
    }
  }
  return [...byDirName.values()].toSorted((left, right) =>
    left.dirName.localeCompare(right.dirName),
  );
}

export interface AntigravityPluginInventoryResult {
  readonly plugins: Array<ProviderExtensionPlugin>;
  readonly marketplaces: Array<ProviderExtensionMarketplace>;
  readonly pluginCatalogStatus: "ready" | "deferred" | "error";
  readonly installedRecords: Array<AntigravityInstalledPluginRecord>;
  readonly errors: Array<string>;
}

/**
 * Lists installed Antigravity plugins for one profile (and optional project),
 * optionally merging the official and partner marketplace catalogs for Browse.
 */
export async function listAntigravityPlugins(input: {
  readonly profileDir: string;
  readonly projectCwd?: string | undefined;
  readonly projectBoundary?: string | undefined;
  readonly includeCatalog: boolean;
  readonly fetch?: AntigravityExtensionsFetch | undefined;
}): Promise<AntigravityPluginInventoryResult> {
  const installedRecords = await listInstalledAntigravityPluginRecords({
    profileDir: input.profileDir,
    ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
    ...(input.projectBoundary ? { projectBoundary: input.projectBoundary } : {}),
  });

  const installedByName = new Map(installedRecords.map((record) => [record.dirName, record]));

  if (!input.includeCatalog) {
    const marketplaces: Array<ProviderExtensionMarketplace> = ANTIGRAVITY_MARKETPLACES.map(
      (spec) => ({
        name: spec.name,
        displayName: spec.displayName,
        source: spec.url,
        installedPluginCount: installedRecords.filter(
          (record) => record.plugin.marketplaceName === spec.name,
        ).length,
        remote: true,
        removable: false,
      }),
    );
    return {
      plugins: installedRecords.map((record) => record.plugin),
      marketplaces,
      pluginCatalogStatus: "deferred",
      installedRecords,
      errors: [],
    };
  }

  const catalog = await fetchMarketplaceCatalogs({ fetch: input.fetch });
  const mergedById = new Map<string, ProviderExtensionPlugin>();
  const catalogByName = new Map<string, AntigravityCatalogEntry>();
  for (const entry of catalog.entries) {
    if (!catalogByName.has(entry.name)) {
      catalogByName.set(entry.name, entry);
    }
  }

  // Enrich installed plugins with catalog artwork/metadata when they match a catalog plugin.
  for (const record of installedRecords) {
    const matched = catalogByName.get(record.dirName);
    const enriched: ProviderExtensionPlugin = matched
      ? {
          ...record.plugin,
          displayName: record.plugin.displayName ?? matched.displayName,
          description: record.plugin.description ?? matched.description,
          developerName: record.plugin.developerName ?? matched.developerName,
          websiteUrl: record.plugin.websiteUrl ?? matched.websiteUrl,
          category: record.plugin.category ?? matched.category,
          keywords:
            record.plugin.keywords ?? (matched.keywords ? [...matched.keywords] : undefined),
          iconUrl: record.plugin.iconUrl ?? matched.iconUrl,
          marketplaceName: record.plugin.marketplaceName ?? matched.marketplaceName,
          remoteMarketplaceName: record.plugin.remoteMarketplaceName ?? matched.marketplaceName,
          ...(matched.version && record.plugin.version && matched.version !== record.plugin.version
            ? { availableVersion: matched.version }
            : {}),
        }
      : record.plugin;
    mergedById.set(record.dirName, enriched);
  }

  // Append uninstalled catalog plugins.
  for (const entry of catalog.entries) {
    if (installedByName.has(entry.name)) continue;
    const id = `${entry.name}@${entry.marketplaceName}`;
    if (mergedById.has(id)) continue;
    mergedById.set(id, {
      id,
      name: entry.name,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      installed: false,
      source: entry.marketplaceName,
      marketplaceName: entry.marketplaceName,
      remoteMarketplaceName: entry.marketplaceName,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.developerName ? { developerName: entry.developerName } : {}),
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.websiteUrl ? { websiteUrl: entry.websiteUrl } : {}),
      ...(entry.keywords ? { keywords: [...entry.keywords] } : {}),
      ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
      ...(FEATURED_ANTIGRAVITY_PLUGINS.has(entry.name) ? { featured: true } : {}),
    });
  }

  const marketplaces: Array<ProviderExtensionMarketplace> = ANTIGRAVITY_MARKETPLACES.map((spec) => {
    const count = catalog.countByMarketplace.get(spec.name);
    const loadError = catalog.errors.find((err) => err.startsWith(`${spec.displayName}:`));
    return {
      name: spec.name,
      displayName: spec.displayName,
      source: spec.url,
      ...(count !== undefined ? { pluginCount: count } : {}),
      installedPluginCount: installedRecords.filter(
        (record) =>
          record.plugin.marketplaceName === spec.name ||
          catalogByName.get(record.dirName)?.marketplaceName === spec.name,
      ).length,
      remote: true,
      removable: false,
      ...(loadError ? { loadError } : {}),
    };
  });

  const allFailed = catalog.errors.length === ANTIGRAVITY_MARKETPLACES.length;
  return {
    plugins: [...mergedById.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    marketplaces,
    pluginCatalogStatus: allFailed ? "error" : "ready",
    installedRecords,
    errors: [...catalog.errors],
  };
}

/** Links Antigravity plugin-bundled skills to their owning plugin so Skills groups them cleanly. */
export function annotateAntigravityPluginSkills(
  skills: ReadonlyArray<ProviderExtensionSkill>,
  installedRecords: ReadonlyArray<AntigravityInstalledPluginRecord>,
): Array<ProviderExtensionSkill> {
  if (skills.length === 0 || installedRecords.length === 0) return [...skills];
  const pluginSkillRoots = installedRecords.map((record) => ({
    record,
    realPrefix: `${normalizedPathKey(join(record.realInstallPath, "skills"))}/`,
    pathPrefix: `${normalizedPathKey(join(record.installPath, "skills"))}/`,
  }));

  return skills.map((skill) => {
    if (skill.bundleId) return skill;
    const skillKey = normalizedPathKey(skill.path);
    const resolvedKey = skill.resolvedPath ? normalizedPathKey(skill.resolvedPath) : skillKey;
    const match = pluginSkillRoots.find(
      (entry) =>
        skillKey.startsWith(entry.pathPrefix) ||
        skillKey.startsWith(entry.realPrefix) ||
        resolvedKey.startsWith(entry.realPrefix),
    );
    if (!match) return skill;
    return {
      ...skill,
      bundleId: match.record.plugin.id,
      bundleName: match.record.plugin.name,
      ...(match.record.plugin.displayName
        ? { bundleDisplayName: match.record.plugin.displayName }
        : {}),
      source: `${match.record.plugin.displayName ?? match.record.plugin.name} plugin`,
    };
  });
}

export async function readAntigravityPluginDetail(input: {
  readonly profileDir: string;
  readonly projectCwd?: string | undefined;
  readonly projectBoundary?: string | undefined;
  readonly pluginName: string;
  readonly remoteMarketplaceName?: string | undefined;
  readonly fetch?: AntigravityExtensionsFetch | undefined;
}): Promise<ProviderExtensionPluginDetail> {
  const dirName = normalizePluginDirName(input.pluginName);
  const installedRecords = await listInstalledAntigravityPluginRecords({
    profileDir: input.profileDir,
    ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
    ...(input.projectBoundary ? { projectBoundary: input.projectBoundary } : {}),
  });
  const installed = installedRecords.find((record) => record.dirName === dirName);
  if (installed) {
    return {
      pluginId: installed.plugin.id,
      name: installed.plugin.name,
      ...(installed.plugin.displayName ? { displayName: installed.plugin.displayName } : {}),
      ...(installed.plugin.description ? { description: installed.plugin.description } : {}),
      ...(installed.plugin.version ? { version: installed.plugin.version } : {}),
      ...(installed.plugin.developerName ? { developerName: installed.plugin.developerName } : {}),
      ...(installed.plugin.websiteUrl ? { websiteUrl: installed.plugin.websiteUrl } : {}),
      ...(installed.repositoryUrl ? { repositoryUrl: installed.repositoryUrl } : {}),
      ...(installed.license ? { license: installed.license } : {}),
      ...(installed.plugin.marketplaceName
        ? { marketplaceName: installed.plugin.marketplaceName }
        : {}),
      components: [...installed.components],
    };
  }

  const catalog = await fetchMarketplaceCatalogs({ fetch: input.fetch });
  const matched =
    catalog.entries.find(
      (entry) =>
        entry.name === dirName &&
        (!input.remoteMarketplaceName || entry.marketplaceName === input.remoteMarketplaceName),
    ) ?? catalog.entries.find((entry) => entry.name === dirName);
  if (!matched) {
    throw new Error(`Plugin "${input.pluginName}" was not found.`);
  }
  return {
    pluginId: `${matched.name}@${matched.marketplaceName}`,
    name: matched.name,
    ...(matched.displayName ? { displayName: matched.displayName } : {}),
    ...(matched.description ? { description: matched.description } : {}),
    ...(matched.version ? { version: matched.version } : {}),
    ...(matched.developerName ? { developerName: matched.developerName } : {}),
    ...(matched.websiteUrl ? { websiteUrl: matched.websiteUrl } : {}),
    ...(matched.repositoryUrl ? { repositoryUrl: matched.repositoryUrl } : {}),
    ...(matched.license ? { license: matched.license } : {}),
    marketplaceName: matched.marketplaceName,
    components: [],
  };
}

export async function setAntigravityPluginEnabled(input: {
  readonly profileDir: string;
  readonly pluginId: string;
  readonly enabled: boolean;
}): Promise<{ readonly effectiveEnabled: boolean }> {
  const dirName = normalizePluginDirName(input.pluginId);
  if (!isSafeAntigravityEntryName(dirName)) {
    throw new Error(`Invalid Antigravity plugin name: ${input.pluginId}`);
  }
  return enqueueProfileWrite(input.profileDir, async () => {
    const configPath = antigravityProfileConfigPath(input.profileDir);
    const existing = await readJsoncFile(configPath);
    if (existing.kind === "error") throw new Error(existing.message);
    const doc: Record<string, unknown> = existing.kind === "ok" ? { ...existing.doc } : {};
    const existingPlugins = isRecord(doc.plugins) ? { ...doc.plugins } : {};
    const currentEntry = isRecord(existingPlugins[dirName]) ? { ...existingPlugins[dirName] } : {};
    existingPlugins[dirName] = { ...currentEntry, enabled: input.enabled };
    doc.plugins = existingPlugins;
    await writeProfileJsonAtomic(input.profileDir, ["config", "config.json"], doc);
    return { effectiveEnabled: input.enabled };
  });
}

async function resolveAntigravityCliExecutable(input: {
  readonly binaryPath?: string | undefined;
  readonly stateDir?: string | undefined;
}): Promise<string> {
  const custom = optionalText(input.binaryPath);
  if (custom) return custom;
  if (input.stateDir) {
    const assetKey = antigravityAssetKey(process.platform, process.arch);
    if (assetKey) {
      const root = join(input.stateDir, "tools", "agy", assetKey);
      const activeRaw = await readRegularFile(join(root, "active.json"), {
        maxBytes: 16_384,
        followLink: false,
      });
      if (activeRaw) {
        try {
          const active = JSON.parse(activeRaw.toString("utf8")) as {
            readonly releaseId?: unknown;
          };
          if (typeof active.releaseId === "string" && active.releaseId.length > 0) {
            const versionDir = join(root, "versions", active.releaseId);
            const markerRaw = await readRegularFile(join(versionDir, ".install-complete.json"), {
              maxBytes: 16_384,
              followLink: false,
            });
            if (markerRaw) {
              const marker = JSON.parse(markerRaw.toString("utf8")) as {
                readonly executable?: { readonly name?: unknown };
              };
              if (typeof marker.executable?.name === "string") {
                const candidate = join(versionDir, marker.executable.name);
                const stat = await fs.stat(candidate).catch(() => null);
                if (stat?.isFile()) return candidate;
              }
            }
          }
        } catch {
          // Fall through to PATH lookup.
        }
      }
    }
  }
  return "agy";
}

async function downloadVerifiedPluginArchive(input: {
  readonly url: string;
  readonly expectedSha256: string;
  readonly destination: string;
  readonly fetch: AntigravityExtensionsFetch;
}): Promise<void> {
  if (!SHA256_HEX_PATTERN.test(input.expectedSha256)) {
    throw new Error("Plugin archive has an invalid SHA-256 digest.");
  }
  const parsedUrl = new URL(input.url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== ANTIGRAVITY_CATALOG_HOST) {
    throw new Error(`Refusing to download plugin archive from host ${parsedUrl.hostname}.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVE_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await input.fetch(input.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download plugin archive (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    const hash = createHash("sha256");
    const chunks: Array<Uint8Array> = [];
    let totalBytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_PLUGIN_ARCHIVE_BYTES) {
            throw new Error("Plugin archive exceeded the 64 MB size limit.");
          }
          hash.update(value);
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > MAX_PLUGIN_ARCHIVE_BYTES) {
        throw new Error("Plugin archive exceeded the 64 MB size limit.");
      }
      hash.update(buffer);
      chunks.push(buffer);
    }

    const actualSha256 = hash.digest("hex");
    if (actualSha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
      throw new Error("Downloaded plugin archive failed SHA-256 verification.");
    }
    await fs.writeFile(input.destination, Buffer.concat(chunks), { mode: 0o600 });
  } finally {
    clearTimeout(timer);
  }
}

async function locateExtractedPluginRoot(extractDir: string): Promise<string> {
  const realExtractDir = await fs.realpath(extractDir);
  if (await findPluginManifest(extractDir, realExtractDir)) return extractDir;
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const visible = entries.filter(
    (entry) => !entry.name.startsWith(".") && entry.name !== "__MACOSX",
  );
  if (visible.length === 1 && visible[0]?.isDirectory()) {
    const nested = join(extractDir, visible[0].name);
    if (await findPluginManifest(nested, realExtractDir)) return nested;
  }
  throw new Error("Plugin archive did not contain a valid plugin.json manifest.");
}

async function recordImportManifestEntry(
  profileDir: string,
  pluginName: string,
  meta: { readonly source: string; readonly version?: string | undefined },
): Promise<void> {
  const manifestPath = antigravityProfileImportManifestPath(profileDir);
  const existing = await readJsoncFile(manifestPath);
  const doc: Record<string, unknown> = existing.kind === "ok" ? { ...existing.doc } : {};
  const plugins = isRecord(doc.plugins) ? { ...doc.plugins } : {};
  plugins[pluginName] = {
    source: meta.source,
    ...(meta.version ? { version: meta.version } : {}),
    installedAt: new Date().toISOString(),
  };
  doc.plugins = plugins;
  await writeProfileJsonAtomic(profileDir, ["config", "import_manifest.json"], doc);
}

async function removeImportManifestEntry(profileDir: string, pluginName: string): Promise<void> {
  const manifestPath = antigravityProfileImportManifestPath(profileDir);
  const existing = await readJsoncFile(manifestPath);
  if (existing.kind !== "ok") return;
  const doc: Record<string, unknown> = { ...existing.doc };
  let changed = false;
  if (isRecord(doc.plugins) && pluginName in doc.plugins) {
    const nextPlugins = { ...doc.plugins };
    delete nextPlugins[pluginName];
    doc.plugins = nextPlugins;
    changed = true;
  } else if (pluginName in doc) {
    delete doc[pluginName];
    changed = true;
  }
  if (changed) {
    await writeProfileJsonAtomic(profileDir, ["config", "import_manifest.json"], doc);
  }
}

/**
 * Terminates a detached child process and its POSIX process group cleanly, escalating from
 * SIGTERM to SIGKILL if needed, and waits until the child has exited (capped at 3s).
 */
export function terminateAntigravityChildProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const pid = child.pid;
  const sendSignal = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall back to signaling the direct child if its group already exited.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Ignore already-exited child.
    }
  };

  return new Promise<void>((resolvePromise) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(escalateTimer);
      clearTimeout(capTimer);
      resolvePromise();
    };
    child.once("close", finish);
    child.once("exit", finish);
    sendSignal("SIGTERM");
    const escalateTimer = setTimeout(() => {
      sendSignal("SIGKILL");
    }, 1_500);
    escalateTimer.unref?.();
    const capTimer = setTimeout(finish, 3_000);
    capTimer.unref?.();
  });
}

/**
 * Runs `antigravity plugin install <source>` against an isolated profile by creating
 * a temporary fake `HOME` whose `.gemini` links to `profileDir`, because standalone
 * `agy plugin` subcommands ignore `GEMINI_HOME`.
 */
async function runAntigravityCliPluginInstall(input: {
  readonly executable: string;
  readonly profileDir: string;
  readonly tempRoot: string;
  readonly source: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  await fs.mkdir(input.profileDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(input.tempRoot, { recursive: true, mode: 0o700 });
  const fakeHome = join(input.tempRoot, `plugin-home-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(fakeHome, { recursive: true, mode: 0o700 });
  try {
    await fs.symlink(
      input.profileDir,
      join(fakeHome, ".gemini"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...input.env,
      HOME: fakeHome,
      ...(process.platform === "win32" ? { USERPROFILE: fakeHome } : {}),
      GEMINI_HOME: input.profileDir,
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
    };

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(input.executable, ["plugin", "install", input.source], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        ...hideWindowsConsole,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        timedOut = true;
        void terminateAntigravityChildProcessGroup(child).then(() => {
          rejectPromise(new Error("Antigravity plugin install timed out."));
        });
      }, CLI_INSTALL_TIMEOUT_MS);
      timer.unref?.();
      child.on("error", (error) => {
        clearTimeout(timer);
        if (!timedOut) rejectPromise(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code === 0) {
          resolvePromise(stdout.trim() || stderr.trim());
        } else {
          rejectPromise(
            new Error(
              stderr.trim() || stdout.trim() || `Antigravity plugin install failed (exit ${code}).`,
            ),
          );
        }
      });
    });
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installAntigravityPlugin(input: {
  readonly profileDir: string;
  readonly tempRoot: string;
  readonly stateDir?: string | undefined;
  readonly binaryPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly pluginName: string;
  readonly source?: string | undefined;
  readonly remoteMarketplaceName?: string | undefined;
  readonly fetch?: AntigravityExtensionsFetch | undefined;
}): Promise<{ readonly pluginName: string }> {
  const directSource = optionalText(input.source);
  const rawName = input.pluginName.trim();
  const isDirectSource =
    directSource !== undefined ||
    /^https?:\/\//i.test(rawName) ||
    rawName.startsWith("/") ||
    rawName.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(rawName);

  if (isDirectSource) {
    const sourceTarget = directSource ?? rawName;
    return enqueueProfileWrite(input.profileDir, async () => {
      const executable = await resolveAntigravityCliExecutable({
        binaryPath: input.binaryPath,
        stateDir: input.stateDir,
      });
      await runAntigravityCliPluginInstall({
        executable,
        profileDir: input.profileDir,
        tempRoot: input.tempRoot,
        source: sourceTarget,
        env: input.env,
      });
      return { pluginName: normalizePluginDirName(rawName) };
    });
  }

  const targetName = normalizePluginDirName(rawName);
  if (!isSafeAntigravityEntryName(targetName)) {
    throw new Error(`Invalid Antigravity plugin name: ${input.pluginName}`);
  }

  const catalog = await fetchMarketplaceCatalogs({ fetch: input.fetch });
  const entry =
    catalog.entries.find(
      (candidate) =>
        candidate.name === targetName &&
        (!input.remoteMarketplaceName || candidate.marketplaceName === input.remoteMarketplaceName),
    ) ?? catalog.entries.find((candidate) => candidate.name === targetName);

  if (!entry || !entry.archiveUrl || !entry.archiveSha256) {
    throw new Error(`Plugin "${targetName}" was not found in the Antigravity plugin marketplaces.`);
  }

  return enqueueProfileWrite(input.profileDir, async () => {
    const pluginsDir = await ensureSafeProfileTarget(input.profileDir, ["config", "plugins"]);
    await fs.mkdir(pluginsDir, { recursive: true, mode: 0o700 });
    const stagingDir = join(
      input.profileDir,
      "config",
      `.plugin-install-${randomBytes(4).toString("hex")}`,
    );
    const archivePath = join(stagingDir, "plugin.zip");
    const extractDir = join(stagingDir, "unpacked");
    await fs.mkdir(extractDir, { recursive: true, mode: 0o700 });

    try {
      await downloadVerifiedPluginArchive({
        url: entry.archiveUrl!,
        expectedSha256: entry.archiveSha256!,
        destination: archivePath,
        fetch: input.fetch ?? defaultCatalogFetch,
      });
      try {
        await extractArchive({
          archivePath,
          kind: "zip",
          outDir: extractDir,
          limits: {
            maxBytes: MAX_PLUGIN_EXTRACTED_BYTES,
            maxEntries: MAX_PLUGIN_EXTRACTED_ENTRIES,
          },
        });
      } catch (error) {
        if (error instanceof ArchiveError) {
          throw new Error(`Plugin archive is unsafe or malformed: ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }

      const pluginRoot = await locateExtractedPluginRoot(extractDir);
      const targetDir = join(pluginsDir, targetName);
      const backupDir = join(stagingDir, `previous-${randomBytes(4).toString("hex")}`);
      const existingStat = await fs.lstat(targetDir).catch(() => null);
      if (existingStat) {
        await fs.rename(targetDir, backupDir);
      }
      try {
        await fs.rename(pluginRoot, targetDir);
      } catch (error) {
        if (existingStat) {
          await fs.rename(backupDir, targetDir).catch(() => undefined);
        }
        throw error;
      }

      await recordImportManifestEntry(input.profileDir, targetName, {
        source: entry.marketplaceName,
        version: entry.version,
      });

      // Clear any stale disabled override when freshly installing from the catalog.
      const configPath = antigravityProfileConfigPath(input.profileDir);
      const configResult = await readJsoncFile(configPath);
      if (configResult.kind === "ok" && isRecord(configResult.doc.plugins)) {
        const pluginsMap = { ...configResult.doc.plugins };
        if (targetName in pluginsMap) {
          delete pluginsMap[targetName];
          await writeProfileJsonAtomic(input.profileDir, ["config", "config.json"], {
            ...configResult.doc,
            plugins: pluginsMap,
          });
        }
      }

      return { pluginName: targetName };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export async function uninstallAntigravityPlugin(input: {
  readonly profileDir: string;
  readonly pluginId: string;
}): Promise<{ readonly uninstalled: boolean }> {
  const dirName = normalizePluginDirName(input.pluginId);
  if (!isSafeAntigravityEntryName(dirName)) {
    throw new Error(`Invalid Antigravity plugin name: ${input.pluginId}`);
  }
  return enqueueProfileWrite(input.profileDir, async () => {
    const realProfile = await fs.realpath(input.profileDir).catch(() => null);
    if (!realProfile) {
      throw new Error(`Antigravity profile directory does not exist: ${input.profileDir}`);
    }
    const configDir = join(input.profileDir, "config");
    const configLstat = await fs.lstat(configDir).catch(() => null);
    if (!configLstat || configLstat.isSymbolicLink() || !configLstat.isDirectory()) {
      throw new Error(`Refusing to uninstall plugin through non-directory path: ${configDir}`);
    }
    const pluginsDir = antigravityProfilePluginsDir(input.profileDir);
    const pluginsLstat = await fs.lstat(pluginsDir).catch(() => null);
    if (!pluginsLstat || pluginsLstat.isSymbolicLink() || !pluginsLstat.isDirectory()) {
      throw new Error(`Refusing to uninstall plugin through non-directory path: ${pluginsDir}`);
    }
    const realPluginsDir = await fs.realpath(pluginsDir);
    if (realPluginsDir !== join(realProfile, "config", "plugins")) {
      throw new Error(`Refusing to uninstall plugin outside Antigravity profile: ${pluginsDir}`);
    }

    const target = join(pluginsDir, dirName);
    const targetLstat = await fs.lstat(target).catch(() => null);
    if (!targetLstat) {
      throw new Error(
        `Plugin "${dirName}" is not installed in this Antigravity profile (project plugins must be removed from the repository).`,
      );
    }
    const realParent = await fs.realpath(dirname(target));
    if (realParent !== realPluginsDir) {
      throw new Error(`Refusing to uninstall plugin outside profile plugins folder: ${target}`);
    }
    if (targetLstat.isSymbolicLink()) {
      await fs.unlink(target);
    } else {
      await fs.rm(target, { recursive: true, force: true });
    }

    const configPath = antigravityProfileConfigPath(input.profileDir);
    const configResult = await readJsoncFile(configPath);
    if (configResult.kind === "ok" && isRecord(configResult.doc.plugins)) {
      const nextPlugins = { ...configResult.doc.plugins };
      if (dirName in nextPlugins) {
        delete nextPlugins[dirName];
        await writeProfileJsonAtomic(input.profileDir, ["config", "config.json"], {
          ...configResult.doc,
          plugins: nextPlugins,
        });
      }
    }
    await removeImportManifestEntry(input.profileDir, dirName);
    return { uninstalled: true };
  });
}

export async function refreshAntigravityPluginCatalog(options?: {
  readonly fetch?: AntigravityExtensionsFetch | undefined;
}): Promise<{
  readonly refreshed: boolean;
  readonly refreshedMarketplaces: Array<string>;
  readonly errors: Array<string>;
}> {
  invalidateAntigravityPluginCatalogCache();
  const catalog = await fetchMarketplaceCatalogs({
    fetch: options?.fetch,
    forceRefresh: true,
  });
  const refreshedMarketplaces = ANTIGRAVITY_MARKETPLACES.filter((spec) =>
    catalog.countByMarketplace.has(spec.name),
  ).map((spec) => spec.name);
  return {
    refreshed: catalog.errors.length === 0,
    refreshedMarketplaces,
    errors: [...catalog.errors],
  };
}

// ── Antigravity MCP Connections ──────────────────────────────────────

function parseAntigravityMcpConfigEntry(input: {
  readonly name: string;
  readonly configuredName?: string | undefined;
  readonly rawEntry: Record<string, unknown>;
  readonly origin: NonNullable<ProviderExtensionMcpServer["origin"]>;
  readonly configPath: string;
  readonly canManage: boolean;
  readonly profileDir: string;
}): Promise<ProviderExtensionMcpServer> {
  return (async () => {
    const disabled = input.rawEntry.disabled === true;
    const timeoutSeconds =
      typeof input.rawEntry.timeoutSeconds === "number" &&
      Number.isInteger(input.rawEntry.timeoutSeconds)
        ? input.rawEntry.timeoutSeconds
        : undefined;
    const cachedToolName = input.configuredName ?? input.name;
    const toolDefinitions = await readCachedMcpTools(input.profileDir, cachedToolName);
    const tools = toolDefinitions.map((tool) => tool.name);

    const mcpRemote = detectMcpRemoteEntry(input.rawEntry, input.profileDir);
    if (mcpRemote) {
      const hasTokens = await hasAntigravityMcpRemoteTokens(input.profileDir, mcpRemote.urlHash);
      const headerKeys = Object.keys(mcpRemote.headers).toSorted();
      const config: ProviderExtensionMcpServerConfigSummary = {
        mode: "oauth",
        url: mcpRemote.url,
        ...(headerKeys.length > 0 ? { headerKeys } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      };
      return {
        name: input.name,
        ...(input.configuredName && input.configuredName !== input.name
          ? { configuredName: input.configuredName }
          : {}),
        origin: input.origin,
        enabled: !disabled,
        canToggle: input.canManage,
        canEdit: input.canManage,
        configPath: input.configPath,
        config,
        transport: "oauth (mcp-remote)",
        authStatus: hasTokens ? "OAuth" : "Not logged in",
        status: disabled ? "Disabled" : hasTokens ? "Ready" : "Needs auth",
        detail: mcpRemote.url,
        ...(tools.length > 0 ? { tools } : {}),
        ...(toolDefinitions.length > 0 ? { toolDefinitions } : {}),
        toolCount: tools.length,
        resourceCount: 0,
      };
    }

    const url = optionalText(input.rawEntry.serverUrl) ?? optionalText(input.rawEntry.url);
    if (url) {
      const rawHeaders = isRecord(input.rawEntry.headers) ? input.rawEntry.headers : {};
      const headerKeys = Object.keys(rawHeaders)
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
        .toSorted();
      const authProviderType: ProviderExtensionMcpServerAuthProviderType | undefined =
        input.rawEntry.authProviderType === "google_credentials" ? "google_credentials" : undefined;
      const config: ProviderExtensionMcpServerConfigSummary = {
        mode: "http",
        url,
        ...(headerKeys.length > 0 ? { headerKeys } : {}),
        ...(authProviderType ? { authProviderType } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      };
      const authStatus = authProviderType
        ? "Google ADC"
        : headerKeys.length > 0
          ? "Custom headers"
          : "No auth required";
      return {
        name: input.name,
        ...(input.configuredName && input.configuredName !== input.name
          ? { configuredName: input.configuredName }
          : {}),
        origin: input.origin,
        enabled: !disabled,
        canToggle: input.canManage,
        canEdit: input.canManage,
        configPath: input.configPath,
        config,
        transport: "http",
        authStatus,
        status: disabled ? "Disabled" : tools.length > 0 ? "Ready" : "Configured",
        detail: url,
        ...(tools.length > 0 ? { tools } : {}),
        ...(toolDefinitions.length > 0 ? { toolDefinitions } : {}),
        toolCount: tools.length,
        resourceCount: 0,
      };
    }

    const command = optionalText(input.rawEntry.command);
    const args = Array.isArray(input.rawEntry.args)
      ? input.rawEntry.args.filter((value): value is string => typeof value === "string")
      : [];
    const cwd = optionalText(input.rawEntry.cwd);
    const rawEnv = isRecord(input.rawEntry.env) ? input.rawEntry.env : {};
    const envKeys = Object.keys(rawEnv)
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .toSorted();
    const config: ProviderExtensionMcpServerConfigSummary | undefined = command
      ? {
          mode: "stdio",
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(cwd ? { cwd } : {}),
          ...(envKeys.length > 0 ? { envKeys } : {}),
          ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        }
      : undefined;
    const detail = command ? [command, ...args].join(" ") : undefined;
    return {
      name: input.name,
      ...(input.configuredName && input.configuredName !== input.name
        ? { configuredName: input.configuredName }
        : {}),
      origin: input.origin,
      enabled: !disabled,
      canToggle: input.canManage,
      canEdit: input.canManage,
      configPath: input.configPath,
      ...(config ? { config } : {}),
      ...(command ? { transport: "stdio" } : {}),
      status: disabled ? "Disabled" : tools.length > 0 ? "Ready" : "Configured",
      ...(detail ? { detail } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolDefinitions.length > 0 ? { toolDefinitions } : {}),
      toolCount: tools.length,
      resourceCount: 0,
    };
  })();
}

export async function listAntigravityMcpServers(input: {
  readonly profileDir: string;
  readonly projectCwd?: string | undefined;
  readonly projectBoundary?: string | undefined;
  readonly installedPlugins: ReadonlyArray<AntigravityInstalledPluginRecord>;
}): Promise<{
  readonly servers: Array<ProviderExtensionMcpServer>;
  readonly errors: Array<string>;
}> {
  const userConfigPath = antigravityProfileMcpConfigPath(input.profileDir);
  const projectConfigPath =
    input.projectCwd && input.projectBoundary
      ? join(input.projectCwd, ".agents", "mcp_config.json")
      : undefined;

  const [userResult, projectResult] = await Promise.all([
    readJsoncFile(userConfigPath),
    projectConfigPath
      ? readJsoncFile(projectConfigPath, { confineBoundary: input.projectBoundary })
      : Promise.resolve({ kind: "missing" as const }),
  ]);

  const errors: Array<string> = [];
  const entries: Array<Promise<ProviderExtensionMcpServer>> = [];

  if (projectResult.kind === "ok") {
    const serversMap = isRecord(projectResult.doc.mcpServers) ? projectResult.doc.mcpServers : {};
    for (const [rawName, rawEntry] of Object.entries(serversMap)) {
      const name = optionalText(rawName);
      if (!name || !isRecord(rawEntry)) continue;
      entries.push(
        parseAntigravityMcpConfigEntry({
          name,
          rawEntry,
          origin: { kind: "project" },
          configPath: projectConfigPath!,
          canManage: false,
          profileDir: input.profileDir,
        }),
      );
    }
  } else if (projectResult.kind === "error" || projectResult.kind === "unsafe") {
    errors.push(projectResult.message);
  }

  if (userResult.kind === "ok") {
    const serversMap = isRecord(userResult.doc.mcpServers) ? userResult.doc.mcpServers : {};
    for (const [rawName, rawEntry] of Object.entries(serversMap)) {
      const name = optionalText(rawName);
      if (!name || !isRecord(rawEntry)) continue;
      entries.push(
        parseAntigravityMcpConfigEntry({
          name,
          rawEntry,
          origin: { kind: "user" },
          configPath: userConfigPath,
          canManage: true,
          profileDir: input.profileDir,
        }),
      );
    }
  } else if (userResult.kind === "error") {
    errors.push(userResult.message);
  }

  for (const record of input.installedPlugins) {
    if (record.plugin.enabled === false) continue;
    for (const pluginServer of record.mcpConfigServers) {
      const configuredName = `${record.dirName}_${pluginServer.name}`;
      entries.push(
        parseAntigravityMcpConfigEntry({
          name: pluginServer.name,
          configuredName,
          rawEntry: pluginServer.rawEntry,
          origin: {
            kind: "plugin",
            pluginId: record.plugin.id,
            pluginName: record.plugin.displayName ?? record.plugin.name,
          },
          configPath: pluginServer.configPath,
          canManage: false,
          profileDir: input.profileDir,
        }),
      );
    }
  }

  const resolved = await Promise.all(entries);
  const byKey = new Map<string, ProviderExtensionMcpServer>();
  for (const server of resolved) {
    const key = (server.configuredName ?? server.name).toLowerCase();
    if (!byKey.has(key)) byKey.set(key, server);
  }
  return {
    servers: [...byKey.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    errors,
  };
}

function validateHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid MCP server URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("MCP server URL must start with https:// or http://.");
  }
  return trimmed;
}

function mergeSecretMap(input: {
  readonly existing: Record<string, string>;
  readonly keepKeys: ReadonlyArray<string> | undefined;
  readonly updates: Readonly<Record<string, string>> | undefined;
}): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const key of input.keepKeys ?? []) {
    const trimmed = key.trim();
    if (trimmed && existingHasKey(input.existing, trimmed)) {
      merged[trimmed] = input.existing[trimmed]!;
    }
  }
  for (const [rawKey, value] of Object.entries(input.updates ?? {})) {
    const key = rawKey.trim();
    if (!key) continue;
    if (
      value.length === 0 &&
      existingHasKey(input.existing, key) &&
      input.keepKeys?.includes(key)
    ) {
      merged[key] = input.existing[key]!;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function existingHasKey(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractStringRecord(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function collectReferencedMcpRemoteHashes(
  mcpServers: Readonly<Record<string, unknown>>,
  profileDir: string,
): Set<string> {
  const hashes = new Set<string>();
  for (const rawEntry of Object.values(mcpServers)) {
    if (!isRecord(rawEntry)) continue;
    const remote = detectMcpRemoteEntry(rawEntry, profileDir);
    if (remote) hashes.add(remote.urlHash);
  }
  return hashes;
}

export async function saveAntigravityMcpServer(input: {
  readonly profileDir: string;
  readonly request: ProviderExtensionMcpServerSaveInput;
}): Promise<ProviderExtensionMcpServerSaveResult> {
  const name = input.request.name.trim();
  if (!isSafeAntigravityEntryName(name)) {
    throw new Error(`Invalid MCP server name: ${input.request.name}`);
  }
  const previousName = optionalText(input.request.previousName);

  return enqueueProfileWrite(input.profileDir, async () => {
    const configPath = antigravityProfileMcpConfigPath(input.profileDir);
    const existingResult = await readJsoncFile(configPath);
    if (existingResult.kind === "error") {
      throw new Error(existingResult.message);
    }
    const doc: Record<string, unknown> =
      existingResult.kind === "ok" ? { ...existingResult.doc } : {};
    const mcpServers: Record<string, unknown> = isRecord(doc.mcpServers)
      ? { ...doc.mcpServers }
      : {};

    const hasOwnName = Object.prototype.hasOwnProperty.call(mcpServers, name);
    if (!previousName && hasOwnName) {
      throw new Error(`An MCP server named "${name}" already exists.`);
    }
    if (previousName && previousName !== name && hasOwnName) {
      throw new Error(`An MCP server named "${name}" already exists.`);
    }

    const existingEntry =
      previousName && isRecord(mcpServers[previousName]) ? mcpServers[previousName] : null;
    const previousRemote = existingEntry
      ? detectMcpRemoteEntry(existingEntry, input.profileDir)
      : null;

    const enabled =
      input.request.enabled ?? (existingEntry ? existingEntry.disabled !== true : true);
    const existingTimeoutSeconds =
      existingEntry &&
      typeof existingEntry.timeoutSeconds === "number" &&
      Number.isInteger(existingEntry.timeoutSeconds)
        ? existingEntry.timeoutSeconds
        : undefined;
    const timeoutSeconds = input.request.timeoutSeconds ?? existingTimeoutSeconds;

    let nextEntry: Record<string, unknown>;
    if (input.request.mode === "stdio") {
      const command = optionalText(input.request.command);
      if (!command) {
        throw new Error("A command is required for stdio MCP servers.");
      }
      const existingEnv = existingEntry ? extractStringRecord(existingEntry.env) : {};
      const mergedEnv = mergeSecretMap({
        existing: existingEnv,
        keepKeys: input.request.keepEnvKeys,
        updates: input.request.env,
      });
      const args = (input.request.args ?? []).filter((arg) => arg.length > 0);
      const serverCwd = optionalText(input.request.serverCwd);
      nextEntry = {
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
        ...(serverCwd ? { cwd: serverCwd } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        disabled: !enabled,
      };
    } else if (input.request.mode === "http") {
      const url = validateHttpUrl(input.request.url ?? "");
      const existingHeaders = existingEntry ? extractStringRecord(existingEntry.headers) : {};
      const mergedHeaders = mergeSecretMap({
        existing: existingHeaders,
        keepKeys: input.request.keepHeaderKeys,
        updates: input.request.headers,
      });
      nextEntry = {
        serverUrl: url,
        ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
        ...(input.request.authProviderType
          ? { authProviderType: input.request.authProviderType }
          : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        disabled: !enabled,
      };
    } else {
      // OAuth via `mcp-remote`, with per-profile token storage inside `<profileDir>/mcp-remote-auth`.
      const url = validateHttpUrl(input.request.url ?? "");
      const existingHeaders = previousRemote
        ? previousRemote.headers
        : existingEntry
          ? extractStringRecord(existingEntry.headers)
          : {};
      const mergedHeaders = mergeSecretMap({
        existing: existingHeaders,
        keepKeys: input.request.keepHeaderKeys,
        updates: input.request.headers,
      });
      const authDir = await resolveSafeProfileMcpRemoteAuthDir(input.profileDir, { create: true });
      const headerArgs = Object.entries(mergedHeaders).flatMap(([key, value]) => [
        "--header",
        `${key}: ${value}`,
      ]);
      nextEntry = {
        command: "npx",
        args: ["-y", "mcp-remote", url, ...headerArgs],
        env: {
          MCP_REMOTE_CONFIG_DIR: authDir!,
        },
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        disabled: !enabled,
      };
    }

    if (previousName && previousName !== name) {
      delete mcpServers[previousName];
    }
    mcpServers[name] = nextEntry;
    doc.mcpServers = mcpServers;

    const writtenPath = await writeProfileJsonAtomic(
      input.profileDir,
      ["config", "mcp_config.json"],
      doc,
    );
    if (previousRemote) {
      const stillReferenced = collectReferencedMcpRemoteHashes(mcpServers, input.profileDir);
      if (!stillReferenced.has(previousRemote.urlHash)) {
        await clearAntigravityMcpRemoteCredentials(input.profileDir, previousRemote.urlHash);
      }
    }
    return { name, configPath: writtenPath };
  });
}

export async function setAntigravityMcpServerEnabled(input: {
  readonly profileDir: string;
  readonly serverName: string;
  readonly enabled: boolean;
}): Promise<{ readonly effectiveEnabled: boolean }> {
  const name = input.serverName.trim();
  return enqueueProfileWrite(input.profileDir, async () => {
    const configPath = antigravityProfileMcpConfigPath(input.profileDir);
    const existingResult = await readJsoncFile(configPath);
    if (existingResult.kind === "error") throw new Error(existingResult.message);
    if (existingResult.kind !== "ok" || !isRecord(existingResult.doc.mcpServers)) {
      throw new Error(`MCP server "${name}" was not found in this Antigravity profile.`);
    }
    const mcpServers = { ...existingResult.doc.mcpServers };
    const entry = mcpServers[name];
    if (!isRecord(entry)) {
      throw new Error(`MCP server "${name}" was not found in this Antigravity profile.`);
    }
    mcpServers[name] = { ...entry, disabled: !input.enabled };
    await writeProfileJsonAtomic(input.profileDir, ["config", "mcp_config.json"], {
      ...existingResult.doc,
      mcpServers,
    });
    return { effectiveEnabled: input.enabled };
  });
}

export async function removeAntigravityMcpServer(input: {
  readonly profileDir: string;
  readonly serverName: string;
}): Promise<{ readonly removed: boolean }> {
  const name = input.serverName.trim();
  return enqueueProfileWrite(input.profileDir, async () => {
    const configPath = antigravityProfileMcpConfigPath(input.profileDir);
    const existingResult = await readJsoncFile(configPath);
    if (existingResult.kind === "error") throw new Error(existingResult.message);
    if (existingResult.kind !== "ok" || !isRecord(existingResult.doc.mcpServers)) {
      throw new Error(`MCP server "${name}" was not found in this Antigravity profile.`);
    }
    const mcpServers = { ...existingResult.doc.mcpServers };
    const entry = mcpServers[name];
    if (!isRecord(entry)) {
      throw new Error(`MCP server "${name}" was not found in this Antigravity profile.`);
    }
    const remote = detectMcpRemoteEntry(entry, input.profileDir);
    delete mcpServers[name];
    await writeProfileJsonAtomic(input.profileDir, ["config", "mcp_config.json"], {
      ...existingResult.doc,
      mcpServers,
    });
    if (remote) {
      const stillReferenced = collectReferencedMcpRemoteHashes(mcpServers, input.profileDir);
      if (!stillReferenced.has(remote.urlHash)) {
        await clearAntigravityMcpRemoteCredentials(input.profileDir, remote.urlHash);
      }
    }
    return { removed: true };
  });
}

export interface AntigravityMcpOAuthTarget {
  readonly serverName: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly authDir: string;
  readonly urlHash: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly terminalCommand: string;
}

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9._:/?=&,-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function redactMcpRemoteArgsForDisplay(args: ReadonlyArray<string>): Array<string> {
  const redacted: Array<string> = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    redacted.push(arg);
    if (arg === "--header" && i + 1 < args.length) {
      const raw = args[i + 1]!;
      const colonIndex = raw.indexOf(":");
      redacted.push(
        colonIndex > 0 ? `${raw.slice(0, colonIndex).trim()}: <redacted>` : "<redacted>",
      );
      i += 1;
    } else if (
      (arg === "--header-file" || arg === "--static-oauth-client-info") &&
      i + 1 < args.length
    ) {
      redacted.push("<redacted>");
      i += 1;
    }
  }
  return redacted;
}

/** Resolves the `mcp-remote` command and token directory for initiating OAuth sign-in. */
export async function resolveAntigravityMcpOAuthTarget(input: {
  readonly profileDir: string;
  readonly serverName: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
}): Promise<AntigravityMcpOAuthTarget> {
  const configPath = antigravityProfileMcpConfigPath(input.profileDir);
  const result = await readJsoncFile(configPath);
  if (result.kind !== "ok" || !isRecord(result.doc.mcpServers)) {
    throw new Error(`MCP server "${input.serverName}" was not found in this Antigravity profile.`);
  }
  const entry = result.doc.mcpServers[input.serverName];
  if (!isRecord(entry)) {
    throw new Error(`MCP server "${input.serverName}" was not found in this Antigravity profile.`);
  }
  const remote = detectMcpRemoteEntry(entry, input.profileDir, input.runtimeEnv);
  if (!remote) {
    throw new Error(
      `MCP server "${input.serverName}" is not configured for OAuth via mcp-remote. Edit the connection and choose Remote OAuth to sign in from Threadlines.`,
    );
  }
  const authDir = (await resolveSafeProfileMcpRemoteAuthDir(input.profileDir, { create: true }))!;
  const command = optionalText(entry.command) ?? "npx";
  const args = Array.isArray(entry.args)
    ? entry.args.filter((value): value is string => typeof value === "string")
    : ["-y", "mcp-remote", remote.url];
  const env: Record<string, string> = {
    ...extractStringRecord(entry.env),
    MCP_REMOTE_CONFIG_DIR: authDir,
  };
  const prefix =
    process.platform === "win32"
      ? `$env:MCP_REMOTE_CONFIG_DIR='${authDir.replaceAll("'", "''")}';`
      : `MCP_REMOTE_CONFIG_DIR='${authDir.replaceAll("'", "'\\''")}'`;
  const displayArgs = redactMcpRemoteArgsForDisplay(args);
  const terminalCommand = `${prefix} ${[command, ...displayArgs].map(shellQuoteArg).join(" ")}`;
  return {
    serverName: input.serverName,
    url: remote.url,
    headers: remote.headers,
    authDir,
    urlHash: remote.urlHash,
    command,
    args,
    env,
    terminalCommand,
  };
}

/** Extracts an OAuth authorization URL printed by `mcp-remote` to stderr/stdout. */
export function extractMcpRemoteAuthorizationUrl(output: string): string | undefined {
  const match =
    output.match(/Please authorize this client by visiting:\s*(https?:\/\/\S+)/i) ??
    output.match(/authorize[^\n]*?(https?:\/\/\S+)/i);
  if (!match?.[1]) return undefined;
  return match[1].replace(/[),.;]+$/, "");
}
