#!/usr/bin/env node
// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
/**
 * Warns when a version we typed into the code by hand has fallen behind what
 * its vendor publishes. Dependabot covers package.json; this covers the pins
 * it can't see (Antigravity, managed Node.js, the ACP and Codex protocol
 * schemas). `.github/workflows/upstream-drift.yml` runs it weekly.
 *
 *   node scripts/check-upstream-drift.ts           # dry run: prints results and the issue plan
 *   node scripts/check-upstream-drift.ts --apply   # also opens, updates and closes issues with `gh`
 *
 * Each pin that is behind gets one open issue, labelled `upstream-drift` and
 * marked with the pin's id in a hidden line of its body. Its body is rewritten while we stay behind, and the issue
 * is closed once we catch up. A source that can't be reached is reported as
 * "couldn't check" and leaves its issue alone. Exits 0 whether or not
 * anything drifted; nonzero means the script itself failed.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { fetchWithNetworkRetry } from "./fetch-with-network-retry.ts";

export const DRIFT_LABEL = "upstream-drift";

/** A published release, as we would write it into our pin. */
export interface PublishedRelease {
  readonly version: string;
  /** What to type into the file when it differs from `version` (a git tag). */
  readonly ref?: string;
  /** Anything else a maintainer must know before updating, one line each. */
  readonly notes?: ReadonlyArray<string>;
}

export interface DriftItem {
  /** Names the pin's issue in a hidden line of its body (`issueMarker`), so a renamed issue is still found. */
  readonly id: string;
  /** Issue title. */
  readonly title: string;
  readonly name: string;
  /** Where the published version comes from, as a reader would say it. */
  readonly source: string;
  readonly pinned: string;
  /** Repo-relative path of the file holding the pin. */
  readonly file: string;
  readonly howToUpdate: (published: PublishedRelease) => ReadonlyArray<string>;
}

export type LookupOutcome =
  | { readonly ok: true; readonly published: PublishedRelease }
  | { readonly ok: false; readonly reason: string };

export type DriftResult =
  | {
      readonly status: "drift" | "current";
      readonly item: DriftItem;
      readonly published: PublishedRelease;
    }
  | { readonly status: "unchecked"; readonly item: DriftItem; readonly reason: string };

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export type IssueAction =
  | { readonly kind: "open"; readonly title: string; readonly body: string }
  | {
      readonly kind: "update";
      readonly number: number;
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly kind: "close";
      readonly number: number;
      readonly title: string;
      readonly comment: string;
    };

// ── Versions ─────────────────────────────────────────────────────────

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
}

const VERSION_PATTERN =
  /^(?:schema-|rust-)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `1.2.3`, `v1.2.3`, `schema-v1.2.3` or `rust-v1.2.3`, with an optional prerelease. */
export function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleasePart(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order: negative when `a` is older than `b`. Throws on text that isn't a version. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index]! - right.core[index]!;
    if (delta !== 0) return delta;
  }
  // A release sorts after its own prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const delta = comparePrereleasePart(l, r);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The newest stable (non-prerelease) version among `versions`, if any. */
