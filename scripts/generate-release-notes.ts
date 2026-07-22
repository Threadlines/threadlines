#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parse as parseYaml } from "yaml";

import { resolveReleaseNotesBaselineTag, type ReleaseChannel } from "./lib/release-tags.ts";

export interface ReleaseNoteCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly parentHashes: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
}

interface FormatReleaseNotesInput {
  readonly channel: ReleaseChannel;
  readonly currentTag: string;
  readonly previousTag: string | undefined;
  readonly repository: string | undefined;
  readonly commits: ReadonlyArray<ReleaseNoteCommit>;
  readonly curated?: CuratedReleaseContent;
}

export interface CuratedReleaseContent {
  readonly summary: string;
  readonly highlights: ReadonlyArray<{
    readonly title: string;
    readonly description: string;
  }>;
  readonly alsoImproved: ReadonlyArray<{
    readonly description: string;
  }>;
}

interface ReleaseNoteEntry {
  readonly title: string;
  readonly commit: ReleaseNoteCommit;
  readonly pullRequestNumber?: number;
}

type ReleaseNoteCategoryId =
  | "breaking"
  | "features"
  | "fixes"
  | "performance"
  | "reliability"
  | "documentation"
  | "tests"
  | "maintenance"
  | "other";

interface ReleaseNoteCategory {
  readonly id: ReleaseNoteCategoryId;
  readonly title: string;
}

interface ConventionalSubject {
  readonly type: string;
  readonly breaking: boolean;
  readonly title: string;
}

interface ClassifiedReleaseNoteEntry extends ReleaseNoteEntry {
  readonly categoryId: ReleaseNoteCategoryId;
  readonly displayTitle: string;
}

const releaseNoteCategories: ReadonlyArray<ReleaseNoteCategory> = [
  { id: "breaking", title: "Breaking changes" },
  { id: "features", title: "Features" },
  { id: "fixes", title: "Fixes" },
  { id: "performance", title: "Performance" },
  { id: "reliability", title: "Reliability" },
  { id: "documentation", title: "Documentation" },
  { id: "tests", title: "Tests" },
  { id: "maintenance", title: "Maintenance" },
  { id: "other", title: "Other changes" },
];

const conventionalTypeCategories = new Map<string, ReleaseNoteCategoryId>([
  ["feat", "features"],
  ["feature", "features"],
  ["fix", "fixes"],
  ["perf", "performance"],
  ["performance", "performance"],
  ["docs", "documentation"],
  ["doc", "documentation"],
  ["test", "tests"],
  ["tests", "tests"],
  ["refactor", "maintenance"],
  ["chore", "maintenance"],
  ["build", "maintenance"],
  ["ci", "maintenance"],
  ["style", "maintenance"],
  ["revert", "maintenance"],
]);

const keywordCategories: ReadonlyArray<readonly [ReleaseNoteCategoryId, RegExp]> = [
  [
    "fixes",
    /\b(fix|fixed|fixes|repair|repairs|repaired|restore|restores|restored|prevent|prevents|prevented|avoid|avoids|avoided|handle|handles|handled|resolve|resolves|resolved|correct|corrects|corrected|patch|patches|patched)\b/i,
  ],
  [
    "performance",
    /\b(perf|performance|fast|faster|speed|cache|cached|caching|polling|cpu|batch|batched|latency|memory|optimize|optimized|optimizes|optimizing|optimization|optimise|optimised|optimises|optimising|optimisation|reduce|reduces|reduced|reducing)\b/i,
  ],
  [
    "reliability",
    /\b(reliability|reliable|retry|retries|retried|recover|recovers|recovered|recovery|reconnect|reconnects|reconnected|restart|restarts|restarted|fallback|failure|failures|error|errors|timeout|timeouts|diagnostic|diagnostics|guard|guards|guarded|resilient|resilience|crash|crashes|crashed|stream|streams|streaming)\b/i,
  ],
  ["documentation", /\b(doc|docs|documentation|readme|guide|guides)\b/i],
  ["tests", /\b(test|tests|tested|vitest|coverage|spec|specs)\b/i],
  [
    "features",
    /\b(add|adds|added|enable|enables|enabled|introduce|introduces|introduced|integrate|integrates|integrated|support|supports|supported|implement|implements|implemented|create|creates|created|new)\b/i,
  ],
  [
    "maintenance",
    /\b(chore|chores|ci|build|builds|release|releases|publish|publishes|published|dependency|dependencies|lockfile|refactor|refactors|refactored|rename|renames|renamed|migrate|migrates|migrated|move|moves|moved|cleanup|format|formatted|lint|typecheck|configure|configures|configured|configuration|config|workflow|workflows)\b/i,
  ],
];

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

