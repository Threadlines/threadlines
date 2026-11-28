/**
 * Native and profile-level skill toggle helpers for non-Codex/Claude providers:
 * - Grok: format-preserving `[skills] ignore` edits in `<grokHome>/config.toml`
 * - Local OpenCode: `policies` (`action: "skill.use"`) evaluation and edits in `opencode.json`
 * - Antigravity: profile-level per-skill disable sync via `AntigravityUserConfig`
 *
 * @module provider/otherProviderSkillToggles
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import {
  ANTIGRAVITY_SKILL_DIRS,
  type AntigravitySkillDir,
  isAntigravitySplitSkillDir,
  setAntigravitySkillDisabled,
  shareAntigravityUserConfigNow,
} from "./antigravity/AntigravityUserConfig.ts";
import { antigravityUserGeminiDir } from "./antigravity/AntigravityUserConfig.ts";

function normalizedPathKey(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function environmentHome(environment: NodeJS.ProcessEnv): string {
  const home =
    process.platform === "win32"
      ? environment.USERPROFILE?.trim() || environment.HOME?.trim()
      : environment.HOME?.trim() || environment.USERPROFILE?.trim();
  return home || homedir();
}

function expandPathWithEnv(raw: string, environment: NodeJS.ProcessEnv): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return environmentHome(environment);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return `${environmentHome(environment)}${trimmed.slice(1)}`;
  }
  return expandHomePath(trimmed);
}

/**
 * Strips a `#` comment outside single/double-quoted TOML strings on a single line.
 */
function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * Parses a TOML table header line (after comment stripping), returning the normalized table name
 * or `null` when the line is not a `[table]` / `[[array]]` header.
 */
function parseTomlTableHeader(strippedLine: string): string | null {
  const trimmed = strippedLine.trim();
  if (!trimmed.startsWith("[")) return null;
  if (trimmed.startsWith("[[")) {
    if (!trimmed.endsWith("]]")) return null;
    return trimmed.slice(2, -2).trim();
  }
  if (!trimmed.endsWith("]")) return null;
  return trimmed.slice(1, -1).trim();
}

function decodeTomlBasicString(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\" || i + 1 >= inner.length) {
      out += ch;
      continue;
    }
    const next = inner[i + 1]!;
    i += 1;
    switch (next) {
      case "b":
        out += "\b";
        break;
      case "t":
        out += "\t";
        break;
      case "n":
        out += "\n";
        break;
      case "f":
        out += "\f";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "u": {
        const hex = inner.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 4;
        } else {
          out += `\\u${hex}`;
          i += hex.length;
        }
        break;
      }
      case "U": {
        const hex = inner.slice(i + 1, i + 9);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 8;
        } else {
          out += `\\U${hex}`;
          i += hex.length;
        }
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

/**
 * Parses a TOML string array literal (everything between `[` and the matching `]`).
 * Returns `null` when the slice does not close with `]` or contains unparseable tokens.
 */
function parseTomlStringArray(raw: string): {
  readonly values: Array<string>;
  readonly endIndex: number;
} | null {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
  if (raw[i] !== "[") return null;
  i += 1;
  const values: Array<string> = [];
  while (i < raw.length) {
    // Skip whitespace, commas, and inline comments.
    while (i < raw.length) {
      const ch = raw[i]!;
      if (/\s/.test(ch) || ch === ",") {
        i += 1;
        continue;
      }
      if (ch === "#") {
        while (i < raw.length && raw[i] !== "\n") i += 1;
        continue;
      }
      break;
    }
    if (i >= raw.length) return null;
    if (raw[i] === "]") {
      return { values, endIndex: i + 1 };
    }
    if (raw[i] === "'") {
      i += 1;
      const start = i;
      while (i < raw.length && raw[i] !== "'" && raw[i] !== "\n") i += 1;
      if (raw[i] !== "'") return null;
      values.push(raw.slice(start, i));
      i += 1;
      continue;
    }
    if (raw[i] === '"') {
      i += 1;
      const start = i;
      let escaped = false;
      while (i < raw.length) {
        const ch = raw[i]!;
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          break;
        } else if (ch === "\n") {
          return null;
        }
        i += 1;
      }
      if (raw[i] !== '"') return null;
      values.push(decodeTomlBasicString(raw.slice(start, i)));
      i += 1;
      continue;
    }
    return null;
  }
  return null;
}

