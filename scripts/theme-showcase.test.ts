import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { THEME_FILE_FORMAT, ThemeShowcaseIndex, type ThemeManifest } from "@threadlines/contracts";
import { themeContentHash } from "@threadlines/shared/themeManifest";
import { STARTER_THEMES } from "@threadlines/shared/themeStarters";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildShowcaseIndex, checkShowcaseRepository } from "./theme-showcase.ts";

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A starter's embedded JetBrains Mono: a real font, with its notice inside. */
const jetBrainsMono = STARTER_THEMES.flatMap((starter) => starter.manifest.fonts?.mono ?? []).find(
  (font) => font.family === "JetBrains Mono" && font.data !== undefined,
)!;

const harbor: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Harbor",
  base: "dark",
  colors: {
    background: "#0b1420",
    foreground: "#e6eef8",
    mutedForeground: "#9fb0c4",
    accent: "#4cc2ff",
    accentForeground: "#04121f",
  },
  fonts: { mono: jetBrainsMono },
  credits: { author: "Sam", license: "CC-BY-4.0" },
};

const decodeIndex = Schema.decodeUnknownSync(ThemeShowcaseIndex);

let repo = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const writeTheme = (slug: string, manifest: unknown, meta: unknown = { sharedBy: "sam" }) => {
  mkdirSync(join(repo, "themes", slug), { recursive: true });
  writeFileSync(join(repo, "themes", slug, "theme.threadlines-theme"), JSON.stringify(manifest));
  writeFileSync(join(repo, "themes", slug, "thumbnail.png"), png(320, 200));
  writeFileSync(join(repo, "themes", slug, "meta.json"), JSON.stringify(meta));
};
const commit = () => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
  return git("rev-parse", "HEAD");
};

afterEach(() => {
  if (repo !== "") rmSync(repo, { recursive: true, force: true });
});

const fresh = () => {
  repo = mkdtempSync(join(tmpdir(), "theme-showcase-"));
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "Themes\n");
};

describe("theme-showcase", () => {
  it("lists passing themes with the digests and notices the app checks them by", async () => {
    fresh();
    writeTheme("harbor", harbor);
    writeTheme("broken", { ...harbor, credits: { author: "Sam", license: "MIT" } });
    commit();

    const found = await checkShowcaseRepository(repo);
    expect([...found.keys()]).toEqual(["themes/broken"]);

    const { index, notices, skipped } = await buildShowcaseIndex(repo);
    expect(skipped).toEqual(["broken"]);
    // The app decodes the list with this schema; an entry it drops is a bug here.
    const decoded = decodeIndex(JSON.parse(JSON.stringify(index)));
    const [entry] = decoded.themes;
    expect(entry).toMatchObject({ id: "harbor", sharedBy: "sam", featured: false, hasArt: false });
    expect(entry?.hash).toBe(await themeContentHash(harbor));
    const file = readFileSync(join(repo, entry!.file.path));
    expect(entry?.file.bytes).toBe(file.length);
    expect(entry?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(notices.get("harbor")).toContain("JetBrains Mono: Copyright");
    expect(notices.get("harbor")).toContain("SIL Open Font License 1.1");
  });

  it("lets an outside author add or change only their own theme folders", async () => {
    fresh();
    writeTheme("harbor", harbor);
    const base = commit();

    // Sam adds a theme: fine. Someone else claiming it, or editing Sam's, is not.
    writeTheme("tide", {
      ...harbor,
      name: "Tide",
      colors: { ...harbor.colors, accent: "#55ccff" },
    });
    commit();
    expect((await checkShowcaseRepository(repo, { base, author: "sam" })).size).toBe(0);
    expect(
      [...(await checkShowcaseRepository(repo, { base, author: "mallory" })).values()].flat(),
    ).toEqual(["meta.json says @sam shared it, but @mallory opened this."]);

    writeTheme("harbor", { ...harbor, name: "Harbor 2" }, { sharedBy: "mallory" });
    writeFileSync(join(repo, "index.json"), "{}");
    commit();
    const problems = await checkShowcaseRepository(repo, { base, author: "mallory" });
    expect(problems.get("index.json")).toEqual([
      "A pull request may only add or change files in a theme's folder.",
    ]);
    expect(problems.get("themes/harbor")).toEqual([
      "Only the person who shared a theme may change it.",
    ]);
    // A maintainer may change anything.
    expect(
      (await checkShowcaseRepository(repo, { base, author: "will", trusted: true })).size,
    ).toBe(0);
  });
});
