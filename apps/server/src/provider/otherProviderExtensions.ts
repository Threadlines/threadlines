/**
 * Multi-provider extension discovery and skill root resolution for providers
 * other than Codex and Claude (Antigravity, Grok, Cursor, OpenCode, Pi, Muse,
 * fx, and community ACP agents).
 *
 * Each built-in driver declares only the roots and read-only config formats it
 * is known to read. Project roots are scanned only when a project scope (`cwd`)
 * is selected and are strictly confined to the canonical repository root so a
 * symlinked project folder cannot read or delete files outside the checkout.
 * Untested community agents (`acpRegistry`) never scan disk; they surface only
 * snapshot-reported skills.
 *
 * @module provider/otherProviderExtensions
 */
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AcpRegistrySettings,
  AntigravitySettings,
  CursorSettings,
  FxSettings,
  GrokSettings,
  MuseSettings,
  OpenCodeSettings,
  PiSettings,
  ProviderDriverKind,
  type ProviderExtensionMcpServer,
  type ProviderExtensionProviderCapabilities,
  type ProviderExtensionProviderInventory,
  type ProviderExtensionSkill,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@threadlines/contracts";

import { expandHomePath } from "../pathExpansion.ts";
import {
  annotateAntigravityPluginSkills,
  listAntigravityMcpServers,
  listAntigravityPlugins,
  parseJsoncObject,
} from "./antigravity/AntigravityExtensions.ts";
import { antigravityInstancePaths } from "./antigravity/AntigravityProfile.ts";
import { makeAntigravitySkillsLister } from "./antigravity/AntigravitySkills.ts";
import {
  type AntigravitySkillDir,
  antigravityUserGeminiDir,
  antigravityUserHome,
  readAntigravityDisabledSkills,
} from "./antigravity/AntigravityUserConfig.ts";
import { grokMainHome } from "./grok/GrokAccountFolder.ts";
import {
  antigravityProfileManagesSkillDir,
  evaluateOpenCodeSkillPolicy,
  hasOpenCodePolicyWildcard,
  listAntigravityDirectUserSkills,
  readGrokIgnoreState,
  syncAntigravityProfileAfterSkillMutation,
  writeAntigravitySkillToggle,
  writeGrokSkillToggle,
  writeOpenCodeSkillToggle,
} from "./otherProviderSkillToggles.ts";
import { piAgentDir } from "./pi/PiBinary.ts";

export const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
export const GROK_DRIVER = ProviderDriverKind.make("grok");
export const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
export const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
export const PI_DRIVER = ProviderDriverKind.make("pi");
export const MUSE_DRIVER = ProviderDriverKind.make("muse");
export const FX_DRIVER = ProviderDriverKind.make("fx");
export const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

const MAX_SKILL_FILE_BYTES = 32_000;
const MAX_SKILL_ROOT_SCAN_DIRECTORIES = 250;
const MAX_SKILL_ROOT_SCAN_DEPTH = 6;

const decodeAntigravitySettings = Schema.decodeUnknownSync(AntigravitySettings);
const decodeGrokSettings = Schema.decodeUnknownSync(GrokSettings);
const decodeCursorSettings = Schema.decodeUnknownSync(CursorSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);
const decodeMuseSettings = Schema.decodeUnknownSync(MuseSettings);
const decodeFxSettings = Schema.decodeUnknownSync(FxSettings);
const decodeAcpRegistrySettings = Schema.decodeUnknownSync(AcpRegistrySettings);

const antigravitySkillsLister = makeAntigravitySkillsLister();

export interface OtherProviderSkillRoots {
  readonly driver: string;
  /** Where newly created skills are written (user scope). */
  readonly userSkillsRoot: string;
  /** User-configured writable roots (may intentionally be symlinked, e.g. dotfiles). */
  readonly userWritableRoots: ReadonlyArray<string>;
  /** Project-scoped writable roots (must stay confined inside `projectBoundary`). */
  readonly projectWritableRoots: ReadonlyArray<string>;
  /** Canonical repository boundary confining `projectWritableRoots`. */
  readonly projectBoundary?: string | undefined;
}

interface ScannedSkillRoot {
  readonly root: string;
  readonly scope: "project" | "user" | "system";
  readonly source: string;
  readonly priority: number;
  readonly confineToProject?: boolean;
}

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizedPathKey(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathWithinBoundary(
  path: Path.Path,
  boundary: string,
  candidate: string,
): boolean {
  const rel = path.relative(boundary, candidate);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith("../"))
  );
}

function environmentHome(environment: NodeJS.ProcessEnv): string {
  const home =
    process.platform === "win32"
      ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
      : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return home || homedir();
}

function openCodeConfigDir(environment: NodeJS.ProcessEnv): string {
  const explicitDir = environment.OPENCODE_CONFIG_DIR?.trim();
  if (explicitDir) return expandHomePath(explicitDir);
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome
    ? `${xdgConfigHome}/opencode`
    : `${environmentHome(environment)}/.config/opencode`;
}

function resolveGrokHome(
  config: GrokSettings,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
): string {
  const accountFolder = optionalText(config.accountFolder);
  if (accountFolder) {
    return path.resolve(expandHomePath(accountFolder));
  }
  return grokMainHome(environment);
}

/**
 * Resolves effective enabled state for non-Codex/Claude drivers, checking both the outer instance
 * record and legacy synthesized settings inside `config.config`.
 */
export function resolveOtherProviderEnabled(
  config: ProviderInstanceConfig,
  snapshot: ServerProvider | undefined,
): boolean {
  if (typeof config.enabled === "boolean") return config.enabled;
  const raw = config.config ?? {};
  try {
    switch (config.driver) {
      case ANTIGRAVITY_DRIVER:
        return decodeAntigravitySettings(raw).enabled;
      case GROK_DRIVER:
        return decodeGrokSettings(raw).enabled;
      case CURSOR_DRIVER:
        return decodeCursorSettings(raw).enabled;
      case OPENCODE_DRIVER:
        return decodeOpenCodeSettings(raw).enabled;
      case PI_DRIVER:
        return decodePiSettings(raw).enabled;
      case MUSE_DRIVER:
        return decodeMuseSettings(raw).enabled;
      case FX_DRIVER:
        return decodeFxSettings(raw).enabled;
      case ACP_REGISTRY_DRIVER:
        return decodeAcpRegistrySettings(raw).enabled;
      default:
        return snapshot?.enabled ?? false;
    }
  } catch {
    return snapshot?.enabled ?? false;
  }
}

function decodeOpenCodeSettingsSafe(config: ProviderInstanceConfig): OpenCodeSettings | null {
  try {
    return decodeOpenCodeSettings(config.config ?? {});
  } catch {
    return null;
  }
}

/**
 * True when an OpenCode instance points at an external `serverUrl` (or its config is malformed so
 * we cannot prove it is local). External instances must never scan, read, or write local files.
 */
export function isExternalOpenCodeConfig(config: ProviderInstanceConfig): boolean {
  if (config.driver !== OPENCODE_DRIVER) return false;
  const rawUrl = (config.config as { readonly serverUrl?: unknown } | undefined)?.serverUrl;
  if (typeof rawUrl === "string" && rawUrl.trim().length > 0) return true;
  const decoded = decodeOpenCodeSettingsSafe(config);
  if (!decoded) return true;
  return decoded.serverUrl.trim().length > 0;
}

function decodeGrokSettingsSafe(config: ProviderInstanceConfig): GrokSettings | null {
  try {
    return decodeGrokSettings(config.config ?? {});
  } catch {
    return null;
  }
}

export const findRepositoryRoot = Effect.fn("otherProviderExtensions.findRepositoryRoot")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(cwd);
    for (;;) {
      const gitExists = yield* fileSystem.stat(path.join(current, ".git")).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (gitExists) return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(cwd);
      current = parent;
    }
  },
);

