// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ReleaseNotesEntry } from "@threadlines/shared/releaseNotes";
import { fromYaml } from "@threadlines/shared/schemaYaml";
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Schema from "effect/Schema";
import type { PluginOption } from "vite-plus";

/** The reviewed stable release notes the marketing site's changelog is built from. */
export const CHANGELOG_DIRECTORY = fileURLToPath(
  new URL("../marketing/src/content/changelog/", import.meta.url),
);
const MODULE_ID = "virtual:release-notes";
const RESOLVED_MODULE_ID = `\0${MODULE_ID}`;

// The frontmatter as written; the fields the app doesn't show (evidence,
// social) fall away in the decode.
const decodeFrontmatter = Schema.decodeUnknownSync(
  fromYaml(
    Schema.Struct({
      ...ReleaseNotesEntry.fields,
      reviewRequired: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/**
 * Every reviewed stable release, newest first. A file still marked
 * `reviewRequired` is a draft and stays out; one that doesn't decode fails
 * the build, so the app never ships notes the site can't show.
 */
export function readReleaseNotesEntries(
  directory = CHANGELOG_DIRECTORY,
): ReadonlyArray<ReleaseNotesEntry> {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .flatMap((file) => {
      const content = readFileSync(join(directory, file), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      if (frontmatter === undefined) throw new Error(`${file} has no frontmatter.`);
      let decoded: ReturnType<typeof decodeFrontmatter>;
      try {
        decoded = decodeFrontmatter(frontmatter);
      } catch (error) {
        throw new Error(`${file} doesn't read as release notes: ${String(error)}`, {
          cause: error,
        });
      }
      const { reviewRequired, ...entry } = decoded;
      return reviewRequired ? [] : [entry];
    })
    .toSorted((left, right) => compareSemverVersions(right.version, left.version));
}

/**
 * `virtual:release-notes`: the stable release notes, for "What's new". Only
 * ever imported dynamically, so they load when the dialog or the post-update
 * notice needs them and never at startup.
 */
export function releaseNotesPlugin(): PluginOption {
  return {
    name: "threadlines:release-notes",
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_MODULE_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_MODULE_ID) return undefined;
      for (const file of readdirSync(CHANGELOG_DIRECTORY)) {
        this.addWatchFile(join(CHANGELOG_DIRECTORY, file));
      }
      return `export default ${JSON.stringify(readReleaseNotesEntries())};`;
    },
  };
}
