#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * The demo computer's fake data (docs/design/assistants.md, "The demo
 * computer"): small sample git repos, a Threadlines project for each, and
 * threads in every state an assistant should see, all made through the
 * server's own API as a signed-in owner (threadlinesClient.ts). Nothing here
 * writes the server's database.
 *
 *   demo-fixtures.ts settings --agent <path> --out <settings.json>
 *       The server settings: every real provider off, the scripted agent on.
 *       Write it before the server starts.
 *   demo-fixtures.ts reset
 *       Deletes the demo projects (and so their threads) with the app's own
 *       `project.delete`, removes the sample repos and their worktrees, then
 *       builds everything again. On an empty computer it just builds.
 *   demo-fixtures.ts status
 *       Prints each demo project's threads and how they're doing.
 *
 * A reset never touches what makes the computer itself: its settings, its
 * secrets folder (signing keys, relay identity), its environment id, and the
 * database rows outside projects and threads (assistant connections, alert
 * targets, sign-ins, relay registration). docker/demo/README.md lists them.
 *
 * Environment:
 * - THREADLINES_URL: the server (default http://127.0.0.1:$THREADLINES_PORT, port 3773).
 * - THREADLINES_HOME: passed on to the CLI that issues the owner token.
 * - DEMO_OWNER_TOKEN: an owner bearer token to use; without it one is issued
 *   with `$DEMO_THREADLINES_CLI auth session issue` (default `threadlines`)
 *   for this run and revoked after.
 * - DEMO_REPOS_DIR: where the sample repos live (default $THREADLINES_HOME/demo-repos).
 *   A reset deletes this folder, so it must hold nothing else.
 * - DEMO_AGENT_INSTANCE: the scripted agent's provider instance (default `demo`).
 * - DEMO_PR_REPO_URL, DEMO_PR_BRANCH: the pull request hook. A public sample
 *   repo's clone URL and a branch with an open pull request there. When both
 *   are set, a reset clones it as a fourth project with a thread on that
 *   branch, so `thread_changes` shows a real pull request. The server also
 *   needs `gh` and a read-only GH_TOKEN to look the pull request up.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { connectThreadlines, statusOf, type ThreadlinesClient } from "./threadlinesClient.ts";

const REPOS_MARKER = ".threadlines-demo-repos";
const AGENT_INSTANCE = process.env.DEMO_AGENT_INSTANCE?.trim() || "demo";
const MODEL = { instanceId: AGENT_INSTANCE, model: "scripted" } as const;
const SAMPLE_AUTHOR = [
  "-c",
  "user.name=Sample Author",
  "-c",
  "user.email=sample-author@example.invalid",
] as const;
/** Fixed, so every reset builds the same commits. */
const SAMPLE_DATE = "2026-10-01T09:00:00Z";

const home = () =>
  process.env.THREADLINES_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".threadlines");
const reposDir = () => process.env.DEMO_REPOS_DIR?.trim() || NodePath.join(home(), "demo-repos");
const serverUrl = () =>
  process.env.THREADLINES_URL?.trim() ||
  `http://127.0.0.1:${process.env.THREADLINES_PORT?.trim() || "3773"}`;
const nowIso = () => new Date().toISOString();

