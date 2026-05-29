#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { resolveReleaseNotesBaselineTag, type ReleaseChannel } from "./lib/release-tags.ts";

export interface ReleaseNoteCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
}

interface FormatReleaseNotesInput {
  readonly channel: ReleaseChannel;
  readonly currentTag: string;
  readonly previousTag: string | undefined;
  readonly repository: string | undefined;
  readonly commits: ReadonlyArray<ReleaseNoteCommit>;
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required --${name} value.`);
  }

  return value.trim();
}

function normalizeChannel(value: unknown): ReleaseChannel {
  const channel = normalizeRequiredString(value, "channel");
  if (channel !== "stable" && channel !== "nightly") {
    throw new Error(`Invalid --channel value '${channel}'. Expected stable or nightly.`);
  }

  return channel;
}

function git(args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], { encoding: "utf8" }).trimEnd();
}

function listGitTags(): ReadonlyArray<string> {
  const output = git(["tag", "--list"]);
  return output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseGitLogOutput(output: string): ReadonlyArray<ReleaseNoteCommit> {
  if (output.trim().length === 0) return [];

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [hash, shortHash, subject] = entry.split("\x00");
      if (!hash || !shortHash || !subject) {
        throw new Error(`Unexpected git log entry: ${JSON.stringify(entry)}`);
      }

      return {
        hash,
        shortHash,
        subject,
      };
    });
}

function listCommits(
  previousTag: string | undefined,
  currentRef: string,
): ReadonlyArray<ReleaseNoteCommit> {
  const range = previousTag ? `${previousTag}..${currentRef}` : currentRef;
  return parseGitLogOutput(git(["log", "--format=%H%x00%h%x00%s%x1e", range, "--"]));
}

function commitUrl(repository: string | undefined, commit: ReleaseNoteCommit): string | undefined {
  if (!repository) return undefined;
  return `https://github.com/${repository}/commit/${commit.hash}`;
}

function compareUrl(
  repository: string | undefined,
  previousTag: string | undefined,
  currentTag: string,
): string | undefined {
  if (!repository || !previousTag) return undefined;
  return `https://github.com/${repository}/compare/${previousTag}...${currentTag}`;
}

export function formatReleaseNotes(input: FormatReleaseNotesInput): string {
  const lines: Array<string> = [];
  const releaseKind = input.channel === "nightly" ? "Nightly" : "Stable";

  lines.push(`## ${releaseKind} changes`, "");

  if (input.previousTag) {
    lines.push(`Changes since \`${input.previousTag}\`.`, "");
  } else {
    lines.push("Initial release notes for this channel.", "");
  }

  if (input.commits.length === 0) {
    lines.push("- No commits found in this release range.");
  } else {
    for (const commit of input.commits) {
      const url = commitUrl(input.repository, commit);
      const hash = url ? `[\`${commit.shortHash}\`](${url})` : `\`${commit.shortHash}\``;
      lines.push(`- ${hash} ${commit.subject}`);
    }
  }

  const url = compareUrl(input.repository, input.previousTag, input.currentTag);
  if (url) {
    lines.push("", `**Full Changelog**: ${url}`);
  }

  return `${lines.join("\n")}\n`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      channel: { type: "string" },
      "current-tag": { type: "string" },
      "current-ref": { type: "string", default: "HEAD" },
      repository: { type: "string" },
      output: { type: "string" },
    },
  });

  const channel = normalizeChannel(values.channel);
  const currentTag = normalizeRequiredString(values["current-tag"], "current-tag");
  const currentRef = normalizeRequiredString(values["current-ref"], "current-ref");
  const repository =
    typeof values.repository === "string" ? values.repository.trim() || undefined : undefined;
  const output = typeof values.output === "string" ? values.output.trim() || undefined : undefined;
  const previousTag = resolveReleaseNotesBaselineTag(channel, currentTag, listGitTags());
  const body = formatReleaseNotes({
    channel,
    currentTag,
    previousTag,
    repository,
    commits: listCommits(previousTag, currentRef),
  });

  if (output) {
    writeFileSync(output, body);
  } else {
    process.stdout.write(body);
  }
}

if (import.meta.main) {
  main();
}
