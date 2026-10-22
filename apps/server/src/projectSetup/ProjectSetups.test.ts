import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProjectSetupId,
  type OrchestrationCommand,
  type OrchestrationProjectCatalogEntry,
  type ProjectSetupJob,
  type ProjectSetupStartInput,
} from "@threadlines/contracts";
import { normalizeGitRemoteUrl } from "@threadlines/shared/git";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { parseCloneProgress } from "./cloneProgress.ts";
import { ProjectSetupRepository, ProjectSetupRepositoryLive } from "./ProjectSetupRepository.ts";
import {
  cloneUrls,
  filesRefusal,
  makeProjectSetups,
  ProjectSetups,
  ProjectSetupsLive,
  stagingPathFor,
} from "./ProjectSetups.ts";
import { ProjectSetupSource, ProjectSetupSourceLive } from "./ProjectSetupSource.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const PROJECT_A = ProjectId.make("project-a");
const SCRIPTS = [
  {
    id: "setup",
    name: "Install",
    command: "pnpm install",
    icon: "play" as const,
    runOnWorktreeCreate: true,
  },
];

/**
 * An origin, the project's computer (`a`: ignored files of every kind, a
 * second remote whose URL carries a token), and an existing plain clone (`b`).
 */
function makeRepos() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-setups-")));
  const origin = path.join(root, "origin.git");
  run(root, "init", "--bare", "--initial-branch=main", origin);
  const a = path.join(root, "a");
  run(root, "clone", origin, a);
  fs.writeFileSync(path.join(a, ".gitignore"), ".env\n*.env.local\n*.log\nnode_modules/\n");
  fs.writeFileSync(path.join(a, "tracked.txt"), "tracked\n");
  run(a, "add", ".");
  run(a, "commit", "-m", "first");
  run(a, "push", "origin", "HEAD:main");
  run(a, "remote", "add", "mirror", "https://bot:s3cret@example.com/org/app.git");
  fs.writeFileSync(path.join(a, ".env"), "SECRET=1\n", { mode: 0o600 });
  fs.mkdirSync(path.join(a, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(a, "apps", "web", ".env.local"), "LOCAL=1\n");
  fs.writeFileSync(path.join(a, "notes.log"), "a log\n");
  fs.mkdirSync(path.join(a, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(a, "node_modules", "pkg", "index.js"), "\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "outside\n");
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(a, "linked.log"));
  }
  const b = path.join(root, "b");
  run(root, "clone", origin, b);
  return { root, origin, a, b };
}

function testLayer(
  repos: ReturnType<typeof makeRepos>,
  dispatched: OrchestrationCommand[],
  catalog: () => ReadonlyArray<OrchestrationProjectCatalogEntry> = () => [],
) {
  return Layer.mergeAll(ProjectSetupsLive, ProjectSetupSourceLive).pipe(
    Layer.provideMerge(ProjectSetupRepositoryLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () =>
            Effect.succeed({
              threads: [],
              projects: [
                {
                  id: PROJECT_A,
                  kind: "workspace",
                  title: "App",
                  workspaceRoot: repos.a,
                  scripts: SCRIPTS,
                  deletedAt: null,
                },
              ],
            } as never),
          getProjectCatalog: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: catalog(),
              updatedAt: "2026-10-22T10:00:00.000Z",
            }),
        }),
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed({ label: "Test PC" } as never),
        }),
      ),
    ),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** The job once it has finished, however it finished. */
const finished = (setupId: ProjectSetupId) =>
  Effect.gen(function* () {
    const setups = yield* ProjectSetups;
    const job = yield* setups.changes.pipe(
      Stream.map((snapshot) => snapshot.jobs.find((entry) => entry.setupId === setupId)),
      Stream.filter(
        (entry): entry is ProjectSetupJob =>
          entry !== undefined && ["done", "failed", "cancelled"].includes(entry.stage),
      ),
      Stream.runHead,
      Effect.timeout("30 seconds"),
    );
    return job._tag === "Some" ? job.value : assert.fail("the job never finished");
  });

