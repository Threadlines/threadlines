#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as String from "effect/String";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolvePreviousReleaseTag } from "./lib/release-tags.ts";

const ReleaseChannelSchema = Schema.Literals(["stable", "nightly"]);

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
  previousTag: string | undefined,
  writeGithubOutput: boolean,
) {
  const entry = `previous_tag=${previousTag ?? ""}\n`;

  if (writeGithubOutput) {
    const fs = yield* FileSystem.FileSystem;
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT");
    yield* fs.writeFileString(githubOutputPath, entry, { flag: "a" });
    return;
  }

  process.stdout.write(entry);
});

const command = Command.make(
  "resolve-previous-release-tag",
  {
    channel: Flag.choice("channel", ReleaseChannelSchema.literals).pipe(
      Flag.withDescription("Release channel whose previous tag should be resolved."),
    ),
    currentTag: Flag.string("current-tag").pipe(
      Flag.withDescription("Current release tag to compare against."),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ channel, currentTag, githubOutput }) =>
    listGitTags().pipe(
      Effect.map((tags) => resolvePreviousReleaseTag(channel, currentTag, tags)),
      Effect.flatMap((previousTag) => writeOutput(previousTag, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve the previous release tag for a stable or nightly series."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