function parseFrontMatterFields(contents: string): {
  readonly name?: string;
  readonly description?: string;
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
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function firstMarkdownParagraph(contents: string): string | undefined {
  const withoutFrontMatter = contents
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  for (const line of withoutFrontMatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return undefined;
}

const listChildDirectories = Effect.fn("otherProviderExtensions.listChildDirectories")(function* (
  directory: string,
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.catch(() => Effect.succeed([])));
  const children = entries
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => path.join(directory, entry));
  const stats = yield* Effect.forEach(
    children,
    (child) => fileSystem.stat(child).pipe(Effect.catch(() => Effect.succeed(null))),
    { concurrency: 16 },
  );
  return children.filter((_, index) => stats[index]?.type === "Directory");
});

const scanSkillRoot = Effect.fn("otherProviderExtensions.scanSkillRoot")(function* (
  rootInput: ScannedSkillRoot,
  projectBoundary: string | undefined,
): Effect.fn.Return<
  ReadonlyArray<{ readonly skill: ProviderExtensionSkill; readonly priority: number }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedRoot = path.resolve(rootInput.root);
  const rootStat = yield* fileSystem
    .stat(resolvedRoot)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!rootStat || rootStat.type !== "Directory") return [];

  const realRoot = yield* fileSystem
    .realPath(resolvedRoot)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!realRoot) return [];
  if (rootInput.confineToProject) {
    if (!projectBoundary || !isPathWithinBoundary(path, projectBoundary, realRoot)) {
      return [];
    }
  }
  // Canonicalize the parent directory so macOS `/var` -> `/private/var` temp paths do not look like
  // user symlinks, while preserving an intentional symlink on the skills root itself (e.g. dotfiles).
  const canonicalParent = yield* fileSystem
    .realPath(path.dirname(resolvedRoot))
    .pipe(Effect.catch(() => Effect.succeed(null)));
  const discoveredRoot = canonicalParent
    ? path.join(canonicalParent, path.basename(resolvedRoot))
    : resolvedRoot;

  let scannedDirectories = 0;
  const found: Array<{
    readonly directory: string;
    readonly skillPath: string;
    readonly size: number;
  }> = [];

  const walk = (
    directory: string,
    depth: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      if (depth > MAX_SKILL_ROOT_SCAN_DEPTH) return;
      if (scannedDirectories >= MAX_SKILL_ROOT_SCAN_DIRECTORIES) return;
      scannedDirectories += 1;

      if (rootInput.confineToProject && projectBoundary) {
        const realDir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!realDir || !isPathWithinBoundary(path, projectBoundary, realDir)) {
          return;
        }
      }

      const skillPath = path.join(directory, "SKILL.md");
      const skillStat = yield* fileSystem
        .stat(skillPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (directory !== discoveredRoot && skillStat?.type === "File") {
        found.push({ directory, skillPath, size: Number(skillStat.size) });
        return;
      }

      for (const child of yield* listChildDirectories(directory)) {
        yield* walk(child, depth + 1);
      }
    });

  yield* walk(discoveredRoot, 0);

  const mapped = yield* Effect.forEach(
    found,
    ({ directory, skillPath, size }) =>
      Effect.gen(function* () {
        // Keep the discovered path under `discoveredRoot` (so a per-skill symlink stays visible to
        // delete checks and never deletes a sibling's target). Expose `resolvedPath` when the
        // canonical target differs (for example, a shared dotfiles folder).
        const realSkillPath = yield* fileSystem
          .realPath(skillPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (
          rootInput.confineToProject &&
          projectBoundary &&
          (!realSkillPath || !isPathWithinBoundary(path, projectBoundary, realSkillPath))
        ) {
          return null;
        }
        const fallbackName = path.basename(directory);
        let name = fallbackName;
        let description: string | undefined;
        if (size <= MAX_SKILL_FILE_BYTES) {
          const contents = yield* fileSystem
            .readFileString(skillPath)
            .pipe(Effect.catch(() => Effect.succeed("")));
          const fm = parseFrontMatterFields(contents);
          if (fm.name) name = fm.name;
          description = fm.description ?? firstMarkdownParagraph(contents);
        }
        const hasDifferentTarget =
          realSkillPath !== null &&
          normalizedPathKey(realSkillPath) !== normalizedPathKey(skillPath);
        const skill: ProviderExtensionSkill = {
          name,
          path: skillPath,
          enabled: true,
          scope: rootInput.scope,
          source: rootInput.source,
          ...(description ? { description } : {}),
          ...(hasDifferentTarget ? { resolvedPath: realSkillPath } : {}),
        };
        return { skill, priority: rootInput.priority };
      }),
    { concurrency: 8 },
  );

  return mapped.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
});

function dedupeSkillsByPriority(
  entries: ReadonlyArray<{ readonly skill: ProviderExtensionSkill; readonly priority: number }>,
): ProviderExtensionSkill[] {
  const sorted = [...entries].toSorted((left, right) => right.priority - left.priority);
  const byName = new Map<string, ProviderExtensionSkill>();
  for (const entry of sorted) {
    const key = entry.skill.name.trim().toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, entry.skill);
    }
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

interface ResolvedWritableRoots {
  readonly userRootKeys: ReadonlySet<string>;
  readonly projectRootKeys: ReadonlySet<string>;
  readonly projectBoundary?: string | undefined;
}

const resolveWritableRootKeys = Effect.fn("otherProviderExtensions.resolveWritableRootKeys")(
  function* (
    roots: OtherProviderSkillRoots,
  ): Effect.fn.Return<ResolvedWritableRoots, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [realUserRoots, realProjectRoots] = yield* Effect.all(
      [
        Effect.forEach(
          roots.userWritableRoots,
          (userRoot) =>
            fileSystem.realPath(userRoot).pipe(Effect.catch(() => Effect.succeed(null))),
          { concurrency: 8 },
        ),
        roots.projectBoundary
          ? Effect.forEach(
              roots.projectWritableRoots,
              (projectRoot) =>
                fileSystem.realPath(projectRoot).pipe(Effect.catch(() => Effect.succeed(null))),
              { concurrency: 8 },
            )
          : Effect.succeed<Array<string | null>>([]),
      ],
      { concurrency: "unbounded" },
    );
    const userRootKeys = new Set<string>();
    for (const realRoot of realUserRoots) {
      if (realRoot) userRootKeys.add(normalizedPathKey(realRoot));
    }
    const projectRootKeys = new Set<string>();
    if (roots.projectBoundary) {
      for (const realRoot of realProjectRoots) {
        if (realRoot && isPathWithinBoundary(path, roots.projectBoundary, realRoot)) {
          projectRootKeys.add(normalizedPathKey(realRoot));
        }
      }
    }
    return {
      userRootKeys,
      projectRootKeys,
      ...(roots.projectBoundary ? { projectBoundary: roots.projectBoundary } : {}),
    };
  },
);

const isDirectChildUnderResolvedWritableRoots = Effect.fn(
  "otherProviderExtensions.isDirectChildUnderResolvedWritableRoots",
)(function* (input: { readonly skillPath: string; readonly resolvedRoots: ResolvedWritableRoots }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedSkillPath = path.resolve(input.skillPath);
  const skillDir = path.dirname(resolvedSkillPath);
  // Never mark a symlinked skill file or symlinked skill directory as deletable.
  const [skillLink, dirLink] = yield* Effect.all([
    fileSystem.readLink(resolvedSkillPath).pipe(Effect.catch(() => Effect.succeed(null))),
    fileSystem.readLink(skillDir).pipe(Effect.catch(() => Effect.succeed(null))),
  ]);
  if (skillLink !== null || dirLink !== null) return false;
  const realDir = yield* fileSystem
    .realPath(skillDir)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!realDir) return false;
  const parentKey = normalizedPathKey(path.dirname(realDir));

  if (input.resolvedRoots.userRootKeys.has(parentKey)) return true;

  if (
    input.resolvedRoots.projectBoundary &&
    input.resolvedRoots.projectRootKeys.has(parentKey) &&
    isPathWithinBoundary(path, input.resolvedRoots.projectBoundary, realDir)
  ) {
    return true;
  }

  return false;
});

