#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Array from "effect/Array";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as String from "effect/String";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

interface NightlyReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));
const TargetVersionSchema = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));

interface StableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export const resolveNightlyBaseVersion = (version: string) => version.replace(/[-+].*$/, "");

export const resolveNightlyTargetVersion = (version: string) => {
  const stableCore = resolveNightlyBaseVersion(version);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableCore);
  if (!match) {
    throw new Error(`Invalid desktop package version '${version}'.`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
};

function parseStableTag(tag: string): StableVersion | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch] = match;
  if (!major || !minor || !patch) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function parseNightlyTagBaseVersion(tag: string): StableVersion | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.\d{8}\.\d+$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch] = match;
  if (!major || !minor || !patch) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function compareStableVersions(left: StableVersion, right: StableVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function formatStableVersion(version: StableVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpPatchVersion(version: StableVersion): StableVersion {
  return {
    ...version,
    patch: version.patch + 1,
  };
}

export function resolveLatestStableTag(tags: ReadonlyArray<string>): string | undefined {
  return tags
    .map((tag) => ({ tag, parsed: parseStableTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: StableVersion } => entry.parsed !== undefined)
    .toSorted((left, right) => compareStableVersions(right.parsed, left.parsed))[0]?.tag;
}

export function resolveNightlyTargetVersionFromTags(tags: ReadonlyArray<string>): string {
  const latestStableVersion = tags
    .map(parseStableTag)
    .filter((version): version is StableVersion => version !== undefined)
    .toSorted((left, right) => compareStableVersions(right, left))[0];
  const stableCandidate = latestStableVersion ? bumpPatchVersion(latestStableVersion) : undefined;
  const nightlyCandidate = tags
    .map(parseNightlyTagBaseVersion)
    .filter((version): version is StableVersion => version !== undefined)
    .toSorted((left, right) => compareStableVersions(right, left))[0];
  const target = [stableCandidate, nightlyCandidate]
    .filter((version): version is StableVersion => version !== undefined)
    .toSorted((left, right) => compareStableVersions(right, left))[0];

  return target ? formatStableVersion(target) : "0.0.1";
}

export const resolveNightlyReleaseMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
) => {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-nightly.${date}.${runNumber}`;
  return {
    baseVersion,
    version,
    tag: `v${version}`,
    name: `Threadlines Nightly ${version} (${shortSha})`,
    shortSha,
  };
};

const listGitTags = Effect.fn("listGitTags")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", ["tag", "--list"]));
  const tags = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
    Effect.map(String.split(/\r?\n/)),
    Effect.map(Array.map(String.trim)),
    Effect.map(Array.filter(String.isNonEmpty)),
  );
  return tags;
});

const writeOutput = Effect.fn("writeOutput")(function* (
  metadata: NightlyReleaseMetadata,
  writeGithubOutput: boolean,
) {
  const fs = yield* FileSystem.FileSystem;

  const entries = [
    ["base_version", metadata.baseVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
  ] as const;

  if (writeGithubOutput) {
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT");
    const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
    yield* fs.writeFileString(githubOutputPath, serialized, { flag: "a" });
  } else {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
  }
});

const command = Command.make(
  "resolve-nightly-release",
  {
    date: Flag.string("date").pipe(
      Flag.withSchema(DateSchema),
      Flag.withDescription("Nightly build date in YYYYMMDD."),
    ),
    runNumber: Flag.string("run-number").pipe(
      Flag.withSchema(RunNumberSchema),
      Flag.withDescription("GitHub Actions run number."),
    ),
    sha: Flag.string("sha").pipe(
      Flag.withSchema(ShaSchema),
      Flag.withDescription("Commit sha for the nightly build."),
    ),
    targetVersion: Flag.string("target-version").pipe(
      Flag.withSchema(TargetVersionSchema),
      Flag.withDescription(
        "Optional stable target version for the nightly, for example 0.0.18. Defaults to the next patch after the latest stable tag.",
      ),
      Flag.optional,
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ date, runNumber, sha, targetVersion, githubOutput }) =>
    Option.match(targetVersion, {
      onNone: () => listGitTags().pipe(Effect.map(resolveNightlyTargetVersionFromTags)),
      onSome: Effect.succeed,
    }).pipe(
      Effect.map((baseVersion) => resolveNightlyReleaseMetadata(baseVersion, date, runNumber, sha)),
      Effect.flatMap((metadata) => writeOutput(metadata, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve nightly release version metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