describe("ProjectSetups", () => {
  it.live(
    "copies a project to another folder: the same key, its remotes, the ticked files and its scripts",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const source = yield* ProjectSetupSource;
        const setups = yield* ProjectSetups;
        const answer = yield* source.source(PROJECT_A);
        assert.equal(answer.repositoryKey, normalizeGitRemoteUrl(repos.origin));
        assert.equal(answer.primaryRemoteName, "origin");
        // Ignored files only, suggested ones first; no folder git ignores whole, no symlink.
        assert.deepEqual(
          answer.files.map((file) => [file.path, file.suggested]),
          [
            [".env", true],
            ["apps/web/.env.local", true],
            ["notes.log", false],
          ],
        );
        // A token in a remote's URL never leaves the computer.
        assert.deepEqual(
          answer.remotes.map((remote) => [remote.name, remote.url]),
          [
            ["origin", repos.origin],
            ["mirror", "https://example.com/org/app.git"],
          ],
        );

        // Only ignored files inside the project can be read for it.
        for (const bad of ["tracked.txt", "../outside.txt", ".git/config", "linked.log"]) {
          const refused = yield* source
            .readFiles({ projectId: PROJECT_A, paths: [bad] })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "ProjectSetupError", bad);
        }
        const { files } = yield* source.readFiles({
          projectId: PROJECT_A,
          paths: [".env", "apps/web/.env.local"],
        });

        const setupId = ProjectSetupId.make("setup-copy-1");
        const destination = path.join(repos.root, "copies", "app");
        const input: ProjectSetupStartInput = {
          setupId,
          source: { environmentId: "env-a" as never, projectId: PROJECT_A, label: "Mac" },
          title: answer.title,
          repositoryKey: answer.repositoryKey,
          subdirectory: answer.subdirectory,
          remotes: answer.remotes,
          primaryRemoteName: answer.primaryRemoteName,
          protocol: "other",
          scripts: answer.scripts,
          destinationPath: destination,
          files,
        };
        yield* setups.start(input);
        const done = yield* finished(setupId);
        assert.equal(done.stage, "done", done.error ?? "");
        assert.deepEqual(done.warnings, []);

        assert.equal(run(destination, "remote", "get-url", "origin"), repos.origin);
        assert.equal(
          run(destination, "remote", "get-url", "mirror"),
          "https://example.com/org/app.git",
        );
        assert.equal(fs.readFileSync(path.join(destination, ".env"), "utf8"), "SECRET=1\n");
        assert.equal(
          fs.readFileSync(path.join(destination, "apps", "web", ".env.local"), "utf8"),
          "LOCAL=1\n",
        );
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(path.join(destination, ".env")).mode & 0o777, 0o600);
        }
        assert.isFalse(fs.existsSync(stagingPathFor(destination, setupId)));

        const created = dispatched.filter((command) => command.type === "project.create");
        assert.equal(created.length, 1);
        assert(created[0]?.type === "project.create");
        assert.equal(created[0].workspaceRoot, destination);
        assert.equal(done.projectId, created[0].projectId);
        const meta = dispatched.find((command) => command.type === "project.meta.update");
        assert(meta?.type === "project.meta.update");
        assert.deepEqual(meta.scripts, SCRIPTS);

        // The same start again is the same job.
        assert.equal((yield* setups.start(input)).stage, "done");
        assert.equal(dispatched.filter((command) => command.type === "project.create").length, 1);
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );

  it.live(
    "adds an existing copy as it is, keeping its own files, and refuses folders it can't use",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      let catalog: OrchestrationProjectCatalogEntry[] = [];
      return Effect.gen(function* () {
        const source = yield* ProjectSetupSource;
        const setups = yield* ProjectSetups;
        const answer = yield* source.source(PROJECT_A);
        const inspect = (folder: string) =>
          setups
            .inspectDestination({
              path: folder,
              repositoryKey: answer.repositoryKey,
              remotes: answer.remotes,
            })
            .pipe(Effect.map((result) => result.state));
        const other = path.join(repos.root, "other");
        run(repos.root, "init", "--initial-branch=main", other);
        run(other, "remote", "add", "origin", "https://example.com/someone/else.git");
        fs.mkdirSync(path.join(repos.root, "empty"));
        assert.equal(yield* inspect(repos.b), "same-repository");
        assert.equal(yield* inspect(other), "other-repository");
        assert.equal(yield* inspect(repos.root), "not-empty");
        assert.equal(yield* inspect(path.join(repos.root, "outside.txt")), "not-a-folder");
        assert.equal(yield* inspect(path.join(repos.root, "empty")), "empty");
        assert.equal(yield* inspect(path.join(repos.root, "nothing-yet")), "missing");

        fs.writeFileSync(path.join(repos.b, ".env"), "MINE=1\n");
        const { files } = yield* source.readFiles({ projectId: PROJECT_A, paths: [".env"] });
        const base = {
          source: { environmentId: "env-a" as never, projectId: PROJECT_A, label: "Mac" },
          title: answer.title,
          repositoryKey: answer.repositoryKey,
          subdirectory: answer.subdirectory,
          remotes: answer.remotes,
          primaryRemoteName: answer.primaryRemoteName,
          protocol: "other" as const,
          scripts: [],
          files,
        };
        const refused = yield* setups
          .start({ ...base, setupId: ProjectSetupId.make("into-other"), destinationPath: other })
          .pipe(Effect.flip);
        assert.include(refused.detail, "different repository");

        const setupId = ProjectSetupId.make("adopt-1");
        yield* setups.start({ ...base, setupId, destinationPath: repos.b });
        const done = yield* finished(setupId);
        assert.equal(done.stage, "done", done.error ?? "");
        // Its own .env wins, and the job says so.
        assert.equal(fs.readFileSync(path.join(repos.b, ".env"), "utf8"), "MINE=1\n");
        assert.deepEqual(done.warnings, ["Kept Test PC's own .env."]);
        const created = dispatched.find((command) => command.type === "project.create");
        assert(created?.type === "project.create");
        assert.equal(created.workspaceRoot, repos.b);

        // Once it has the project, it says so instead of copying it again.
        catalog = [
          {
            id: created.projectId,
            kind: "workspace",
            title: "App",
            workspaceRoot: repos.b,
            createdAt: "2026-10-22T10:00:00.000Z",
            updatedAt: "2026-10-22T10:00:00.000Z",
            deletedAt: null,
          },
        ];
        const again = yield* setups
          .start({
            ...base,
            setupId: ProjectSetupId.make("adopt-2"),
            destinationPath: path.join(repos.root, "another"),
          })
          .pipe(Effect.flip);
        assert.equal(again.detail, "Test PC already has App.");
      }).pipe(Effect.provide(testLayer(repos, dispatched, () => catalog)));
    },
  );

  it.live(
    "after a restart, finishes a copy already in place and deletes only a staging folder it made",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const repo = yield* ProjectSetupRepository;
        const request = {
          source: { environmentId: "env-a" as never, projectId: PROJECT_A, label: "Mac" },
          title: "App",
          repositoryKey: normalizeGitRemoteUrl(repos.origin),
          subdirectory: "",
          remotes: [{ name: "origin", url: repos.origin, protocol: "other" as const }],
          primaryRemoteName: "origin",
          protocol: "other" as const,
          scripts: [],
          filePaths: [],
        };
        const row = (
          setupId: string,
          destination: string,
          stagingPath: string | null,
          stage: "cloning" | "publishing",
        ) =>
          repo.insert({
            setupId: ProjectSetupId.make(setupId),
            request: { ...request, destinationPath: destination },
            destinationPath: destination,
            stagingPath,
            adopted: false,
            stage,
            projectId: ProjectId.make(`project-${setupId}`),
            createCommandId: CommandId.make(`create-${setupId}`),
            scriptsCommandId: CommandId.make(`scripts-${setupId}`),
            createdAt: "2026-10-22T10:00:00.000Z",
          });

        // Cut off mid-clone: its staging folder goes, the folder beside it stays.
        const cut = path.join(repos.root, "copies", "cut");
        const cutStaging = stagingPathFor(cut, "cut-1");
        fs.mkdirSync(path.join(cutStaging, "copy"), { recursive: true });
        fs.writeFileSync(path.join(cutStaging, ".threadlines-setup"), "cut-1");
        fs.writeFileSync(path.join(cutStaging, "copy", "partial"), "x");
        fs.writeFileSync(path.join(repos.root, "copies", "keep.txt"), "keep");
        yield* row("cut-1", cut, cutStaging, "cloning");
        // Moved into place just before the restart: it is finished, never deleted.
        const placed = path.join(repos.root, "copies", "placed");
        run(repos.root, "clone", repos.origin, placed);
        const placedStaging = stagingPathFor(placed, "placed-1");
        fs.mkdirSync(placedStaging);
        fs.writeFileSync(path.join(placedStaging, ".threadlines-setup"), "placed-1");
        yield* row("placed-1", placed, placedStaging, "publishing");
        // A row naming a folder that isn't its own staging folder: nothing is deleted.
        yield* row("odd-1", path.join(repos.root, "copies", "odd"), repos.b, "cloning");
        // A folder at the staging name without this job's mark isn't the job's.
        const unmarked = path.join(repos.root, "copies", "unmarked");
        const unmarkedStaging = stagingPathFor(unmarked, "unmarked-1");
        fs.mkdirSync(unmarkedStaging);
        fs.writeFileSync(path.join(unmarkedStaging, "someone-elses"), "x");
        yield* row("unmarked-1", unmarked, unmarkedStaging, "cloning");

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeProjectSetups;
            for (let tries = 0; tries < 200; tries += 1) {
              const rows = yield* repo.list;
              if (rows.every((entry) => ["done", "failed"].includes(entry.stage))) break;
              yield* Effect.sleep("50 millis");
            }
          }),
        );
        const rows = new Map((yield* repo.list).map((entry) => [entry.setupId, entry]));
        assert.equal(rows.get(ProjectSetupId.make("cut-1"))?.stage, "failed");
        assert.include(rows.get(ProjectSetupId.make("cut-1"))?.error ?? "", "restarted");
        assert.isFalse(fs.existsSync(cutStaging));
        assert.isTrue(fs.existsSync(path.join(repos.root, "copies", "keep.txt")));
        assert.equal(rows.get(ProjectSetupId.make("placed-1"))?.stage, "done");
        assert.isFalse(fs.existsSync(placedStaging));
        assert.isTrue(fs.existsSync(path.join(unmarkedStaging, "someone-elses")));
        const created = dispatched.find((command) => command.type === "project.create");
        assert(created?.type === "project.create");
        assert.equal(created.projectId, "project-placed-1");
        assert.equal(created.workspaceRoot, placed);
        assert.isTrue(fs.existsSync(path.join(repos.b, ".git")));
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );

  it("reads git's progress, picks clone URLs and checks the files it is sent", () => {
    assert.deepEqual(
      parseCloneProgress(
        "Cloning into 'app'...\nremote: Counting objects: 100% (5/5), done.\rReceiving objects:  24% (1200/5000), 168.80 MiB | 20.69 MiB/s\r",
      ),
      { phase: "Receiving objects", percent: 24, detail: "168.80 MiB | 20.69 MiB/s" },
    );
    assert.isNull(parseCloneProgress("Cloning into 'app'...\n"));
    const request = {
      remotes: [{ name: "origin", url: "git@github.com:org/app.git", protocol: "ssh" as const }],
      primaryRemoteName: "origin",
    };
    assert.deepEqual(cloneUrls({ ...request, protocol: "ssh" } as never), [
      "git@github.com:org/app.git",
      "https://github.com/org/app.git",
    ]);
    assert.deepEqual(cloneUrls({ ...request, protocol: "https" } as never), [
      "https://github.com/org/app.git",
      "git@github.com:org/app.git",
    ]);
    const file = (path: string, contentBase64 = "eA==") => ({
      path,
      contentBase64,
      mode: 0o644 as const,
    });
    assert.isNull(filesRefusal([file(".env"), file("apps/web/.env")]));
    assert.isNotNull(filesRefusal([file(".git/hooks/pre-commit")]));
    assert.isNotNull(filesRefusal([file("../.env")]));
    assert.isNotNull(filesRefusal([file(".env"), file(".ENV")]));
    assert.isNotNull(filesRefusal([file(".env", "not base64!")]));
    assert.isNotNull(filesRefusal([file("big", Buffer.alloc(1024 * 1024 + 1).toString("base64"))]));
  });
});