const annotateDeletableSkills = Effect.fn("otherProviderExtensions.annotateDeletableSkills")(
  function* (skills: ReadonlyArray<ProviderExtensionSkill>, roots: OtherProviderSkillRoots | null) {
    if (!roots || skills.length === 0) return [...skills];
    // Resolve writable root realPaths once per inventory instead of repeating
    // them inside the per-skill loop.
    const resolvedRoots = yield* resolveWritableRootKeys(roots);
    return yield* Effect.forEach(
      skills,
      (skill) =>
        Effect.gen(function* () {
          if (skill.bundleId !== undefined || skill.scope === "system" || skill.canRead === false) {
            return skill;
          }
          const canDelete = yield* isDirectChildUnderResolvedWritableRoots({
            skillPath: skill.path,
            resolvedRoots,
          });
          return canDelete ? { ...skill, canDelete: true } : skill;
        }),
      { concurrency: 8 },
    );
  },
);

/**
 * Checks whether an Antigravity profile's `config/skills` slot actually sees the user's shared
 * `~/.gemini/config/skills` directory. Returns false when the profile has a foreign symlink or
 * non-empty local directory that shadows the user's folder, so Create never writes into a folder
 * the selected profile ignores.
 */
const antigravityProfileSeesUserSkillsRoot = Effect.fn(
  "otherProviderExtensions.antigravityProfileSeesUserSkillsRoot",
)(function* (profileDir: string | undefined, userSkillsRoot: string) {
  if (!profileDir) return true;
  return yield* antigravityProfileManagesSkillDir(profileDir, "config/skills", userSkillsRoot);
});

/**
 * Resolves writable skill roots for non-Codex/Claude drivers that support creating/deleting skills.
 * Returns `null` for providers that are read-only (Muse, fx, community ACP agents, external OpenCode,
 * or Antigravity profiles whose `config/skills` does not point to the user's shared skills folder).
 */
export const resolveOtherProviderSkillRoots = Effect.fn(
  "otherProviderExtensions.resolveOtherProviderSkillRoots",
)(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ProviderInstanceConfig;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly projectCwd?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly projectBoundary?: string | undefined;
}): Effect.fn.Return<OtherProviderSkillRoots | null, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.config.driver === OPENCODE_DRIVER && isExternalOpenCodeConfig(input.config)) {
    return null;
  }

  const projectCwd = optionalText(input.projectCwd);
  const repoRoot = projectCwd
    ? (input.repoRoot ?? (yield* findRepositoryRoot(projectCwd)))
    : undefined;
  const projectBoundary = repoRoot
    ? (input.projectBoundary ??
      (yield* fileSystem.realPath(repoRoot).pipe(Effect.catch(() => Effect.succeed(repoRoot)))))
    : undefined;

  if (input.config.driver === ANTIGRAVITY_DRIVER) {
    const userHome = antigravityUserHome(process.platform, input.processEnv, homedir());
    const userSkillsRoot = path.join(antigravityUserGeminiDir(userHome), "config", "skills");
    const profileDir = input.stateDir
      ? antigravityInstancePaths(input.stateDir, String(input.instanceId)).profileDir
      : undefined;
    const canWriteUserRoot = yield* antigravityProfileSeesUserSkillsRoot(
      profileDir,
      userSkillsRoot,
    );
    if (!canWriteUserRoot) return null;
    const projectWritableRoots = projectCwd
      ? [
          path.join(projectCwd, ".gemini", "skills"),
          path.join(projectCwd, ".agents", "skills"),
          path.join(projectCwd, ".agent", "skills"),
        ]
      : [];
    return {
      driver: input.config.driver,
      userSkillsRoot,
      userWritableRoots: [userSkillsRoot],
      projectWritableRoots,
      ...(projectBoundary ? { projectBoundary } : {}),
    };
  }

  if (input.config.driver === GROK_DRIVER) {
    const decoded = decodeGrokSettingsSafe(input.config);
    if (!decoded) return null;
    const grokHome = resolveGrokHome(decoded, input.processEnv, path);
    const userSkillsRoot = path.join(grokHome, "skills");
    const projectWritableRoots = projectCwd
      ? [
          path.join(projectCwd, ".grok", "skills"),
          ...(repoRoot && normalizedPathKey(repoRoot) !== normalizedPathKey(projectCwd)
            ? [path.join(repoRoot, ".grok", "skills")]
            : []),
        ]
      : [];
    return {
      driver: input.config.driver,
      userSkillsRoot,
      userWritableRoots: [userSkillsRoot],
      projectWritableRoots,
      ...(projectBoundary ? { projectBoundary } : {}),
    };
  }

  if (input.config.driver === CURSOR_DRIVER) {
    const userSkillsRoot = path.join(environmentHome(input.processEnv), ".cursor", "skills");
    const projectWritableRoots = projectCwd
      ? [path.join(projectCwd, ".cursor", "skills"), path.join(projectCwd, ".agents", "skills")]
      : [];
    return {
      driver: input.config.driver,
      userSkillsRoot,
      userWritableRoots: [userSkillsRoot],
      projectWritableRoots,
      ...(projectBoundary ? { projectBoundary } : {}),
    };
  }

  if (input.config.driver === OPENCODE_DRIVER) {
    if (isExternalOpenCodeConfig(input.config)) return null;
    const userSkillsRoot = path.join(openCodeConfigDir(input.processEnv), "skills");
    const projectWritableRoots = projectCwd
      ? [path.join(projectCwd, ".opencode", "skills"), path.join(projectCwd, ".agents", "skills")]
      : [];
    return {
      driver: input.config.driver,
      userSkillsRoot,
      userWritableRoots: [userSkillsRoot],
      projectWritableRoots,
      ...(projectBoundary ? { projectBoundary } : {}),
    };
  }

  if (input.config.driver === PI_DRIVER) {
    const userSkillsRoot = path.join(piAgentDir(input.processEnv), "skills");
    const projectWritableRoots = projectCwd
      ? [path.join(projectCwd, ".pi", "skills"), path.join(projectCwd, ".agents", "skills")]
      : [];
    return {
      driver: input.config.driver,
      userSkillsRoot,
      userWritableRoots: [userSkillsRoot],
      projectWritableRoots,
      ...(projectBoundary ? { projectBoundary } : {}),
    };
  }

  return null;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonReadOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly message: string }
  | { readonly kind: "ok"; readonly doc: Record<string, unknown>; readonly strictJson?: boolean }
  | { readonly kind: "error"; readonly message: string };

const readJsonFileSafe = Effect.fn("otherProviderExtensions.readJsonFileSafe")(function* (
  filePath: string,
  confineBoundary?: string | undefined,
  options?: { readonly allowJsonc?: boolean },
): Effect.fn.Return<JsonReadOutcome, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fileSystem.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) return { kind: "missing" };
  if (confineBoundary) {
    const real = yield* fileSystem
      .realPath(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!real || !isPathWithinBoundary(path, confineBoundary, real)) {
      return {
        kind: "unsafe",
        message: `${filePath} points outside the repository boundary.`,
      };
    }
  }
  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (contents === null) {
    return { kind: "error", message: `Could not read ${filePath}.` };
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed)
      ? { kind: "ok", doc: parsed, strictJson: true }
      : { kind: "error", message: `${filePath} is not a JSON object.` };
  } catch {
    if (options?.allowJsonc) {
      const parsed = parseJsoncObject(contents);
      if (parsed) {
        return { kind: "ok", doc: parsed, strictJson: false };
      }
    }
    return { kind: "error", message: `${filePath} contains invalid JSON.` };
  }
});