function log(message: string): void {
  console.log(`[demo] ${message}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Every built-in provider, all off: the scripted agent is the only one. */
const BUILT_IN_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "fx",
  "opencode",
  "antigravity",
  "muse",
  "grok",
  "pi",
] as const;

/**
 * The scripted agent rides the Cursor ACP driver: of the drivers that can run
 * an arbitrary ACP agent, it is the one that carries an agent's questions
 * (`cursor/ask_question`), which `thread_answer` needs. Its own name replaces
 * Cursor's everywhere a provider's name is shown, and assistants never see a
 * driver. (The agent also answers fx's status check, so `driver: "fx"` works
 * too, minus questions: the agent then asks for an approval instead.)
 */
function demoSettings(agentPath: string) {
  return {
    providers: Object.fromEntries(BUILT_IN_PROVIDERS.map((kind) => [kind, { enabled: false }])),
    providerInstances: {
      [AGENT_INSTANCE]: {
        driver: "cursor",
        displayName: "Demo agent (scripted)",
        enabled: true,
        config: { enabled: true, binaryPath: agentPath },
      },
    },
    newThreadModelSelection: MODEL,
    // Titles and branch names come from the scripted agent too, not a model.
    textGenerationModelSelection: MODEL,
    usageAnalyticsEnabled: false,
    computerName: "Demo computer",
  };
}

// ---------------------------------------------------------------------------
// Sample repos
// ---------------------------------------------------------------------------

interface SampleRepo {
  readonly folder: string;
  readonly title: string;
  readonly files: Readonly<Record<string, string>>;
}

const SAMPLE_REPOS: ReadonlyArray<SampleRepo> = [
  {
    folder: "acme-notes",
    title: "Acme Notes",
    files: {
      ".gitignore": "node_modules/\n",
      "package.json": `${JSON.stringify(
        {
          name: "acme-notes",
          version: "0.3.0",
          description: "Small helpers for plain-text notes.",
          type: "module",
          exports: "./src/index.js",
          scripts: { test: "node --test" },
          license: "MIT",
        },
        null,
        2,
      )}\n`,
      "README.md": `# Acme Notes

Small helpers for plain-text notes: word counts, excerpts and tidy whitespace. No dependencies.

## Use

\`\`\`js
import { excerpt, wordCount } from "acme-notes";

wordCount("Buy milk and eggs"); // 4
excerpt("A long note about the weekend plans", 3); // "A long note…"
\`\`\`

## Test

\`\`\`sh
npm test
\`\`\`
`,
      "CHANGELOG.md": `# Changelog

## 0.3.0

- Added \`excerpt\`.

## 0.2.0

- Added \`tidyWhitespace\`.
`,
      "src/index.js": `export { excerpt, tidyWhitespace, wordCount } from "./format.js";\n`,
      "src/format.js": `/** How many words \`text\` has. */
export function wordCount(text) {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\\s+/).length;
}

/** The first \`words\` words of \`text\`, with an ellipsis when it was cut. */
export function excerpt(text, words) {
  const all = text.trim().split(/\\s+/);
  return all.length <= words ? all.join(" ") : \`\${all.slice(0, words).join(" ")}…\`;
}

/** Collapses runs of spaces and blank lines. */
export function tidyWhitespace(text) {
  return text
    .split("\\n")
    .map((line) => line.replace(/[ \\t]+/g, " ").trimEnd())
    .join("\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}
`,
      "test/format.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { excerpt, tidyWhitespace, wordCount } from "../src/format.js";

test("wordCount counts words", () => {
  assert.equal(wordCount("Buy milk and eggs"), 4);
  assert.equal(wordCount("   "), 0);
});

test("excerpt cuts long text", () => {
  assert.equal(excerpt("A long note about the weekend plans", 3), "A long note…");
  assert.equal(excerpt("Short", 3), "Short");
});

test("tidyWhitespace collapses runs", () => {
  assert.equal(tidyWhitespace("a   b\\n\\n\\n\\nc  "), "a b\\n\\nc");
});
`,
    },
  },
  {
    folder: "weather-cli",
    title: "Weather CLI",
    files: {
      ".gitignore": "__pycache__/\n.venv/\n",
      "pyproject.toml": `[project]
name = "weather-cli"
version = "0.5.1"
description = "Convert and print weather readings from the command line."
requires-python = ">=3.10"

[project.scripts]
weather = "weather.cli:main"

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
      "README.md": `# Weather CLI

Convert and print weather readings from the command line.

## Use

\`\`\`sh
weather convert 21 --to f   # 69.8
\`\`\`

## Test

\`\`\`sh
python -m pytest
\`\`\`
`,
      "CHANGELOG.md": `# Changelog

## 0.5.1

- \`convert\` rounds to one decimal place.
`,
      "weather/__init__.py": `"""Convert and print weather readings."""\n`,
      "weather/units.py": `def celsius_to_fahrenheit(celsius: float) -> float:
    """Convert a Celsius reading to Fahrenheit."""
    return celsius * 9 / 5 + 32


def fahrenheit_to_celsius(fahrenheit: float) -> float:
    """Convert a Fahrenheit reading to Celsius."""
    return (fahrenheit - 32) * 5 / 9
`,
      "weather/cli.py": `import argparse

from weather.units import celsius_to_fahrenheit, fahrenheit_to_celsius


def main() -> None:
    parser = argparse.ArgumentParser(prog="weather")
    commands = parser.add_subparsers(dest="command", required=True)
    convert = commands.add_parser("convert", help="convert a temperature")
    convert.add_argument("value", type=float)
    convert.add_argument("--to", choices=["c", "f"], required=True)
    args = parser.parse_args()
    if args.command == "convert":
        result = celsius_to_fahrenheit(args.value) if args.to == "f" else fahrenheit_to_celsius(args.value)
        print(round(result, 1))


if __name__ == "__main__":
    main()
`,
      "tests/test_units.py": `from weather.units import celsius_to_fahrenheit, fahrenheit_to_celsius


def test_round_trip():
    assert celsius_to_fahrenheit(100) == 212
    assert fahrenheit_to_celsius(212) == 100
`,
    },
  },
  {
    folder: "field-guide",
    title: "Field Guide docs",
    files: {
      "README.md": `# Field Guide

The user guide for Field Guide, a note-taking app for hikers.

## Pages

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Installing version 1 (old)](docs/old-install.md)
`,
      "docs/getting-started.md": `# Getting started

1. Install the app from your phone's app store.
2. Open it and pick a folder for your notes.
3. Tap **New note** and start writing.
`,
      "docs/configuration.md": `# Configuration

Settings live in **Menu → Settings**.

- **Units:** metric or imperial.
- **Backups:** where copies of your notes go.
`,
      "docs/old-install.md": `# Installing version 1

This page is out of date: version 1 is no longer available.
`,
    },
  },
];

