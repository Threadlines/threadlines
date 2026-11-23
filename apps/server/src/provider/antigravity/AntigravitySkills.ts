/**
 * AntigravitySkills — the skills Google's Antigravity CLI loads for a
 * folder, read from disk the way the CLI finds them, for the provider
 * snapshot's `skills`.
 *
 * Where the CLI looks, in the order that decides which copy of a name wins
 * (T3 Code's native root order, checked against its tests):
 *
 * 1. `~/.gemini/config/skills`
 * 2. `<project>/.gemini/skills`
 * 3. `~/.gemini/antigravity-cli/skills`
 * 4. `<project>/.agents/skills`, then the legacy `<project>/.agent/skills`
 * 5. Folders a manifest declares: the project's `.agents/skills.json` (and
 *    legacy `.agent/skills.json`) in every folder from the project up to its
 *    repository root, then `~/.gemini/config/skills.json`. A project
 *    manifest's paths resolve against the folder holding `.agents`, any
 *    other manifest's against its own folder.
 * 6. Plugins installed in the instance's own profile
 *
 * A root holding a `SKILL.md` is one skill; otherwise each folder directly
 * inside it is. Manifests follow the CLI's rules (changelog 1.4 to 1.5.2):
 * `inherits` reads another manifest, `include_only` and `exclude` match
 * names literally (no patterns) and may be null, a nested item loads only
 * when `include_only` names it (`category/my-skill`), `~` is not expanded,
 * and a project manifest
 * only reaches inside the project or its repository root.
 *
 * The scan reads front matter only and has a size and entry budget, so a
 * huge skills folder can't stall a status check; past the budget it stops
 * and lists what it found.
 *
 * @module provider/antigravity/AntigravitySkills
 */
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ServerProviderSkill } from "@threadlines/contracts";
import { fromYaml } from "@threadlines/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { antigravityUserGeminiDir } from "./AntigravityUserConfig.ts";

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_INHERIT_DEPTH = 10;
const READ_CHUNK_BYTES = 4096;

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
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

const statOf = (path: string) => fs.stat(path).catch(() => undefined);

/** The nearest folder at or above `cwd` holding `.git`, or `cwd` when there is none. */
async function repositoryRoot(cwd: string): Promise<string> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (await fs.lstat(join(dir, ".git")).catch(() => undefined)) return dir;
    if (dirname(dir) === dir) return cwd;
  }
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
  /** Set once the budget runs out; the scan stops and keeps what it found. */
  exhausted = false;
  readonly skills = new Map<string, ServerProviderSkill>();

  private spendEntries(count: number) {
    if (count > this.remainingEntries) {
      this.exhausted = true;
      return false;
    }
    this.remainingEntries -= count;
    return true;
  }

  private async readDir(dir: string) {
    const names = await fs.readdir(dir).catch(() => undefined);
    if (names === undefined || this.exhausted) return undefined;
    return this.spendEntries(names.length) ? names : undefined;
  }

  /** Reads a skill file up to the end of its front matter, within the budget. */
  private async readHead(path: string): Promise<string | undefined> {
    const limit = Math.min(MAX_SKILL_BYTES, this.remainingBytes);
    const handle = await fs.open(path, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const chunks: Array<Buffer> = [];
      let total = 0;
      let markers = 0;
      let dashes = 0;
      while (total <= limit) {
        const buffer = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, total);
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
      await handle.close();
    }
  }

  /** Adds the skill at `skillFile` unless a copy with its name came first. */
  private async addSkill(skillFile: string, scope: Scope) {
    const head = await this.readHead(skillFile);
    const frontMatter = head === undefined ? undefined : frontMatterOf(head);
    if (frontMatter === undefined) return;
    const parsed = decodeFrontMatter(frontMatter || "{}");
    if (Option.isNone(parsed)) return;
    // A skill without a name is named after its folder (CLI 1.5.10).
    const name = parsed.value.name || basename(dirname(skillFile));
    // The CLI keeps names as written; one with outer spaces can't be offered by name.
    if (!name || name !== name.trim() || this.skills.has(name)) return;
    const description = parsed.value.description?.trim();
    this.skills.set(name, {
      name,
      path: skillFile,
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
    return (await statOf(path))?.isFile() ? path : undefined;
  }

  /**
   * A skills folder: a skill itself when it holds a `SKILL.md`, otherwise
   * each folder directly inside it (the ones `filter` lets through) plus
   * nested items `include_only` names.
   */
  async scanFolder(
    dir: string,
    scope: Scope,
    filter: NameFilter = NO_FILTER,
    accept?: (path: string) => Promise<boolean>,
  ) {
    if (this.exhausted || !(await statOf(dir))?.isDirectory()) return;
    const names = await this.readDir(dir);
    if (names === undefined) return;
    const own = await this.skillFileIn(dir, names);
    if (own) {
      if (!accept || (await accept(own))) await this.addSkill(own, scope);
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
      if (!(await statOf(child))?.isDirectory()) continue;
      const skillFile = await this.skillFileIn(child);
      if (skillFile && (!accept || (await accept(skillFile)))) {
        await this.addSkill(skillFile, scope);
      }
    }
  }

  /** A manifest entry: a skills folder, or a `SKILL.md` named directly. */
  private async scanEntry(
    path: string,
    scope: Scope,
    filter: NameFilter,
    accept?: (path: string) => Promise<boolean>,
  ) {
    const stat = await statOf(path);
    if (stat?.isFile()) {
      if (!this.spendEntries(1)) return;
      if (basename(path).toLowerCase() !== "skill.md") return;
      if (!passesFilter(basename(dirname(path)), filter)) return;
      if (!accept || (await accept(path))) await this.addSkill(path, scope);
      return;
    }
    await this.scanFolder(path, scope, filter, accept);
  }

  /**
   * A `skills.json`: its `inherits` first, then its `entries`. `accept`
   * confines a project manifest to the project.
   */
  async scanManifest(input: {
    readonly path: string;
    /** What its relative paths resolve against; the manifest's own folder by default. */
    readonly baseDir?: string;
    readonly scope: Scope;
    readonly filter: NameFilter;
    readonly accept?: (path: string) => Promise<boolean>;
    readonly visited?: ReadonlySet<string>;
    readonly depth?: number;
  }): Promise<void> {
    const depth = input.depth ?? 0;
    const visited = input.visited ?? new Set<string>();
    const path = resolve(input.path);
    if (this.exhausted || depth > MAX_INHERIT_DEPTH || visited.has(path)) return;
    const stat = await statOf(path);
    if (!stat?.isFile()) return;
    if (input.accept && !(await input.accept(path))) return;
    if (stat.size > Math.min(MAX_SKILL_BYTES, this.remainingBytes)) {
      this.exhausted = true;
      return;
    }
    const raw = await fs.readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    this.remainingBytes -= Buffer.byteLength(raw, "utf8");
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
        ...(input.accept ? { accept: input.accept } : {}),
        visited: nextVisited,
        depth: depth + 1,
      });
    }
    for (const entry of manifest.value.entries ?? []) {
      if (this.exhausted) return;
      const entryPath = resolveEntry(entry.path);
      if (input.accept && !(await input.accept(entryPath))) continue;
      await this.scanEntry(entryPath, input.scope, narrowFilter(input.filter, entry), input.accept);
    }
  }
}