interface GrokSkillsSectionMatch {
  readonly sectionStart: number;
  readonly sectionEnd: number;
  readonly ignoreValueStart?: number;
  readonly ignoreValueEnd?: number;
  readonly ignoreValues: Array<string>;
}

function findGrokSkillsSection(tomlText: string): GrokSkillsSectionMatch | null {
  const lineStarts: Array<number> = [0];
  for (let i = 0; i < tomlText.length; i += 1) {
    if (tomlText[i] === "\n") lineStarts.push(i + 1);
  }
  const lines = tomlText.split("\n");

  let skillsHeaderLine = -1;
  let nextHeaderLine = lines.length;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const header = parseTomlTableHeader(stripTomlComment(lines[idx]!));
    if (header === null) continue;
    if (skillsHeaderLine === -1) {
      if (header === "skills" || header === '"skills"' || header === "'skills'") {
        skillsHeaderLine = idx;
      }
    } else {
      nextHeaderLine = idx;
      break;
    }
  }
  if (skillsHeaderLine === -1) return null;

  const sectionStart = lineStarts[skillsHeaderLine]!;
  const sectionEnd =
    nextHeaderLine < lineStarts.length ? lineStarts[nextHeaderLine]! : tomlText.length;

  for (let idx = skillsHeaderLine + 1; idx < nextHeaderLine; idx += 1) {
    const stripped = stripTomlComment(lines[idx]!);
    const keyMatch = stripped.match(/^\s*(?:ignore|"ignore"|'ignore')\s*=\s*/);
    if (!keyMatch) continue;
    const valueStart = lineStarts[idx]! + keyMatch[0].length;
    const parsed = parseTomlStringArray(tomlText.slice(valueStart, sectionEnd));
    if (!parsed) {
      // Unparseable ignore value — report match without bounds so caller refuses to clobber it.
      return {
        sectionStart,
        sectionEnd,
        ignoreValues: [],
      };
    }
    return {
      sectionStart,
      sectionEnd,
      ignoreValueStart: valueStart,
      ignoreValueEnd: valueStart + parsed.endIndex,
      ignoreValues: parsed.values,
    };
  }

  return {
    sectionStart,
    sectionEnd,
    ignoreValues: [],
  };
}

/** Reads `[skills] ignore = [...]` entries from a Grok `config.toml` document. */
export function parseGrokSkillsIgnore(tomlText: string): Array<string> {
  return findGrokSkillsSection(tomlText)?.ignoreValues ?? [];
}

function encodeTomlString(value: string): string {
  // Use TOML literal strings for Windows-style paths containing backslashes (recommended in Grok's
  // own docs) whenever safe; otherwise fall back to standard double-quoted TOML escaping.
  if (value.includes("\\") && !value.includes("'") && !/[\r\n\t\x00-\x1f\x7f]/.test(value)) {
    return `'${value}'`;
  }
  return JSON.stringify(value);
}

function formatTomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map((entry) => encodeTomlString(entry)).join(", ")}]`;
}

/**
 * Updates `[skills] ignore = [...]` in a Grok `config.toml` string while preserving comments,
 * formatting, and all other sections.
 */
export function updateGrokSkillsIgnore(
  tomlText: string,
  nextIgnore: ReadonlyArray<string>,
): string {
  const eol = tomlText.includes("\r\n") ? "\r\n" : "\n";
  const formattedArray = formatTomlStringArray(nextIgnore);
  const section = findGrokSkillsSection(tomlText);

  if (!section) {
    const prefix =
      tomlText.length === 0
        ? ""
        : tomlText.endsWith("\n")
          ? `${tomlText}${eol}`
          : `${tomlText}${eol}${eol}`;
    return `${prefix}[skills]${eol}ignore = ${formattedArray}${eol}`;
  }

  if (section.ignoreValueStart !== undefined && section.ignoreValueEnd !== undefined) {
    return `${tomlText.slice(0, section.ignoreValueStart)}${formattedArray}${tomlText.slice(section.ignoreValueEnd)}`;
  }

  // Insert `ignore = [...]` right before the next table header (preserving trailing blank lines).
  const beforeNext = tomlText.slice(0, section.sectionEnd);
  const afterNext = tomlText.slice(section.sectionEnd);
  const trailingNewlinesMatch = beforeNext.match(/(\r?\n)+$/);
  const trimmedSection = trailingNewlinesMatch
    ? beforeNext.slice(0, beforeNext.length - trailingNewlinesMatch[0].length)
    : beforeNext;
  const trailing = trailingNewlinesMatch ? trailingNewlinesMatch[0] : eol;
  return `${trimmedSection}${eol}ignore = ${formattedArray}${trailing}${afterNext}`;
}

export interface GrokIgnoreState {
  readonly rawEntries: ReadonlyArray<string>;
  readonly resolvedKeys: ReadonlySet<string>;
  readonly sharesMainConfig: boolean;
}

async function resolveFileLinkAndHardLinkTarget(
  filePath: string,
  mainFilePath: string,
): Promise<{
  readonly targetPath: string;
  readonly isHardLinkedToMain: boolean;
  readonly sharesMainConfig: boolean;
}> {
  const lstat = await fs.lstat(filePath).catch(() => null);
  if (lstat?.isSymbolicLink()) {
    const real = await fs.realpath(filePath).catch(() => filePath);
    const mainReal = await fs.realpath(mainFilePath).catch(() => mainFilePath);
    return {
      targetPath: real,
      isHardLinkedToMain: false,
      sharesMainConfig:
        normalizedPathKey(filePath) !== normalizedPathKey(mainFilePath) &&
        normalizedPathKey(real) === normalizedPathKey(mainReal),
    };
  }
  if (lstat?.isFile() && normalizedPathKey(filePath) !== normalizedPathKey(mainFilePath)) {
    const mainStat = await fs.stat(mainFilePath).catch(() => null);
    if (mainStat?.isFile() && mainStat.dev === lstat.dev && mainStat.ino === lstat.ino) {
      return {
        targetPath: mainFilePath,
        isHardLinkedToMain: true,
        sharesMainConfig: true,
      };
    }
  }
  return {
    targetPath: filePath,
    isHardLinkedToMain: false,
    sharesMainConfig: false,
  };
}

/**
 * Reads Grok's `[skills] ignore` entries and resolves both raw and canonical paths so symlinked
 * skills and `~/` entries match reliably.
 */
export const readGrokIgnoreState = Effect.fn("otherProviderSkillToggles.readGrokIgnoreState")(
  function* (input: {
    readonly grokHome: string;
    readonly mainGrokHome: string;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<GrokIgnoreState, never, Path.Path> {
    const path = yield* Path.Path;
    const configPath = path.join(input.grokHome, "config.toml");
    const mainConfigPath = path.join(input.mainGrokHome, "config.toml");

    return yield* Effect.promise(async () => {
      const linkInfo = await resolveFileLinkAndHardLinkTarget(configPath, mainConfigPath);
      const raw = await fs.readFile(linkInfo.targetPath, "utf8").catch(() => null);
      if (raw === null) {
        return {
          rawEntries: [],
          resolvedKeys: new Set<string>(),
          sharesMainConfig: linkInfo.sharesMainConfig,
        };
      }
      const rawEntries = parseGrokSkillsIgnore(raw);
      const resolvedKeys = new Set<string>();
      for (const entry of rawEntries) {
        const expanded = path.resolve(expandPathWithEnv(entry, input.environment));
        resolvedKeys.add(normalizedPathKey(expanded));
        const real = await fs.realpath(expanded).catch(() => null);
        if (real) resolvedKeys.add(normalizedPathKey(real));
      }
      return {
        rawEntries,
        resolvedKeys,
        sharesMainConfig: linkInfo.sharesMainConfig,
      };
    });
  },
);

/** Per-file serialization queue so concurrent skill toggles never overwrite each other. */
const configWriteQueue = new Map<string, Promise<unknown>>();

function enqueueConfigWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = normalizedPathKey(filePath);
  const previous = configWriteQueue.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const settled = run.catch(() => undefined);
  configWriteQueue.set(key, settled);
  void settled.then(() => {
    if (configWriteQueue.get(key) === settled) configWriteQueue.delete(key);
  });
  return run;
}

async function writeFilePreservingModeAndLinks(input: {
  readonly targetPath: string;
  readonly contents: string;
  readonly path: Path.Path;
}): Promise<void> {
  const target = input.targetPath;
  await fs.mkdir(input.path.dirname(target), { recursive: true });
  const existingStat = await fs.stat(target).catch(() => null);
  const mode = existingStat ? existingStat.mode & 0o777 : 0o600;

  // When hard links point at this config (e.g. Grok account overlays on Windows/POSIX), renaming
  // over `target` would split the inode and detach every hard-linked account. Write in place
  // instead so every linked account stays in sync with the updated file.
  if (existingStat && existingStat.nlink > 1) {
    await fs.writeFile(target, input.contents, "utf8");
    return;
  }

  const temp = `${target}.threadlines-${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, input.contents, { encoding: "utf8", mode });
  await fs.chmod(temp, mode).catch(() => undefined);
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Updates Grok's `[skills] ignore` list for one validated skill directory. */
export const writeGrokSkillToggle = Effect.fn("otherProviderSkillToggles.writeGrokSkillToggle")(
  function* (input: {
    readonly grokHome: string;
    readonly mainGrokHome: string;
    readonly skillPath: string;
    readonly enabled: boolean;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<void, string, Path.Path> {
    const path = yield* Path.Path;
    const configPath = path.join(input.grokHome, "config.toml");
    const mainConfigPath = path.join(input.mainGrokHome, "config.toml");
    const skillDir = path.dirname(path.resolve(input.skillPath));

    return yield* Effect.tryPromise({
      try: async () => {
        const linkInfo = await resolveFileLinkAndHardLinkTarget(configPath, mainConfigPath);
        await enqueueConfigWrite(linkInfo.targetPath, async () => {
          const existingText = await fs
            .readFile(linkInfo.targetPath, "utf8")
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
              throw error;
            });

          // Refuse to clobber an unparseable `ignore = ...` line in `[skills]`.
          const section = findGrokSkillsSection(existingText);
          if (section && section.ignoreValueStart === undefined) {
            const sectionSlice = existingText.slice(section.sectionStart, section.sectionEnd);
            if (/^\s*(?:ignore|"ignore"|'ignore')\s*=/m.test(sectionSlice)) {
              throw new Error(
                `Could not parse [skills].ignore in ${linkInfo.targetPath}. Edit the file directly to change ignored skills.`,
              );
            }
          }

          const existingEntries = parseGrokSkillsIgnore(existingText);
          const targetKeys = new Set<string>([normalizedPathKey(skillDir)]);
          const realSkillDir = await fs.realpath(skillDir).catch(() => null);
          if (realSkillDir) targetKeys.add(normalizedPathKey(realSkillDir));

          const matchesTarget = async (entry: string): Promise<boolean> => {
            const expanded = path.resolve(expandPathWithEnv(entry, input.environment));
            if (targetKeys.has(normalizedPathKey(expanded))) return true;
            const realEntry = await fs.realpath(expanded).catch(() => null);
            return realEntry !== null && targetKeys.has(normalizedPathKey(realEntry));
          };

          const filtered: Array<string> = [];
          for (const entry of existingEntries) {
            if (!(await matchesTarget(entry))) {
              filtered.push(entry);
            }
          }

          const nextEntries = input.enabled ? filtered : [...filtered, skillDir];
          const nextText = updateGrokSkillsIgnore(existingText, nextEntries);
          await writeFilePreservingModeAndLinks({
            targetPath: linkInfo.targetPath,
            contents: nextText,
            path,
          });
        });
      },
      catch: (error) =>
        error instanceof Error ? error.message : `Failed to update ${configPath}.`,
    });
  },
);

