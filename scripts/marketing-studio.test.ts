import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const studioScript = NodePath.join(repoRoot, "scripts/marketing-studio.ts");

const runStudio = (root: string, args: ReadonlyArray<string>) =>
  ChildProcess.spawnSync(process.execPath, [studioScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      THREADLINES_MARKETING_STUDIO_DIR: root,
      THREADLINES_MARKETING_STUDIO_APP_DATA_DIR: NodePath.join(NodePath.dirname(root), "app-data"),
    },
  });

const runGit = (project: string, args: ReadonlyArray<string>): string =>
  ChildProcess.execFileSync("git", [...args], {
    cwd: project,
    encoding: "utf8",
  }).trimEnd();

describe("marketing-studio", () => {
  it("creates an idempotent, guarded capture repository", () => {
    const temporaryRoot = FileSystem.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "threadlines-marketing-studio-test-"),
    );
    const root = NodePath.join(temporaryRoot, "studio");
    const project = NodePath.join(root, "Orbit");

    try {
      const firstSetup = runStudio(root, ["setup"]);
      assert.equal(firstSetup.status, 0, firstSetup.stderr);
      for (const projectName of ["Orbit", "Lumen", "Northstar"]) {
        assert.equal(
          FileSystem.existsSync(NodePath.join(root, projectName, "favicon.svg")),
          true,
          projectName + " should have a favicon",
        );
        assert.equal(
          FileSystem.existsSync(NodePath.join(root, projectName, ".git")),
          true,
          projectName + " should be a Git repository",
        );
      }
      assert.equal(
        FileSystem.existsSync(NodePath.join(root, ".threadlines-marketing-projects-seeded")),
        true,
      );
      assert.equal(
        FileSystem.existsSync(NodePath.join(root, ".threadlines-marketing-threads-seeded")),
        true,
      );
      const threadSeed = JSON.parse(
        FileSystem.readFileSync(
          NodePath.join(root, ".threadlines-marketing-thread-seed.json"),
          "utf8",
        ),
      ) as {
        readonly projects: ReadonlyArray<{
          readonly workspaceRoot: string;
          readonly threads: ReadonlyArray<{
            readonly title: string;
            readonly branch: string | null;
            readonly modelSelection: {
              readonly instanceId: string;
              readonly model: string;
              readonly options: ReadonlyArray<{ readonly id: string; readonly value: string }>;
            };
          }>;
        }>;
      };
      assert.deepEqual(
        threadSeed.projects.map((seededProject) => seededProject.threads.length),
        [4, 3, 2],
      );
      assert.deepEqual(
        threadSeed.projects.flatMap((seededProject) =>
          seededProject.threads
            .filter((thread) =>
              [
                "feature/usage-insights",
                "studio/alert-grouping",
                "studio/evaluation-cache",
              ].includes(thread.branch ?? ""),
            )
            .map((thread) => thread.title),
        ),
        ["Usage insights", "Group noisy alerts", "Evaluation cache"],
      );
      const seededThreads = threadSeed.projects.flatMap((seededProject) => seededProject.threads);
      assert.deepEqual(
        seededThreads.find((thread) => thread.title === "Project file editing")?.modelSelection,
        {
          instanceId: "claudeAgent",
          model: "claude-fable-5",
          options: [{ id: "effort", value: "high" }],
        },
      );
      assert.deepEqual(
        seededThreads.find((thread) => thread.title === "Checkout recovery")?.modelSelection,
        {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      );
      for (const worktree of [
        ["Orbit", "project-files"],
        ["Orbit", "usage-insights"],
        ["Northstar", "alert-grouping"],
        ["Lumen", "evaluation-cache"],
      ]) {
        assert.equal(
          FileSystem.existsSync(NodePath.join(root, ".worktrees", ...worktree, ".git")),
          true,
        );
      }
      const fixtureGh = NodePath.join(root, ".bin", "gh");
      for (const fixtureCommand of ["gh", "git", "threadlines-studio-shell"]) {
        assert.equal(FileSystem.existsSync(NodePath.join(root, ".bin", fixtureCommand)), true);
      }
      const fixturePr = ChildProcess.execFileSync(
        process.execPath,
        [fixtureGh, "pr", "list", "--head", "feature/usage-insights", "--state", "all"],
        { encoding: "utf8" },
      );
      assert.equal(JSON.parse(fixturePr)[0]?.state, "MERGED");
      assert.equal(
        runGit(project, ["status", "--short"]),
        [
          " M docs/release-checklist.md",
          " M src/components/CheckoutSummary.tsx",
          " M src/lib/retry.ts",
          "M  src/theme.ts",
        ].join("\n"),
      );
      assert.deepEqual(runGit(project, ["branch", "--format=%(refname:short)"]).split("\n"), [
        "feature/project-files",
        "feature/usage-insights",
        "fix/checkout-timeout",
        "main",
      ]);
      assert.equal(
        runGit(project, ["config", "--get", "remote.origin.url"]),
        "https://github.com/threadlines-labs/orbit-demo.git",
      );
      assert.equal(
        runGit(NodePath.join(root, "Lumen"), ["config", "--get", "remote.origin.url"]),
        "https://github.com/threadlines-labs/lumen-demo.git",
      );
      assert.equal(
        runGit(NodePath.join(root, "Northstar"), ["config", "--get", "remote.origin.url"]),
        "https://github.com/threadlines-labs/northstar-demo.git",
      );
      assert.equal(
        runGit(project, ["remote", "get-url", "origin"]),
        "https://github.com/threadlines-labs/orbit-demo.git",
      );
      assert.match(
        runGit(project, ["show-ref", "--verify", "refs/remotes/origin/main"]),
        /refs\/remotes\/origin\/main$/,
      );
      assert.match(
        runGit(project, ["config", "--get", "threadlines.marketing-local-remote"]),
        /^file:\/\//,
      );
      assert.notEqual(
        runGit(project, ["rev-parse", "main"]),
        runGit(project, ["rev-parse", "v0.9.0-rc.1"]),
      );
      assert.equal(
        runGit(project, ["rev-parse", "main^"]),
        runGit(project, ["rev-parse", "v0.9.0-rc.1"]),
      );
      assert.deepEqual(
        JSON.parse(
          FileSystem.readFileSync(
            NodePath.join(root, ".threadlines/dev/window-state.json"),
            "utf8",
          ),
        ),
        {
          width: 1624,
          height: 995,
          isMaximized: true,
        },
      );

      const secondSetup = runStudio(root, ["setup"]);
      assert.equal(secondSetup.status, 0, secondSetup.stderr);
      assert.match(secondSetup.stdout, /already set up/);

      const refusedReset = runStudio(root, ["reset"]);
      assert.equal(refusedReset.status, 1);
      assert.match(refusedReset.stderr, /--force/);
      assert.equal(FileSystem.existsSync(project), true);

      const forcedReset = runStudio(root, ["reset", "--force"]);
      assert.equal(forcedReset.status, 0, forcedReset.stderr);
      assert.equal(FileSystem.existsSync(NodePath.join(project, ".git")), true);
    } finally {
      FileSystem.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
