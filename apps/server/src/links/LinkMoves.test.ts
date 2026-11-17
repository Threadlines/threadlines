import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  ThreadParticipantId,
  TurnId,
  GENERAL_CHATS_PROJECT_ID,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type PeerMoveManifest,
  type PeerMoveThreadState,
} from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  estimateMoveOtherBytes,
  inspectMoveCheckout,
  type MoveExportInput,
  movePayloadPath,
  writeMoveExport,
  writeScratchExport,
} from "../moves/moveExport.ts";
import { participantSessionKey } from "@threadlines/shared/threadParticipants";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import {
  exportClaudeNativeSession,
  importClaudeNativeSession,
} from "../provider/Drivers/ClaudeNativeSession.ts";
import type { NativeSessionExport } from "../provider/nativeSession.ts";
import type { ProviderAdapterCapabilities } from "../provider/Services/ProviderAdapter.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { LinkMoveRepositoryLive } from "./LinkMoveRepository.ts";
import {
  binaryPatchBytes,
  linkMoveKey,
  linkMoveThreadId,
  LinkMoves,
  LinkMovesLive,
  MAX_STAGED_MOVES_PER_LINK,
  moveManifestRefusal,
  movePathRefusal,
} from "./LinkMoves.ts";
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
  // Git for Windows turns on core.autocrlf for the whole computer by default,
  // and then every checkout, the moved one included, has CRLF line endings
  // where these tests read LF. Each clone turns it off before it checks out.
  const clone = (target: string) => run(root, "clone", "-c", "core.autocrlf=false", origin, target);
  const seed = path.join(root, "seed");
  clone(seed);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    fs.writeFileSync(path.join(seed, name), `${name} as pushed\n`);
  }
  run(seed, "add", ".");
  run(seed, "commit", "-m", "pushed");
  run(seed, "push", "origin", "HEAD:main");
  const a = path.join(root, "a");
  clone(a);
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
  clone(b);
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
        sentFrom: { kind: "phone", name: "iPhone", os: "iOS" },
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

/** Where carried sessions land here, and the bindings written for them. */
interface CarryRecord {
  readonly home: string;
  readonly adopted: Array<Parameters<ProviderServiceShape["adoptNativeSession"]>[0]>;
  /** Bindings taken back for threads that never landed. */
  readonly forgotten?: Array<ThreadId>;
  /** The engine fails to create the moved thread. */
  readonly failImport?: boolean;
  /** What the agent here keeps of a moved thread (docs/design/fleet.md, Part 3e). */
  readonly capabilities?: Partial<ProviderAdapterCapabilities>;
  /** This computer's General Chats folder, for a general chat that moves here. */
  readonly generalChatsRoot?: string;
  /** The moved thread as it reads here once it landed (its queue, its session). */
  readonly shell?: () => OrchestrationThreadShell | undefined;
}

/** The services LinkMoves leans on, with this computer's git real and the rest faked. */
function testLayer(
  repos: ReturnType<typeof makeRepos>,
  dispatched: OrchestrationCommand[],
  access: "allowed" | "ask" = "allowed",
  revoked: () => boolean = () => false,
  setupRuns: string[] = [],
  carry: CarryRecord = { home: os.tmpdir(), adopted: [] },
) {
  return LinkMovesLive.pipe(
    Layer.provideMerge(LinkMoveRepositoryLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(LinkRequests)({
          authority: () =>
            Effect.succeed(
              revoked()
                ? {
                    ok: false,
                    outcome: "denied",
                    text: "Mac mini doesn't take work from Windows PC.",
                  }
                : {
                    ok: true,
                    access,
                    maxRuntimeMode: "auto-accept-edits",
                    pinnedEnvironmentId: null,
                  },
            ),
          projectForKey: () =>
            Effect.succeed({
              id: ProjectId.make("project-b"),
              title: "Threadlines",
              workspaceRoot: repos.b,
            } as never),
          // An instance this computer doesn't have ("gone") is refused.
          resolveAgentFor: (input) =>
            Effect.succeed(
              (input.agent.instanceId === "gone"
                ? { refused: "Mac mini has no such agent." }
                : {
                    selection: {
                      instanceId: input.agent.instanceId,
                      model: input.agent.model ?? "m",
                    },
                  }) as never,
            ),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            carry.failImport === true && command.type === "thread.import"
              ? Effect.die(new Error("the engine is down"))
              : Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: dispatched.length };
                }),
          getCommandReceipt: (commandId) =>
            Effect.succeed(
              dispatched.some((command) => command.commandId === commandId)
                ? Option.some({ status: "accepted" } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed({ threads: [], projects: [] } as never),
          getProjectCatalog: () =>
            Effect.succeed({
              projects:
                carry.generalChatsRoot === undefined
                  ? []
                  : [
                      {
                        id: GENERAL_CHATS_PROJECT_ID,
                        kind: "general-chat",
                        title: "General Chats",
                        workspaceRoot: carry.generalChatsRoot,
                        deletedAt: null,
                      },
                    ],
            } as never),
          getThreadShellById: () => Effect.succeed(Option.fromUndefinedOr(carry.shell?.())),
        }),
        Layer.mock(ProjectionThreadRepository)({ getById: () => Effect.succeed(Option.none()) }),
        Layer.mock(RelayDeviceRepository)({ getDevice: () => Effect.succeed(Option.none()) }),
        // Every agent here is a Claude whose home is `carry.home`.
        Layer.mock(ProviderService)({
          getInstanceInfo: () =>
            Effect.succeed({ driverKind: ProviderDriverKind.make("claudeAgent") } as never),
          importNativeSession: ({ instanceId: _instanceId, ...input }) =>
            importClaudeNativeSession({ ...input, configDir: carry.home }),
          adoptNativeSession: (input) => Effect.sync(() => void carry.adopted.push(input)),
          getCapabilities: () =>
            Effect.succeed({
              sessionModelSwitch: "in-session",
              threadGoals: "supported",
              ...carry.capabilities,
            } as ProviderAdapterCapabilities),
          forgetNativeSession: (threadId) =>
            Effect.sync(() => void carry.forgotten?.push(threadId)),
        }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "example.com/repo",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: repos.origin },
            }),
        }),
        ServerEnvironment.layerTest({ label: "Mac mini" }),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.sync(() => {
              setupRuns.push(input.worktreePath);
              return { status: "no-script" } as const;
            }),
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
const pack = (
  repos: ReturnType<typeof makeRepos>,
  nativeSession?: NativeSessionExport | null,
  state?: PeerMoveThreadState,
  room?: Pick<MoveExportInput, "room" | "outsideWork"> & {
    readonly thread?: OrchestrationThread;
  },
) =>
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
      thread: room?.thread ?? movingThread(),
      room: room?.room,
      outsideWork: room?.outsideWork,
      projectTitle: "Threadlines",
      subdirectory: "",
      canonicalKey: "example.com/repo",
      source: {
        environmentId: EnvironmentId.make("environment-windows"),
        environmentLabel: "Windows PC",
        threadId: ThreadId.make("thread-a"),
      },
      agent,
      nativeSession,
      state,
    });
    return { manifest, payload: fs.readFileSync(movePayloadPath(dir)), checkout };
  });

