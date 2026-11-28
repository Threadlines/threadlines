/**
 * AntigravitySkills — the skills Google's Antigravity CLI loads for a
 * folder, read from disk the way the CLI finds them, for the provider
 * snapshot's `skills`.
 *
 * Global skills are read through the instance's profile, which is what the
 * agent sees: the user's own folders arrive there as links or copies
 * (`AntigravityUserConfig`), and a folder the agent made in the profile
 * counts as it does for the agent. Where the CLI looks, in the order that
 * decides which copy of a name wins (T3 Code's native root order, checked
 * against its tests):
 *
 * 1. `<profile>/config/skills`
 * 2. `<project>/.gemini/skills`
 * 3. `<profile>/antigravity-cli/skills`
 * 4. `<project>/.agents/skills`, then the legacy `<project>/.agent/skills`
 * 5. Folders a manifest declares: the project's `.agents/skills.json` (and
 *    legacy `.agent/skills.json`) in every folder from the project up to its
 *    repository root, then `<profile>/config/skills.json`. A project
 *    manifest's paths resolve against the folder holding `.agents`, any
 *    other manifest's against its own folder.
 * 6. Plugins installed in the profile
 *
 * A root holding a `SKILL.md` is one skill; otherwise each folder directly
 * inside it is. Manifests follow the CLI's rules (changelog 1.4 to 1.5.2):
 * `inherits` reads another manifest, `include_only` and `exclude` match
 * names literally (no patterns), may be null, and apply to a named skill
 * folder or `SKILL.md` alike, a nested item loads only when `include_only`
 * names it (`category/my-skill`), and `~` is not expanded.
 *
 * Project files are untrusted, so nothing outside the project or its
 * repository root is listed or even opened for a project: the CLI skips
 * manifest entries that leave it, and a project skill folder linked from
 * outside is not listed either (the agent may still load that one).
 *
 * Every directory entry, lookup and byte read is charged to a budget, and
 * the scan stops at a deadline, so a huge or hostile tree can't stall a
 * status check; past either it keeps what it found.
 *
 * @module provider/antigravity/AntigravitySkills
 */
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ServerProviderSkill } from "@threadlines/contracts";
import { fromYaml } from "@threadlines/shared/schemaYaml";
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openRegularFile, readOpenedRegularFile } from "./AntigravityFileReads.ts";

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_INHERIT_DEPTH = 10;
const READ_CHUNK_BYTES = 4096;
/** A longer name is no name the CLI offers; it is left out rather than cut. */
const MAX_NAME_LENGTH = 256;
/** What is kept of a description: it is sent to every client and searched (as registry agents). */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** The longest a listing may run; past it the scan stops where it is. */
const LIST_TIME_LIMIT = Duration.seconds(5);

const SkillFrontMatter = fromYaml(
  Schema.Struct({
    name: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeFrontMatter = Schema.decodeUnknownOption(SkillFrontMatter);

const NullableNames = Schema.optional(Schema.NullOr(Schema.Array(Schema.String)));
const ManifestEntry = Schema.Struct({
  path: Schema.String,
  include_only: NullableNames,
  exclude: NullableNames,
});
type ManifestEntry = typeof ManifestEntry.Type;
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      inherits: Schema.optional(Schema.NullOr(Schema.Array(ManifestEntry))),
      entries: Schema.optional(Schema.NullOr(Schema.Array(ManifestEntry))),
    }),
  ),
);
const decodePluginSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
);

type Scope = "user" | "project";

/** Whether a path may be opened; a project's scan only reaches inside the project. */
type Confine = (path: string) => Promise<boolean>;

/** Names a manifest lets through: in every `include_only` list met on the way, in no `exclude`. */
interface NameFilter {
  readonly includeGroups: ReadonlyArray<ReadonlyArray<string>>;
  readonly exclude: ReadonlyArray<string>;
}

const NO_FILTER: NameFilter = { includeGroups: [], exclude: [] };

const narrowFilter = (parent: NameFilter, entry: ManifestEntry): NameFilter => ({
  includeGroups:
    entry.include_only && entry.include_only.length > 0
      ? [...parent.includeGroups, entry.include_only]
      : parent.includeGroups,
  exclude: entry.exclude ? [...parent.exclude, ...entry.exclude] : parent.exclude,
});

const passesFilter = (name: string, filter: NameFilter) =>
  filter.includeGroups.every((group) => group.includes(name)) && !filter.exclude.includes(name);