/** OpenCode's wildcard rule matcher: `*` matches any run, `?` matches one character. */
function openCodeWildcardMatch(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Evaluates whether an OpenCode config document explicitly allows or denies a skill name.
 * Supports OpenCode 2 `policies` (`action: "skill.use"` and legacy `action: "integration.use"`
 * with `"skill:"` resource prefix) and OpenCode 1 `permission.skill` maps. Last match wins.
 */
export function evaluateOpenCodeSkillPolicy(
  doc: Record<string, unknown>,
  skillName: string,
): "allow" | "deny" | undefined {
  let effect: "allow" | "deny" | undefined;

  // Fallback OpenCode 1 `permission.skill` object map (evaluated first so v2 `policies` wins).
  if (isRecord(doc.permission)) {
    const skillPerm = doc.permission.skill;
    if (typeof skillPerm === "string") {
      if (skillPerm === "deny") effect = "deny";
      else if (skillPerm === "allow" || skillPerm === "ask") effect = "allow";
    } else if (isRecord(skillPerm)) {
      for (const [pattern, rawEffect] of Object.entries(skillPerm)) {
        if (!openCodeWildcardMatch(skillName, pattern)) continue;
        if (rawEffect === "deny") effect = "deny";
        else if (rawEffect === "allow" || rawEffect === "ask") effect = "allow";
      }
    }
  }

  if (Array.isArray(doc.policies)) {
    for (const rawRule of doc.policies) {
      if (!isRecord(rawRule)) continue;
      const action = typeof rawRule.action === "string" ? rawRule.action : undefined;
      const resource = typeof rawRule.resource === "string" ? rawRule.resource : undefined;
      const ruleEffect =
        rawRule.effect === "allow" || rawRule.effect === "deny" ? rawRule.effect : undefined;
      if (!action || !resource || !ruleEffect) continue;

      if (action === "skill.use") {
        if (openCodeWildcardMatch(skillName, resource)) {
          effect = ruleEffect;
        }
      } else if (action === "integration.use" && resource.startsWith("skill:")) {
        if (openCodeWildcardMatch(skillName, resource.slice("skill:".length))) {
          effect = ruleEffect;
        }
      }
    }
  }

  return effect;
}

/** True when an OpenCode skill name contains wildcard characters that would affect other skills. */
export function hasOpenCodePolicyWildcard(skillName: string): boolean {
  return /[*?]/.test(skillName);
}

/**
 * Updates OpenCode's user `opencode.json` `policies` list to enable or disable `skillName`.
 * Never modifies project config files; refuses wildcard skill names and malformed JSON.
 */
export const writeOpenCodeSkillToggle = Effect.fn(
  "otherProviderSkillToggles.writeOpenCodeSkillToggle",
)(function* (input: {
  readonly userConfigPath: string;
  readonly skillName: string;
  readonly enabled: boolean;
  readonly forbiddenBoundary?: string | undefined;
  /** Effective policy from lower-precedence user configs (e.g. `config.json`). */
  readonly inheritedEffect?: "allow" | "deny" | undefined;
}): Effect.fn.Return<void, string, Path.Path> {
  const path = yield* Path.Path;
  if (hasOpenCodePolicyWildcard(input.skillName)) {
    return yield* Effect.fail(
      "Skills with wildcard characters in their name cannot be toggled safely via opencode.json.",
    );
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const target = (await fs.lstat(input.userConfigPath).catch(() => null))?.isSymbolicLink()
        ? await fs.realpath(input.userConfigPath).catch(() => input.userConfigPath)
        : input.userConfigPath;

      if (input.forbiddenBoundary) {
        const realTarget = (await fs.realpath(target).catch(() => null)) ?? path.resolve(target);
        const rel = path.relative(input.forbiddenBoundary, realTarget);
        const insideRepo =
          rel === "" ||
          (!path.isAbsolute(rel) &&
            rel !== ".." &&
            !rel.startsWith(`..${path.sep}`) &&
            !rel.startsWith("../"));
        if (insideRepo) {
          throw new Error(
            "User opencode.json links into this repository. Open config to edit it directly.",
          );
        }
      }

      await enqueueConfigWrite(target, async () => {
        const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        let doc: Record<string, unknown> = {};
        if (raw !== null) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error(`${target} contains invalid JSON. Fix it before toggling skills.`);
          }
          if (!isRecord(parsed)) {
            throw new Error(`${target} is not a JSON object.`);
          }
          doc = { ...parsed };
        }

        const existingPolicies = Array.isArray(doc.policies) ? [...doc.policies] : [];
        const filteredPolicies = existingPolicies.filter((rule) => {
          if (!isRecord(rule)) return true;
          if (rule.action === "skill.use" && rule.resource === input.skillName) return false;
          if (rule.action === "integration.use" && rule.resource === `skill:${input.skillName}`) {
            return false;
          }
          return true;
        });

        // Clear any exact OpenCode 1 `permission.skill[skillName] = "deny"` when enabling.
        if (input.enabled && isRecord(doc.permission) && isRecord(doc.permission.skill)) {
          const nextSkillPerm = { ...doc.permission.skill };
          if (nextSkillPerm[input.skillName] === "deny") {
            delete nextSkillPerm[input.skillName];
            doc.permission = { ...doc.permission, skill: nextSkillPerm };
          }
        }

        if (!input.enabled) {
          filteredPolicies.push({
            action: "skill.use",
            resource: input.skillName,
            effect: "deny",
          });
        } else {
          // If remaining rules (e.g. a wildcard `*` deny or lower-precedence config.json)
          // still deny this skill, append an explicit allow.
          const probeDoc: Record<string, unknown> = { ...doc, policies: filteredPolicies };
          const effectiveAfterRemoval =
            evaluateOpenCodeSkillPolicy(probeDoc, input.skillName) ?? input.inheritedEffect;
          if (effectiveAfterRemoval === "deny") {
            filteredPolicies.push({
              action: "skill.use",
              resource: input.skillName,
              effect: "allow",
            });
          }
        }

        if (filteredPolicies.length > 0) {
          doc.policies = filteredPolicies;
        } else {
          delete doc.policies;
        }

        await writeFilePreservingModeAndLinks({
          targetPath: target,
          contents: `${JSON.stringify(doc, null, 2)}\n`,
          path,
        });
      });
    },
    catch: (error) =>
      error instanceof Error ? error.message : `Failed to update ${input.userConfigPath}.`,
  });
});

