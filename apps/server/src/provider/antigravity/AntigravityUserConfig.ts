/**
 * AntigravityUserConfig — brings the user's own global rules and skills from
 * `~/.gemini` into each instance's private profile.
 *
 * An instance runs with its own `GEMINI_HOME` (`AntigravityProfile`) so its
 * sign-in stays separate, and the agent reads global rules and skills from
 * there. This module links the rule files and skill folders listed below
 * into the profile on macOS and Linux. On Windows it uses junctions for the
 * folders (they need no privileges) and copies the files, refreshing each
 * copy when its source changes. Runs before every agent start and every
 * status check, so a source that appears later is picked up then, and one
 * that goes away takes Threadlines' link or copy with it.
 *
 * What it will not do:
 *
 * - Bring in anything on the keep-out list, even through a link: sign-in
 *   and token files, hooks, MCP config, plugins, agents config, the rest of
 *   `~/.gemini`, and Threadlines' own data folder.
 * - Touch anything it didn't make. A record beside the profile (outside the
 *   agent's home) names each link and copy Threadlines made; only those are
 *   replaced or removed. A matching link someone else made is used as it is
 *   and never removed. The one exception is an empty folder the agent left
 *   where a link was missing, which holds nothing to lose.
 * - Work through a link inside the profile: a profile folder that is a link
 *   (to the user's real `~/.gemini/config`, say) would turn a profile write
 *   into a write to the user's own files, so that entry is skipped.
 * - Hold up a chat: the whole step has a time bound, and file reads never
 *   block on a FIFO.
 *
 * Writes go in a crash-safe order: the record claims a link or copy before
 * it is made, a new copy is linked into place without overwriting, and a
 * replaced or removed one is first moved aside and checked.
 *
 * @module provider/antigravity/AntigravityUserConfig
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { readRegularFile } from "./AntigravityFileReads.ts";

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

/** Global rule files and the skill and rule manifests, relative to `GEMINI_HOME`. */
export const ANTIGRAVITY_SHARED_FILES = [
  "AGENTS.md",
  "GEMINI.md",
  "config/AGENTS.md",
  "config/GEMINI.md",
  "config/skills.json",
  "config/rules.json",
] as const;

/**
 * File names never brought in, wherever a shared source's link leads:
 * sign-in and token files, hooks, MCP config, plugins and agents config.
 */
const KEEP_OUT_NAMES = new Set([
  "antigravity-oauth-token",
  "acp_token.json",
  "oauth_creds.json",
  "google_accounts.json",
  "application_default_credentials.json",
  "credentials.db",
  "access_tokens.db",
  "hooks.json",
  "mcp_config.json",
  "plugins.json",
  "plugins",
  "agents.json",
]);

/** Copies above this size are skipped: the CLI cuts a rule file off far below it. */
const MAX_COPY_BYTES = 1_000_000;
const MAX_RECORD_BYTES = 64 * 1024;
/** No chat waits longer than this for the user's rules and skills. */
const SHARE_TIME_LIMIT = Duration.seconds(10);

/** What Threadlines put in the profile, so it never touches what it didn't. */
interface SharedConfigRecord {
  /** Link path (relative to the profile) to the target it was made for. */
  links: Record<string, string>;
  /**
   * Copy path (relative to the profile) to the sha256 of each content that
   * is Threadlines': two while a refresh is in flight, so a crash between
   * the copy landing and the record catching up leaves it still ours.
   */
  copies: Record<string, ReadonlyArray<string>>;
}

/** Beside the profile, so the record is outside the folder the agent keeps as its home. */
export const antigravitySharedConfigRecordPath = (profileDir: string) =>
  `${profileDir}.shared-config.json`;

function parseRecord(raw: unknown): SharedConfigRecord {
  const record: SharedConfigRecord = { links: {}, copies: {} };
  if (typeof raw !== "object" || raw === null) return record;
  const { links, copies } = raw as { links?: unknown; copies?: unknown };
  if (typeof links === "object" && links !== null) {
    for (const [rel, target] of Object.entries(links)) {
      if (typeof target === "string") record.links[rel] = target;
    }
  }
  if (typeof copies === "object" && copies !== null) {
    for (const [rel, digests] of Object.entries(copies)) {
      if (Array.isArray(digests)) {
        record.copies[rel] = digests.filter((digest) => typeof digest === "string");
      }
    }
  }
  return record;
}

