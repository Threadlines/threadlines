import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type PeerMoveManifest,
} from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { inspectMoveCheckout, movePayloadPath, writeMoveExport } from "../moves/moveExport.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { LinkMoveRepositoryLive } from "./LinkMoveRepository.ts";
import { LinkMoves, LinkMovesLive, moveManifestRefusal, movePathRefusal } from "./LinkMoves.ts";
import { LinkRequests, type PeerLink } from "./LinkRequests.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * An origin, the computer a thread leaves (`a`, on a branch with a commit the
 * origin doesn't have and every kind of change), and the one it moves to
 * (`b`, a plain clone).
 */
function makeRepos() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "link-moves-")));
  const origin = path.join(root, "origin.git");
  run(root, "init", "--bare", "--initial-branch=main", origin);
  const seed = path.join(root, "seed");
  run(root, "clone", origin, seed);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    fs.writeFileSync(path.join(seed, name), `${name} as pushed\n`);
  }
  run(seed, "add", ".");
  run(seed, "commit", "-m", "pushed");
  run(seed, "push", "origin", "HEAD:main");
  const a = path.join(root, "a");
  run(root, "clone", origin, a);
  run(a, "checkout", "-b", "feature/move-me");
  fs.writeFileSync(path.join(a, "a.txt"), "a.txt from an unpushed commit\n");
  run(a, "commit", "-am", "unpushed");
  fs.writeFileSync(path.join(a, "b.txt"), "b.txt staged\n");
  run(a, "add", "b.txt");
  fs.writeFileSync(path.join(a, "c.txt"), "c.txt unstaged\n");
  fs.rmSync(path.join(a, "d.txt"));
  fs.mkdirSync(path.join(a, "notes"));
  fs.writeFileSync(path.join(a, "notes", "new.txt"), "a new note\n");
  fs.writeFileSync(path.join(a, "tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.writeFileSync(path.join(a, "image.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 9]));
  const b = path.join(root, "b");
  run(root, "clone", origin, b);
  return { root, origin, a, b };
}

const TRANSFER = ThreadMoveId.make("transfer-1");
const agent = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

const movingThread = (): OrchestrationThread =>
  ({
    id: ThreadId.make("thread-a"),
    title: "Move me",
    runtimeMode: "full-access",
    interactionMode: "default",
    messages: [
      {
        id: MessageId.make("m1"),
        role: "user",
        text: "Make it faster",
        turnId: null,
        streaming: false,
        createdAt: "2026-10-22T10:00:00.000Z",
        updatedAt: "2026-10-22T10:00:00.000Z",
      },
      {
        id: MessageId.make("m2"),
        role: "assistant",
        text: "Done: it caches now.",
        turnId: "turn-1",
        agentModels: {
          primary: {
            modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: "fake-model" },
            nameIndex: 1,
          },
        },
        streaming: false,
        createdAt: "2026-10-22T10:01:00.000Z",
        updatedAt: "2026-10-22T10:01:00.000Z",
      },
    ],
    activities: [],
  }) as unknown as OrchestrationThread;

/** The services LinkMoves leans on, with this computer's git real and the rest faked. */
function testLayer(repos: ReturnType<typeof makeRepos>, dispatched: OrchestrationCommand[]) {
  const imported = (threadId: string) =>
    dispatched.some((command) => command.type === "thread.import" && command.threadId === threadId);
  return LinkMovesLive.pipe(
    Layer.provideMerge(LinkMoveRepositoryLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(LinkRequests)({
          authority: () =>
            Effect.succeed({
              ok: true,
              maxRuntimeMode: "auto-accept-edits",
              pinnedEnvironmentId: null,
            }),
          projectForKey: () =>
            Effect.succeed({
              id: ProjectId.make("project-b"),
              title: "Threadlines",
              workspaceRoot: repos.b,
            } as never),
          resolveAgentFor: (input) =>
            Effect.succeed({
              selection: { instanceId: input.agent.instanceId, model: input.agent.model ?? "m" },
            } as never),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Effect.succeed(imported(threadId) ? Option.some({} as never) : Option.none()),
          getCommandReadModel: () => Effect.succeed({ threads: [], projects: [] } as never),
        }),
        Layer.mock(RelayDeviceRepository)({ getDevice: () => Effect.succeed(Option.none()) }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "example.com/repo",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: repos.origin },
            }),
        }),
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed({ label: "Mac mini" } as never),
        }),
      ),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "link-moves-test-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const link = (access: PeerLink["access"]): PeerLink => ({
  deviceId: "device-windows",
  label: "Windows PC",
  environmentId: null,
  environmentPinned: false,
  access,
  maxRuntimeMode: "auto-accept-edits",
});

