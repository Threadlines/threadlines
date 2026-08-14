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
  readonly githubGeneratedNotes?: string;
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

interface ConventionalSubject {
  readonly title: string;
}

const conventionalTypes = new Set([
  "feat",
  "feature",
  "fix",
  "perf",
  "performance",
  "docs",
  "doc",
  "test",
  "tests",
  "refactor",
  "chore",
  "build",
  "ci",
  "style",
  "revert",
]);

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
  if (!breaking && !conventionalTypes.has(type)) return undefined;

  return {
    title: sentenceCaseTitle(cleanPullRequestTitle(title)),
  };
}

function displayTitle(entry: ReleaseNoteEntry): string {
  const conventional = parseConventionalSubject(entry.title);
  return conventional?.title ?? sentenceCaseTitle(cleanPullRequestTitle(entry.title));
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

function formatPullRequestEntry(repository: string | undefined, entry: ReleaseNoteEntry): string {
  const pullRequestNumber = entry.pullRequestNumber;
  const pullRequest = pullRequestNumber ? pullRequestUrl(repository, pullRequestNumber) : undefined;
  const pullRequestLabel =
    pullRequest && pullRequestNumber
      ? `[#${pullRequestNumber}](${pullRequest})`
      : `#${pullRequestNumber}`;

  return `- ${displayTitle(entry)} in ${pullRequestLabel}`;
}

function formatCommitEntry(repository: string | undefined, entry: ReleaseNoteEntry): string {
  return `- ${commitLink(repository, entry.commit)} ${displayTitle(entry)}`;
}

function isReleasePreparationTitle(title: string): boolean {
  const conventionalTitle = parseConventionalSubject(title)?.title ?? title;
  return /^(?:prepare|prep|draft|update)\s+v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?\s+(?:(?:stable\s+)?release\s+(?:content|notes?)|changelog(?:\s+and\s+(?:announcement|social(?:\s+post)?))?)/i.test(
    conventionalTitle.trim(),
  );
}

interface ParsedGitHubGeneratedNotes {
  readonly pullRequestLines: ReadonlyArray<string>;
  readonly newContributorLines: ReadonlyArray<string>;
  readonly fullChangelogLine: string | undefined;
}

function githubProfileLink(login: string): string {
  return `[@${login}](https://github.com/${login})`;
}

/** GitHub gives bare @mentions a viewer-specific highlight. Keep attribution
 * clickable without that highlight by rendering the generated author patterns
 * as ordinary profile links. Limit this to GitHub's own templates so an @ in a
 * pull request title or email-like text is not rewritten. */
function linkGitHubGeneratedAttribution(line: string): string {
  return line
    .replace(
      /\bby @([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)(?=\s+in\s+)/gi,
      (_match, login: string) => `by ${githubProfileLink(login)}`,
    )
    .replace(
      /^([-*]\s+)@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)(?=\s+made their first contribution\b)/i,
      (_match, bullet: string, login: string) => `${bullet}${githubProfileLink(login)}`,
    );
}

function parseGitHubGeneratedNotes(body: string): ParsedGitHubGeneratedNotes {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const newContributorsStart = lines.findIndex((line) => /^##\s+New Contributors\s*$/i.test(line));
  const fullChangelogIndex = lines.findIndex((line) => /^\*\*Full Changelog\*\*:/i.test(line));
  const pullRequestSectionEnd =
    [newContributorsStart, fullChangelogIndex]
      .filter((index) => index >= 0)
      .toSorted((left, right) => left - right)[0] ?? lines.length;
  const filteredPullRequestNumbers = new Set<string>();
  const pullRequestLines = lines
    .slice(0, pullRequestSectionEnd)
    .filter((line) => /^[-*]\s+.+\/pull\/\d+(?:\)|\s|$)/i.test(line.trim()))
    .filter((line) => {
      const title = line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/\s+by\s+@\S+\s+in\s+.+\/pull\/\d+\)?\s*$/i, "");
      if (!isReleasePreparationTitle(title)) return true;

      const pullRequestNumber = /\/pull\/(\d+)/i.exec(line)?.[1];
      if (pullRequestNumber) filteredPullRequestNumbers.add(pullRequestNumber);
      return false;
    })
    .map((line) => linkGitHubGeneratedAttribution(line.trim().replace(/^\*\s+/, "- ")));

  const newContributorSection =
    newContributorsStart === -1
      ? []
      : lines
          .slice(
            newContributorsStart,
            fullChangelogIndex > newContributorsStart ? fullChangelogIndex : undefined,
          )
          .filter((line) => {
            const pullRequestNumber = /\/pull\/(\d+)/i.exec(line)?.[1];
            return !pullRequestNumber || !filteredPullRequestNumbers.has(pullRequestNumber);
          })
          .map((line) => linkGitHubGeneratedAttribution(line.trimEnd()))
          .filter((line, index, section) => {
            if (line.length > 0) return true;
            return index > 0 && index < section.length - 1;
          });
  const newContributorLines = newContributorSection.some((line) => /^[-*]\s+/.test(line.trim()))
    ? newContributorSection
    : [];

  return {
    pullRequestLines,
    newContributorLines,
    fullChangelogLine: fullChangelogIndex === -1 ? undefined : lines[fullChangelogIndex]?.trim(),
  };
}