function parseCursorMcpConfig(
  doc: Record<string, unknown>,
  originKind: "project" | "user",
): ProviderExtensionMcpServer[] {
  const servers = doc.mcpServers;
  if (!isRecord(servers)) return [];
  const results: ProviderExtensionMcpServer[] = [];
  for (const [rawName, rawEntry] of Object.entries(servers)) {
    const name = optionalText(rawName);
    if (!name || !isRecord(rawEntry)) continue;
    const url = typeof rawEntry.url === "string" ? optionalText(rawEntry.url) : undefined;
    const command =
      typeof rawEntry.command === "string" ? optionalText(rawEntry.command) : undefined;
    const args = Array.isArray(rawEntry.args)
      ? rawEntry.args.filter((value): value is string => typeof value === "string")
      : [];
    const transport = url ? "http" : command ? "stdio" : undefined;
    const detail = url ?? (command ? [command, ...args].join(" ") : undefined);
    const disabled = rawEntry.disabled === true;
    results.push({
      name,
      origin: { kind: originKind },
      status: disabled ? "Disabled" : "Configured",
      ...(transport ? { transport } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return results;
}

function parseOpenCodeMcpConfig(
  doc: Record<string, unknown>,
  originKind: "project" | "user",
): ProviderExtensionMcpServer[] {
  const servers = doc.mcp;
  if (!isRecord(servers)) return [];
  const results: ProviderExtensionMcpServer[] = [];
  for (const [rawName, rawEntry] of Object.entries(servers)) {
    const name = optionalText(rawName);
    if (!name || !isRecord(rawEntry)) continue;
    const url = typeof rawEntry.url === "string" ? optionalText(rawEntry.url) : undefined;
    const commandParts = Array.isArray(rawEntry.command)
      ? rawEntry.command.filter((value): value is string => typeof value === "string")
      : typeof rawEntry.command === "string"
        ? [rawEntry.command]
        : [];
    const type = typeof rawEntry.type === "string" ? rawEntry.type.trim().toLowerCase() : undefined;
    const transport =
      type === "remote" || url
        ? "http"
        : type === "local" || commandParts.length > 0
          ? "stdio"
          : undefined;
    const detail = url ?? (commandParts.length > 0 ? commandParts.join(" ") : undefined);
    const disabled = rawEntry.enabled === false;
    results.push({
      name,
      origin: { kind: originKind },
      status: disabled ? "Disabled" : "Configured",
      ...(transport ? { transport } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return results;
}

function dedupeMcpServers(
  projectServers: ReadonlyArray<ProviderExtensionMcpServer>,
  userServers: ReadonlyArray<ProviderExtensionMcpServer>,
): ProviderExtensionMcpServer[] {
  const byName = new Map<string, ProviderExtensionMcpServer>();
  for (const server of [...projectServers, ...userServers]) {
    const key = server.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, server);
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

const mapSnapshotSkillsForScope = Effect.fn("otherProviderExtensions.mapSnapshotSkillsForScope")(
  function* (input: {
    readonly snapshot: ServerProvider | undefined;
    readonly projectCwd?: string | undefined;
    readonly projectBoundary?: string | undefined;
    readonly remote?: boolean;
  }): Effect.fn.Return<ProviderExtensionSkill[], never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rawSkills: ReadonlyArray<ServerProviderSkill> = input.snapshot?.skills ?? [];
    const results = yield* Effect.forEach(
      rawSkills,
      (skill) =>
        Effect.gen(function* () {
          // Snapshot skills were probed against the server's startup cwd, so verify canonical
          // containment before admitting project-scoped entries.
          if (skill.scope?.trim().toLowerCase() === "project") {
            if (!input.projectCwd || !input.projectBoundary) return null;
            if (input.remote) return null;
            const real = yield* fileSystem
              .realPath(path.resolve(skill.path))
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (!real || !isPathWithinBoundary(path, input.projectBoundary, real)) {
              return null;
            }
          }
          return {
            name: skill.name,
            path: skill.path,
            ...(skill.displayName ? { displayName: skill.displayName } : {}),
            ...(skill.description ? { description: skill.description } : {}),
            ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
            ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}),
            ...(skill.scope ? { scope: skill.scope } : {}),
            source: input.remote ? "Remote server" : "Provider status",
            ...(input.remote ? { canRead: false } : {}),
          } satisfies ProviderExtensionSkill;
        }),
      { concurrency: 8 },
    );
    return results.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  },
);

function readOnlyCapabilities(overrides?: {
  readonly plugins?: boolean;
  readonly mcpServers?: boolean;
  readonly mcpServerManage?: boolean;
  readonly pluginMarketplaces?: boolean;
  readonly pluginSourceInstall?: boolean;
  readonly skillCreate?: boolean;
}): ProviderExtensionProviderCapabilities {
  return {
    plugins: overrides?.plugins ?? false,
    mcpServers: overrides?.mcpServers ?? false,
    ...(overrides?.mcpServerManage !== undefined
      ? { mcpServerManage: overrides.mcpServerManage }
      : {}),
    ...(overrides?.pluginMarketplaces !== undefined
      ? { pluginMarketplaces: overrides.pluginMarketplaces }
      : {}),
    ...(overrides?.pluginSourceInstall !== undefined
      ? { pluginSourceInstall: overrides.pluginSourceInstall }
      : {}),
    apps: false,
    hooks: false,
    skillCreate: overrides?.skillCreate ?? false,
  };
}

export const readOtherProviderInventory = Effect.fn(
  "otherProviderExtensions.readOtherProviderInventory",
)(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ProviderInstanceConfig;
  readonly snapshot: ServerProvider | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly projectCwd?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly projectBoundary?: string | undefined;
  readonly includePluginCatalog?: boolean | undefined;
}): Effect.fn.Return<ProviderExtensionProviderInventory, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = {
    instanceId: input.instanceId,
    driver: input.config.driver,
    displayName: input.config.displayName ?? input.snapshot?.displayName,
  };

  if (!resolveOtherProviderEnabled(input.config, input.snapshot)) {
    return {
      ...base,
      status: "disabled",
      message: "Provider is disabled.",
      capabilities: readOnlyCapabilities(),
      plugins: [],
      marketplaces: [],
      skills: [],
      mcpServers: [],
      apps: [],
    };
  }

  // External OpenCode instances must stay strictly metadata-only without touching local disk or `.git`.
  if (input.config.driver === OPENCODE_DRIVER && isExternalOpenCodeConfig(input.config)) {
    const skills = yield* mapSnapshotSkillsForScope({
      snapshot: input.snapshot,
      remote: true,
    });
    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({ mcpServers: false, skillCreate: false }),
      plugins: [],
      marketplaces: [],
      skills,
      mcpServers: [],
      apps: [],
    };
  }

  const projectCwd = optionalText(input.projectCwd);
  const repoRoot = projectCwd
    ? (input.repoRoot ?? (yield* findRepositoryRoot(projectCwd)))
    : undefined;
  const projectBoundary = repoRoot
    ? (input.projectBoundary ??
      (yield* fileSystem.realPath(repoRoot).pipe(Effect.catch(() => Effect.succeed(repoRoot)))))
    : undefined;
  const writableRoots = yield* resolveOtherProviderSkillRoots({
    instanceId: input.instanceId,
    config: input.config,
    processEnv: input.processEnv,
    projectCwd,
    stateDir: input.stateDir,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(projectBoundary !== undefined ? { projectBoundary } : {}),
  });

  if (input.config.driver === ANTIGRAVITY_DRIVER) {
    const userHome = antigravityUserHome(process.platform, input.processEnv, homedir());
    const geminiDir = antigravityUserGeminiDir(userHome);
    const profileDir = input.stateDir
      ? antigravityInstancePaths(input.stateDir, String(input.instanceId)).profileDir
      : undefined;
    const profileExists = profileDir
      ? yield* fileSystem.stat(profileDir).pipe(
          Effect.map((stat) => stat.type === "Directory"),
          Effect.catch(() => Effect.succeed(false)),
        )
      : false;

    const [directUserSkills, managesConfigSkills, managesCliSkills, disabledByDir] =
      yield* Effect.all([
        listAntigravityDirectUserSkills(userHome),
        antigravityProfileManagesSkillDir(
          profileDir,
          "config/skills",
          path.join(geminiDir, "config", "skills"),
        ),
        antigravityProfileManagesSkillDir(
          profileDir,
          "antigravity-cli/skills",
          path.join(geminiDir, "antigravity-cli", "skills"),
        ),
        profileDir
          ? Effect.promise(() => readAntigravityDisabledSkills(profileDir))
          : Effect.succeed<Readonly<Record<AntigravitySkillDir, ReadonlyArray<string>>>>({
              "config/skills": [],
              "antigravity-cli/skills": [],
            }),
      ]);

    const manageableSharedDirs = new Set<AntigravitySkillDir>();
    if (profileDir && managesConfigSkills) manageableSharedDirs.add("config/skills");
    if (profileDir && managesCliSkills) manageableSharedDirs.add("antigravity-cli/skills");

    const disabledKeys = new Set<string>();
    for (const sharedDir of ["config/skills", "antigravity-cli/skills"] as const) {
      for (const entryName of disabledByDir[sharedDir]) {
        disabledKeys.add(`${sharedDir}\0${entryName}`);
      }
    }

    const directByDiscovered = new Map(
      directUserSkills.map((entry) => [normalizedPathKey(entry.discoveredSkillPath), entry]),
    );
    const directByReal = new Map<string, Array<(typeof directUserSkills)[number]>>();
    for (const entry of directUserSkills) {
      const key = normalizedPathKey(entry.realSkillPath);
      const list = directByReal.get(key);
      if (list) list.push(entry);
      else directByReal.set(key, [entry]);
    }

    const antigravityToggleNotice =
      "Applies inside Threadlines only. Terminal agy sessions still load ~/.gemini/config/skills.";

    const enrichAntigravitySkill = (skill: ProviderExtensionSkill): ProviderExtensionSkill => {
      let direct = directByDiscovered.get(normalizedPathKey(skill.path));
      if (!direct && skill.scope === "user") {
        const candidates = directByReal.get(normalizedPathKey(skill.path)) ?? [];
        // Prefer an enabled non-symlink entry matching the skill's name/folder when `AntigravitySkills`
        // normalized `skill.path` to `realpath` (e.g. symlinked `~/.gemini/config/skills -> dotfiles`).
        direct =
          candidates.find(
            (candidate) =>
              !disabledKeys.has(`${candidate.sharedDir}\0${candidate.entryName}`) &&
              candidate.entryName.toLowerCase() === skill.name.trim().toLowerCase(),
          ) ??
          candidates.find(
            (candidate) => !disabledKeys.has(`${candidate.sharedDir}\0${candidate.entryName}`),
          ) ??
          candidates[0];
      }
      if (!direct) return skill;
      const canToggle = manageableSharedDirs.has(direct.sharedDir);
      const hasDifferentTarget =
        normalizedPathKey(direct.realSkillPath) !== normalizedPathKey(direct.discoveredSkillPath);
      return {
        ...skill,
        path: direct.discoveredSkillPath,
        ...(hasDifferentTarget ? { resolvedPath: direct.realSkillPath } : {}),
        ...(canToggle ? { canToggle: true, toggleNotice: antigravityToggleNotice } : {}),
      };
    };

    let skills: ProviderExtensionSkill[];
    if (profileDir && profileExists) {
      const listed = yield* antigravitySkillsLister({
        cwd: projectCwd ?? homedir(),
        profileDir,
        includeProject: projectCwd !== undefined,
      });
      skills = listed.map((skill) =>
        enrichAntigravitySkill({
          name: skill.name,
          path: skill.path,
          ...(skill.displayName ? { displayName: skill.displayName } : {}),
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
          enabled: skill.enabled ?? true,
          ...(skill.scope ? { scope: skill.scope } : {}),
          source: skill.scope === "project" ? "Project" : "Antigravity profile",
        }),
      );
    } else {
      const roots: ScannedSkillRoot[] = [
        ...(projectCwd
          ? [
              {
                root: path.join(projectCwd, ".gemini", "skills"),
                scope: "project" as const,
                source: "Project (.gemini/skills)",
                priority: 30,
                confineToProject: true,
              },
              {
                root: path.join(projectCwd, ".agents", "skills"),
                scope: "project" as const,
                source: "Project (.agents/skills)",
                priority: 20,
                confineToProject: true,
              },
              {
                root: path.join(projectCwd, ".agent", "skills"),
                scope: "project" as const,
                source: "Project (.agent/skills)",
                priority: 15,
                confineToProject: true,
              },
            ]
          : []),
        {
          root: path.join(geminiDir, "config", "skills"),
          scope: "user",
          source: "Antigravity user",
          priority: 10,
        },
        {
          root: path.join(geminiDir, "antigravity-cli", "skills"),
          scope: "user",
          source: "Antigravity CLI",
          priority: 5,
        },
      ];
      const scanned = yield* Effect.forEach(roots, (root) => scanSkillRoot(root, projectBoundary), {
        concurrency: 4,
      });
      skills = dedupeSkillsByPriority(scanned.flat()).map((skill) => enrichAntigravitySkill(skill));
    }

    // Surface profile-disabled personal skills so the user can see them and re-enable them.
    const existingPaths = new Set(skills.map((skill) => normalizedPathKey(skill.path)));
    const disabledEntries = directUserSkills.filter(
      (entry) =>
        disabledKeys.has(`${entry.sharedDir}\0${entry.entryName}`) &&
        !existingPaths.has(normalizedPathKey(entry.discoveredSkillPath)),
    );
    if (disabledEntries.length > 0) {
      const disabledSkills = yield* Effect.forEach(
        disabledEntries,
        (entry) =>
          Effect.gen(function* () {
            const stat = yield* fileSystem
              .stat(entry.discoveredSkillPath)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            let name = entry.entryName;
            let description: string | undefined;
            if (stat?.type === "File" && Number(stat.size) <= MAX_SKILL_FILE_BYTES) {
              const contents = yield* fileSystem
                .readFileString(entry.discoveredSkillPath)
                .pipe(Effect.catch(() => Effect.succeed("")));
              const fm = parseFrontMatterFields(contents);
              if (fm.name) name = fm.name;
              description = fm.description ?? firstMarkdownParagraph(contents);
            }
            const hasDifferentTarget =
              normalizedPathKey(entry.realSkillPath) !==
              normalizedPathKey(entry.discoveredSkillPath);
            const canToggle = manageableSharedDirs.has(entry.sharedDir);
            return {
              name,
              path: entry.discoveredSkillPath,
              enabled: false,
              scope: "user",
              source:
                entry.sharedDir === "config/skills" ? "Antigravity profile" : "Antigravity CLI",
              ...(description ? { description } : {}),
              ...(hasDifferentTarget ? { resolvedPath: entry.realSkillPath } : {}),
              ...(canToggle ? { canToggle: true, toggleNotice: antigravityToggleNotice } : {}),
            } satisfies ProviderExtensionSkill;
          }),
        { concurrency: 8 },
      );
      skills = [...skills, ...disabledSkills].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
    }

    // When a sibling skill's `SKILL.md` is symlinked to another skill's regular file, never allow
    // Delete on any entry sharing that realpath so deleting cannot remove a sibling folder.
    const symlinkedRealTargets = new Set(
      directUserSkills
        .filter((entry) => entry.isEntryOrFileSymlink)
        .map((entry) => normalizedPathKey(entry.realSkillPath)),
    );
    const annotatedSkills = (yield* annotateDeletableSkills(skills, writableRoots)).map((skill) => {
      const direct = directByDiscovered.get(normalizedPathKey(skill.path));
      if (
        direct?.isEntryOrFileSymlink ||
        symlinkedRealTargets.has(normalizedPathKey(skill.resolvedPath ?? skill.path))
      ) {
        const { canDelete: _ignored, ...rest } = skill;
        return rest;
      }
      return skill;
    });
    const [pluginInventory, mcpInventory] = profileDir
      ? yield* Effect.gen(function* () {
          const pluginsResult = yield* Effect.promise(() =>
            listAntigravityPlugins({
              profileDir,
              ...(projectCwd ? { projectCwd } : {}),
              ...(projectBoundary ? { projectBoundary } : {}),
              includeCatalog: input.includePluginCatalog === true,
            }),
          );
          const mcpResult = yield* Effect.promise(() =>
            listAntigravityMcpServers({
              profileDir,
              ...(projectCwd ? { projectCwd } : {}),
              ...(projectBoundary ? { projectBoundary } : {}),
              installedPlugins: pluginsResult.installedRecords,
            }),
          );
          return [pluginsResult, mcpResult] as const;
        })
      : [null, null];

    const skillsWithPlugins = pluginInventory
      ? annotateAntigravityPluginSkills(annotatedSkills, pluginInventory.installedRecords)
      : annotatedSkills;

    const mcpServers = mcpInventory?.servers ?? [];
    const mcpErrors = mcpInventory?.errors ?? [];

    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({
        plugins: profileDir !== undefined,
        mcpServers: profileDir !== undefined,
        mcpServerManage: profileDir !== undefined,
        pluginMarketplaces: false,
        pluginSourceInstall: profileDir !== undefined,
        skillCreate: writableRoots !== null,
      }),
      plugins: pluginInventory?.plugins ?? [],
      marketplaces: pluginInventory?.marketplaces ?? [],
      ...(pluginInventory ? { pluginCatalogStatus: pluginInventory.pluginCatalogStatus } : {}),
      skills: skillsWithPlugins,
      mcpServers,
      mcpServersStatus:
        profileDir === undefined
          ? "ready"
          : mcpErrors.length > 0 && mcpServers.length === 0
            ? "error"
            : "ready",
      ...(mcpErrors.length > 0 ? { mcpServersMessage: mcpErrors.join(" ") } : {}),
      apps: [],
    };
  }

  if (input.config.driver === GROK_DRIVER) {
    const decoded = decodeGrokSettingsSafe(input.config);
    const mainGrokHome = grokMainHome(input.processEnv);
    const grokHome = decoded ? resolveGrokHome(decoded, input.processEnv, path) : mainGrokHome;
    const grokConfigPath = path.join(grokHome, "config.toml");
    const home = environmentHome(input.processEnv);
    const roots: ScannedSkillRoot[] = [
      ...(projectCwd
        ? [
            {
              root: path.join(projectCwd, ".grok", "skills"),
              scope: "project" as const,
              source: "Project (.grok/skills)",
              priority: 30,
              confineToProject: true,
            },
            ...(repoRoot && normalizedPathKey(repoRoot) !== normalizedPathKey(projectCwd)
              ? [
                  {
                    root: path.join(repoRoot, ".grok", "skills"),
                    scope: "project" as const,
                    source: "Repository (.grok/skills)",
                    priority: 20,
                    confineToProject: true,
                  },
                ]
              : []),
          ]
        : []),
      {
        root: path.join(grokHome, "skills"),
        scope: "user",
        source: "Grok user",
        priority: 10,
      },
      {
        root: path.join(home, ".claude", "skills"),
        scope: "user",
        source: "Claude user (shared with Grok)",
        priority: 5,
      },
    ];
    const [scanned, ignoreState] = yield* Effect.all([
      Effect.forEach(roots, (root) => scanSkillRoot(root, projectBoundary), { concurrency: 4 }),
      readGrokIgnoreState({
        grokHome,
        mainGrokHome,
        environment: input.processEnv,
      }),
    ]);

    const sortedEntries = scanned.flat().toSorted((left, right) => right.priority - left.priority);
    const seenActiveNames = new Set<string>();
    const seenPaths = new Set<string>();
    const mergedGrokSkills: Array<ProviderExtensionSkill> = [];
    for (const entry of sortedEntries) {
      const pathKey = normalizedPathKey(entry.skill.path);
      if (seenPaths.has(pathKey)) continue;
      const dirKey = normalizedPathKey(path.dirname(entry.skill.path));
      const resolvedDirKey = entry.skill.resolvedPath
        ? normalizedPathKey(path.dirname(entry.skill.resolvedPath))
        : dirKey;
      const ignored =
        ignoreState.resolvedKeys.has(dirKey) || ignoreState.resolvedKeys.has(resolvedDirKey);
      const nameKey = entry.skill.name.trim().toLowerCase();
      if (!ignored) {
        if (seenActiveNames.has(nameKey)) continue;
        seenActiveNames.add(nameKey);
      }
      seenPaths.add(pathKey);
      mergedGrokSkills.push({
        ...entry.skill,
        enabled: !ignored,
        canToggle: true,
        configPath: grokConfigPath,
        ...(ignoreState.sharesMainConfig
          ? { toggleNotice: "Shared with your main Grok config.toml." }
          : {}),
      });
    }
    mergedGrokSkills.sort((left, right) => left.name.localeCompare(right.name));

    const skills = yield* annotateDeletableSkills(mergedGrokSkills, writableRoots);
    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({ skillCreate: writableRoots !== null }),
      plugins: [],
      marketplaces: [],
      skills,
      mcpServers: [],
      apps: [],
    };
  }

  if (input.config.driver === CURSOR_DRIVER) {
    const home = environmentHome(input.processEnv);
    const cursorHome = path.join(home, ".cursor");
    const roots: ScannedSkillRoot[] = [
      ...(projectCwd
        ? [
            {
              root: path.join(projectCwd, ".cursor", "skills"),
              scope: "project" as const,
              source: "Project (.cursor/skills)",
              priority: 30,
              confineToProject: true,
            },
            {
              root: path.join(projectCwd, ".agents", "skills"),
              scope: "project" as const,
              source: "Project (.agents/skills)",
              priority: 20,
              confineToProject: true,
            },
          ]
        : []),
      {
        root: path.join(cursorHome, "skills"),
        scope: "user",
        source: "Cursor user",
        priority: 10,
      },
      {
        root: path.join(cursorHome, "skills-cursor"),
        scope: "system",
        source: "Cursor built-in",
        priority: 5,
      },
    ];
    const [scanned, projectMcpResult, userMcpResult] = yield* Effect.all(
      [
        Effect.forEach(roots, (root) => scanSkillRoot(root, projectBoundary), { concurrency: 4 }),
        projectCwd && normalizedPathKey(projectCwd) !== normalizedPathKey(home)
          ? readJsonFileSafe(path.join(projectCwd, ".cursor", "mcp.json"), projectBoundary)
          : Effect.succeed<JsonReadOutcome>({ kind: "missing" }),
        readJsonFileSafe(path.join(cursorHome, "mcp.json")),
      ],
      { concurrency: "unbounded" },
    );
    const skills = yield* annotateDeletableSkills(
      dedupeSkillsByPriority(scanned.flat()),
      writableRoots,
    );
    const mcpServers = dedupeMcpServers(
      projectMcpResult.kind === "ok" ? parseCursorMcpConfig(projectMcpResult.doc, "project") : [],
      userMcpResult.kind === "ok" ? parseCursorMcpConfig(userMcpResult.doc, "user") : [],
    );
    const mcpErrors = [projectMcpResult, userMcpResult].flatMap((entry) =>
      entry.kind === "error" ? [entry.message] : [],
    );
    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({ mcpServers: true, skillCreate: writableRoots !== null }),
      plugins: [],
      marketplaces: [],
      skills,
      mcpServers,
      mcpServersStatus: mcpErrors.length > 0 && mcpServers.length === 0 ? "error" : "ready",
      ...(mcpErrors.length > 0 ? { mcpServersMessage: mcpErrors.join(" ") } : {}),
      apps: [],
    };
  }

  if (input.config.driver === OPENCODE_DRIVER) {
    if (isExternalOpenCodeConfig(input.config)) {
      const skills = yield* mapSnapshotSkillsForScope({
        snapshot: input.snapshot,
        projectCwd,
        projectBoundary,
        remote: true,
      });
      return {
        ...base,
        status: "ready",
        capabilities: readOnlyCapabilities({ mcpServers: false, skillCreate: false }),
        plugins: [],
        marketplaces: [],
        skills,
        mcpServers: [],
        apps: [],
      };
    }

    const home = environmentHome(input.processEnv);
    const configDir = openCodeConfigDir(input.processEnv);
    const roots: ScannedSkillRoot[] = [
      ...(projectCwd
        ? [
            {
              root: path.join(projectCwd, ".opencode", "skills"),
              scope: "project" as const,
              source: "Project (.opencode/skills)",
              priority: 30,
              confineToProject: true,
            },
            {
              root: path.join(projectCwd, ".agents", "skills"),
              scope: "project" as const,
              source: "Project (.agents/skills)",
              priority: 20,
              confineToProject: true,
            },
          ]
        : []),
      {
        root: path.join(configDir, "skills"),
        scope: "user",
        source: "OpenCode user",
        priority: 10,
      },
      {
        root: path.join(home, ".agents", "skills"),
        scope: "user",
        source: "Shared user (.agents/skills)",
        priority: 5,
      },
    ];
    const userConfigPath = path.join(configDir, "opencode.json");
    const explicitConfig = input.processEnv.OPENCODE_CONFIG?.trim();
    const explicitConfigPath = explicitConfig ? expandHomePath(explicitConfig) : undefined;
    // Precedence order (lowest to highest) matching OpenCode's config layering.
    const userConfigPaths = [
      path.join(configDir, "config.json"),
      userConfigPath,
      path.join(configDir, "opencode.jsonc"),
      ...(explicitConfigPath ? [explicitConfigPath] : []),
    ].filter((filePath, index, list) => list.indexOf(filePath) === index);
    const projectConfigPaths = projectCwd
      ? [path.join(projectCwd, "opencode.json"), path.join(projectCwd, "opencode.jsonc")]
      : [];
    const [scanned, projectConfigResults, userConfigResults, realUserConfigPath] =
      yield* Effect.all(
        [
          Effect.forEach(roots, (root) => scanSkillRoot(root, projectBoundary), { concurrency: 4 }),
          Effect.forEach(
            projectConfigPaths,
            (filePath) =>
              readJsonFileSafe(filePath, projectBoundary, { allowJsonc: true }).pipe(
                Effect.map((result) => ({ filePath, result })),
              ),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            userConfigPaths,
            (filePath) =>
              readJsonFileSafe(filePath, undefined, { allowJsonc: true }).pipe(
                Effect.map((result) => ({ filePath, result })),
              ),
            { concurrency: "unbounded" },
          ),
          fileSystem.realPath(userConfigPath).pipe(Effect.catch(() => Effect.succeed(null))),
        ],
        { concurrency: "unbounded" },
      );
    const userConfigIndex = userConfigResults.findIndex(
      (entry) => entry.filePath === userConfigPath,
    );
    const userConfigResult =
      userConfigIndex >= 0
        ? userConfigResults[userConfigIndex]!.result
        : ({ kind: "missing" } satisfies JsonReadOutcome);
    const higherUserConfigs =
      userConfigIndex >= 0 ? userConfigResults.slice(userConfigIndex + 1) : [];
    const userConfigPointsIntoProject =
      projectBoundary !== undefined &&
      realUserConfigPath !== null &&
      isPathWithinBoundary(path, projectBoundary, realUserConfigPath);
    const policyAnnotatedSkills = dedupeSkillsByPriority(scanned.flat()).map((skill) => {
      let projectEffect: "allow" | "deny" | undefined;
      let projectPolicyPath: string | undefined;
      for (const entry of projectConfigResults) {
        if (entry.result.kind !== "ok") continue;
        const next = evaluateOpenCodeSkillPolicy(entry.result.doc, skill.name);
        if (next !== undefined) {
          projectEffect = next;
          projectPolicyPath = entry.filePath;
        }
      }
      let userEffect: "allow" | "deny" | undefined;
      for (const entry of userConfigResults) {
        if (entry.result.kind !== "ok") continue;
        const next = evaluateOpenCodeSkillPolicy(entry.result.doc, skill.name);
        if (next !== undefined) {
          userEffect = next;
        }
      }
      let overrideUserPolicyPath: string | undefined;
      for (const entry of higherUserConfigs) {
        if (entry.result.kind !== "ok") continue;
        if (evaluateOpenCodeSkillPolicy(entry.result.doc, skill.name) !== undefined) {
          overrideUserPolicyPath = entry.filePath;
        }
      }

      if (projectEffect === "deny" && projectPolicyPath) {
        return {
          ...skill,
          enabled: false,
          configPath: projectPolicyPath,
          toggleNotice: `Disabled by this project's ${path.basename(projectPolicyPath)}. Open config to change it.`,
        };
      }
      if (projectEffect === "allow" && projectPolicyPath) {
        return {
          ...skill,
          enabled: true,
          configPath: projectPolicyPath,
          toggleNotice: `Enabled by this project's ${path.basename(projectPolicyPath)}. Open config to change it.`,
        };
      }
      if (overrideUserPolicyPath) {
        return {
          ...skill,
          enabled: userEffect !== "deny",
          configPath: overrideUserPolicyPath,
          toggleNotice: `Managed by ${path.basename(overrideUserPolicyPath)}. Open config to change it.`,
        };
      }
      if (userConfigResult.kind === "error") {
        return {
          ...skill,
          enabled: userEffect !== "deny",
          configPath: userConfigPath,
          toggleNotice: "Fix invalid JSON in opencode.json before toggling skills.",
        };
      }
      if (userConfigResult.kind === "ok" && userConfigResult.strictJson === false) {
        return {
          ...skill,
          enabled: userEffect !== "deny",
          configPath: userConfigPath,
          toggleNotice:
            "User opencode.json contains comments or trailing commas. Open config to edit it directly.",
        };
      }
      if (userConfigPointsIntoProject) {
        return {
          ...skill,
          enabled: userEffect !== "deny",
          configPath: userConfigPath,
          toggleNotice:
            "User opencode.json links into this repository. Open config to edit it directly.",
        };
      }
      if (hasOpenCodePolicyWildcard(skill.name)) {
        return {
          ...skill,
          enabled: userEffect !== "deny",
          configPath: userConfigPath,
          toggleNotice:
            "Skills with wildcard characters in their name cannot be toggled safely via opencode.json.",
        };
      }
      return {
        ...skill,
        enabled: userEffect !== "deny",
        canToggle: true,
        configPath: userConfigPath,
      };
    });
    const skills = yield* annotateDeletableSkills(policyAnnotatedSkills, writableRoots);
    const projectMcpServers = projectConfigResults
      .toReversed()
      .flatMap((entry) =>
        entry.result.kind === "ok" ? parseOpenCodeMcpConfig(entry.result.doc, "project") : [],
      );
    const userMcpServers = userConfigResults
      .toReversed()
      .flatMap((entry) =>
        entry.result.kind === "ok" ? parseOpenCodeMcpConfig(entry.result.doc, "user") : [],
      );
    const mcpServers = dedupeMcpServers(projectMcpServers, userMcpServers);
    const mcpErrors = [...projectConfigResults, ...userConfigResults].flatMap(({ result }) =>
      result.kind === "error" || result.kind === "unsafe" ? [result.message] : [],
    );
    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({ mcpServers: true, skillCreate: writableRoots !== null }),
      plugins: [],
      marketplaces: [],
      skills,
      mcpServers,
      mcpServersStatus: mcpErrors.length > 0 && mcpServers.length === 0 ? "error" : "ready",
      ...(mcpErrors.length > 0 ? { mcpServersMessage: mcpErrors.join(" ") } : {}),
      apps: [],
    };
  }

  if (input.config.driver === PI_DRIVER) {
    const home = environmentHome(input.processEnv);
    const agentDir = piAgentDir(input.processEnv);
    const roots: ScannedSkillRoot[] = [
      ...(projectCwd
        ? [
            {
              root: path.join(projectCwd, ".pi", "skills"),
              scope: "project" as const,
              source: "Project (.pi/skills)",
              priority: 30,
              confineToProject: true,
            },
            {
              root: path.join(projectCwd, ".agents", "skills"),
              scope: "project" as const,
              source: "Project (.agents/skills)",
              priority: 20,
              confineToProject: true,
            },
          ]
        : []),
      {
        root: path.join(agentDir, "skills"),
        scope: "user",
        source: "Pi user",
        priority: 10,
      },
      {
        root: path.join(home, ".agents", "skills"),
        scope: "user",
        source: "Shared user (.agents/skills)",
        priority: 5,
      },
    ];
    const [scanned, snapshotSkills] = yield* Effect.all(
      [
        Effect.forEach(roots, (root) => scanSkillRoot(root, projectBoundary), { concurrency: 4 }),
        mapSnapshotSkillsForScope({
          snapshot: input.snapshot,
          projectCwd,
          projectBoundary,
        }),
      ],
      { concurrency: "unbounded" },
    );
    // Include Pi `--skill` launch-arg skills from the live snapshot at lower priority than direct
    // disk discovery so custom paths still appear in Settings without leaking out-of-scope project skills.
    const merged = dedupeSkillsByPriority([
      ...scanned.flat(),
      ...snapshotSkills.map((skill) => ({ skill, priority: 1 })),
    ]);
    const skills = yield* annotateDeletableSkills(merged, writableRoots);
    return {
      ...base,
      status: "ready",
      capabilities: readOnlyCapabilities({ skillCreate: writableRoots !== null }),
      plugins: [],
      marketplaces: [],
      skills,
      mcpServers: [],
      apps: [],
    };
  }

  // Muse, fx, and community ACP agents: never guess disk paths; surface only safe snapshot skills.
  const skills = yield* mapSnapshotSkillsForScope({
    snapshot: input.snapshot,
    projectCwd,
    projectBoundary,
  });
  return {
    ...base,
    status: "ready",
    capabilities: readOnlyCapabilities(),
    plugins: [],
    marketplaces: [],
    skills,
    mcpServers: [],
    apps: [],
  };
});