/** Offers, sends and finishes a packed move, then waits for its import to settle. */
const deliver = (manifest: PeerMoveManifest, payload: Buffer) =>
  Effect.gen(function* () {
    const moves = yield* LinkMoves;
    yield* moves.prepare(link("allowed"), { transferId: TRANSFER, manifest });
    for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
      yield* moves.chunk(link("allowed"), {
        transferId: TRANSFER,
        offset,
        data: payload.subarray(offset, offset + 64 * 1024).toString("base64"),
      });
    }
    let state = yield* moves.finish(link("allowed"), { transferId: TRANSFER });
    for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
      yield* Effect.sleep("50 millis");
      state = yield* moves.status(link("allowed"), { transferId: TRANSFER });
    }
    return state;
  });

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** A Claude home on the computer a thread leaves, with the thread's session in it. */
function claudeHomeWithSession(root: string) {
  const home = path.join(root, "claude-a");
  const write = (relPath: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(home, relPath)), { recursive: true });
    fs.writeFileSync(path.join(home, relPath), text);
  };
  write(`projects/-a-repo/${SESSION}.jsonl`, '{"type":"user","message":"Make it faster"}\n');
  write(`projects/-a-repo/${SESSION}/subagents/agent-s1.jsonl`, '{"type":"assistant"}\n');
  write(".credentials.json", '{"claudeAiOauth":"secret"}');
  return home;
}

/** Every file under `root`, `/`-separated, sorted; none when it doesn't exist. */
const filesUnder = (root: string): string[] =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
        )
        .toSorted()
    : [];

