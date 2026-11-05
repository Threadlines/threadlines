import { assert, it } from "@effect/vitest";
import type { ReportProblemInput } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as ProblemReports from "./ProblemReports.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const ghFailure = (detail: string) =>
  new GitHubCli.GitHubCliError({ operation: "execute", detail });

const REPORT: ReportProblemInput = {
  submissionId: "4f0c1d2e-9a8b-4c7d-8e6f-5a4b3c2d1e0f",
  login: "octocat",
  title: "Changing the access level opens another chat",
  whatHappened: "The chat jumped.",
  steps: "1. Change the access level",
  expected: "",
  errorText: "",
  version: "0.9.0",
  setup: "macOS, desktop app",
};

/**
 * A stand-in for `gh api` against github.com: who is signed in, the issues
 * GitHub holds, and how a POST goes (`onPost` may record the issue and still
 * fail, as when GitHub takes it but the answer never arrives). Looking for a
 * report answers as `gh` would after its `--jq` filter: the issues whose body
 * holds the marker. `failedLookups` lists which looks (counted from 1) fail.
 */
function fakeGitHub(options: {
  readonly login: string;
  readonly onPost: (
    issue: { readonly title: string; readonly body: string },
    issues: Array<{ number: number; url: string; body: string }>,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCli.GitHubCliError>;
  readonly failedLookups?: ReadonlyArray<number>;
}) {
  const issues: Array<{ number: number; url: string; body: string }> = [];
  const calls: Array<ReadonlyArray<string>> = [];
  let lookups = 0;
  const execute: GitHubCli.GitHubCliShape["execute"] = (input) => {
    calls.push(input.args);
    assert.deepStrictEqual(input.args.slice(0, 3), ["api", "--hostname", "github.com"]);
    const endpoint = input.args.includes("POST") ? "POST" : input.args[3];
    if (endpoint === "user") return Effect.succeed(output(`${options.login}\n`));
    if (endpoint === "POST") {
      return options.onPost(JSON.parse(input.stdin ?? "{}"), issues);
    }
    if (endpoint?.startsWith("repos/Threadlines/threadlines/issues?creator=octocat")) {
      lookups += 1;
      if (options.failedLookups?.includes(lookups)) {
        return Effect.fail(ghFailure("error connecting to api.github.com"));
      }
      const marker = JSON.parse(/contains\((".*?")\)/.exec(input.args[5] ?? "")![1]!) as string;
      const found = issues
        .filter((issue) => issue.body.includes(marker))
        .map(({ number, url }) => ({ number, url }));
      return Effect.succeed(output(JSON.stringify(found)));
    }
    return Effect.die(new Error(`unexpected gh call: ${input.args.join(" ")}`));
  };
  const posts = () => calls.filter((args) => args.includes("POST")).length;
  return {
    issues,
    posts,
    reports: ProblemReports.make().pipe(
      Effect.provide(Layer.mock(GitHubCli.GitHubCli)({ execute })),
    ),
  };
}

const recordIssue = (
  issue: { readonly body: string },
  issues: Array<{ number: number; url: string; body: string }>,
) => {
  const number = 812 + issues.length;
  const posted = {
    number,
    url: `https://github.com/Threadlines/threadlines/issues/${number}`,
    body: issue.body,
  };
  issues.push(posted);
  return posted;
};

it.effect("posts the report to Threadlines' issues from the signed-in account", () =>
  Effect.gen(function* () {
    let sent: { readonly title: string; readonly body: string } | null = null;
    const github = fakeGitHub({
      login: "octocat",
      onPost: (issue, issues) => {
        sent = issue;
        const posted = recordIssue(issue, issues);
        return Effect.succeed(output(JSON.stringify({ number: posted.number, url: posted.url })));
      },
    });
    const reports = yield* github.reports;

    assert.deepStrictEqual(yield* reports.account, { status: "signedIn", login: "octocat" });
    const issue = yield* reports.submit(REPORT);
    assert.deepStrictEqual(issue, {
      number: 812,
      url: "https://github.com/Threadlines/threadlines/issues/812",
    });
    assert.strictEqual(sent!.title, "[Bug]: Changing the access level opens another chat");
    assert.include(sent!.body, "### What happened?\n\nThe chat jumped.");
    assert.include(sent!.body, `<!-- threadlines:report-a-problem ${REPORT.submissionId} -->`);

    // Sending the same report again answers with the issue already posted.
    assert.deepStrictEqual(yield* reports.submit(REPORT), issue);
    assert.strictEqual(github.posts(), 1);
  }),
);

it.effect("finds a report GitHub took without answering instead of posting it twice", () =>
  Effect.gen(function* () {
    const github = fakeGitHub({
      login: "octocat",
      // GitHub keeps the issue, but the answer never comes back.
      onPost: (issue, issues) => {
        recordIssue(issue, issues);
        return Effect.fail(ghFailure("VcsProcessTimeoutError\ngh api timed out after 30000ms"));
      },
      // And the look after it fails too, so the person hears it may have posted.
      failedLookups: [2],
    });

    const first = yield* Effect.flip((yield* github.reports).submit(REPORT));
    assert.isTrue(first.uncertain);

    // Sent again after a server restart, which forgot the first try.
    const second = yield* (yield* github.reports).submit(REPORT);
    assert.strictEqual(second.number, 812);
    assert.strictEqual(github.posts(), 1);
    assert.strictEqual(github.issues.length, 1);
  }),
);

it.effect("refuses to post as an account other than the one the person saw", () =>
  Effect.gen(function* () {
    const github = fakeGitHub({
      login: "someone-else",
      onPost: () => Effect.die(new Error("must not post")),
    });
    const reports = yield* github.reports;

    const error = yield* Effect.flip(reports.submit(REPORT));
    assert.isFalse(error.uncertain);
    assert.include(error.reason, "@someone-else");
    assert.strictEqual(github.posts(), 0);
  }),
);