/**
 * Revalidates a skill toggle request against the live inventory for `(instanceId, projectCwd)`
 * and applies the provider-appropriate native or profile-level toggle.
 */
export const setOtherProviderSkillEnabled = Effect.fn(
  "otherProviderExtensions.setOtherProviderSkillEnabled",
)(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ProviderInstanceConfig;
  readonly snapshot: ServerProvider | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly projectCwd?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly skillPath: string;
  readonly enabled: boolean;
}): Effect.fn.Return<boolean, string, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const inventory = yield* readOtherProviderInventory({
    instanceId: input.instanceId,
    config: input.config,
    snapshot: input.snapshot,
    processEnv: input.processEnv,
    projectCwd: input.projectCwd,
    stateDir: input.stateDir,
  });
  if (inventory.status !== "ready") {
    return yield* Effect.fail(inventory.message ?? "Provider is not ready.");
  }

  const requestedKey = normalizedPathKey(path.resolve(input.skillPath));
  const matched =
    inventory.skills.find(
      (skill) => normalizedPathKey(path.resolve(skill.path)) === requestedKey,
    ) ??
    (() => {
      const byResolved = inventory.skills.filter(
        (skill) =>
          skill.resolvedPath !== undefined &&
          normalizedPathKey(path.resolve(skill.resolvedPath)) === requestedKey,
      );
      return byResolved.length === 1 ? byResolved[0] : undefined;
    })();

  if (!matched) {
    return yield* Effect.fail("That skill is not in this provider's current scope.");
  }
  if (matched.canToggle !== true) {
    return yield* Effect.fail(
      matched.toggleNotice ??
        `${inventory.displayName ?? input.config.driver} does not support toggling this skill here.`,
    );
  }

  if (input.config.driver === GROK_DRIVER) {
    const decoded = decodeGrokSettingsSafe(input.config);
    const mainGrokHome = grokMainHome(input.processEnv);
    const grokHome = decoded ? resolveGrokHome(decoded, input.processEnv, path) : mainGrokHome;
    yield* writeGrokSkillToggle({
      grokHome,
      mainGrokHome,
      skillPath: matched.path,
      enabled: input.enabled,
      environment: input.processEnv,
    });
    return input.enabled;
  }

  if (input.config.driver === OPENCODE_DRIVER) {
    if (isExternalOpenCodeConfig(input.config)) {
      return yield* Effect.fail("Remote OpenCode skills cannot be toggled from this machine.");
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const projectCwd = optionalText(input.projectCwd);
    const repoRoot = projectCwd ? yield* findRepositoryRoot(projectCwd) : undefined;
    const projectBoundary = repoRoot
      ? yield* fileSystem.realPath(repoRoot).pipe(Effect.catch(() => Effect.succeed(repoRoot)))
      : undefined;
    const configDir = openCodeConfigDir(input.processEnv);
    const userConfigPath = path.join(configDir, "opencode.json");
    const baseConfigResult = yield* readJsonFileSafe(
      path.join(configDir, "config.json"),
      undefined,
      { allowJsonc: true },
    );
    const inheritedEffect =
      baseConfigResult.kind === "ok"
        ? evaluateOpenCodeSkillPolicy(baseConfigResult.doc, matched.name)
        : undefined;
    yield* writeOpenCodeSkillToggle({
      userConfigPath,
      skillName: matched.name,
      enabled: input.enabled,
      forbiddenBoundary: projectBoundary,
      inheritedEffect,
    });
    // Re-read inventory to verify effective state (e.g. a project config cannot be overridden).
    const after = yield* readOtherProviderInventory({
      instanceId: input.instanceId,
      config: input.config,
      snapshot: input.snapshot,
      processEnv: input.processEnv,
      projectCwd: input.projectCwd,
      stateDir: input.stateDir,
    });
    const refreshed = after.skills.find(
      (skill) =>
        normalizedPathKey(path.resolve(skill.path)) ===
        normalizedPathKey(path.resolve(matched.path)),
    );
    return refreshed?.enabled ?? input.enabled;
  }

  if (input.config.driver === ANTIGRAVITY_DRIVER) {
    if (!input.stateDir) {
      return yield* Effect.fail("Antigravity profile state directory is unavailable.");
    }
    const userHome = antigravityUserHome(process.platform, input.processEnv, homedir());
    const profileDir = antigravityInstancePaths(
      input.stateDir,
      String(input.instanceId),
    ).profileDir;
    const directEntries = yield* listAntigravityDirectUserSkills(userHome);
    const matchedKey = normalizedPathKey(path.resolve(matched.path));
    const entry = directEntries.find(
      (candidate) => normalizedPathKey(path.resolve(candidate.discoveredSkillPath)) === matchedKey,
    );
    if (!entry) {
      return yield* Effect.fail("Only personal Antigravity skills can be toggled here.");
    }
    yield* writeAntigravitySkillToggle({
      profileDir,
      userHome,
      stateDir: input.stateDir,
      sharedDir: entry.sharedDir,
      entryName: entry.entryName,
      enabled: input.enabled,
    });
    return input.enabled;
  }

  return yield* Effect.fail(
    `${inventory.displayName ?? input.config.driver} does not support toggling individual skills here.`,
  );
});

/** Re-syncs profile links after creating or deleting a user skill on profile-managed providers. */
export const syncOtherProviderAfterSkillMutation = Effect.fn(
  "otherProviderExtensions.syncOtherProviderAfterSkillMutation",
)(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ProviderInstanceConfig;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly stateDir?: string | undefined;
}): Effect.fn.Return<void, never, never> {
  if (input.config.driver !== ANTIGRAVITY_DRIVER || !input.stateDir) return;
  const userHome = antigravityUserHome(process.platform, input.processEnv, homedir());
  const profileDir = antigravityInstancePaths(input.stateDir, String(input.instanceId)).profileDir;
  yield* syncAntigravityProfileAfterSkillMutation({
    profileDir,
    userHome,
    stateDir: input.stateDir,
  });
});