describe("LinkMoves", () => {
  it.live("rebuilds the moved checkout in a worktree of its own and imports the thread", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const setupRuns: string[] = [];
    let linkOff = false;
    return Effect.gen(function* () {
      const { manifest, payload, checkout } = yield* pack(repos);
      assert.equal(manifest.summary.unpushedCommits, 1);
      // The dialog's guess at the same move comes near what was packed.
      const estimate = yield* estimateMoveOtherBytes({
        git: yield* GitVcsDriver.GitVcsDriver,
        checkout,
        thread: movingThread(),
        attachmentsDir: path.join(repos.root, "attachments"),
      });
      assert.isAbove(estimate, manifest.totalBytes / 2);
      assert.isBelow(estimate, manifest.totalBytes * 1.5);
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
      // Its answer keeps the agent that wrote it, not the one it moves on with,
      // and its question the device it was sent from.
      assert.equal(command.messages[1]?.agentModels?.primary?.modelSelection.model, "fake-model");
      assert.deepEqual(command.messages[0]?.sentFrom, { kind: "phone", name: "iPhone", os: "iOS" });
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
      // Its worktree gets the project's setup, like a new worktree thread here.
      assert.deepEqual(setupRuns, [worktree]);
      // Dropping it now changes nothing: it landed.
      assert.equal(
        (yield* moves.abort(link("allowed"), { transferId: TRANSFER })).status,
        "committed",
      );

      // Its last write lost, the row still says importing; a stop that comes
      // now (the link went off, a finish resent) finds the import landed.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE link_moves SET status = 'importing'`;
      linkOff = true;
      state = yield* moves.finish(link("allowed"), { transferId: TRANSFER });
      for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
        yield* Effect.sleep("50 millis");
        state = yield* moves.status(link("allowed"), { transferId: TRANSFER });
      }
      assert.equal(state.status, "committed");
      assert.equal(run(worktree, "rev-parse", "HEAD"), checkout.headSha);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => linkOff, setupRuns)));
  });

  it.live(
    "carries the agent's session into the chosen agent's own home and binds the thread",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      const carry: CarryRecord = { home: path.join(repos.root, "claude-b"), adopted: [] };
      return Effect.gen(function* () {
        const session = yield* exportClaudeNativeSession({
          configDir: claudeHomeWithSession(repos.root),
          resumeCursor: { resume: SESSION, turnCount: 1 },
        });
        const { manifest, payload } = yield* pack(repos, session);
        assert.deepEqual(manifest.session, {
          driver: "claudeAgent",
          cursor: { resume: SESSION, turnCount: 1 },
        });
        assert.equal(manifest.parts.filter((part) => part.kind === "session").length, 2);
        assert.equal((yield* deliver(manifest, payload)).status, "committed");

        const command = dispatched.find((entry) => entry.type === "thread.import");
        assert(command?.type === "thread.import");
        assert.equal(command.nativeSession, "carried");
        // Under the new checkout's project in this computer's own home, and nothing else.
        const slug = command.worktreePath!.replace(/[^a-zA-Z0-9]/g, "-");
        assert.deepEqual(filesUnder(carry.home), [
          `projects/${slug}/${SESSION}.jsonl`,
          `projects/${slug}/${SESSION}/subagents/agent-s1.jsonl`,
        ]);
        // The binding is written in the same step, for the thread the move becomes.
        assert.deepEqual(carry.adopted, [
          {
            threadId: command.threadId,
            instanceId: agent.instanceId,
            cursor: { resume: SESSION, turnCount: 1 },
            runtimeMode: "auto-accept-edits",
          },
        ]);
      }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, [], carry)));
    },
  );

  it.live("a session naming a credential writes nothing, and the thread gets a summary", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const carry: CarryRecord = { home: path.join(repos.root, "claude-b"), adopted: [] };
    return Effect.gen(function* () {
      const home = claudeHomeWithSession(repos.root);
      const exported = yield* exportClaudeNativeSession({
        configDir: home,
        resumeCursor: { resume: SESSION },
      });
      // A sender that also names the sign-in, as a path in its home.
      const session: NativeSessionExport = {
        ...exported!,
        files: [
          ...exported!.files,
          {
            relPath: ".credentials.json",
            absolutePath: path.join(home, ".credentials.json"),
            size: fs.statSync(path.join(home, ".credentials.json")).size,
          },
        ],
      };
      const { manifest, payload } = yield* pack(repos, session);
      assert.equal((yield* deliver(manifest, payload)).status, "committed");
      const command = dispatched.find((entry) => entry.type === "thread.import");
      assert(command?.type === "thread.import");
      assert.equal(command.nativeSession, undefined);
      assert.deepEqual(filesUnder(carry.home), []);
      assert.deepEqual(carry.adopted, []);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, [], carry)));
  });

  it.live("a session file that can't be read leaves the session behind, not the move", () => {
    const repos = makeRepos();
    const dispatched: Array<OrchestrationCommand> = [];
    const carry: CarryRecord = { home: path.join(repos.root, "claude-b"), adopted: [] };
    return Effect.gen(function* () {
      const home = claudeHomeWithSession(repos.root);
      const exported = yield* exportClaudeNativeSession({
        configDir: home,
        resumeCursor: { resume: SESSION },
      });
      // Found when the move was sized, gone by the time it is packed.
      const session: NativeSessionExport = {
        ...exported!,
        files: exported!.files.map((file) => ({
          ...file,
          absolutePath: path.join(home, "gone", path.basename(file.absolutePath)),
        })),
      };
      const { manifest, payload } = yield* pack(repos, session);
      assert.equal(manifest.session, undefined);
      assert.equal((yield* deliver(manifest, payload)).status, "committed");
      const command = dispatched.find((entry) => entry.type === "thread.import");
      assert(command?.type === "thread.import");
      assert.equal(command.nativeSession, undefined);
      assert.deepEqual(filesUnder(carry.home), []);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, [], carry)));
  });

  it.live("a move that carried a session but didn't land takes back its files and binding", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const carry: CarryRecord = {
      home: path.join(repos.root, "claude-b"),
      adopted: [],
      forgotten: [],
      failImport: true,
    };
    // Someone else's file in the same home stays.
    fs.mkdirSync(path.join(carry.home, "projects"), { recursive: true });
    fs.writeFileSync(path.join(carry.home, "projects", "keep.jsonl"), "not the move's\n");
    return Effect.gen(function* () {
      const session = yield* exportClaudeNativeSession({
        configDir: claudeHomeWithSession(repos.root),
        resumeCursor: { resume: SESSION },
      });
      const { manifest, payload } = yield* pack(repos, session);
      assert.equal((yield* deliver(manifest, payload)).status, "aborted");
      // The abort is recorded first and the clean-up follows it: the session
      // goes a moment after the move reads aborted (its files, then its binding).
      for (let tries = 0; tries < 200 && (carry.forgotten?.length ?? 0) === 0; tries += 1) {
        yield* Effect.sleep("50 millis");
      }
      assert.equal(carry.adopted.length, 1);
      assert.deepEqual(carry.forgotten, [carry.adopted[0]!.threadId]);
      assert.deepEqual(filesUnder(carry.home), ["projects/keep.jsonl"]);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, [], carry)));
  });

  it.live(
    "a move dropped after its worktree was made takes away the branch it made, and only that",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      // Someone on this computer has a branch at the moved commit's name: not ours.
      const hasMovedBranch = () =>
        run(repos.b, "branch", "--list", "feature/move-me-from-windows-pc").length > 0;
      return Effect.gen(function* () {
        const { manifest, payload } = yield* pack(repos);
        run(repos.b, "fetch", "--quiet", "origin");
        const moves = yield* LinkMoves;
        let state = yield* moves.prepare(link("allowed"), { transferId: TRANSFER, manifest });
        state = yield* moves.chunk(link("allowed"), {
          transferId: TRANSFER,
          offset: 0,
          data: payload.toString("base64"),
        });
        // `feature/move-me` exists here already (someone else's), so the move
        // makes `feature/move-me-from-windows-pc`; the link goes off right after.
        run(repos.b, "branch", "feature/move-me", "origin/main");
        state = yield* moves.finish(link("allowed"), { transferId: TRANSFER });
        for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
          yield* Effect.sleep("50 millis");
          state = yield* moves.status(link("allowed"), { transferId: TRANSFER });
        }
        assert.equal(state.status, "aborted");
        assert.include(state.reason ?? "", "doesn't take work");
        assert.equal(dispatched.length, 0);
        // Its branch and worktree go (clean-up follows the recorded abort);
        // the other branch stays.
        for (let tries = 0; tries < 200 && hasMovedBranch(); tries += 1) {
          yield* Effect.sleep("50 millis");
        }
        assert.isFalse(hasMovedBranch());
        assert.include(run(repos.b, "branch", "--list", "feature/move-me"), "feature/move-me");
        assert.equal(run(repos.b, "worktree", "list").split("\n").length, 1);
      }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", hasMovedBranch)));
    },
  );

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
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });
});

