/**
 * The Showcase repository's checks and list (docs/design/custom-themes.md,
 * "Showcase"). Threadlines/themes' workflows run it from a pinned Threadlines
 * commit; it never runs code from the repository it reads.
 *
 *   node scripts/theme-showcase.ts check <repo> [--base <sha> --author <login> [--trusted]]
 *   node scripts/theme-showcase.ts index <repo>
 *
 * `check` holds every theme folder to the Showcase's rules (the same ones the
 * app shares by): a theme file with only fields this build knows, an open
 * license, no trace of the thread that made it, fonts that carry their own
 * notice and an OFL or Apache license, and a plain 320×200 PNG. With
 * `--base`, it also checks what a pull request changed: an outside author
 * (not `--trusted`) may add theme folders, change only folders they shared,
 * and touch nothing else, and may say only that they shared it themselves.
 *
 * `index` writes `index.json` (the list the app reads, with each file's size
 * and SHA-256) and each theme's `NOTICE.md` (its credit and its fonts'
 * notices), from the folders as they are on main.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";

import {
  GitHubLogin,
  THEME_MAX_FILE_BYTES,
  THEME_SHOWCASE_FORMAT,
  type ThemeManifest,
  type ThemeShowcaseEntry,
  type ThemeShowcaseFont,
  type ThemeShowcaseIndex,
  ThemeShowcaseSlug,
} from "@threadlines/contracts";
import {
  fontNoticeLicense,
  readWoff2Notice,
  WOFF2_MAX_DECOMPRESSED_BYTES,
} from "@threadlines/shared/themeFontNotice";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";
import {
  showcaseFontProblems,
  showcasePngProblems,
  THEME_SHOWCASE_THUMBNAIL,
  themeShowcaseProblems,
} from "@threadlines/shared/themeShowcase";
import * as Schema from "effect/Schema";

const THEME_FILE = "theme.threadlines-theme";
const THUMBNAIL_FILE = "thumbnail.png";
const META_FILE = "meta.json";
const NOTICE_FILE = "NOTICE.md";
/** What a theme's folder holds; NOTICE.md is written by `index`, never by hand. */
const FOLDER_FILES = new Set([THEME_FILE, THUMBNAIL_FILE, META_FILE, NOTICE_FILE]);

const isSlug = Schema.is(ThemeShowcaseSlug);
const isLogin = Schema.is(GitHubLogin);

/** `meta.json`: who shared it (their GitHub login, or null), and whether maintainers feature it. */
export interface ShowcaseMeta {
  readonly sharedBy: string | null;
  readonly featured: boolean;
}

export interface ShowcaseTheme {
  readonly slug: string;
  readonly manifest: ThemeManifest;
  readonly hash: string;
  readonly fonts: ReadonlyArray<ThemeShowcaseFont & { readonly notice: string | null }>;
  readonly meta: ShowcaseMeta;
  readonly file: Uint8Array;
  readonly thumbnail: Uint8Array;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A picture's image data unpacked, bounded well past what 320×200 can need. */
const inflatePicture = (data: Uint8Array) =>
  inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 });

function readMeta(text: string): { meta: ShowcaseMeta; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { meta: { sharedBy: null, featured: false }, problems: ["meta.json isn't JSON."] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { meta: { sharedBy: null, featured: false }, problems: ["meta.json isn't an object."] };
  }
  const problems: string[] = [];
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "sharedBy" && key !== "featured") problems.push(`meta.json has "${key}".`);
  }
  const sharedBy = record.sharedBy ?? null;
  if (sharedBy !== null && !isLogin(sharedBy)) {
    problems.push("meta.json's sharedBy isn't a GitHub login.");
  }
  const featured = record.featured ?? false;
  if (typeof featured !== "boolean") problems.push("meta.json's featured isn't true or false.");
  return {
    meta: {
      sharedBy: typeof sharedBy === "string" && isLogin(sharedBy) ? sharedBy : null,
      featured: featured === true,
    },
    problems,
  };
}