export function newestStable(versions: ReadonlyArray<string>): string | undefined {
  let newest: string | undefined;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (!parsed || parsed.prerelease.length > 0) continue;
    if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

// ── Pure decisions ───────────────────────────────────────────────────

export function evaluateDrift(item: DriftItem, outcome: LookupOutcome): DriftResult {
  if (!outcome.ok) return { status: "unchecked", item, reason: outcome.reason };
  if (!parseVersion(outcome.published.version)) {
    return {
      status: "unchecked",
      item,
      reason: `${item.source} returned "${outcome.published.version}", which is not a version`,
    };
  }
  const behind = compareVersions(outcome.published.version, item.pinned) > 0;
  return { status: behind ? "drift" : "current", item, published: outcome.published };
}

const display = (published: PublishedRelease) => published.ref ?? published.version;

/**
 * The hidden line that marks an issue as this check's issue for one pin. Only
 * issues carrying it are edited or closed, so one filed by hand is left alone.
 */
export const issueMarker = (id: string) => `<!-- upstream-drift:${id} -->`;

export function issueBody(item: DriftItem, published: PublishedRelease): string {
  return [
    issueMarker(item.id),
    `We pin ${item.name} **${item.pinned}**. ${item.source} now has **${display(published)}**.`,
    "",
    `The pin lives in \`${item.file}\`. To update:`,
    "",
    ...item.howToUpdate(published).map((step) => `- ${step}`),
    ...(published.notes && published.notes.length > 0
      ? ["", ...published.notes.map((note) => `**${note}**`)]
      : []),
    "",
    "<sub>Kept up to date by the weekly upstream drift check (`.github/workflows/upstream-drift.yml`). It closes this issue once the pin catches up.</sub>",
  ].join("\n");
}

/**
 * What to do with the drift issues: open one per drifting item that has none,
 * rewrite a body that changed, and close the issue of an item that caught up.
 * Items that couldn't be checked leave their issue as it is.
 */
export function planIssueActions(
  results: ReadonlyArray<DriftResult>,
  openIssues: ReadonlyArray<OpenIssue>,
): ReadonlyArray<IssueAction> {
  const actions: Array<IssueAction> = [];
  for (const result of results) {
    const { title } = result.item;
    const marker = issueMarker(result.item.id);
    const existing = openIssues.find((issue) => issue.body.includes(marker));
    if (result.status === "drift") {
      const body = issueBody(result.item, result.published);
      if (!existing) actions.push({ kind: "open", title, body });
      else if (existing.body.trim() !== body.trim()) {
        actions.push({ kind: "update", number: existing.number, title, body });
      }
    } else if (result.status === "current" && existing) {
      actions.push({
        kind: "close",
        number: existing.number,
        title,
        comment: `We pin ${result.item.pinned} now, and ${result.item.source} has ${display(result.published)}. Closing.`,
      });
    }
  }
  return actions;
}

// ── The pins ─────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ANTIGRAVITY_FILE = "apps/server/src/provider/antigravity/AntigravityRelease.ts";
const MANAGED_NODE_FILE = "apps/server/src/provider/managedRuntime/ManagedNode.ts";
const ACP_GENERATE_FILE = "packages/effect-acp/scripts/generate.ts";
const CODEX_GENERATE_FILE = "packages/effect-codex-app-server/scripts/generate.ts";

const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
const ACP_RELEASES_URL =
  "https://api.github.com/repos/agentclientprotocol/agent-client-protocol/releases?per_page=100";
const CODEX_NPM_URL = "https://registry.npmjs.org/@openai%2fcodex";

/** Reads an exported string at `path` from a module that has no side effects on import. */
async function importedString(file: string, read: (module: unknown) => unknown): Promise<string> {
  const module: unknown = await import(pathToFileURL(join(ROOT, file)).href);
  const value = read(module);
  if (typeof value !== "string") throw new Error(`No pinned version found in ${file}`);
  return value;
}

/** Reads `const NAME = "..."` from a script that runs when imported, so can't be. */
async function constantFromSource(file: string, name: string): Promise<string> {
  const source = await readFile(join(ROOT, file), "utf8");
  const match = new RegExp(`^const ${name} = "([^"]+)";$`, "m").exec(source);
  if (!match?.[1]) throw new Error(`No \`const ${name} = "..."\` found in ${file}`);
  return match[1];
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

interface PinnedLookup {
  readonly item: DriftItem;
  readonly lookup: () => Promise<PublishedRelease>;
}

export async function loadPins(): Promise<ReadonlyArray<PinnedLookup>> {
  const [antigravity, node, acpSchema, codexProtocol] = await Promise.all([
    importedString(ANTIGRAVITY_FILE, (module) =>
      field(field(module, "ANTIGRAVITY_RELEASE"), "version"),
    ),
    importedString(MANAGED_NODE_FILE, (module) =>
      field(field(module, "MANAGED_NODE_RELEASE"), "version"),
    ),
    constantFromSource(ACP_GENERATE_FILE, "CURRENT_SCHEMA_RELEASE"),
    constantFromSource(CODEX_GENERATE_FILE, "CODEX_PROTOCOL_VERSION"),
  ]);
  const nodeMajor = parseVersion(node)?.core[0];
  if (nodeMajor === undefined) throw new Error(`Managed Node pin "${node}" is not a version`);

  return [
    {
      item: {
        id: "antigravity",
        title: "Upstream drift: Antigravity",
        name: "Google's Antigravity CLI at",
        source: "Google's CLI update feed",
        pinned: antigravity,
        file: ANTIGRAVITY_FILE,
        howToUpdate: ({ version }) => [
          `Users are already offered ${version} through Settings (\`AntigravityReleaseSource\`) wherever the feed's manifest fits; this pin is what installs when the feed can't be read, and the oldest version offered.`,
          "Read Google's changelog (https://github.com/google-antigravity/antigravity-cli) for `agy acp` changes, and check the sign-in behavior noted in `apps/server/src/provider/antigravity/AntigravitySignInMethod.ts` and `AntigravityAuth.ts` against it.",
          `Then set the built-in release to ${version}: take each build's url and sha512 from its manifest (\`antigravityFeedUrl\`), and measure each download's size and its unpacked \`antigravity\` file's size.`,
        ],
      },
      lookup: async () => {
        const module: unknown = await import(pathToFileURL(join(ROOT, ANTIGRAVITY_FILE)).href);
        const feedUrl = field(module, "antigravityFeedUrl");
        const parse = field(module, "parseAntigravityFeedManifest");
        if (typeof feedUrl !== "function" || typeof parse !== "function") {
          throw new Error(`No feed reader in ${ANTIGRAVITY_FILE}`);
        }
        const manifests = await Promise.all(
          ANTIGRAVITY_BUILDS.map(async (assetKey) => {
            const manifest = await fetchJson(feedUrl(assetKey) as string);
            return { assetKey, manifest, fits: parse(manifest, assetKey) !== undefined };
          }),
        );
        const versions = manifests.map(({ manifest }) => field(manifest, "version"));
        // The newest any build has: a release can reach one platform first.
        const version = versions
          .filter(
            (value): value is string =>
              typeof value === "string" && parseVersion(value) !== undefined,
          )
          .reduce<string | undefined>(
            (newest, value) =>
              newest === undefined || compareVersions(value, newest) > 0 ? value : newest,
            undefined,
          );
        if (version === undefined) throw new Error("the feed named no version");
        const behind = manifests
          .filter((_, index) => versions[index] !== version)
          .map(({ assetKey }) => assetKey);
        const refused = manifests.filter(({ fits }) => !fits).map(({ assetKey }) => assetKey);
        return {
          version,
          ...(refused.length > 0 || behind.length > 0
            ? {
                notes: [
                  ...(behind.length > 0
                    ? [`The feed doesn't list ${version} for ${behind.join(", ")} yet.`]
                    : []),
                  ...(refused.length > 0
                    ? [
                        `Threadlines won't offer the feed's release on ${refused.join(", ")}: its manifest changed (download host, folder, file name or hash), so \`parseAntigravityFeedManifest\` refuses it. Check what changed and teach Threadlines to install it.`,
                      ]
                    : []),
                ],
              }
            : {}),
        };
      },
    },
    {
      item: {
        id: "managed-node",
        title: "Upstream drift: managed Node.js",
        name: "Node.js",
        source: `nodejs.org (the ${nodeMajor}.x line)`,
        pinned: node,
        file: MANAGED_NODE_FILE,
        howToUpdate: ({ version }) => [
          `Change the version and the six archive URLs to v${version}.`,
          `Take each archive's sha256 from https://nodejs.org/dist/v${version}/SHASUMS256.txt, and its size and unpacked size from the download.`,
          "Only this major line is checked. Moving to a new major is a separate decision.",
        ],
      },
      lookup: async () => {
        const index = await fetchJson(NODE_INDEX_URL);
        if (!Array.isArray(index)) throw new Error("index.json is not a list");
        const versions = index
          .map((entry: unknown) => field(entry, "version"))
          .filter((version): version is string => typeof version === "string")
          .filter((version) => parseVersion(version)?.core[0] === nodeMajor);
        const newest = newestStable(versions);
        if (!newest) throw new Error(`no ${nodeMajor}.x release in index.json`);
        return { version: newest.replace(/^v/, "") };
      },
    },
    {
      item: {
        id: "acp-schema",
        title: "Upstream drift: ACP schema",
        name: "the ACP schema at",
        source: "agentclientprotocol/agent-client-protocol",
        pinned: acpSchema,
        file: ACP_GENERATE_FILE,
        howToUpdate: (published) => [
          `Set \`CURRENT_SCHEMA_RELEASE\` to \`${display(published)}\`. Schema releases are tagged \`schema-v*\` now; the plain \`v*\` tags are the Rust crate and carry no schema.`,
          "Run `node packages/effect-acp/scripts/generate.ts`, then fix what the new bindings break and run the ACP driver tests.",
        ],
      },
      lookup: async () => {
        // Releases alternate between the Rust crate (`v*`, no files) and the
        // schema (`schema-v*`), so "latest release" can't be trusted. Take the
        // newest stable release that ships the file the generator downloads.
        const releases = await fetchJson(ACP_RELEASES_URL, githubHeaders());
        if (!Array.isArray(releases)) throw new Error("the releases list is not a list");
        const tags = releases
          .filter((release: unknown) => field(release, "draft") !== true)
          .filter((release: unknown) => field(release, "prerelease") !== true)
          .filter((release: unknown) => {
            const assets = field(release, "assets");
            return (
              Array.isArray(assets) &&
              assets.some((asset: unknown) => field(asset, "name") === "schema.unstable.json")
            );
          })
          .map((release: unknown) => field(release, "tag_name"))
          .filter((tag): tag is string => typeof tag === "string");
        const newest = newestStable(tags);
        if (!newest) throw new Error("no stable release with schema.unstable.json");
        return { version: newest.replace(/^schema-v|^v/, ""), ref: newest };
      },
    },
    {
      item: {
        id: "codex-protocol",
        title: "Upstream drift: Codex app-server protocol",
        name: "the Codex app-server protocol at",
        source: "npm (`@openai/codex` latest)",
        pinned: codexProtocol,
        file: CODEX_GENERATE_FILE,
        howToUpdate: ({ version }) => [
          `Set \`CODEX_PROTOCOL_VERSION\` to \`${version}\`. The generator runs \`codex\` and refuses any other version, so install \`@openai/codex@${version}\` or point \`THREADLINES_CODEX_SCHEMA_BINARY\` at that build.`,
          "Run `node packages/effect-codex-app-server/scripts/generate.ts`, then fix what the new bindings break.",
          "Run the Codex replay tests in `apps/server/integration/replay`.",
        ],
      },
      lookup: async () => {
        // npm `latest` is the stable CLI release; `rust-v*` tags on GitHub
        // also include alphas. The generator checks `codex --version` against
        // the pin, and that version is the npm one.
        const packument = await fetchJson(CODEX_NPM_URL);
        const latest = field(field(packument, "dist-tags"), "latest");
        if (typeof latest !== "string") throw new Error("no latest dist-tag");
        return { version: latest };
      },
    },
  ];
}

/** Threadlines' name for each Antigravity build (`AntigravityAssetKey`). */
const ANTIGRAVITY_BUILDS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "win32-arm64",
  "win32-x64",
] as const;

// ── I/O ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "threadlines-drift-check";

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetchWithNetworkRetry(url, {
    maxAttempts: 2,
    timeoutMs: FETCH_TIMEOUT_MS,
    // The ACP CDN answers 403 to some default user agents.
    fetchImplementation: (input, init) =>
      fetch(input, { ...init, headers: { "user-agent": USER_AGENT, ...headers } }),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function checkPin(pin: PinnedLookup): Promise<DriftResult> {
  try {
    return evaluateDrift(pin.item, { ok: true, published: await pin.lookup() });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return evaluateDrift(pin.item, { ok: false, reason });
  }
}

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;

async function gh(args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function listOpenDriftIssues(): Promise<ReadonlyArray<OpenIssue>> {
  const output = await gh([
    "issue",
    "list",
    "--label",
    DRIFT_LABEL,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,body",
  ]);
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("gh issue list did not return a list");
  return parsed.flatMap((issue: unknown) => {
    const number = field(issue, "number");
    const title = field(issue, "title");
    const body = field(issue, "body");
    return typeof number === "number" && typeof title === "string"
      ? [{ number, title, body: typeof body === "string" ? body : "" }]
      : [];
  });
}

async function applyAction(action: IssueAction): Promise<void> {
  switch (action.kind) {
    case "open":
      await gh([
        "issue",
        "create",
        "--title",
        action.title,
        "--body",
        action.body,
        "--label",
        DRIFT_LABEL,
      ]);
      return;
    case "update":
      await gh(["issue", "edit", String(action.number), "--body", action.body]);
      return;
    case "close":
      await gh(["issue", "close", String(action.number), "--comment", action.comment]);
      return;
  }
}

function describeResult(result: DriftResult): string {
  const { item } = result;
  const label = item.title.replace(/^Upstream drift: /, "");
  switch (result.status) {
    case "drift":
      return `DRIFT     ${label}: we pin ${item.pinned}, ${item.source} has ${display(result.published)}`;
    case "current":
      return `current   ${label}: ${item.pinned} (${item.source} has ${display(result.published)})`;
    case "unchecked":
      return `unchecked ${label}: couldn't check (${result.reason})`;
  }
}

function describeAction(action: IssueAction): string {
  switch (action.kind) {
    case "open":
      return `open issue "${action.title}"`;
    case "update":
      return `update issue #${action.number} "${action.title}"`;
    case "close":
      return `close issue #${action.number} "${action.title}"`;
  }
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const unknownFlags = argv.filter((arg) => arg !== "--apply" && arg !== "--dry-run");
  if (unknownFlags.length > 0) throw new Error(`Unknown arguments: ${unknownFlags.join(" ")}`);
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    throw new Error("Pass --apply or --dry-run, not both.");
  }
  const apply = argv.includes("--apply");

  const pins = await loadPins();
  const results = await Promise.all(pins.map(checkPin));
  for (const result of results) console.log(describeResult(result));

  if (process.env.GITHUB_ACTIONS === "true") {
    for (const result of results) {
      if (result.status === "unchecked") {
        console.log(`::warning title=${result.item.title}::Couldn't check: ${result.reason}`);
      }
    }
  }

  let openIssues: ReadonlyArray<OpenIssue>;
  try {
    openIssues = await listOpenDriftIssues();
  } catch (error) {
    if (apply) throw error;
    console.log(`\n(gh couldn't list issues, so the plan assumes none are open: ${String(error)})`);
    openIssues = [];
  }

  const actions = planIssueActions(results, openIssues);
  console.log(apply ? "\nIssue changes:" : "\nIssue changes (dry run, nothing written):");
  if (actions.length === 0) console.log("  none");
  for (const action of actions) console.log(`  ${describeAction(action)}`);
  if (!apply) {
    for (const action of actions) {
      if (action.kind !== "close") console.log(`\n--- ${action.title} ---\n${action.body}`);
    }
    return;
  }

  if (actions.some((action) => action.kind === "open")) {
    await gh([
      "label",
      "create",
      DRIFT_LABEL,
      "--color",
      "FBCA04",
      "--description",
      "A version pinned in code is behind its vendor's latest release.",
      "--force",
    ]);
  }
  // One failed change doesn't stop the others; the run still fails at the end.
  let failures = 0;
  for (const action of actions) {
    try {
      await applyAction(action);
    } catch (error) {
      failures += 1;
      console.error(`Couldn't ${describeAction(action)}: ${String(error)}`);
    }
  }
  if (failures > 0) throw new Error(`${failures} issue change(s) failed`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