describe("LinkMoves, receive before allow", () => {
  /** Sends every byte the way the computer the thread leaves does. */
  const sendAll = (transferId: ThreadMoveId, payload: Buffer, linkAccess: "ask" | "allowed") =>
    Effect.gen(function* () {
      const moves = yield* LinkMoves;
      let state = yield* moves.status(link(linkAccess), { transferId });
      for (let offset = 0; offset < payload.length && state.status === "receiving";) {
        state = yield* moves.chunk(link(linkAccess), {
          transferId,
          offset,
          data: payload.subarray(offset, offset + 64).toString("base64"),
        });
        offset = state.bytesReceived;
      }
      return state;
    });
  const awaitSettled = (transferId: ThreadMoveId) =>
    Effect.gen(function* () {
      const moves = yield* LinkMoves;
      let state = yield* moves.status(link("ask"), { transferId });
      for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
        yield* Effect.sleep("50 millis");
        state = yield* moves.status(link("ask"), { transferId });
      }
      return state;
    });
  const stagingOf = (transferId: ThreadMoveId) =>
    Effect.map(ServerConfig, (config) =>
      path.join(config.stateDir, "link-moves", linkMoveKey("device-windows", transferId)),
    );

  it.live("under Ask first takes every byte, and Allow sets it up with nobody sending", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      const moves = yield* LinkMoves;
      const offered = yield* moves.prepare(link("ask"), {
        transferId: TRANSFER,
        manifest,
        stagedApproval: true,
      });
      // The bytes flow while its user hasn't answered.
      assert.equal(offered.status, "receiving");
      assert.equal((yield* moves.pending)[0]?.move?.bytesReceived, 0);
      const sent = yield* sendAll(TRANSFER, payload, "ask");
      assert.equal(sent.status, "staged_awaiting_approval");
      assert.equal(sent.bytesReceived, payload.length);
      assert.equal((yield* moves.pending)[0]?.move?.bytesReceived, payload.length);
      // Every byte is here; only Allow sets it up, not a finish.
      assert.equal(
        (yield* moves.finish(link("ask"), { transferId: TRANSFER })).status,
        "staged_awaiting_approval",
      );
      assert.equal(dispatched.length, 0);

      assert.isTrue(
        yield* moves.respond({
          deviceId: "device-windows",
          requestId: TRANSFER as never,
          allow: true,
        }),
      );
      const settled = yield* awaitSettled(TRANSFER);
      assert.equal(settled.status, "committed", settled.reason);
      assert.equal(dispatched.filter((entry) => entry.type === "thread.import").length, 1);
      assert.equal((yield* moves.pending).length, 0);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });

  it.live("an Allow given while the bytes still come imports once the last one arrives", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      const moves = yield* LinkMoves;
      yield* moves.prepare(link("ask"), { transferId: TRANSFER, manifest, stagedApproval: true });
      // Part of it is here when its user allows it.
      yield* moves.chunk(link("ask"), {
        transferId: TRANSFER,
        offset: 0,
        data: payload.subarray(0, 64).toString("base64"),
      });
      assert.isTrue(
        yield* moves.respond({
          deviceId: "device-windows",
          requestId: TRANSFER as never,
          allow: true,
        }),
      );
      // The rest arrives; the asking computer hears `importing` and sends no
      // finish. No sweep runs here (no reactor): the last chunk starts it.
      const sent = yield* sendAll(TRANSFER, payload, "ask");
      assert.equal(sent.status, "importing");
      const settled = yield* awaitSettled(TRANSFER);
      assert.equal(settled.status, "committed", settled.reason);
      assert.equal(dispatched.filter((entry) => entry.type === "thread.import").length, 1);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });

  it.live("Don't allow and the day's expiry each delete what was staged", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const EXPIRES = ThreadMoveId.make("transfer-expires");
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      const moves = yield* LinkMoves;
      for (const transferId of [TRANSFER, EXPIRES]) {
        yield* moves.prepare(link("ask"), { transferId, manifest, stagedApproval: true });
        assert.equal(
          (yield* sendAll(transferId, payload, "ask")).status,
          "staged_awaiting_approval",
        );
        assert.isTrue(fs.existsSync(yield* stagingOf(transferId)));
      }
      const answered = yield* moves.respondMany({
        deviceId: "device-windows",
        requestIds: [TRANSFER as never, "transfer-unknown" as never],
        allow: false,
      });
      assert.deepEqual(answered.answered as ReadonlyArray<string>, [TRANSFER]);
      assert.equal(answered.failed.length, 1);
      const denied = yield* moves.status(link("ask"), { transferId: TRANSFER });
      assert.equal(denied.status, "aborted");
      assert.include(denied.reason ?? "", "didn't allow");
      // The computer it came from reads why as a code too.
      assert.equal(denied.abortCode, "denied");
      assert.isFalse(fs.existsSync(yield* stagingOf(TRANSFER)));

      // Nobody answered within the day: the sweep drops it and its bytes.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE link_moves SET updated_at = '2000-01-01T00:00:00.000Z' WHERE transfer_id = ${EXPIRES}`;
      const expiredStaging = yield* stagingOf(EXPIRES);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* moves.startReactor();
          // Until its bytes are gone too, which follows the recorded abort:
          // closing this scope stops the sweep, mid clean-up or not.
          for (
            let tries = 0;
            tries < 200 &&
            ((yield* moves.status(link("ask"), { transferId: EXPIRES })).status !== "aborted" ||
              fs.existsSync(expiredStaging));
            tries += 1
          ) {
            yield* Effect.sleep("20 millis");
          }
        }),
      );
      const expired = yield* moves.status(link("ask"), { transferId: EXPIRES });
      assert.equal(expired.status, "aborted");
      assert.include(expired.reason ?? "", "in time");
      assert.equal(expired.abortCode, "expired");
      assert.isFalse(fs.existsSync(expiredStaging));
      assert.equal(dispatched.length, 0);
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });

  it.live("Allow all sets moves up no more at once than the caps, and every one in turn", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const ids = [TRANSFER, ThreadMoveId.make("second"), ThreadMoveId.make("third")];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      const moves = yield* LinkMoves;
      for (const transferId of ids) {
        yield* moves.prepare(link("ask"), { transferId, manifest, stagedApproval: true });
        assert.equal(
          (yield* sendAll(transferId, payload, "ask")).status,
          "staged_awaiting_approval",
        );
      }
      const answered = yield* moves.respondMany({
        deviceId: "device-windows",
        requestIds: ids as never,
        allow: true,
      });
      assert.equal(answered.answered.length, 3);
      const sql = yield* SqlClient.SqlClient;
      let most = 0;
      for (let tries = 0; tries < 400; tries += 1) {
        const rows = yield* sql<{ readonly status: string }>`SELECT status FROM link_moves`;
        most = Math.max(most, rows.filter((row) => row.status === "importing").length);
        if (rows.every((row) => row.status === "committed" || row.status === "aborted")) break;
        yield* Effect.sleep("10 millis");
      }
      // Two from one link at a time; the third waited for a slot, then went.
      assert.isAtMost(most, 2);
      for (const transferId of ids) {
        const state = yield* moves.status(link("ask"), { transferId });
        assert.include(["committed", "aborted"], state.status);
      }
      assert.equal(
        (yield* moves.status(link("ask"), { transferId: TRANSFER })).status,
        "committed",
      );
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });

  it.live("a busy computer says wait, and staged moves have limits of their own", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    const id = (name: string) => ThreadMoveId.make(name);
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      const moves = yield* LinkMoves;
      const offer = (transferId: ThreadMoveId, stagedApproval = true) =>
        moves.prepare(link("ask"), { transferId, manifest, stagedApproval });
      // Two in flight (still arriving) fill this link's slots: a third waits.
      assert.equal((yield* offer(id("first"))).status, "receiving");
      assert.equal((yield* offer(id("second"))).status, "receiving");
      const busy = yield* offer(id("third"));
      assert.equal(busy.status, "aborted");
      assert.equal(busy.refusalCode, "busy");
      // An older asking computer hears it as it always did.
      assert.isUndefined((yield* offer(id("third-old"), false)).refusalCode);
      // Once one has every byte here it waits for Allow outside the slots,
      // and the waiting one is taken.
      yield* sendAll(id("first"), payload, "ask");
      assert.equal((yield* offer(id("third"))).status, "receiving");

      // Held moves have their own limit per link: a move past it is refused for good.
      yield* sendAll(id("second"), payload, "ask");
      yield* sendAll(id("third"), payload, "ask");
      for (let index = 3; index < MAX_STAGED_MOVES_PER_LINK; index += 1) {
        assert.equal((yield* offer(id(`held-${index}`))).status, "receiving");
        assert.equal(
          (yield* sendAll(id(`held-${index}`), payload, "ask")).status,
          "staged_awaiting_approval",
        );
      }
      const full = yield* offer(id("one-too-many"));
      assert.equal(full.status, "aborted");
      assert.equal(full.refusalCode, "staging_full");
      assert.include(full.reason ?? "", "until its user allows them");

      // Allowed while every slot is taken, a held move waits for one with its
      // bytes still in staging: it keeps its place in the budget.
      assert.equal((yield* offer(id("slot-a"), false)).status, "awaiting_approval");
      assert.equal((yield* offer(id("slot-b"), false)).status, "awaiting_approval");
      assert.isTrue(
        yield* moves.respond({
          deviceId: "device-windows",
          requestId: "first" as never,
          allow: true,
        }),
      );
      assert.equal(
        (yield* moves.status(link("ask"), { transferId: id("first") })).status,
        "importing",
      );
      const stillFull = yield* offer(id("after-allow"));
      assert.equal(stillFull.refusalCode, "staging_full");
    }).pipe(Effect.provide(testLayer(repos, dispatched, "ask")));
  });
});