async function readRecord(profileDir: string): Promise<SharedConfigRecord> {
  const raw = await readRegularFile(antigravitySharedConfigRecordPath(profileDir), {
    maxBytes: MAX_RECORD_BYTES,
    followLink: false,
  });
  try {
    return parseRecord(raw === undefined ? undefined : JSON.parse(raw.toString("utf8")));
  } catch {
    return { links: {}, copies: {} };
  }
}

async function writeRecord(profileDir: string, record: SharedConfigRecord): Promise<void> {
  const target = antigravitySharedConfigRecordPath(profileDir);
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
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

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const realpathOf = (path: string) => fs.realpath(path).catch(() => undefined);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Where Threadlines may and may not take a shared source from. */
interface SourceRules {
  /** The user's real `~/.gemini`, if it exists. */
  readonly realGemini: string | undefined;
  /** Folders a source may never lead into: Threadlines' data and the profile. */
  readonly forbidden: ReadonlyArray<string>;
}

/**
 * Whether the source of a shared entry exists as `kind` and may be brought
 * in. A source can be a link (people keep these in a dotfiles repo); what
 * counts is where it leads. Inside `~/.gemini` it may only lead to one of
 * the shared entries, so a `GEMINI.md` linked to the sign-in token is not a
 * rule; anywhere else it must not be a keep-out file or Threadlines' data.
 */
async function sourceAllowed(source: string, kind: EntryKind, rules: SourceRules) {
  const real = await realpathOf(source);
  if (real === undefined) return false;
  const stat = await fs.stat(real).catch(() => undefined);
  if (kind === "dir" ? !stat?.isDirectory() : !stat?.isFile()) return false;
  if (KEEP_OUT_NAMES.has(basename(real).toLowerCase())) return false;
  if (rules.forbidden.some((root) => isInside(root, real))) return false;
  const { realGemini } = rules;
  if (realGemini !== undefined && isInside(realGemini, real)) {
    return [...ANTIGRAVITY_SHARED_DIRS, ...ANTIGRAVITY_SHARED_FILES].some((rel) =>
      isInside(join(realGemini, ...rel.split("/")), real),
    );
  }
  return true;
}

/**
 * Whether every folder between the profile and an entry is a real folder
 * inside the profile (or missing, when `create` is off); false when one is a
 * link or anything else, so nothing is read or written through it. With
 * `create`, missing folders are made, one level at a time.
 */
async function realParentInProfile(input: {
  readonly profileDir: string;
  readonly realProfile: string;
  readonly rel: string;
  readonly create: boolean;
}): Promise<boolean> {
  const parts = input.rel.split("/").slice(0, -1);
  let dir = input.profileDir;
  for (const part of parts) {
    dir = join(dir, part);
    const stat = await fs.lstat(dir).catch(() => undefined);
    if (stat === undefined) {
      if (!input.create) return true;
      // Not recursive: mkdir -p would walk through a link made meanwhile.
      await fs.mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
        if (codeOf(error) !== "EEXIST") throw error;
      });
      continue;
    }
    if (!stat.isDirectory()) return false;
  }
  return (await realpathOf(dir)) === join(input.realProfile, ...parts);
}

/** Where an existing link points, as an absolute path; Windows' `\\?\` prefix dropped. */
const linkTarget = async (link: string) => {
  const raw = await fs.readlink(link);
  return resolve(dirname(link), raw.replace(/^\\\\\?\\/u, ""));
};

const asidePath = (path: string) => `${path}.threadlines-${randomBytes(4).toString("hex")}`;

/**
 * Puts back something moved aside that turned out not to be Threadlines',
 * without replacing whatever took its place meanwhile. If its name is taken
 * it stays under the aside name, and that is reported.
 */
async function putBack(aside: string, path: string): Promise<void> {
  const stat = await fs.lstat(aside);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(aside), path);
    await fs.unlink(aside);
  } else if (stat.isDirectory()) {
    await fs.rename(aside, path);
  } else {
    await fs.link(aside, path);
    await fs.unlink(aside);
  }
}

/**
 * Removes `path` only if it still is what `isOurs` recognizes, judged after
 * it is moved aside, so a file the agent writes at the same moment is never
 * deleted in its place.
 */
async function removeIfOurs(
  path: string,
  isOurs: (aside: string) => Promise<boolean>,
): Promise<boolean> {
  const aside = asidePath(path);
  try {
    await fs.rename(path, aside);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return true;
    throw error;
  }
  if (await isOurs(aside)) {
    await fs.unlink(aside);
    return true;
  }
  await putBack(aside, path).catch((error: unknown) => {
    throw new Error(`Left ${aside} beside ${path}: ${String(error)}`, { cause: error });
  });
  return false;
}