/** Packs `repos.a`'s thread the way the computer it leaves does. */
const pack = (repos: ReturnType<typeof makeRepos>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const checkout = yield* inspectMoveCheckout(git, repos.a, "origin");
    const dir = path.join(repos.root, "export");
    const manifest = yield* writeMoveExport({
      git,
      checkout,
      transferId: TRANSFER,
      dir,
      attachmentsDir: path.join(repos.root, "attachments"),
      thread: movingThread(),
      projectTitle: "Threadlines",
      canonicalKey: "example.com/repo",
      source: {
        environmentId: EnvironmentId.make("environment-windows"),
        environmentLabel: "Windows PC",
        threadId: ThreadId.make("thread-a"),
      },
      agent,
    });
    return { manifest, payload: fs.readFileSync(movePayloadPath(dir)), checkout };
  });

describe("LinkMoves", () => {
  it.live("rebuilds the moved checkout in a worktree of its own and imports the thread", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload, checkout } = yield* pack(repos);
      assert.equal(manifest.summary.unpushedCommits, 1);
      const moves = yield* LinkMoves;
      let state = yield* moves.prepare(link("allowed"), { transferId: TRANSFER, manifest });
      assert.equal(state.status, "receiving");
      for (let offset = 0; offset < payload.length; offset += 7) {
        state = yield* moves.chunk(link("allowed"), {
          transferId: TRANSFER,
          offset,
          data: payload.subarray(offset, offset + 7).toString("base64"),
        });
      }
      // A resent chunk changes nothing.
      state = yield* moves.chunk(link("allowed"), {
        transferId: TRANSFER,
        offset: 0,
        data: payload.subarray(0, 7).toString("base64"),
      });
      assert.equal(state.bytesReceived, payload.length);
      state = yield* moves.finish(link("allowed"), { transferId: TRANSFER });
      for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
        yield* Effect.sleep("50 millis");
        state = yield* moves.status(link("allowed"), { transferId: TRANSFER });
      }
      assert.equal(state.status, "committed", state.reason);

      const command = dispatched.find((entry) => entry.type === "thread.import");
      assert(command?.type === "thread.import");
      assert.equal(command.runtimeMode, "auto-accept-edits");
      assert.equal(command.branch, "feature/move-me");
      assert.deepEqual(
        command.messages.map((message) => message.text),
        ["Make it faster", "Done: it caches now."],
      );
      assert.notEqual(command.messages[0]?.messageId, "m1");
      // Its answer keeps the agent that wrote it, not the one it moves on with.
      assert.equal(command.messages[1]?.agentModels?.primary?.modelSelection.model, "fake-model");
      const worktree = command.worktreePath!;
      assert.equal(run(worktree, "rev-parse", "HEAD"), checkout.headSha);
      const read = (name: string) => fs.readFileSync(path.join(worktree, name), "utf8");
      assert.equal(read("a.txt"), "a.txt from an unpushed commit\n");
      assert.equal(read("b.txt"), "b.txt staged\n");
      assert.equal(read("c.txt"), "c.txt unstaged\n");
      assert.isFalse(fs.existsSync(path.join(worktree, "d.txt")));
      assert.equal(read("notes/new.txt"), "a new note\n");
      assert.deepEqual(
        [...fs.readFileSync(path.join(worktree, "image.bin"))],
        [0, 1, 2, 255, 254, 0, 9],
      );
      if (process.platform !== "win32") {
        assert.notEqual(fs.statSync(path.join(worktree, "tool.sh")).mode & 0o111, 0);
      }
      // Dropping it now changes nothing: it landed.
      assert.equal(
        (yield* moves.abort(link("allowed"), { transferId: TRANSFER })).status,
        "committed",
      );
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });

  it.live("asks first, and a no leaves nothing behind", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest } = yield* pack(repos);
      const moves = yield* LinkMoves;
      const state = yield* moves.prepare(link("ask"), { transferId: TRANSFER, manifest });
      assert.equal(state.status, "awaiting_approval");
      const pending = yield* moves.pending;
      assert.equal(pending[0]?.kind, "move");
      assert.equal(pending[0]?.move?.unpushedCommits, 1);
      // Bytes don't arrive before the user says yes.
      const early = yield* moves.chunk(link("ask"), {
        transferId: TRANSFER,
        offset: 0,
        data: Buffer.from("x").toString("base64"),
      });
      assert.equal(early.bytesReceived, 0);
      assert.isTrue(
        yield* moves.respond({
          deviceId: "device-windows",
          requestId: TRANSFER as never,
          allow: false,
        }),
      );
      const after = yield* moves.status(link("ask"), { transferId: TRANSFER });
      assert.equal(after.status, "aborted");
      assert.equal((yield* moves.pending).length, 0);
      assert.equal(dispatched.length, 0);
      assert.equal(run(repos.b, "worktree", "list").split("\n").length, 1);
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });
});