function runGit(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

function buildSampleRepo(root: string, repo: SampleRepo): string {
  const dir = NodePath.join(root, repo.folder);
  for (const [path, content] of Object.entries(repo.files)) {
    const file = NodePath.join(dir, path);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  }
  runGit(dir, ["init", "--quiet", "--initial-branch=main"]);
  runGit(dir, ["add", "-A"]);
  runGit(dir, [...SAMPLE_AUTHOR, "commit", "--quiet", "-m", `Start ${repo.title}`], {
    GIT_AUTHOR_DATE: SAMPLE_DATE,
    GIT_COMMITTER_DATE: SAMPLE_DATE,
  });
  return dir;
}

/** Removes every worktree of the repos under `root` (Threadlines makes them elsewhere), then `root`. */
function removeSampleRepos(root: string): void {
  if (!NodeFS.existsSync(root)) return;
  if (!NodeFS.existsSync(NodePath.join(root, REPOS_MARKER))) {
    throw new Error(
      `${root} exists but wasn't made by these fixtures (no ${REPOS_MARKER}); refusing to delete it. Set DEMO_REPOS_DIR to a folder of its own.`,
    );
  }
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const repo = NodePath.join(root, entry.name);
    if (!entry.isDirectory() || !NodeFS.existsSync(NodePath.join(repo, ".git"))) continue;
    const listed = runGit(repo, ["worktree", "list", "--porcelain"]);
    const worktrees = listed
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((path) => NodePath.resolve(path) !== NodePath.resolve(repo));
    for (const worktree of worktrees) {
      try {
        runGit(repo, ["worktree", "remove", "--force", "--force", worktree]);
      } catch {
        NodeFS.rmSync(worktree, { recursive: true, force: true });
      }
    }
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The owner token
// ---------------------------------------------------------------------------

interface OwnerToken {
  readonly token: string;
  readonly revoke: () => void;
}

function cliCommand(): ReadonlyArray<string> {
  const raw = process.env.DEMO_THREADLINES_CLI?.trim() || "threadlines";
  return raw.split(/\s+/u);
}

function ownerToken(): OwnerToken {
  const given = process.env.DEMO_OWNER_TOKEN?.trim();
  if (given) return { token: given, revoke: () => {} };
  const [command, ...prefix] = cliCommand();
  const issued = JSON.parse(
    execFileSync(
      command!,
      [
        ...prefix,
        "auth",
        "session",
        "issue",
        "--role",
        "owner",
        "--label",
        "Demo fixtures",
        "--ttl",
        "30m",
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  ) as { readonly sessionId: string; readonly token: string };
  return {
    token: issued.token,
    revoke: () => {
      try {
        execFileSync(command!, [...prefix, "auth", "session", "revoke", issued.sessionId], {
          stdio: "ignore",
        });
      } catch {
        log(`couldn't revoke the fixtures' session ${issued.sessionId}; it expires in 30 minutes.`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Projects and threads
// ---------------------------------------------------------------------------

const isInside = (path: string, root: string) => {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(path));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

async function deleteDemoProjects(client: ThreadlinesClient, root: string): Promise<void> {
  const shell = await client.shell();
  const demo = [...shell.projects.values()].filter((project) =>
    isInside(project.workspaceRoot, root),
  );
  for (const project of demo) {
    log(`deleting project "${project.title}" and its threads`);
    await client.dispatch({
      type: "project.delete",
      commandId: `demo-reset:${randomUUID()}`,
      projectId: project.id,
      force: true,
    });
  }
  await client.waitFor("the demo projects and their threads to go", (state) =>
    demo.every((project) => !state.projects.has(project.id)) &&
    ![...state.threads.values()].some((thread) => demo.some((p) => p.id === thread.projectId))
      ? true
      : undefined,
  );
}

async function createProject(
  client: ThreadlinesClient,
  title: string,
  workspaceRoot: string,
): Promise<string> {
  const projectId = randomUUID();
  await client.dispatch({
    type: "project.create",
    commandId: `demo-project:${projectId}`,
    projectId,
    title,
    workspaceRoot,
    defaultModelSelection: MODEL,
    createdAt: nowIso(),
  });
  await client.waitFor(`project "${title}"`, (state) =>
    state.projects.has(projectId) ? true : undefined,
  );
  return projectId;
}

type Expect =
  | "idle"
  | "working"
  | "failed"
  | "needs the user (question)"
  | "needs the user (approval)";

interface FixtureThread {
  readonly title: string;
  readonly prompt: string;
  readonly expect: Expect;
  readonly runtimeMode?: "full-access" | "approval-required";
  /** Work on this existing branch in the project folder instead of a new worktree. */
  readonly branch?: string;
}

/** Starts a thread the way the app's first send does, and waits until it shows `expect`. */
async function startThread(
  client: ThreadlinesClient,
  project: { readonly id: string; readonly root: string },
  fixture: FixtureThread,
): Promise<string> {
  const threadId = randomUUID();
  const createdAt = nowIso();
  const runtimeMode = fixture.runtimeMode ?? "full-access";
  await client.dispatch({
    type: "thread.turn.start",
    commandId: `demo-thread:${threadId}`,
    threadId,
    message: { messageId: randomUUID(), role: "user", text: fixture.prompt, attachments: [] },
    modelSelection: MODEL,
    runtimeMode,
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: project.id,
        title: fixture.title,
        modelSelection: MODEL,
        runtimeMode,
        interactionMode: "default",
        branch: fixture.branch ?? null,
        worktreePath: null,
        createdAt,
      },
      ...(fixture.branch === undefined
        ? { prepareWorktree: { projectCwd: project.root, baseBranch: "main" } }
        : {}),
      runSetupScript: false,
    },
    createdAt,
  });
  const reached = await client.waitFor(
    `"${fixture.title}" to be ${fixture.expect}`,
    (state) => {
      const thread = state.threads.get(threadId);
      if (!thread || thread.latestTurn === null) return undefined;
      const status = statusOf(thread);
      // Idle only counts once its turn has really finished (checkpoint included).
      if (fixture.expect === "idle") {
        return thread.latestTurn.state === "completed" && status === "idle" ? status : undefined;
      }
      return status === fixture.expect ? status : undefined;
    },
    120_000,
  );
  log(`  "${fixture.title}": ${reached}`);
  return threadId;
}

interface ProjectFixture {
  readonly repo: SampleRepo;
  readonly threads: ReadonlyArray<FixtureThread>;
}

const FIXTURES: ReadonlyArray<ProjectFixture> = [
  {
    repo: SAMPLE_REPOS[0]!,
    threads: [
      {
        title: "Add a clamp helper",
        prompt: "Add a clamp helper to the library, with a test.",
        expect: "idle",
      },
      {
        title: "Pick the next change",
        prompt: "Ask me which change to make first, then make it.",
        expect: "needs the user (question)",
      },
    ],
  },
  {
    repo: SAMPLE_REPOS[1]!,
    threads: [
      // No fixture commits: `thread_changes` counts a thread's uncommitted
      // work (a commit that cleans the checkout zeroes its totals), so
      // finished threads leave their changes for the reviewer to see.
      {
        title: "Add a slugify helper",
        prompt: "Add a slugify helper for city names.",
        expect: "idle",
      },
      {
        title: "Run the release check",
        prompt: "Run the release check. If anything looks wrong, fail the run.",
        expect: "failed",
      },
    ],
  },
  {
    repo: SAMPLE_REPOS[2]!,
    threads: [
      {
        title: "Explain this project",
        prompt: "Explain what this project is.",
        expect: "idle",
      },
      {
        title: "Remove the outdated install page",
        prompt: "Remove docs/old-install.md, it's out of date.",
        expect: "needs the user (approval)",
        runtimeMode: "approval-required",
      },
      {
        title: "Watch the docs build",
        prompt: "Keep watching the docs build until I stop you.",
        expect: "working",
      },
    ],
  },
];

/** The pull request hook: see the module notes. */
async function seedPullRequestProject(client: ThreadlinesClient, root: string): Promise<void> {
  const url = process.env.DEMO_PR_REPO_URL?.trim();
  const branch = process.env.DEMO_PR_BRANCH?.trim();
  if (!url || !branch) {
    log("no DEMO_PR_REPO_URL and DEMO_PR_BRANCH: skipping the pull request project");
    return;
  }
  const dir = NodePath.join(root, "pull-request-sample");
  // A public repo: no credentials. The clone checks out the pull request's branch.
  runGit(root, ["clone", "--quiet", "--branch", branch, url, dir]);
  const projectId = await createProject(client, "Pull request sample", dir);
  log(`project "Pull request sample" (${url}, branch ${branch})`);
  await startThread(
    client,
    { id: projectId, root: dir },
    {
      title: "Review the open pull request",
      prompt: "Explain what this project is.",
      expect: "idle",
      branch,
    },
  );
}

async function reset(): Promise<void> {
  const root = reposDir();
  const owner = ownerToken();
  const client = await connectThreadlines({ serverUrl: serverUrl(), token: owner.token });
  try {
    await deleteDemoProjects(client, root);
    removeSampleRepos(root);
    NodeFS.mkdirSync(root, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, REPOS_MARKER),
      "Sample repos for the Threadlines demo computer. A fixtures reset deletes this folder.\n",
    );
    for (const fixture of FIXTURES) {
      const dir = buildSampleRepo(root, fixture.repo);
      const projectId = await createProject(client, fixture.repo.title, dir);
      log(`project "${fixture.repo.title}" (${dir})`);
      for (const thread of fixture.threads) {
        await startThread(client, { id: projectId, root: dir }, thread);
      }
    }
    await seedPullRequestProject(client, root);
    log("reset done");
  } finally {
    client.close();
    owner.revoke();
  }
}

async function status(): Promise<void> {
  const root = reposDir();
  const owner = ownerToken();
  const client = await connectThreadlines({ serverUrl: serverUrl(), token: owner.token });
  try {
    const shell = await client.shell();
    for (const project of shell.projects.values()) {
      if (!isInside(project.workspaceRoot, root)) continue;
      console.log(`${project.title}  (${project.workspaceRoot})`);
      for (const thread of shell.threads.values()) {
        if (thread.projectId !== project.id) continue;
        console.log(`  ${statusOf(thread).padEnd(26)} ${thread.title}  [${thread.branch ?? "-"}]`);
      }
    }
  } finally {
    client.close();
    owner.revoke();
  }
}

function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "settings": {
      const agent = flag(rest, "--agent");
      const out = flag(rest, "--out");
      if (!agent || !out)
        throw new Error("Usage: demo-fixtures.ts settings --agent <path> --out <file>");
      NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
      NodeFS.writeFileSync(
        out,
        `${JSON.stringify(demoSettings(NodePath.resolve(agent)), null, 2)}\n`,
      );
      log(`wrote ${out}`);
      return;
    }
    case "reset":
      return reset();
    case "status":
      return status();
    default:
      console.error(
        "Usage: demo-fixtures.ts settings --agent <path> --out <file> | reset | status",
      );
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (cause: unknown) => {
    console.error(`[demo] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  },
);