function formatTechnicalReleaseNotes(input: FormatReleaseNotesInput): string {
  const lines: Array<string> = ["## What's Changed", ""];
  const entries = input.commits.map(releaseNoteEntryFromCommit);
  const generated = input.githubGeneratedNotes
    ? parseGitHubGeneratedNotes(input.githubGeneratedNotes)
    : undefined;
  const localPullRequestLines = entries
    .filter(
      (entry) => entry.pullRequestNumber !== undefined && !isReleasePreparationTitle(entry.title),
    )
    .map((entry) => formatPullRequestEntry(input.repository, entry));
  const pullRequestLines =
    generated && generated.pullRequestLines.length > 0
      ? generated.pullRequestLines
      : localPullRequestLines;
  const directCommitLines = entries
    .filter(
      (entry) => entry.pullRequestNumber === undefined && !isReleasePreparationTitle(entry.title),
    )
    .map((entry) => formatCommitEntry(input.repository, entry));

  lines.push(...pullRequestLines);
  if (directCommitLines.length > 0) {
    if (pullRequestLines.length > 0) lines.push("");
    lines.push("### Direct changes", "", ...directCommitLines);
  }

  if (pullRequestLines.length === 0 && directCommitLines.length === 0) {
    lines.push("- No commits found in this release range.");
  }

  if (generated && generated.newContributorLines.length > 0) {
    lines.push("", ...generated.newContributorLines);
  }

  const url = compareUrl(input.repository, input.previousTag, input.currentTag);
  const fullChangelogLine =
    generated?.fullChangelogLine ?? (url ? `**Full Changelog**: ${url}` : undefined);
  if (fullChangelogLine) {
    lines.push("", fullChangelogLine);
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
  if (record.reviewRequired === true) {
    throw new Error(
      "Curated release content still requires human review. Remove 'reviewRequired: true' before publishing.",
    );
  }
  if (containsHumanReviewPlaceholder(record)) {
    throw new Error(
      "Curated release content still contains a reserved 'TODO:' human-review placeholder.",
    );
  }
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

function containsHumanReviewPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /^TODO:/i.test(value.trim());
  if (Array.isArray(value)) return value.some(containsHumanReviewPlaceholder);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(containsHumanReviewPlaceholder);
}

function formatCuratedReleaseContent(content: CuratedReleaseContent): string {
  const lines = ["## Highlights", "", content.summary, ""];
  for (const highlight of content.highlights) {
    lines.push(`- **${highlight.title}** — ${highlight.description}`);
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
      "github-notes-file": { type: "string" },
      "print-baseline-tag": { type: "boolean", default: false },
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
  if (values["print-baseline-tag"]) {
    process.stdout.write(previousTag ?? "");
    return;
  }
  const githubNotesFile =
    typeof values["github-notes-file"] === "string"
      ? values["github-notes-file"].trim() || undefined
      : undefined;
  const body = formatReleaseNotes({
    channel,
    currentTag,
    previousTag,
    repository,
    commits: listCommits(previousTag, currentRef),
    ...(githubNotesFile ? { githubGeneratedNotes: readFileSync(githubNotesFile, "utf8") } : {}),
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