/** The CLI orders a folder's children by their escaped URL path (Go's `URL.EscapedPath`). */
const escapedPathKey = (name: string) =>
  encodeURI(name).replace(
    /[!'()*?#]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const byEscapedPath = (left: string, right: string) => {
  const a = escapedPathKey(left);
  const b = escapedPathKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Front matter between the first two `---`, as the CLI finds them (text may come before). */
function frontMatterOf(text: string): string | undefined {
  const start = text.indexOf("---");
  if (start === -1) return undefined;
  const end = text.indexOf("---", start + 3);
  return end === -1 ? undefined : text.slice(start + 3, end).trim();
}

class SkillScan {
  private remainingBytes = MAX_SCAN_BYTES;
  private remainingEntries = MAX_SCAN_ENTRIES;
  /** Set once the budget or the time runs out; the scan stops and keeps what it found. */
  exhausted = false;
  readonly skills = new Map<string, ServerProviderSkill>();

  private readonly deadline: number;

  constructor(deadline: number) {
    this.deadline = deadline;
  }

  /** Charges `count` entries or lookups; false (and the scan over) when they don't fit. */
  private spend(count: number) {
    if (this.exhausted || count > this.remainingEntries || Date.now() > this.deadline) {
      this.exhausted = true;
      return false;
    }
    this.remainingEntries -= count;
    return true;
  }

  private async stat(path: string) {
    return this.spend(1) ? fs.stat(path).catch(() => undefined) : undefined;
  }

  realpath(path: string) {
    return this.spend(1) ? fs.realpath(path).catch(() => undefined) : Promise.resolve(undefined);
  }

  /** A folder's names, read one entry at a time so a huge folder costs only the budget. */
  private async readDir(dir: string): Promise<Array<string> | undefined> {
    if (!this.spend(1)) return undefined;
    const handle = await fs.opendir(dir, { bufferSize: 32 }).catch(() => undefined);
    if (!handle) return undefined;
    const names: Array<string> = [];
    try {
      for await (const entry of handle) {
        if (!this.spend(1)) return undefined;
        names.push(entry.name);
      }
    } catch {
      return undefined;
    }
    return names;
  }

  /** Reads a skill file up to the end of its front matter, within the budget. */
  private async readHead(path: string): Promise<string | undefined> {
    if (!this.spend(1)) return undefined;
    const limit = Math.min(MAX_SKILL_BYTES, this.remainingBytes);
    const opened = await openRegularFile(path, { followLink: true });
    if (!opened) return undefined;
    try {
      const chunks: Array<Buffer> = [];
      let total = 0;
      let markers = 0;
      let dashes = 0;
      while (total <= limit) {
        const buffer = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await opened.handle.read(buffer, 0, READ_CHUNK_BYTES, total);
        if (bytesRead === 0) break;
        let end = bytesRead;
        for (let index = 0; index < bytesRead && markers < 2; index += 1) {
          dashes = buffer[index] === 0x2d ? dashes + 1 : 0;
          if (dashes === 3) {
            dashes = 0;
            markers += 1;
            if (markers === 2) end = index + 1;
          }
        }
        chunks.push(buffer.subarray(0, end));
        total += end;
        if (markers === 2) break;
      }
      this.remainingBytes -= Math.min(total, limit);
      if (total > limit) {
        // One oversized file is skipped; a spent budget ends the scan.
        if (limit < MAX_SKILL_BYTES) this.exhausted = true;
        return undefined;
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await opened.handle.close();
    }
  }

  /** Reads a small JSON file (a manifest, plugin settings) within the budget. */
  async readSmall(path: string): Promise<string | undefined> {
    if (!this.spend(1)) return undefined;
    const maxBytes = Math.min(MAX_SKILL_BYTES, this.remainingBytes);
    const opened = await openRegularFile(path, { followLink: true });
    if (!opened) return undefined;
    try {
      if (opened.size > maxBytes) {
        if (maxBytes < MAX_SKILL_BYTES) this.exhausted = true;
        return undefined;
      }
      const bytes = await readOpenedRegularFile(opened.handle, {
        maxBytes,
        expectedSize: opened.size,
      });
      if (bytes === undefined) return undefined;
      this.remainingBytes -= bytes.byteLength;
      return bytes.toString("utf8");
    } finally {
      await opened.handle.close();
    }
  }

  /** Adds the skill at `skillFile` unless a copy with its name came first. */
  private async addSkill(
    skillFile: string,
    scope: Scope,
    options?: { readonly keepDiscoveredPath?: boolean },
  ) {
    const head = await this.readHead(skillFile);
    const frontMatter = head === undefined ? undefined : frontMatterOf(head);
    if (frontMatter === undefined) return;
    const parsed = decodeFrontMatter(frontMatter || "{}");
    if (Option.isNone(parsed)) return;
    // A skill without a name is named after its folder (CLI 1.5.10).
    const name = parsed.value.name || basename(dirname(skillFile));
    // The CLI keeps names as written; one with outer spaces can't be offered by name.
    if (!name || name !== name.trim() || name.length > MAX_NAME_LENGTH) return;
    if (this.skills.has(name)) return;
    const description = capText(
      parsed.value.description?.trim() ?? "",
      MAX_SKILL_DESCRIPTION_LENGTH,
    ).trim();
    this.skills.set(name, {
      name,
      // Where it really is: for profile links, resolve through the profile link
      // to the user's own folder; for direct roots such as `~/.agents/skills`,
      // preserve the discovered path so symlink targets stay distinct from `~/.gemini`.
      path: options?.keepDiscoveredPath
        ? skillFile
        : ((await this.realpath(skillFile)) ?? skillFile),
      scope,
      enabled: true,
      ...(description ? { description } : {}),
    });
  }

  /** The `SKILL.md` directly in `dir` (any case), if there is one. */
  private async skillFileIn(dir: string, names?: ReadonlyArray<string>) {
    const listed = names ?? (await this.readDir(dir));
    const found = listed?.toSorted().find((name) => name.toLowerCase() === "skill.md");
    if (found === undefined) return undefined;
    const path = join(dir, found);
    return (await this.stat(path))?.isFile() ? path : undefined;
  }

  /**
   * A skills folder: a skill itself when it holds a `SKILL.md` (and `filter`
   * lets its name through), otherwise each folder directly inside it that
   * `filter` lets through, plus nested items `include_only` names. With
   * `confine`, nothing outside it is listed or opened.
   */
  async scanFolder(
    dir: string,
    scope: Scope,
    filter: NameFilter,
    confine?: Confine,
    options?: { readonly keepDiscoveredPath?: boolean },
  ) {
    if (this.exhausted) return;
    if (confine && !(await confine(dir))) return;
    if (!(await this.stat(dir))?.isDirectory()) return;
    const names = await this.readDir(dir);
    if (names === undefined) return;
    const own = await this.skillFileIn(dir, names);
    if (own) {
      if (passesFilter(basename(dir), filter) && (!confine || (await confine(own)))) {
        await this.addSkill(own, scope, options);
      }
      return;
    }
    const nested = filter.includeGroups
      .flat()
      .filter((name) => name.includes("/") && !name.split("/").includes(".."));
    const candidates = [...new Set([...names, ...nested])]
      .filter((name) => passesFilter(name, filter))
      .toSorted(byEscapedPath);
    for (const name of candidates) {
      if (this.exhausted) return;
      const child = join(dir, ...name.split("/"));
      if (confine && !(await confine(child))) continue;
      if (!(await this.stat(child))?.isDirectory()) continue;
      const skillFile = await this.skillFileIn(child);
      if (skillFile && (!confine || (await confine(skillFile)))) {
        await this.addSkill(skillFile, scope, options);
      }
    }
  }

  /** A manifest entry: a skills folder, or a `SKILL.md` named directly. */
  private async scanEntry(path: string, scope: Scope, filter: NameFilter, confine?: Confine) {
    if (confine && !(await confine(path))) return;
    const stat = await this.stat(path);
    if (stat?.isFile()) {
      if (basename(path).toLowerCase() !== "skill.md") return;
      if (!passesFilter(basename(dirname(path)), filter)) return;
      await this.addSkill(path, scope);
      return;
    }
    await this.scanFolder(path, scope, filter, confine);
  }

  /** A `skills.json`: its `inherits` first, then its `entries`. */
  async scanManifest(input: {
    readonly path: string;
    /** What its relative paths resolve against; the manifest's own folder by default. */
    readonly baseDir?: string;
    readonly scope: Scope;
    readonly filter: NameFilter;
    readonly confine?: Confine;
    readonly visited?: ReadonlySet<string>;
    readonly depth?: number;
  }): Promise<void> {
    const depth = input.depth ?? 0;
    const visited = input.visited ?? new Set<string>();
    const path = resolve(input.path);
    if (this.exhausted || depth > MAX_INHERIT_DEPTH || visited.has(path)) return;
    if (input.confine && !(await input.confine(path))) return;
    const raw = await this.readSmall(path);
    if (raw === undefined) return;
    const manifest = decodeManifest(raw);
    if (Option.isNone(manifest)) return;
    const baseDir = input.baseDir ?? dirname(path);
    // The CLI does not expand `~`, so `~/x` is a folder named `~` next to the manifest.
    const resolveEntry = (entryPath: string) =>
      isAbsolute(entryPath) ? resolve(entryPath) : resolve(baseDir, entryPath);
    const nextVisited = new Set(visited).add(path);
    for (const inherited of manifest.value.inherits ?? []) {
      await this.scanManifest({
        path: resolveEntry(inherited.path),
        scope: input.scope,
        filter: narrowFilter(input.filter, inherited),
        ...(input.confine ? { confine: input.confine } : {}),
        visited: nextVisited,
        depth: depth + 1,
      });
    }
    for (const entry of manifest.value.entries ?? []) {
      if (this.exhausted) return;
      await this.scanEntry(
        resolveEntry(entry.path),
        input.scope,
        narrowFilter(input.filter, entry),
        input.confine,
      );
    }
  }

  /** Skills of plugins installed in the profile, unless turned off in its settings. */
  async scanPlugins(profileDir: string) {
    const pluginsDir = join(profileDir, "config", "plugins");
    const plugins = await this.readDir(pluginsDir);
    if (!plugins || plugins.length === 0) return;
    const settings = await this.readSmall(join(profileDir, "config", "config.json"));
    const parsed = settings === undefined ? Option.none() : decodePluginSettings(settings);
    const states = Option.isSome(parsed) ? (parsed.value.plugins ?? {}) : {};
    for (const plugin of plugins.toSorted()) {
      if (this.exhausted) return;
      if (states[plugin]?.enabled === false) continue;
      await this.scanFolder(join(pluginsDir, plugin, "skills"), "user", NO_FILTER);
    }
  }
}

/** The nearest folder at or above `cwd` holding `.git`, or `cwd` when there is none. */
async function repositoryRoot(scan: SkillScan, cwd: string): Promise<string> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (scan.exhausted) return cwd;
    if (await fs.lstat(join(dir, ".git")).catch(() => undefined)) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

/** Antigravity 1.5.16 added discovery of user-global cross-tool skills in `~/.agents/skills`. */
export const ANTIGRAVITY_HOME_AGENTS_SKILLS_MIN_VERSION = "1.5.16";

/**
 * Whether an Antigravity CLI version loads `~/.agents/skills`. Returns false
 * only when a known version is strictly older than 1.5.16 (e.g. a custom 1.5.14
 * or 1.5.15 binary).
 */
export function antigravitySupportsHomeAgentsSkills(version: string | null | undefined): boolean {
  const trimmed = version?.trim();
  if (!trimmed) return true;
  const match = /^v?(\d+\.\d+\.\d+)/u.exec(trimmed);
  if (!match?.[1]) return true;
  return compareSemverVersions(match[1], ANTIGRAVITY_HOME_AGENTS_SKILLS_MIN_VERSION) >= 0;
}

export interface ListAntigravitySkillsInput {
  /** The folder a session would run in. */
  readonly cwd: string;
  /** The instance's profile (`GEMINI_HOME`), already prepared (`prepareAntigravityProfile`). */
  readonly profileDir: string;
  /** False on machine-wide views, so home-dir `.agents` / `.gemini` folders are not treated as project roots. */
  readonly includeProject?: boolean;
  /** The user's home folder (`$HOME` / `USERPROFILE`), for `~/.agents/skills` (CLI 1.5.16+). */
  readonly userHome?: string;
  /** False for older binaries (< 1.5.16) that do not read `~/.agents/skills`. Defaults to true. */
  readonly includeHomeAgentsSkills?: boolean;
}

export interface AntigravitySkillListing {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  /** The scan hit its budget or its deadline, so the list may be missing skills. */
  readonly truncated: boolean;
}

/** Lists the skills Antigravity would load in `cwd`, sorted by name. */
export async function listAntigravitySkillsNow(
  input: ListAntigravitySkillsInput,
  options: { readonly timeLimitMs?: number } = {},
): Promise<AntigravitySkillListing> {
  const cwd = resolve(input.cwd);
  const profile = resolve(input.profileDir);
  const includeProject = input.includeProject !== false;
  const homeAgentsSkillsDir =
    input.includeHomeAgentsSkills !== false && input.userHome?.trim()
      ? join(resolve(input.userHome), ".agents", "skills")
      : undefined;
  const scan = new SkillScan(
    Date.now() + (options.timeLimitMs ?? Duration.toMillis(LIST_TIME_LIMIT)),
  );

  // Nothing outside the project or its repository root is opened for it.
  const root = includeProject ? await repositoryRoot(scan, cwd) : cwd;
  const realRoot = includeProject ? ((await scan.realpath(root)) ?? root) : cwd;
  const insideProject: Confine = async (path) => {
    const real = await scan.realpath(path);
    return real !== undefined && isInside(realRoot, real);
  };

  const roots: ReadonlyArray<readonly [dir: string, scope: Scope, keepDiscoveredPath?: boolean]> = [
    [join(profile, "config", "skills"), "user"],
    ...(includeProject ? ([[join(cwd, ".gemini", "skills"), "project"]] as const) : []),
    [join(profile, "antigravity-cli", "skills"), "user"],
    ...(includeProject
      ? ([
          [join(cwd, ".agents", "skills"), "project"],
          [join(cwd, ".agent", "skills"), "project"],
        ] as const)
      : []),
    // CLI 1.5.16+: user-global cross-tool skills, after `~/.gemini` and project skills.
    ...(homeAgentsSkillsDir ? ([[homeAgentsSkillsDir, "user", true]] as const) : []),
  ];
  for (const [dir, scope, keepDiscoveredPath] of roots) {
    await scan.scanFolder(
      dir,
      scope,
      NO_FILTER,
      scope === "project" ? insideProject : undefined,
      keepDiscoveredPath ? { keepDiscoveredPath: true } : undefined,
    );
  }

  // The CLI skips project manifest entries leaving the project or its repository root.
  if (includeProject) {
    for (let dir = cwd; ; dir = dirname(dir)) {
      for (const folder of [".agents", ".agent"]) {
        await scan.scanManifest({
          path: join(dir, folder, "skills.json"),
          baseDir: dir,
          scope: "project",
          filter: NO_FILTER,
          confine: insideProject,
        });
      }
      if (dir === root || dirname(dir) === dir || scan.exhausted) break;
    }
  }
  await scan.scanManifest({
    path: join(profile, "config", "skills.json"),
    scope: "user",
    filter: NO_FILTER,
  });
  await scan.scanPlugins(profile);

  return {
    skills: [...scan.skills.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    truncated: scan.exhausted,
  };
}

/**
 * A skills lister for one instance. It never fails and never runs past its
 * time limit; when a scan is cut short it answers with the last complete
 * list for the same folders, or what it found if there is none yet.
 */
export function makeAntigravitySkillsLister() {
  const lastComplete = new Map<string, ReadonlyArray<ServerProviderSkill>>();
  return (input: ListAntigravitySkillsInput) => {
    const key = [
      resolve(input.cwd),
      resolve(input.profileDir),
      input.includeProject !== false ? "1" : "0",
      input.userHome ? resolve(input.userHome) : "",
      input.includeHomeAgentsSkills !== false ? "1" : "0",
    ].join("\0");
    return Effect.promise(() =>
      listAntigravitySkillsNow(input).catch((): AntigravitySkillListing => ({
        skills: [],
        truncated: true,
      })),
    ).pipe(
      // The scan stops itself at its deadline; this bounds a stuck file call.
      Effect.timeoutOption(Duration.sum(LIST_TIME_LIMIT, Duration.seconds(1))),
      Effect.flatMap((result) => {
        const listing = Option.getOrUndefined(result);
        if (listing && !listing.truncated) {
          lastComplete.set(key, listing.skills);
          return Effect.succeed(listing.skills);
        }
        return Effect.logWarning("Antigravity's skill list was cut short.", {
          cwd: input.cwd,
        }).pipe(Effect.as(lastComplete.get(key) ?? listing?.skills ?? []));
      }),
    );
  };
}