interface EntryContext {
  readonly rel: string;
  readonly path: string;
  readonly source: string;
  readonly kind: EntryKind;
  readonly allowed: boolean;
  readonly platform: NodeJS.Platform;
  readonly record: SharedConfigRecord;
  /** Saves the record before a link or copy is made, so a crash leaves it claimed. */
  readonly claim: () => Promise<void>;
  /** Makes the entry's folders, still refusing any that is a link; false when refused. */
  readonly makeParent: () => Promise<boolean>;
}

/** Links one shared folder or file; updates the record with what is Threadlines'. */
async function shareByLink(entry: EntryContext): Promise<void> {
  const { path, source, record, rel } = entry;
  const recorded = record.links[rel];
  const stat = await fs.lstat(path).catch(() => undefined);
  if (stat?.isSymbolicLink()) {
    const current = await linkTarget(path);
    if (current === source && entry.allowed) return;
    // A link Threadlines didn't make is used as it is, and never removed.
    if (recorded === undefined || current !== recorded) {
      delete record.links[rel];
      return;
    }
    const removed = await removeIfOurs(path, async (aside) => {
      const asideStat = await fs.lstat(aside).catch(() => undefined);
      return asideStat?.isSymbolicLink() === true && (await linkTarget(aside)) === recorded;
    });
    if (!removed) {
      delete record.links[rel];
      return;
    }
  } else if (stat?.isDirectory()) {
    delete record.links[rel];
    if (!entry.allowed || entry.kind !== "dir") return;
    // The agent leaves an empty folder where a link was missing. rmdir
    // refuses one with anything in it, so nothing the agent wrote is lost.
    const removed = await fs.rmdir(path).then(
      () => true,
      () => false,
    );
    if (!removed) return;
  } else if (stat) {
    // A real file the agent or the user put there.
    delete record.links[rel];
    return;
  }
  delete record.links[rel];
  if (!entry.allowed) return;
  if (!(await entry.makeParent())) return;
  record.links[rel] = source;
  await entry.claim();
  const type =
    entry.kind === "file" ? "file" : entry.platform === "win32" ? "junction" : ("dir" as const);
  try {
    // Fails on an existing entry instead of replacing it.
    await fs.symlink(source, path, type);
  } catch (error) {
    if (codeOf(error) === "EEXIST" && (await linkTarget(path).catch(() => undefined)) === source) {
      return;
    }
    delete record.links[rel];
    throw error;
  }
}

const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");

const readCopy = (path: string) =>
  readRegularFile(path, { maxBytes: MAX_COPY_BYTES, followLink: false });

/**
 * Copies one shared file (Windows, where a file link needs elevation) and
 * updates the record. A copy the record doesn't recognize is the agent's or
 * the user's own and is left alone for good.
 */