export interface ListAntigravitySkillsInput {
  /** The folder a session would run in. */
  readonly cwd: string;
  /** The user's home, whose `.gemini` holds their global skills (`antigravityUserHome`). */
  readonly userHome: string;
  /** The instance's profile (`GEMINI_HOME`), where plugins it installed live. */
  readonly profileDir: string;
}

export interface AntigravitySkillListing {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  /** The scan hit its budget, so the list may be missing skills. */
  readonly truncated: boolean;
}

/** Lists the skills Antigravity would load in `cwd`, sorted by name. */
export async function listAntigravitySkillsNow(
  input: ListAntigravitySkillsInput,
): Promise<AntigravitySkillListing> {
  const cwd = resolve(input.cwd);
  const userGemini = antigravityUserGeminiDir(input.userHome);
  const scan = new SkillScan();

  const roots: ReadonlyArray<readonly [string, Scope]> = [
    [join(userGemini, "config", "skills"), "user"],
    [join(cwd, ".gemini", "skills"), "project"],
    [join(userGemini, "antigravity-cli", "skills"), "user"],
    [join(cwd, ".agents", "skills"), "project"],
    [join(cwd, ".agent", "skills"), "project"],
  ];
  for (const [dir, scope] of roots) await scan.scanFolder(dir, scope);

  // Project manifests load from inside the project or its repository root
  // only: entries leaving it by an absolute path, `..` or a link are skipped.
  const root = await repositoryRoot(cwd);
  const realRoot = await fs.realpath(root).catch(() => root);
  const insideProject = async (path: string) =>
    isInside(realRoot, await fs.realpath(path).catch(() => resolve(path)));
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const folder of [".agents", ".agent"]) {
      await scan.scanManifest({
        path: join(dir, folder, "skills.json"),
        baseDir: dir,
        scope: "project",
        filter: NO_FILTER,
        accept: insideProject,
      });
    }
    if (dir === root || dirname(dir) === dir) break;
  }
  await scan.scanManifest({
    path: join(userGemini, "config", "skills.json"),
    scope: "user",
    filter: NO_FILTER,
  });

  const pluginsDir = join(input.profileDir, "config", "plugins");
  const plugins = await fs.readdir(pluginsDir).catch(() => [] as Array<string>);
  if (plugins.length > 0) {
    const settings = await fs
      .readFile(join(input.profileDir, "config", "config.json"), "utf8")
      .then(decodePluginSettings, () => Option.none());
    const pluginStates = Option.isSome(settings) ? (settings.value.plugins ?? {}) : {};
    for (const plugin of plugins.toSorted()) {
      if (pluginStates[plugin]?.enabled === false) continue;
      await scan.scanFolder(join(pluginsDir, plugin, "skills"), "user");
    }
  }

  return {
    skills: [...scan.skills.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    truncated: scan.exhausted,
  };
}

/** `listAntigravitySkillsNow` as an effect that never fails; a cut-short scan is logged. */
export const listAntigravitySkills = (input: ListAntigravitySkillsInput) =>
  Effect.promise(() =>
    listAntigravitySkillsNow(input).catch((): AntigravitySkillListing => ({
      skills: [],
      truncated: true,
    })),
  ).pipe(
    Effect.tap((listing) =>
      listing.truncated
        ? Effect.logWarning("Antigravity's skill list stopped at its scan limit.", {
            cwd: input.cwd,
          })
        : Effect.void,
    ),
    Effect.map((listing) => listing.skills),
  );
