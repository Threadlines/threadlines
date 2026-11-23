/**
 * AntigravityUserConfig — brings the user's own global rules and skills from
 * `~/.gemini` into each instance's private profile.
 *
 * An instance runs with its own `GEMINI_HOME` (`AntigravityProfile`) so its
 * sign-in stays separate, and the agent reads global rules and skills from
 * there. This module links the rule files and skill folders listed below
 * into the profile on macOS and Linux. On Windows it uses junctions for the
 * folders (they need no privileges) and copies the files, refreshing each
 * copy when its source changes. Credentials, hooks, plugins and the user's
 * MCP config are never brought in.
 *
 * Runs before every agent start, so a source that appears later is picked
 * up then, and one that goes away takes its link with it (a dangling link
 * would stop the agent creating the folder itself). A link or copy is only
 * replaced or removed when Threadlines made it: a real file or a non-empty
 * folder the agent wrote stays as it is.
 *
 * @module provider/antigravity/AntigravityUserConfig
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import * as Effect from "effect/Effect";

/**
 * Folders Google's CLI reads global skills and rules from, relative to
 * `GEMINI_HOME`. The CLI looks in `antigravity-cli/skills` even when its app
 * data dir is `antigravity-acp` (T3 Code links the same two skill folders;
 * the CLI creates both itself when they are missing). `config/rules` holds
 * always-on rule files (CLI changelog: global customization in
 * `~/.gemini/config` includes the `rules/` folder).
 */
export const ANTIGRAVITY_SHARED_DIRS = [
  "config/skills",
  "antigravity-cli/skills",
  "config/rules",
] as const;

/**
 * Global rule files and the skill and rule manifests, relative to
 * `GEMINI_HOME`. Left out on purpose: `config/hooks.json`,
 * `config/mcp_config.json`, `config/plugins` and `plugins.json` (plugins
 * carry MCP servers and hooks), `config/agents.json`, and every sign-in file.
 */
export const ANTIGRAVITY_SHARED_FILES = [
  "AGENTS.md",
  "GEMINI.md",
  "config/AGENTS.md",
  "config/GEMINI.md",
  "config/skills.json",
  "config/rules.json",
] as const;

/** Copies above this size are skipped: the CLI cuts a rule file off far below it. */
const MAX_COPY_BYTES = 1_000_000;

/** What Threadlines put in the profile, so it never touches what it didn't. */
interface SharedConfigRecord {
  /** Link path (relative to the profile) to the target it was made for. */
  links: Record<string, string>;
  /** Copy path (relative to the profile) to the sha256 of what was written. */
  copies: Record<string, string>;
}

const recordPath = (profileDir: string) => join(profileDir, "threadlines-shared-config.json");

const stringRecord = (raw: unknown): Record<string, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

async function readRecord(profileDir: string): Promise<SharedConfigRecord> {
  const raw = await fs.readFile(recordPath(profileDir), "utf8").catch(() => undefined);
  try {
    const parsed = raw === undefined ? undefined : (JSON.parse(raw) as Partial<SharedConfigRecord>);
    return { links: stringRecord(parsed?.links), copies: stringRecord(parsed?.copies) };
  } catch {
    return { links: {}, copies: {} };
  }
}

async function writeRecord(profileDir: string, record: SharedConfigRecord): Promise<void> {
  const target = recordPath(profileDir);
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record));
  await fs.rename(temp, target);
}

/**
 * The home folder the agent will treat as `~`, which is where its global
 * config lives: Python's `os.path.expanduser`, so `USERPROFILE` (then
 * `HOMEDRIVE` + `HOMEPATH`) on Windows and `HOME` elsewhere.
 */
export function antigravityUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  fallback: string,
): string {
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
    return fallback;
  }
  return environment.HOME || fallback;
}

/** The user's own `~/.gemini`. */
export const antigravityUserGeminiDir = (userHome: string) => join(userHome, ".gemini");

type EntryKind = "dir" | "file";

const sourceIs = async (path: string, kind: EntryKind) => {
  const stat = await fs.stat(path).catch(() => undefined);
  return kind === "dir" ? stat?.isDirectory() === true : stat?.isFile() === true;
};

/** Where an existing link points, as an absolute path; Windows' `\\?\` prefix dropped. */
const linkTarget = async (link: string) => {
  const raw = await fs.readlink(link);
  return resolve(dirname(link), raw.replace(/^\\\\\?\\/u, ""));
};

/**
 * Links one shared folder or file. Returns the target to record when the
 * link is Threadlines', or undefined when there is none (or it isn't ours).
 */