/**
 * Checks whether an Antigravity profile's slot (`config/skills` or `antigravity-cli/skills`) is
 * controlled by Threadlines (either a symlink to `sourceDir`, an empty directory, missing, or a
 * Threadlines-managed split directory).
 */
export const antigravityProfileManagesSkillDir = Effect.fn(
  "otherProviderSkillToggles.antigravityProfileManagesSkillDir",
)(function* (
  profileDir: string | undefined,
  rel: AntigravitySkillDir,
  sourceDir: string,
): Effect.fn.Return<boolean, never, Path.Path> {
  if (!profileDir) return false;
  const path = yield* Path.Path;
  const slot = path.join(profileDir, ...rel.split("/"));
  return yield* Effect.promise(async () => {
    const lstat = await fs.lstat(slot).catch(() => null);
    if (!lstat) return true;
    if (lstat.isSymbolicLink()) {
      const [slotReal, sourceReal] = await Promise.all([
        fs.realpath(slot).catch(() => null),
        fs.realpath(sourceDir).catch(() => null),
      ]);
      if (slotReal && sourceReal) {
        return normalizedPathKey(slotReal) === normalizedPathKey(sourceReal);
      }
      const rawTarget = await fs.readlink(slot).catch(() => null);
      if (!rawTarget) return false;
      const resolvedTarget = path.resolve(path.dirname(slot), rawTarget);
      return normalizedPathKey(resolvedTarget) === normalizedPathKey(path.resolve(sourceDir));
    }
    if (lstat.isDirectory()) {
      if (await isAntigravitySplitSkillDir(profileDir, rel)) return true;
      const entries = await fs.readdir(slot).catch(() => null);
      return entries !== null && entries.length === 0;
    }
    return false;
  });
});