/** One theme folder, read and held to the rules: the theme, or why it can't be listed. */
export async function readShowcaseTheme(
  repo: string,
  slug: string,
): Promise<{ readonly theme: ShowcaseTheme | null; readonly problems: string[] }> {
  const folder = join(repo, "themes", slug);
  const problems: string[] = [];
  if (!isSlug(slug))
    problems.push("The folder's name must be lowercase letters, digits and dashes.");
  for (const name of readdirSync(folder)) {
    if (!FOLDER_FILES.has(name)) problems.push(`It holds ${name}, which a theme folder doesn't.`);
  }
  for (const name of [THEME_FILE, THUMBNAIL_FILE, META_FILE]) {
    if (!existsSync(join(folder, name))) problems.push(`It has no ${name}.`);
  }
  if (problems.length > 0) return { theme: null, problems };

  const file = readFileSync(join(folder, THEME_FILE));
  if (file.length > THEME_MAX_FILE_BYTES) {
    return {
      theme: null,
      problems: [`${THEME_FILE} is larger than ${THEME_MAX_FILE_BYTES} bytes.`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.toString("utf8"));
  } catch {
    return { theme: null, problems: [`${THEME_FILE} isn't JSON.`] };
  }
  const check = checkThemeManifest(parsed, { authoring: true });
  if (!check.ok)
    return { theme: null, problems: check.errors.map((error) => `${THEME_FILE}: ${error}`) };
  const manifest = check.manifest;
  problems.push(...themeShowcaseProblems(manifest));

  const fonts: Array<ThemeShowcaseFont & { notice: string | null }> = [];
  for (const slot of ["ui", "mono"] as const) {
    const font = manifest.fonts?.[slot];
    if (font === undefined) continue;
    if (font.data === undefined) {
      if (font.source !== "system") {
        problems.push(`The ${slot} font names ${font.source} without embedding it.`);
      }
      continue;
    }
    const read = readWoff2Notice(Buffer.from(font.data, "base64"), (data) =>
      brotliDecompressSync(data, { maxOutputLength: WOFF2_MAX_DECOMPRESSED_BYTES }),
    );
    if (!read.ok) problems.push(`The ${slot} font can't be read: ${read.error}.`);
    fonts.push({
      slot,
      family: font.family,
      copyright: read.ok ? read.notice.copyright : null,
      license: read.ok ? fontNoticeLicense(read.notice) : null,
      notice: read.ok ? read.notice.licenseUrl : null,
    });
  }
  problems.push(...showcaseFontProblems(fonts));

  const thumbnail = readFileSync(join(folder, THUMBNAIL_FILE));
  problems.push(
    ...showcasePngProblems(thumbnail, THEME_SHOWCASE_THUMBNAIL, inflatePicture).map(
      (p) => `${THUMBNAIL_FILE}: ${p}`,
    ),
  );
  const { meta, problems: metaProblems } = readMeta(readFileSync(join(folder, META_FILE), "utf8"));
  problems.push(...metaProblems);
  if (problems.length > 0) return { theme: null, problems };
  return {
    theme: {
      slug,
      manifest,
      hash: await themeContentHash(manifest),
      fonts,
      meta,
      file: new Uint8Array(file),
      thumbnail: new Uint8Array(thumbnail),
    },
    problems: [],
  };
}

const themeSlugs = (repo: string) => {
  const themes = join(repo, "themes");
  if (!existsSync(themes)) return [];
  return readdirSync(themes)
    .filter((name) => statSync(join(themes, name)).isDirectory())
    .toSorted();
};

// stderr is kept with the error, not the log: a `git show` of a file a new folder lacks fails by design.
const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export interface ShowcaseCheckOptions {
  /** The pull request's base commit: what it changed is checked too. */
  readonly base?: string;
  /** Who opened it. */
  readonly author?: string;
  /** A maintainer's pull request: it may change anything. */
  readonly trusted?: boolean;
}

/** Every problem in the repository, by place ("themes/<slug>", or a path a pull request changed). */
export async function checkShowcaseRepository(
  repo: string,
  options: ShowcaseCheckOptions = {},
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const note = (place: string, problem: string) =>
    found.set(place, [...(found.get(place) ?? []), problem]);

  const hashes = new Map<string, string>();
  const themes = new Map<string, ShowcaseTheme>();
  for (const slug of themeSlugs(repo)) {
    const { theme, problems } = await readShowcaseTheme(repo, slug);
    for (const problem of problems) note(`themes/${slug}`, problem);
    if (theme === null) continue;
    themes.set(slug, theme);
    const twin = hashes.get(theme.hash);
    if (twin !== undefined) note(`themes/${slug}`, `It's the same theme as themes/${twin}.`);
    else hashes.set(theme.hash, slug);
  }

  if (options.base !== undefined && options.trusted !== true) {
    const author = options.author?.toLowerCase();
    if (author === undefined) throw new Error("--base needs --author.");
    const changed = git(repo, ["diff", "--name-only", "--no-renames", `${options.base}...HEAD`])
      .split("\n")
      .filter((line) => line.length > 0);
    const folders = new Set<string>();
    for (const path of changed) {
      const match = /^themes\/([^/]+)\/([^/]+)$/.exec(path);
      if (match === null || match[2] === NOTICE_FILE) {
        note(path, "A pull request may only add or change files in a theme's folder.");
      } else {
        folders.add(match[1]!);
      }
    }
    for (const slug of folders) {
      let before: string | null = null;
      try {
        before = git(repo, ["show", `${options.base}:themes/${slug}/${META_FILE}`]);
      } catch {
        // A new folder.
      }
      if (before !== null && readMeta(before).meta.sharedBy?.toLowerCase() !== author) {
        note(`themes/${slug}`, "Only the person who shared a theme may change it.");
      }
      const theme = themes.get(slug);
      if (theme === undefined) {
        if (!existsSync(join(repo, "themes", slug))) {
          note(`themes/${slug}`, "A pull request may not remove a theme; open a takedown issue.");
        }
        continue;
      }
      if (theme.meta.sharedBy !== null && theme.meta.sharedBy.toLowerCase() !== author) {
        note(
          `themes/${slug}`,
          `meta.json says @${theme.meta.sharedBy} shared it, but @${options.author} opened this.`,
        );
      }
      if (theme.meta.featured) note(`themes/${slug}`, "Only maintainers feature a theme.");
    }
  }
  return found;
}

/** The day a file was first added on this branch, YYYY-MM-DD; today when git doesn't know it yet. */
function addedOn(repo: string, path: string): string {
  try {
    const days = git(repo, ["log", "--diff-filter=A", "--format=%cs", "--", path])
      .split("\n")
      .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
    const first = days.at(-1);
    if (first !== undefined) return first;
  } catch {
    // Not a git checkout.
  }
  return new Date().toISOString().slice(0, 10);
}

/** Each license a theme or font may carry, as a notice names and links it. */
const NOTICE_LICENSES = {
  "CC-BY-4.0": "[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)",
  "CC0-1.0": "[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)",
  MIT: "the MIT License",
  "OFL-1.1": "the [SIL Open Font License 1.1](../../licenses/OFL-1.1.txt)",
  "Apache-2.0": "the [Apache License 2.0](../../licenses/Apache-2.0.txt)",
} as const;

/** A sentence as a font's notice gives it, ending in a period. */
const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * A theme's NOTICE.md: who made it and its license, then each embedded font
 * with its own copyright notice and license, as OFL asks.
 */
export function noticeFor(theme: Pick<ShowcaseTheme, "manifest" | "fonts">): string {
  const credits = theme.manifest.credits;
  const author = credits?.author?.trim();
  const link = credits?.link?.trim();
  const license = credits?.license;
  const byLine =
    author === undefined || author === ""
      ? null
      : `By ${author}${link === undefined || link === "" ? "" : ` (${link})`}.`;
  const licenseLine =
    license === undefined ? "No license given." : `Shared under ${NOTICE_LICENSES[license]}.`;
  const lines = [
    `# ${theme.manifest.name}`,
    "",
    byLine === null ? licenseLine : `${byLine} ${licenseLine}`,
  ];
  if (theme.fonts.length > 0) {
    lines.push("", "## Fonts", "");
    for (const font of theme.fonts) {
      const notice = font.copyright === null ? "" : ` ${sentence(font.copyright)}`;
      const terms =
        font.license === null ? "" : ` Licensed under ${NOTICE_LICENSES[font.license]}.`;
      lines.push(`- **${font.family}**.${notice}${terms}`);
    }
  }
  lines.push("", "The picture was drawn by Threadlines from the theme.", "");
  return lines.join("\n");
}

/** The list the app reads, built from the folders as they are. Folders that fail the checks are left out. */
export async function buildShowcaseIndex(repo: string): Promise<{
  readonly index: ThemeShowcaseIndex;
  readonly notices: ReadonlyMap<string, string>;
  readonly skipped: ReadonlyArray<string>;
}> {
  const themes: ThemeShowcaseEntry[] = [];
  const notices = new Map<string, string>();
  const skipped: string[] = [];
  for (const slug of themeSlugs(repo)) {
    const { theme } = await readShowcaseTheme(repo, slug);
    if (theme === null) {
      skipped.push(slug);
      continue;
    }
    const { manifest } = theme;
    themes.push({
      id: slug,
      name: manifest.name,
      base: manifest.base,
      hasArt: manifest.backdrop !== undefined,
      colors: {
        background: manifest.colors.background,
        foreground: manifest.colors.foreground,
        accent: manifest.colors.accent,
      },
      ...(manifest.credits === undefined ? {} : { credits: manifest.credits }),
      sharedBy: theme.meta.sharedBy,
      featured: theme.meta.featured,
      addedAt: addedOn(repo, `themes/${slug}/${THEME_FILE}`),
      hash: theme.hash,
      file: {
        path: `themes/${slug}/${THEME_FILE}`,
        sha256: sha256(theme.file),
        bytes: theme.file.length,
      },
      thumbnail: {
        path: `themes/${slug}/${THUMBNAIL_FILE}`,
        sha256: sha256(theme.thumbnail),
        bytes: theme.thumbnail.length,
      },
    });
    notices.set(slug, noticeFor(theme));
  }
  themes.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
  return { index: { format: THEME_SHOWCASE_FORMAT, themes }, notices, skipped };
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, repo, ...rest] = argv;
  const flag = (name: string) => {
    const at = rest.indexOf(name);
    return at === -1 ? undefined : rest[at + 1];
  };
  if (repo === undefined || (command !== "check" && command !== "index")) {
    console.error(
      "Usage: theme-showcase.ts check|index <repo> [--base <sha> --author <login> [--trusted]]",
    );
    return 2;
  }
  if (command === "check") {
    const base = flag("--base");
    const author = flag("--author");
    const found = await checkShowcaseRepository(repo, {
      ...(base === undefined ? {} : { base }),
      ...(author === undefined ? {} : { author }),
      trusted: rest.includes("--trusted"),
    });
    if (found.size === 0) {
      console.log(`Every theme passes (${themeSlugs(repo).length}).`);
      return 0;
    }
    for (const [place, problems] of found) {
      console.error(`${place}:`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
    return 1;
  }
  const { index, notices, skipped } = await buildShowcaseIndex(repo);
  writeFileSync(join(repo, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  for (const [slug, notice] of notices)
    writeFileSync(join(repo, "themes", slug, NOTICE_FILE), notice);
  console.log(`Listed ${index.themes.length} themes.`);
  if (skipped.length > 0) console.error(`Left out, failing the checks: ${skipped.join(", ")}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