async function shareByLink(input: {
  readonly link: string;
  readonly target: string;
  readonly kind: EntryKind;
  readonly platform: NodeJS.Platform;
  readonly recorded: string | undefined;
}): Promise<string | undefined> {
  const { link, target, kind } = input;
  const present = await sourceIs(target, kind);
  const stat = await fs.lstat(link).catch(() => undefined);
  if (stat?.isSymbolicLink()) {
    const current = await linkTarget(link);
    if (current === target && present) return target;
    // Another target (the home moved) or a source that went away: replaced
    // or removed only when Threadlines made it.
    if (current !== target && current !== input.recorded) return undefined;
    await fs.rm(link, { force: true });
  } else if (stat?.isDirectory()) {
    if (!present || kind !== "dir") return undefined;
    // The agent leaves an empty folder where a link was missing. rmdir
    // refuses one with anything in it, so nothing the agent wrote is lost.
    const removed = await fs.rmdir(link).then(
      () => true,
      () => false,
    );
    if (!removed) return undefined;
  } else if (stat) {
    // A real file the agent or the user put there.
    return undefined;
  }
  if (!present) return undefined;
  await fs.mkdir(dirname(link), { recursive: true, mode: 0o700 });
  const type = kind === "file" ? "file" : input.platform === "win32" ? "junction" : "dir";
  try {
    await fs.symlink(target, link, type);
  } catch (error) {
    // Another start of the same instance linked it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await linkTarget(link).catch(() => undefined)) !== target) throw error;
  }
  return target;
}

const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");

const readSmallFile = async (path: string) => {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.size > MAX_COPY_BYTES) return undefined;
  return fs.readFile(path).catch(() => undefined);
};

/**
 * Copies one shared file (Windows, where a file link needs elevation).
 * Returns the hash to record when the copy is Threadlines', or undefined.
 */
async function shareByCopy(input: {
  readonly copy: string;
  readonly source: string;
  readonly recorded: string | undefined;
}): Promise<string | undefined> {
  const stat = await fs.lstat(input.copy).catch(() => undefined);
  const current = stat?.isFile() ? await fs.readFile(input.copy) : undefined;
  // Anything else there, or a copy changed since Threadlines wrote it, is
  // the agent's or the user's own.
  if (stat && (current === undefined || sha256(current) !== input.recorded)) return undefined;
  const source = await readSmallFile(input.source);
  if (source === undefined) {
    if (current !== undefined) await fs.rm(input.copy, { force: true });
    return undefined;
  }
  const hash = sha256(source);
  if (current !== undefined && sha256(current) === hash) return hash;
  await fs.mkdir(dirname(input.copy), { recursive: true, mode: 0o700 });
  const temp = `${input.copy}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, source, { mode: 0o600 });
  await fs.rename(temp, input.copy);
  return hash;
}

export interface ShareAntigravityUserConfigInput {
  readonly profileDir: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}

/** Brings the user's shared rules and skills into the profile; returns what failed. */
export async function shareAntigravityUserConfigNow(
  input: ShareAntigravityUserConfigInput,
): Promise<ReadonlyArray<{ readonly path: string; readonly error: string }>> {
  const userGemini = antigravityUserGeminiDir(input.userHome);
  const before = await readRecord(input.profileDir);
  const after: SharedConfigRecord = { links: {}, copies: {} };
  const problems: Array<{ path: string; error: string }> = [];
  const entries = [
    ...ANTIGRAVITY_SHARED_DIRS.map((rel) => ({ rel, kind: "dir" as const })),
    ...ANTIGRAVITY_SHARED_FILES.map((rel) => ({ rel, kind: "file" as const })),
  ];
  for (const { rel, kind } of entries) {
    const inProfile = join(input.profileDir, ...rel.split("/"));
    const source = join(userGemini, ...rel.split("/"));
    try {
      if (kind === "file" && input.platform === "win32") {
        const hash = await shareByCopy({ copy: inProfile, source, recorded: before.copies[rel] });
        if (hash) after.copies[rel] = hash;
      } else {
        const target = await shareByLink({
          link: inProfile,
          target: source,
          kind,
          platform: input.platform,
          recorded: before.links[rel],
        });
        if (target) after.links[rel] = target;
      }
    } catch (error) {
      problems.push({ path: inProfile, error: String(error) });
      // Still Threadlines' when it fails to change: keep the record so the
      // next start can try again.
      if (before.links[rel]) after.links[rel] = before.links[rel];
      if (before.copies[rel]) after.copies[rel] = before.copies[rel];
    }
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await writeRecord(input.profileDir, after).catch((error: unknown) =>
      problems.push({ path: recordPath(input.profileDir), error: String(error) }),
    );
  }
  return problems;
}

/**
 * `shareAntigravityUserConfigNow` as an effect that never fails: a rule or
 * skill that can't be brought in is logged, and the agent starts without it.
 */
export const shareAntigravityUserConfig = (input: ShareAntigravityUserConfigInput) =>
  Effect.promise(() =>
    shareAntigravityUserConfigNow(input).catch((error: unknown) => [
      { path: input.profileDir, error: String(error) },
    ]),
  ).pipe(
    Effect.flatMap((problems) =>
      problems.length === 0
        ? Effect.void
        : Effect.logWarning("Some of the user's Antigravity rules or skills are not shared.", {
            problems,
          }),
    ),
  );