export interface AntigravityDirectUserSkillEntry {
  readonly sharedDir: AntigravitySkillDir;
  readonly entryName: string;
  readonly discoveredSkillPath: string;
  readonly realSkillPath: string;
  readonly isEntryOrFileSymlink: boolean;
}

/**
 * Enumerates direct child skills inside `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills`,
 * preserving both their discovered path under `~/.gemini` and their canonical `realpath`.
 */
export const listAntigravityDirectUserSkills = Effect.fn(
  "otherProviderSkillToggles.listAntigravityDirectUserSkills",
)(function* (
  userHome: string,
): Effect.fn.Return<ReadonlyArray<AntigravityDirectUserSkillEntry>, never, Path.Path> {
  const path = yield* Path.Path;
  const geminiDir = antigravityUserGeminiDir(userHome);
  return yield* Effect.promise(async () => {
    const results: Array<AntigravityDirectUserSkillEntry> = [];
    for (const sharedDir of ANTIGRAVITY_SKILL_DIRS) {
      const rootDir = path.join(geminiDir, ...sharedDir.split("/"));
      const entries = await fs.readdir(rootDir).catch(() => null);
      if (!entries) continue;
      // Skip roots that themselves hold a direct SKILL.md (single-skill roots cannot be split).
      const hasDirectSkill = entries.some((entry) => entry.toLowerCase() === "skill.md");
      if (hasDirectSkill) continue;
      for (const entryName of entries.toSorted()) {
        if (entryName.startsWith(".")) continue;
        const entryDir = path.join(rootDir, entryName);
        const dirLstat = await fs.lstat(entryDir).catch(() => null);
        if (!dirLstat) continue;
        const dirStat = dirLstat.isSymbolicLink()
          ? await fs.stat(entryDir).catch(() => null)
          : dirLstat;
        if (!dirStat?.isDirectory()) continue;
        const childFiles = await fs.readdir(entryDir).catch(() => null);
        const skillFileName = childFiles
          ?.toSorted()
          .find((name) => name.toLowerCase() === "skill.md");
        if (!skillFileName) continue;
        const discoveredSkillPath = path.join(entryDir, skillFileName);
        const fileLstat = await fs.lstat(discoveredSkillPath).catch(() => null);
        if (!fileLstat) continue;
        const fileStat = fileLstat.isSymbolicLink()
          ? await fs.stat(discoveredSkillPath).catch(() => null)
          : fileLstat;
        if (!fileStat?.isFile()) continue;
        const realSkillPath =
          (await fs.realpath(discoveredSkillPath).catch(() => null)) ?? discoveredSkillPath;
        results.push({
          sharedDir,
          entryName,
          discoveredSkillPath,
          realSkillPath,
          isEntryOrFileSymlink: dirLstat.isSymbolicLink() || fileLstat.isSymbolicLink(),
        });
      }
    }
    return results;
  });
});

