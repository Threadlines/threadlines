// @effect-diagnostics preferSchemaOverJson:off
import { assert, afterEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCliShape["execute"]>();

const layer = Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute: mockExecute });

// The recorded path of an Azure remote; `az` takes the repository's own name and
// reads the organisation and project from the checkout it detects.
const repository = { cwd: "/workspaces/tools", repository: "acme/Platform/_git/tools" };

const calls = () => mockExecute.mock.calls.map(([input]) => input);

afterEach(() => {
  mockExecute.mockReset();
});

describe("AzureDevOpsPullRequestProvider.listChangeRequests", () => {
  it.effect("asks for the repository by its own name, dropping the recorded path", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("[]")));
      const provider = yield* AzureDevOpsPullRequestProvider.make();

      yield* provider.listChangeRequests({ ...repository, state: "merged", limit: 30 });

      assert.deepStrictEqual(calls()[0]?.args, [
        "repos",
        "pr",
        "list",
        "--detect",
        "true",
        "--repository",
        "tools",
        "--status",
        "completed",
        "--include-links",
        "--top",
        "30",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("AzureDevOpsPullRequestProvider.runAction", () => {
  const cases = [
    {
      name: "merges by completing the pull request, squashing when asked",
      input: { action: "merge", mergeMethod: "squash" },
      args: ["--status", "completed", "--squash", "true"],
    },
    {
      name: "arms auto-complete with the squash choice stored alongside",
      input: { action: "enable-auto-merge", mergeMethod: "merge" },
      args: ["--auto-complete", "true", "--squash", "false"],
    },
    {
      name: "disarms auto-complete",
      input: { action: "disable-auto-merge" },
      args: ["--auto-complete", "false"],
    },
    {
      name: "turns a pull request back into a draft",
      input: { action: "draft" },
      args: ["--draft", "true"],
    },
    {
      name: "reopens by reactivating",
      input: { action: "reopen" },
      args: ["--status", "active"],
    },
  ] as const;

  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
        const provider = yield* AzureDevOpsPullRequestProvider.make();

        yield* provider.runAction({ ...repository, number: 7, ...testCase.input });

        assert.deepStrictEqual(calls()[0]?.args, [
          "repos",
          "pr",
          "update",
          "--detect",
          "true",
          "--id",
          "7",
          ...testCase.args,
          "--only-show-errors",
          "--output",
          "json",
        ]);
      }).pipe(Effect.provide(layer)),
    );
  }
});

describe("AzureDevOpsPullRequestProvider.updateChangeRequest", () => {
  it.effect("keeps the new words in one argument, so a leading dash is not read as a flag", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* AzureDevOpsPullRequestProvider.make();

      yield* provider.updateChangeRequest({
        ...repository,
        number: 7,
        body: "- Tidies the toolbox",
      });

      assert.deepStrictEqual(calls()[0]?.args, [
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "7",
        "--description=- Tidies the toolbox",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("AzureDevOpsPullRequestProvider.setReviewerRequest", () => {
  it.effect("takes a request back with one --reviewers, which az reads as a list", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* AzureDevOpsPullRequestProvider.make();

      yield* provider.setReviewerRequest({
        ...repository,
        number: 7,
        reviewers: [
          { id: "hubot@acme.test", kind: "user" },
          { id: "monalisa@acme.test", kind: "user" },
        ],
        requested: false,
      });

      assert.deepStrictEqual(calls()[0]?.args, [
        "repos",
        "pr",
        "reviewer",
        "remove",
        "--detect",
        "true",
        "--id",
        "7",
        "--reviewers",
        "hubot@acme.test",
        "monalisa@acme.test",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a reviewer shaped like a flag without running az", () =>
    Effect.gen(function* () {
      const provider = yield* AzureDevOpsPullRequestProvider.make();

      const error = yield* provider
        .setReviewerRequest({
          ...repository,
          number: 7,
          reviewers: [{ id: "--query", kind: "user" }],
          requested: true,
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "Azure DevOps takes a reviewer's email address, display name or id.",
      );
      assert.deepStrictEqual(calls(), []);
    }).pipe(Effect.provide(layer)),
  );
});

describe("AzureDevOpsPullRequestProvider.getDiff", () => {
  it.effect("refuses without running az, there being no patch to produce", () =>
    Effect.gen(function* () {
      const provider = yield* AzureDevOpsPullRequestProvider.make();

      const error = yield* provider.getDiff({ ...repository, number: 7 }).pipe(Effect.flip);

      assert.equal(error.detail, "Azure DevOps cannot produce a patch for a pull request.");
      assert.deepStrictEqual(calls(), []);
    }).pipe(Effect.provide(layer)),
  );
});