async function shareByCopy(entry: EntryContext): Promise<void> {
  const { path, record, rel } = entry;
  const ours = record.copies[rel] ?? [];
  const stat = await fs.lstat(path).catch(() => undefined);
  const current = stat ? await readCopy(path) : undefined;
  const currentHash = current === undefined ? undefined : sha256(current);
  if (stat && (currentHash === undefined || !ours.includes(currentHash))) {
    delete record.copies[rel];
    return;
  }
  const isOurs = async (aside: string) => {
    const content = await readCopy(aside);
    return content !== undefined && ours.includes(sha256(content));
  };
  const source = entry.allowed
    ? await readRegularFile(entry.source, { maxBytes: MAX_COPY_BYTES, followLink: true })
    : undefined;
  if (source === undefined) {
    if (stat) await removeIfOurs(path, isOurs);
    delete record.copies[rel];
    return;
  }
  const hash = sha256(source);
  if (currentHash === hash) {
    record.copies[rel] = [hash];
    return;
  }
  if (!(await entry.makeParent())) return;
  record.copies[rel] = currentHash === undefined ? [hash] : [currentHash, hash];
  await entry.claim();
  const temp = asidePath(path);
  await fs.writeFile(temp, source, { mode: 0o600, flag: "wx" });
  try {
    if (stat && !(await removeIfOurs(path, isOurs))) {
      delete record.copies[rel];
      return;
    }
    try {
      // Fails on an existing entry, so a file the agent just made stays.
      await fs.link(temp, path);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      delete record.copies[rel];
      return;
    }
    record.copies[rel] = [hash];
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export interface ShareAntigravityUserConfigInput {
  readonly profileDir: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  /** Threadlines' own data folder, which a shared source may never lead into. */
  readonly threadlinesDir?: string;
}

/** Brings the user's shared rules and skills into the profile; returns what failed. */
async function shareOnce(
  input: ShareAntigravityUserConfigInput,
): Promise<ReadonlyArray<{ readonly path: string; readonly error: string }>> {
  await fs.mkdir(input.profileDir, { recursive: true, mode: 0o700 });
  const realProfile = await fs.realpath(input.profileDir);
  const userGemini = antigravityUserGeminiDir(input.userHome);
  const threadlinesDir = input.threadlinesDir ? await realpathOf(input.threadlinesDir) : undefined;
  const rules: SourceRules = {
    realGemini: await realpathOf(userGemini),
    forbidden: [realProfile, ...(threadlinesDir ? [threadlinesDir] : [])],
  };
  const before = await readRecord(input.profileDir);
  const record: SharedConfigRecord = {
    links: { ...before.links },
    copies: { ...before.copies },
  };
  let saved = JSON.stringify(record);
  const save = async () => {
    const next = JSON.stringify(record);
    if (next === saved) return;
    await writeRecord(input.profileDir, record);
    saved = next;
  };
  const problems: Array<{ path: string; error: string }> = [];
  const entries = [
    ...ANTIGRAVITY_SHARED_DIRS.map((rel) => ({ rel, kind: "dir" as const })),
    ...ANTIGRAVITY_SHARED_FILES.map((rel) => ({ rel, kind: "file" as const })),
  ];
  for (const { rel, kind } of entries) {
    const path = join(input.profileDir, ...rel.split("/"));
    try {
      const parent = { profileDir: input.profileDir, realProfile, rel };
      if (!(await realParentInProfile({ ...parent, create: false }))) {
        problems.push({ path, error: "A folder on the way is a link; left alone." });
        continue;
      }
      const source = join(userGemini, ...rel.split("/"));
      const entry: EntryContext = {
        rel,
        path,
        source,
        kind,
        allowed: await sourceAllowed(source, kind, rules),
        platform: input.platform,
        record,
        claim: save,
        makeParent: () => realParentInProfile({ ...parent, create: true }),
      };
      if (kind === "file" && input.platform === "win32") await shareByCopy(entry);
      else await shareByLink(entry);
    } catch (error) {
      problems.push({ path, error: String(error) });
    }
  }
  await save().catch((error: unknown) =>
    problems.push({
      path: antigravitySharedConfigRecordPath(input.profileDir),
      error: String(error),
    }),
  );
  return problems;
}

/** The run in progress for each profile: two starts never share at once. */
const running = new Map<string, Promise<unknown>>();

/** `shareOnce`, one at a time per profile; a run stuck past the time bound no longer holds the next. */
export function shareAntigravityUserConfigNow(
  input: ShareAntigravityUserConfigInput,
): Promise<ReadonlyArray<{ readonly path: string; readonly error: string }>> {
  const key = resolve(input.profileDir);
  const previous = running.get(key) ?? Promise.resolve();
  const waited = Promise.race([
    previous.catch(() => undefined),
    new Promise((done) => setTimeout(done, Duration.toMillis(SHARE_TIME_LIMIT)).unref()),
  ]);
  const run = waited.then(() => shareOnce(input));
  const settled = run.catch(() => undefined);
  running.set(key, settled);
  void settled.then(() => {
    if (running.get(key) === settled) running.delete(key);
  });
  return run;
}

/**
 * `shareAntigravityUserConfigNow` as an effect that never fails and never
 * waits past its time bound: a rule or skill that can't be brought in is
 * logged, and the agent starts without it.
 */
export const shareAntigravityUserConfig = (input: ShareAntigravityUserConfigInput) =>
  Effect.promise(() =>
    shareAntigravityUserConfigNow(input).catch((error: unknown) => [
      { path: input.profileDir, error: String(error) },
    ]),
  ).pipe(
    Effect.timeoutOption(SHARE_TIME_LIMIT),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logWarning("Sharing the user's Antigravity rules and skills took too long.", {
            profileDir: input.profileDir,
          })
        : result.value.length === 0
          ? Effect.void
          : Effect.logWarning("Some of the user's Antigravity rules or skills are not shared.", {
              problems: result.value,
            }),
    ),
  );