export function parseGitLogOutput(output: string): ReadonlyArray<ReleaseNoteCommit> {
  if (output.trim().length === 0) return [];

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [hash, shortHash, parentHashes, subject, body = ""] = entry.split("\x00");
      if (!hash || !shortHash || !subject) {
        throw new Error(`Unexpected git log entry: ${JSON.stringify(entry)}`);
      }

      return {
        hash,
        shortHash,
        parentHashes: parentHashes ? parentHashes.split(" ").filter(Boolean) : [],
        subject,
        body: body.trim(),
      };
    });
}

function listCommits(
  previousTag: string | undefined,
  currentRef: string,
): ReadonlyArray<ReleaseNoteCommit> {
  const range = previousTag ? `${previousTag}..${currentRef}` : currentRef;
  return parseGitLogOutput(
    git(["log", "--first-parent", "--format=%H%x00%h%x00%P%x00%s%x00%b%x1e", range, "--"]),
  );
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

function pullRequestUrl(
  repository: string | undefined,
  pullRequestNumber: number,
): string | undefined {
  if (!repository) return undefined;
  return `https://github.com/${repository}/pull/${pullRequestNumber}`;
}

function firstMeaningfulBodyLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
}

function cleanPullRequestTitle(title: string): string {
  return title
    .replace(/\s+\(#\d+\)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCaseTitle(title: string): string {
  const trimmed = title.trim();
  if (!/^[a-z][a-z]/.test(trimmed)) return trimmed;
  return `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`;
}

function parseConventionalSubject(subject: string): ConventionalSubject | undefined {
  const match = /^([a-z][a-z0-9-]*)(?:\([^)]+\))?(!)?:\s+(.+)$/i.exec(subject);
  const type = match?.[1]?.toLowerCase();
  const title = match?.[3];
  if (!type || !title) return undefined;

  const breaking = match[2] === "!";
  if (!breaking && !conventionalTypeCategories.has(type)) return undefined;

  return {
    type,
    breaking,
    title: sentenceCaseTitle(cleanPullRequestTitle(title)),
  };
}

function hasBreakingChangeBody(body: string): boolean {
  return /^BREAKING[ -]CHANGE:/im.test(body);
}

function classifyReleaseNoteEntry(entry: ReleaseNoteEntry): ClassifiedReleaseNoteEntry {
  const conventional = parseConventionalSubject(entry.title);
  const displayTitle = conventional?.title ?? sentenceCaseTitle(cleanPullRequestTitle(entry.title));

  if (conventional?.breaking === true || hasBreakingChangeBody(entry.commit.body)) {
    return { ...entry, categoryId: "breaking", displayTitle };
  }

  const conventionalCategory =
    conventional === undefined ? undefined : conventionalTypeCategories.get(conventional.type);
  if (conventionalCategory) {
    return { ...entry, categoryId: conventionalCategory, displayTitle };
  }

  for (const [categoryId, pattern] of keywordCategories) {
    if (pattern.test(displayTitle)) {
      return { ...entry, categoryId, displayTitle };
    }
  }

  return { ...entry, categoryId: "other", displayTitle };
}

function releaseNoteEntryFromCommit(commit: ReleaseNoteCommit): ReleaseNoteEntry {
  const mergeMatch = /^Merge pull request #(\d+) from .+$/i.exec(commit.subject);
  if (mergeMatch?.[1]) {
    return {
      title: cleanPullRequestTitle(
        firstMeaningfulBodyLine(commit.body) ?? `Pull request #${mergeMatch[1]}`,
      ),
      commit,
      pullRequestNumber: Number(mergeMatch[1]),
    };
  }

  const squashMatch = /^(.+?)\s+\(#(\d+)\)$/.exec(commit.subject);
  if (squashMatch?.[1] && squashMatch[2]) {
    return {
      title: cleanPullRequestTitle(squashMatch[1]),
      commit,
      pullRequestNumber: Number(squashMatch[2]),
    };
  }

  return {
    title: commit.subject,
    commit,
  };
}

function commitLink(repository: string | undefined, commit: ReleaseNoteCommit): string {
  const url = commitUrl(repository, commit);
  return url ? `[\`${commit.shortHash}\`](${url})` : `\`${commit.shortHash}\``;
}

function formatPullRequestEntry(
  repository: string | undefined,
  entry: ClassifiedReleaseNoteEntry,
): string {
  const pullRequestNumber = entry.pullRequestNumber;
  const pullRequest = pullRequestNumber ? pullRequestUrl(repository, pullRequestNumber) : undefined;
  const pullRequestLabel =
    pullRequest && pullRequestNumber
      ? `[#${pullRequestNumber}](${pullRequest})`
      : `#${pullRequestNumber}`;

  return `- ${pullRequestLabel} ${entry.displayTitle} (${commitLink(repository, entry.commit)})`;
}

function formatCommitEntry(
  repository: string | undefined,
  entry: ClassifiedReleaseNoteEntry,
): string {
  return `- ${commitLink(repository, entry.commit)} ${entry.displayTitle}`;
}

function formatReleaseNoteEntry(
  repository: string | undefined,
  entry: ClassifiedReleaseNoteEntry,
): string {
  return entry.pullRequestNumber === undefined
    ? formatCommitEntry(repository, entry)
    : formatPullRequestEntry(repository, entry);
}

function formatTechnicalReleaseNotes(input: FormatReleaseNotesInput): string {
  const lines: Array<string> = [];
  const entries = input.commits.map(releaseNoteEntryFromCommit).map(classifyReleaseNoteEntry);

  lines.push("## What's changed", "");

  if (input.previousTag) {
    lines.push(`Changes since \`${input.previousTag}\`.`, "");
  } else {
    lines.push("Initial release notes for this channel.", "");
  }

  if (input.commits.length === 0) {
    lines.push("- No commits found in this release range.");
  } else {
    let wroteCategory = false;
    for (const category of releaseNoteCategories) {
      const categoryEntries = entries.filter((entry) => entry.categoryId === category.id);
      if (categoryEntries.length === 0) continue;

      if (wroteCategory) {
        lines.push("");
      }
      wroteCategory = true;

      lines.push(`### ${category.title}`, "");
      for (const entry of categoryEntries) {
        lines.push(formatReleaseNoteEntry(input.repository, entry));
      }
    }
  }

  const url = compareUrl(input.repository, input.previousTag, input.currentTag);
  if (url) {
    lines.push("", `**Full Changelog**: ${url}`);
  }

  return `${lines.join("\n")}\n`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Curated release content is missing '${name}'.`);
  }
  return value.trim();
}

export function parseCuratedReleaseContent(content: string): CuratedReleaseContent {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) throw new Error("Curated release content is missing YAML frontmatter.");

  const parsed = parseYaml(frontmatter) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Curated release frontmatter must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.highlights) || record.highlights.length === 0) {
    throw new Error("Curated release content must include highlights.");
  }
  if (!Array.isArray(record.alsoImproved)) {
    throw new Error("Curated release content must include alsoImproved.");
  }

  return {
    summary: requiredString(record.summary, "summary"),
    highlights: record.highlights.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Curated highlight ${index + 1} must be an object.`);
      }
      const highlight = value as Record<string, unknown>;
      return {
        title: requiredString(highlight.title, `highlights[${index}].title`),
        description: requiredString(highlight.description, `highlights[${index}].description`),
      };
    }),
    alsoImproved: record.alsoImproved.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Curated improvement ${index + 1} must be an object.`);
      }
      return {
        description: requiredString(
          (value as Record<string, unknown>).description,
          `alsoImproved[${index}].description`,
        ),
      };
    }),
  };
}

function formatCuratedReleaseContent(content: CuratedReleaseContent): string {
  const lines = ["## Highlights", "", content.summary];
  for (const highlight of content.highlights) {
    lines.push("", `### ${highlight.title}`, "", highlight.description);
  }
  if (content.alsoImproved.length > 0) {
    lines.push("", "### Also improved", "");
    for (const improvement of content.alsoImproved) {
      lines.push(`- ${improvement.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatReleaseNotes(input: FormatReleaseNotesInput): string {
  const technical = formatTechnicalReleaseNotes(input);
  if (!input.curated) return technical;

  return [
    formatCuratedReleaseContent(input.curated).trimEnd(),
    "",
    "<details>",
    "<summary>Complete technical changes</summary>",
    "",
    technical.trimEnd(),
    "",
    "</details>",
    "",
  ].join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      channel: { type: "string" },
      "current-tag": { type: "string" },
      "current-ref": { type: "string", default: "HEAD" },
      repository: { type: "string" },
      output: { type: "string" },
      "highlights-file": { type: "string" },
    },
  });

  const channel = normalizeChannel(values.channel);
  const currentTag = normalizeRequiredString(values["current-tag"], "current-tag");
  const currentRef = normalizeRequiredString(values["current-ref"], "current-ref");
  const repository =
    typeof values.repository === "string" ? values.repository.trim() || undefined : undefined;
  const output = typeof values.output === "string" ? values.output.trim() || undefined : undefined;
  const highlightsFile =
    typeof values["highlights-file"] === "string"
      ? values["highlights-file"].trim() || undefined
      : undefined;
  const previousTag = resolveReleaseNotesBaselineTag(channel, currentTag, listGitTags());
  const body = formatReleaseNotes({
    channel,
    currentTag,
    previousTag,
    repository,
    commits: listCommits(previousTag, currentRef),
    ...(highlightsFile
      ? { curated: parseCuratedReleaseContent(readFileSync(highlightsFile, "utf8")) }
      : {}),
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