/** Re-syncs an Antigravity profile after creating or deleting a user skill so split dirs stay current. */
export const syncAntigravityProfileAfterSkillMutation = Effect.fn(
  "otherProviderSkillToggles.syncAntigravityProfileAfterSkillMutation",
)(function* (input: {
  readonly profileDir: string;
  readonly userHome: string;
  readonly stateDir: string;
}): Effect.fn.Return<void, never, never> {
  yield* Effect.promise(async () => {
    const stat = await fs.stat(input.profileDir).catch(() => null);
    if (!stat?.isDirectory()) return;
    await shareAntigravityUserConfigNow({
      profileDir: input.profileDir,
      userHome: input.userHome,
      platform: process.platform,
      threadlinesDir: input.stateDir,
    }).catch(() => undefined);
  });
});

/** Toggles one Antigravity personal skill inside its Threadlines profile and fails on any sync error. */
export const writeAntigravitySkillToggle = Effect.fn(
  "otherProviderSkillToggles.writeAntigravitySkillToggle",
)(function* (input: {
  readonly profileDir: string;
  readonly userHome: string;
  readonly stateDir: string;
  readonly sharedDir: AntigravitySkillDir;
  readonly entryName: string;
  readonly enabled: boolean;
}): Effect.fn.Return<void, string, Path.Path> {
  const path = yield* Path.Path;
  const targetPrefix = path.resolve(path.join(input.profileDir, ...input.sharedDir.split("/")));
  return yield* Effect.tryPromise({
    try: async () => {
      const problems = await setAntigravitySkillDisabled({
        profileDir: input.profileDir,
        userHome: input.userHome,
        platform: process.platform,
        threadlinesDir: input.stateDir,
        sharedDir: input.sharedDir,
        entryName: input.entryName,
        disabled: !input.enabled,
      });
      const relevant = problems.filter((problem) => {
        const resolved = path.resolve(problem.path);
        return (
          normalizedPathKey(resolved) === normalizedPathKey(targetPrefix) ||
          normalizedPathKey(resolved).startsWith(`${normalizedPathKey(targetPrefix)}/`) ||
          problem.path.endsWith(".shared-config.json")
        );
      });
      if (relevant.length > 0) {
        throw new Error(relevant.map((problem) => problem.error).join(" "));
      }
    },
    catch: (error) =>
      error instanceof Error ? error.message : "Failed to update Antigravity skill toggle.",
  });
});