describe("LinkMoves, a clean thread", () => {
  it.live(
    "moves a thread with nothing unpushed and only an empty new file, carrying no bytes",
    () => {
      const repos = makeRepos();
      // `a` as pushed, with one new empty file: the move carries its history
      // and a file of no bytes.
      run(repos.a, "reset", "--hard", "origin/main");
      run(repos.a, "clean", "-fdx");
      run(repos.a, "checkout", "main");
      fs.writeFileSync(path.join(repos.a, "EMPTY"), "");
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
        assert.equal(fs.readFileSync(path.join(command.worktreePath!, "EMPTY"), "utf8"), "");
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );
});

describe("LinkMoves, what a thread had going (Part 3e)", () => {
  const at = "2026-10-22T10:00:00.000Z";
  const carried = (extra?: Partial<PeerMoveThreadState>): PeerMoveThreadState => ({
    goal: {
      objective: "Make the suite pass",
      status: "active",
      tokenBudget: 5_000,
      tokensUsed: 1_200,
      timeUsedSeconds: 60,
      createdAt: at,
      updatedAt: at,
      pickUp: true,
    },
    checkBacks: [
      {
        scheduledFor: "2030-01-01T10:00:00.000Z",
        recurring: false,
        exact: true,
        prompt: "Look at CI on #212",
        durable: false,
      },
    ],
    pullRequests: {
      autoFix: true,
      autoMerge: null,
      linked: [
        { number: 212, url: "https://example.com/repo/pull/212", autoFix: true, autoMerge: null },
      ],
    },
    queuedFollowUps: [
      {
        messageId: MessageId.make("q-1"),
        text: "and then this",
        attachments: [],
        interactionMode: "default",
        createdAt: at,
      },
    ],
    proposedPlans: [
      {
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "1. Fix it",
        implementedAt: null,
        implementationThreadId: ThreadId.make("thread-a"),
        dismissedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    plansLeftBehind: 3,
    ...extra,
  });
  /** The moved thread as it reads here: the queue its import wrote, and no session. */
  const landedShell = (dispatched: OrchestrationCommand[]) => () => {
    const imported = dispatched.find((entry) => entry.type === "thread.import");
    if (imported?.type !== "thread.import") return undefined;
    const head = imported.arrival?.message?.messageId ?? imported.queuedFollowUps?.[0]?.messageId;
    return {
      queuedFollowUps: head === undefined ? [] : [{ messageId: head }],
      session: null,
    } as unknown as OrchestrationThreadShell;
  };
  const importOf = (dispatched: OrchestrationCommand[]) => {
    const command = dispatched.find((entry) => entry.type === "thread.import");
    assert(command?.type === "thread.import");
    return command;
  };
  const sends = (dispatched: OrchestrationCommand[]) =>
    dispatched.filter((entry) => entry.type === "thread.follow-up.send-queued");

  it.live("lands with its goal, pull requests, plans and queue, and sends its arrival once", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos, null, carried());
      const state = yield* deliver(manifest, payload);
      assert.equal(state.status, "committed", state.reason);
      const command = importOf(dispatched);
      // Working, it is picked up here, with its budget as it was.
      assert.deepInclude(command.goal, { status: "active", tokenBudget: 5_000, tokensUsed: 1_200 });
      // The pull request comes along with its switch off: only the user here
      // turns it on, from the offer the thread keeps.
      assert.deepEqual(command.pullRequests, {
        autoFix: false,
        autoMerge: null,
        linked: [
          {
            number: 212,
            url: "https://example.com/repo/pull/212",
            autoFix: false,
            autoMerge: null,
          },
        ],
      });
      assert.deepEqual(command.movedFrom.pullRequestSwitches, {
        autoFix: true,
        autoMerge: null,
        linked: [
          { number: 212, url: "https://example.com/repo/pull/212", autoFix: true, autoMerge: null },
        ],
      });
      // This computer's ids, the plan pointing at the thread it is now.
      assert.notEqual(command.queuedFollowUps?.[0]?.messageId, "q-1");
      assert.equal(command.queuedFollowUps?.[0]?.runtimeMode, "auto-accept-edits");
      assert.notEqual(command.proposedPlans?.[0]?.id, "plan-1");
      assert.equal(command.proposedPlans?.[0]?.implementationThreadId, command.threadId);
      const message = command.arrival?.message?.text ?? "";
      assert.include(message, "This thread moved from Windows PC to Mac mini");
      assert.include(message, "Your goal is still on: Make the suite pass. Carry on with it.");
      // This computer's agent (a Codex) can't set check-backs: told once.
      assert.include(message, "you can't set them here");
      assert.include(message, "Look at CI on #212");
      assert.deepEqual(command.arrival?.brought, [
        "its goal",
        "pull request #212",
        "1 queued message",
        "its plan",
      ]);
      assert.include(command.arrival?.left.join("\n"), "can't set them");
      assert.include(command.arrival?.left.join("\n"), "3 older plans stayed on Windows PC.");
      assert.include(
        command.arrival?.left.join("\n"),
        "Auto-fix was on for this thread's pull request and #212 on Windows PC. It's off here until you turn it on.",
      );
      // One send: the arrival message, by the move's own command id.
      assert.deepEqual(
        sends(dispatched).map((entry) =>
          entry.type === "thread.follow-up.send-queued" ? entry.messageId : null,
        ),
        [command.arrival?.message?.messageId ?? null],
      );

      // A restart before the arrival was recorded sends it then.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE link_moves SET stage = 'applied'`;
      dispatched.splice(0, dispatched.length, command);
      const moves = yield* LinkMoves;
      yield* Effect.scoped(moves.startReactor().pipe(Effect.andThen(Effect.sleep("300 millis"))));
      assert.lengthOf(sends(dispatched), 1);
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          shell: landedShell(dispatched),
        }),
      ),
    );
  });

  it.live(
    "a token budget going to Claude arrives paused, and Claude sets its check-backs again",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const { manifest, payload } = yield* pack(repos, null, carried());
        assert.equal((yield* deliver(manifest, payload)).status, "committed");
        const command = importOf(dispatched);
        assert.deepInclude(command.goal, { status: "paused", tokenBudget: null });
        assert.include(
          command.arrival?.left.join("\n"),
          "Its goal came paused: the agent here can't keep its token budget. Resume runs it without one.",
        );
        const message = command.arrival?.message?.text ?? "";
        assert.notInclude(message, "Your goal is still on");
        assert.include(message, "Run CronList, then set again the ones you still need");
      }).pipe(
        Effect.provide(
          testLayer(repos, dispatched, "allowed", () => false, [], {
            home: os.tmpdir(),
            adopted: [],
            capabilities: { threadGoalBudget: "unsupported", checkBacks: "supported" },
            shell: landedShell(dispatched),
          }),
        ),
      );
    },
  );

  it.live("a goal that finished arrives finished, and nobody is told to carry on with it", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const finished = carried({ checkBacks: [], queuedFollowUps: [] });
      const { manifest, payload } = yield* pack(repos, null, {
        ...finished,
        goal: { ...finished.goal!, status: "complete", pickUp: true },
      });
      assert.equal((yield* deliver(manifest, payload)).status, "committed");
      const command = importOf(dispatched);
      assert.equal(command.goal?.status, "complete");
      assert.isUndefined(command.arrival?.message);
      assert.lengthOf(sends(dispatched), 0);
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          shell: landedShell(dispatched),
        }),
      ),
    );
  });

  it.live("a branch renamed here arrives with its switches off, and says why", () => {
    const repos = makeRepos();
    // This computer already has a branch of that name, elsewhere.
    run(repos.b, "branch", "feature/move-me");
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos, null, carried());
      assert.equal((yield* deliver(manifest, payload)).status, "committed");
      const command = importOf(dispatched);
      assert.equal(command.branch, "feature/move-me-from-windows-pc");
      assert.deepEqual(command.pullRequests, {
        autoFix: false,
        autoMerge: null,
        linked: [
          {
            number: 212,
            url: "https://example.com/repo/pull/212",
            autoFix: false,
            autoMerge: null,
          },
        ],
      });
      assert.include(
        command.arrival?.left.join("\n"),
        "Auto-fix is off here: this computer already has a branch named `feature/move-me`, so pushes from this thread wouldn't reach pull request #212.",
      );
      // Turning it on wouldn't reach the pull request: nothing is offered.
      assert.isUndefined(command.movedFrom.pullRequestSwitches);
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          shell: landedShell(dispatched),
        }),
      ),
    );
  });

  it.live("the branch made here tracks the one it tracked there, when the remote has it", () => {
    const repos = makeRepos();
    run(repos.a, "push", "--quiet", "-u", "origin", "feature/move-me");
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* pack(repos);
      assert(!("workspace" in manifest));
      assert.equal(manifest.git.upstreamBranch, "feature/move-me");
      assert.equal((yield* deliver(manifest, payload)).status, "committed");
      const command = importOf(dispatched);
      assert.equal(
        run(command.worktreePath!, "rev-parse", "--abbrev-ref", "feature/move-me@{upstream}"),
        "origin/feature/move-me",
      );
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });
});