describe("LinkMoves, a clean thread", () => {
  it.live("moves a thread with nothing unpushed and no changes, carrying no bytes", () => {
    const repos = makeRepos();
    // `a` as pushed, nothing changed: the move carries only its history.
    run(repos.a, "reset", "--hard", "origin/main");
    run(repos.a, "clean", "-fdx");
    run(repos.a, "checkout", "main");
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, checkout } = yield* pack(repos);
      assert.equal(manifest.totalBytes, 0);
      assert.isNull(manifest.git.baseSha);
      const moves = yield* LinkMoves;
      let state = yield* moves.prepare(link("allowed"), { transferId: TRANSFER, manifest });
      assert.equal(state.status, "receiving");
      state = yield* moves.finish(link("allowed"), { transferId: TRANSFER });
      for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
        yield* Effect.sleep("50 millis");
        state = yield* moves.status(link("allowed"), { transferId: TRANSFER });
      }
      assert.equal(state.status, "committed", state.reason);
      const command = dispatched.find((entry) => entry.type === "thread.import");
      assert(command?.type === "thread.import");
      // `main` is checked out in b already, so the move takes another name.
      assert.equal(command.branch, "main-from-windows-pc");
      assert.equal(run(command.worktreePath!, "rev-parse", "HEAD"), checkout.headSha);
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });
});

describe("what a move may write here", () => {
  it("refuses paths that leave the worktree or touch git, and a manifest that doesn't add up", () => {
    for (const bad of [
      "../escape.txt",
      "/etc/passwd",
      "C:/x",
      "a/./b",
      ".git/hooks/post-checkout",
      "a//b",
      "x:y",
    ]) {
      assert.isNotNull(movePathRefusal(bad), bad);
    }
    assert.isNull(movePathRefusal("notes/new.txt"));
    const manifest = {
      totalBytes: 10,
      sha256: "x",
      parts: [{ kind: "file", offset: 0, length: 10, sha256: "y", path: "../out", mode: "file" }],
      git: { headSha: "h", branch: null, baseSha: null },
    } as unknown as PeerMoveManifest;
    assert.include(moveManifestRefusal(manifest), "../out");
    assert.include(
      moveManifestRefusal({
        ...manifest,
        parts: [{ ...manifest.parts[0]!, path: "fine.txt", length: 4 }],
      }),
      "add up",
    );
  });
});