describe("LinkMoves, a General Chats thread", () => {
  /** A general chat's folder on the computer it leaves, with files in it. */
  const chatFolder = (root: string) => {
    const folder = path.join(root, "general-a", "threads", "thread-a");
    fs.mkdirSync(path.join(folder, "data"), { recursive: true });
    fs.writeFileSync(path.join(folder, "notes.md"), "# Ideas\n");
    fs.writeFileSync(path.join(folder, "data", "out.csv"), "a,b\n1,2\n");
    fs.writeFileSync(path.join(folder, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    return folder;
  };
  const packChat = (root: string) =>
    Effect.gen(function* () {
      const dir = path.join(root, "export-chat");
      const manifest = yield* writeScratchExport({
        dir,
        folder: chatFolder(root),
        attachmentsDir: path.join(root, "attachments"),
        thread: movingThread(),
        source: {
          environmentId: EnvironmentId.make("environment-windows"),
          environmentLabel: "Windows PC",
          threadId: ThreadId.make("thread-a"),
        },
        agent,
      });
      return { manifest, payload: fs.readFileSync(movePayloadPath(dir)) };
    });
  const landedFolder = (root: string) =>
    path.join(
      root,
      "general-b",
      "threads",
      linkMoveThreadId(linkMoveKey("device-windows", TRANSFER)),
    );

  it.live("lands in General chats with every file of its folder", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* packChat(repos.root);
      assert.deepEqual(manifest.summary, { messageCount: 2, files: 3 });
      const state = yield* deliver(manifest, payload);
      assert.equal(state.status, "committed", state.reason);
      const command = dispatched.find((entry) => entry.type === "thread.import");
      assert(command?.type === "thread.import");
      assert.equal(command.projectId, GENERAL_CHATS_PROJECT_ID);
      assert.isNull(command.worktreePath);
      assert.isNull(command.branch);
      const folder = landedFolder(repos.root);
      assert.deepEqual(filesUnder(folder), ["data/out.csv", "notes.md", "run.sh"]);
      assert.equal(fs.readFileSync(path.join(folder, "notes.md"), "utf8"), "# Ideas\n");
      if (process.platform !== "win32") {
        assert.notEqual(fs.statSync(path.join(folder, "run.sh")).mode & 0o111, 0);
      }
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          generalChatsRoot: path.join(repos.root, "general-b"),
        }),
      ),
    );
  });

  it.live("a folder already there stops the move, and is left as it was", () => {
    const repos = makeRepos();
    const folder = landedFolder(repos.root);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "theirs.txt"), "not the move's\n");
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* packChat(repos.root);
      const state = yield* deliver(manifest, payload);
      assert.equal(state.status, "aborted");
      assert.include(state.reason, "already has a folder");
      assert.deepEqual(filesUnder(folder), ["theirs.txt"]);
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          generalChatsRoot: path.join(repos.root, "general-b"),
        }),
      ),
    );
  });

  it.live("a move dropped after its files arrived takes its own folder away", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const { manifest, payload } = yield* packChat(repos.root);
      const state = yield* deliver(manifest, payload);
      assert.equal(state.status, "aborted");
      const folder = landedFolder(repos.root);
      for (let tries = 0; tries < 100 && fs.existsSync(folder); tries += 1) {
        yield* Effect.sleep("20 millis");
      }
      assert.isFalse(fs.existsSync(folder));
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          failImport: true,
          generalChatsRoot: path.join(repos.root, "general-b"),
        }),
      ),
    );
  });
});

describe("LinkMoves, a room (Part 3f, (i))", () => {
  const SOL = ThreadParticipantId.make("6f1d7c2a-1b2c-4d3e-8f90-0a1b2c3d4e5f");
  const ADA = ThreadParticipantId.make("7a2e8d3b-2c3d-4e4f-9a01-1b2c3d4e5f60");
  const at = "2026-10-22T10:00:00.000Z";
  /** The moving thread as a room: Sol's reply, and the user's message to it. */
  const roomThread = (): OrchestrationThread => {
    const thread = movingThread();
    return {
      ...thread,
      participants: [],
      messages: [
        ...thread.messages,
        {
          id: MessageId.make("m3"),
          role: "user",
          text: "Sol, review it",
          participantId: SOL,
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
        {
          id: MessageId.make("m4"),
          role: "assistant",
          text: "Looks right.",
          participantId: SOL,
          turnId: "turn-2",
          agentModels: {
            [SOL]: { modelSelection: agent, nameIndex: 1 },
          },
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
    } as unknown as OrchestrationThread;
  };
  const participant = (id: ThreadParticipantId, handle: string, agentThere?: typeof agent) => ({
    id,
    handle,
    joinedAt: at,
    leftAt: null,
    source: { driver: "codex", model: "gpt-6.1-sol" },
    ...(agentThere !== undefined
      ? { agent: agentThere, seenThroughMessageId: MessageId.make("m4") }
      : {}),
  });
  const outsideWork = [
    {
      participantId: SOL,
      connections: [{ connectionId: "connection-1", name: "Chat" }],
      since: at,
      version: 1,
    },
    {
      participantId: ADA,
      connections: [{ connectionId: "connection-1", name: "Chat" }],
      since: at,
      version: 1,
    },
  ] as unknown as MoveExportInput["outsideWork"];

  it.live(
    "lands its agents with fresh ids, each with its own session, fenced; one with no agent here as having left",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      const carry: CarryRecord = { home: path.join(repos.root, "claude-b"), adopted: [] };
      return Effect.gen(function* () {
        const session = yield* exportClaudeNativeSession({
          configDir: claudeHomeWithSession(repos.root),
          resumeCursor: { resume: SESSION, turnCount: 1 },
        });
        const { manifest, payload } = yield* pack(repos, null, undefined, {
          thread: roomThread(),
          room: {
            agentRole: "Builder",
            participants: [participant(SOL, "Sol", agent), participant(ADA, "Ada")],
            sessions: session === null ? [] : [{ participantId: SOL, session }],
          },
          outsideWork,
        });
        // The session's files name their agent; the thread's own agent carries none.
        const sessionParts = manifest.parts.filter((part) => part.kind === "session");
        assert.isAbove(sessionParts.length, 0);
        assert(sessionParts.every((part) => part.participantId === SOL));
        assert.equal(manifest.session, undefined);
        assert.equal(moveManifestRefusal(manifest), null);
        assert.equal((yield* deliver(manifest, payload)).status, "committed");

        const command = dispatched.find((entry) => entry.type === "thread.import");
        assert(command?.type === "thread.import");
        const participants = command.participants ?? [];
        const sol = participants.find((entry) => entry.handle === "Sol");
        const ada = participants.find((entry) => entry.handle === "Ada");
        assert(sol !== undefined && ada !== undefined);
        // Ids of this computer's own, never the sender's.
        assert.notEqual(sol.id, SOL);
        assert.notEqual(ada.id, ADA);
        assert.deepInclude(sol, {
          leftAt: null,
          movedIn: true,
          nativeSession: "carried",
          modelSelection: agent,
        });
        assert.equal(ada.leftAt, command.createdAt);
        assert.equal(ada.movedIn, undefined);
        assert.equal(command.agentRole, "Builder");
        // Sol's session is bound under its own key here, nothing else is.
        assert.deepEqual(
          carry.adopted.map((entry) => entry.threadId),
          [participantSessionKey(command.threadId, sol.id)],
        );
        // Its messages name it by its id here.
        const reply = command.messages.find((message) => message.text === "Looks right.");
        assert.equal(reply?.participantId, sol.id);
        // Its carried session saw up to its own reply: named by its id here.
        assert.equal(sol.movedSeenThrough, reply?.messageId);
        assert.deepEqual(Object.keys(reply?.agentModels ?? {}), [sol.id]);
        // Outside work still limits it here; Ada's mark goes with Ada.
        assert.deepEqual(
          (command.outsideWork ?? []).map((mark) => mark.participantId),
          [sol.id],
        );
        // The "Moved here" line says who came, and who didn't with why.
        assert.include(command.arrival?.brought ?? [], "its agents Sol");
        assert.include(
          command.arrival?.left ?? [],
          "Ada didn't come: this computer has no Codex agent.",
        );
      }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, [], carry)));
    },
  );

  it.live(
    "refuses a room agent this computer doesn't have, and a part naming no agent of the room",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const { manifest } = yield* pack(repos, null, undefined, {
          thread: roomThread(),
          room: {
            participants: [
              participant(SOL, "Sol", {
                instanceId: ProviderInstanceId.make("gone"),
                model: "gpt-6.1-sol",
              }),
            ],
            sessions: [],
          },
        });
        const moves = yield* LinkMoves;
        const state = yield* moves.prepare(link("allowed"), { transferId: TRANSFER, manifest });
        assert.equal(state.status, "aborted");
        assert.include(state.reason ?? "", "Sol: Mac mini has no such agent.");
        assert.equal(
          moveManifestRefusal({
            ...manifest,
            thread: {
              ...manifest.thread,
              messages: [
                ...manifest.thread.messages,
                {
                  messageId: MessageId.make("m-stranger"),
                  role: "user",
                  text: "Hi",
                  turnId: null,
                  participantId: ADA,
                  createdAt: at,
                },
              ],
            },
          }),
          "a message names an agent the room doesn't have",
        );
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );
});

describe("what a move may write here", () => {
  it("measures a binary change by the file it makes, delta or literal", () => {
    const repos = makeRepos();
    // A big file that doesn't compress, changed a little: git sends a small
    // delta, whose stated size is far below the file it makes.
    const big = randomBytes(300_000);
    fs.writeFileSync(path.join(repos.a, "blob.bin"), big);
    run(repos.a, "add", "blob.bin");
    run(repos.a, "commit", "-m", "blob");
    big[150_000] = (big[150_000]! + 1) % 256;
    const grown = Buffer.concat([big, randomBytes(100)]);
    fs.writeFileSync(path.join(repos.a, "blob.bin"), grown);
    fs.writeFileSync(path.join(repos.a, "fresh.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
    run(repos.a, "add", "fresh.bin");
    const patch = run(
      repos.a,
      "diff",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
      "blob.bin",
      "fresh.bin",
    );
    assert.match(patch, /^delta \d+$/m);
    assert.equal(binaryPatchBytes(patch), grown.length + 6);
    // A hunk that doesn't parse can't be measured, so it's refused.
    assert.isNull(binaryPatchBytes(patch.replace(/^delta \d+\n./m, "delta 10\n~")));
  });

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
