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
  ThreadMoveFamilyId,
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
import { linkMoveCopyThreadId } from "../moves/linkMoveIds.ts";
import { ComputerLinkRepository } from "./ComputerLinkRepository.ts";
import { LinkMoveRepository, LinkMoveRepositoryLive } from "./LinkMoveRepository.ts";
import {
  binaryPatchBytes,
  linkFamilyKey,
  linkFamilyThreadId,
  linkMoveKey,
  linkMoveThreadId,
  LinkMoves,
  LinkMovesLive,
  MAX_STAGED_MOVES_PER_LINK,
  moveManifestRefusal,
  movePathRefusal,
  sameProjectAs,
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
  /** The computer the link was made for, when its invite pinned it. */
  readonly pinnedEnvironmentId?: string;
  /** This computer's device on that computer (its own link there), when it has one. */
  readonly deviceThere?: string;
  /** The link's name for that computer here (its device row). */
  readonly linkLabel?: string;
  /** Threads already here, as their rows read. */
  readonly threadsHere?: ReadonlyArray<{ readonly threadId: ThreadId } & Record<string, unknown>>;
  /**
   * Threads this link gave up (LinkRequests.releaseThread), each with how
   * many commands were dispatched by then, and the ones closed for it after.
   */
  readonly released?: Array<{ readonly threadId: ThreadId; readonly dispatchedBefore: number }>;
  readonly closed?: Array<ThreadId>;
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
        Layer.mock(ComputerLinkRepository)({
          getByEnvironment: () =>
            Effect.succeed(
              carry.deviceThere === undefined
                ? Option.none()
                : Option.some({ deviceId: carry.deviceThere } as never),
            ),
        }),
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
                    pinnedEnvironmentId: carry.pinnedEnvironmentId ?? null,
                  },
            ),
          projectForKey: () =>
            Effect.succeed({
              id: ProjectId.make("project-b"),
              title: "Threadlines",
              workspaceRoot: repos.b,
            } as never),
          releaseThread: (_deviceId, threadId) =>
            Effect.sync(
              () => void carry.released?.push({ threadId, dispatchedBefore: dispatched.length }),
            ),
          closeThread: (_deviceId, threadId) =>
            Effect.sync(() => void carry.closed?.push(threadId)),
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
        // A thread here once its import was dispatched (a family's child reads
        // its parent), or one that was here already.
        Layer.mock(ProjectionThreadRepository)({
          // As the decider would write them: every thread the import asked for.
          listAdoptedChildIds: ({ parentThreadId }) =>
            Effect.sync(() =>
              dispatched.flatMap((command) =>
                command.type === "thread.import" && command.threadId === parentThreadId
                  ? (command.adoptsChildren?.children ?? []).map((child) => child.threadId)
                  : [],
              ),
            ),
          listIdsByRemoteLink: ({ linkDeviceId }) =>
            Effect.succeed(
              (carry.threadsHere ?? []).flatMap((row) =>
                (row.remoteOrigin as { readonly linkDeviceId?: string } | undefined)
                  ?.linkDeviceId === linkDeviceId
                  ? [row.threadId]
                  : [],
              ),
            ),
          getById: ({ threadId }) =>
            Effect.sync(() => {
              const here = carry.threadsHere?.find((row) => row.threadId === threadId);
              if (here !== undefined) return Option.some(here as never);
              const imported = dispatched
                .flatMap((command) => (command.type === "thread.import" ? [command] : []))
                .find((command) => command.threadId === threadId);
              return Option.fromUndefinedOr(
                imported === undefined
                  ? undefined
                  : ({
                      threadId,
                      projectId: ProjectId.make("project-b"),
                      deletedAt: null,
                      move: null,
                      pendingMove: null,
                      remoteOrigin: imported.remoteOrigin ?? null,
                    } as never),
              );
            }),
        }),
        Layer.mock(RelayDeviceRepository)({
          getDevice: () =>
            Effect.succeed(
              carry.linkLabel === undefined
                ? Option.none()
                : Option.some({ label: carry.linkLabel } as never),
            ),
        }),
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
  room?: Pick<
    MoveExportInput,
    "room" | "outsideWork" | "family" | "linkLineage" | "startedThere"
  > & {
    /** What the move says the computer it leaves calls itself. */
    readonly sourceEnvironmentId?: EnvironmentId | undefined;
    readonly sourceLabel?: string;
    readonly thread?: OrchestrationThread;
    /** Another thread of the same checkout (a family member), as its own transfer. */
    readonly threadId?: ThreadId;
    readonly transferId?: ThreadMoveId;
  },
) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const checkout = yield* inspectMoveCheckout(git, repos.a, "origin");
    const transferId = room?.transferId ?? TRANSFER;
    const dir = path.join(repos.root, "export", transferId);
    const manifest = yield* writeMoveExport({
      git,
      checkout,
      transferId,
      dir,
      family: room?.family,
      linkLineage: room?.linkLineage,
      startedThere: room?.startedThere,
      attachmentsDir: path.join(repos.root, "attachments"),
      thread: room?.thread ?? movingThread(),
      room: room?.room,
      outsideWork: room?.outsideWork,
      projectTitle: "Threadlines",
      subdirectory: "",
      canonicalKey: "example.com/repo",
      source: {
        environmentId: room?.sourceEnvironmentId ?? EnvironmentId.make("environment-windows"),
        environmentLabel: room?.sourceLabel ?? "Windows PC",
        threadId: room?.threadId ?? ThreadId.make("thread-a"),
      },
      agent,
      nativeSession,
      state,
    });
    return { manifest, payload: fs.readFileSync(movePayloadPath(dir)), checkout };
  });

/**
 * Offers, sends and finishes a packed move, then waits for its import to
 * settle (with `settle: false`, only until it is handed to the import).
 */
const deliver = (
  manifest: PeerMoveManifest,
  payload: Buffer,
  transferId: ThreadMoveId = TRANSFER,
  options: { readonly settle?: boolean } = {},
) =>
  Effect.gen(function* () {
    const moves = yield* LinkMoves;
    yield* moves.prepare(link("allowed"), { transferId, manifest });
    for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
      yield* moves.chunk(link("allowed"), {
        transferId,
        offset,
        data: payload.subarray(offset, offset + 64 * 1024).toString("base64"),
      });
    }
    let state = yield* moves.finish(link("allowed"), { transferId });
    if (options.settle === false) return state;
    for (let tries = 0; tries < 200 && state.status === "importing"; tries += 1) {
      yield* Effect.sleep("50 millis");
      state = yield* moves.status(link("allowed"), { transferId });
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

describe("a family moving here (Part 3f, (g))", () => {
  const FAMILY = ThreadMoveFamilyId.make("family-1");
  const PARENT = ThreadId.make("thread-a");
  const CHILD = ThreadId.make("thread-c1");
  const OTHER_CHILD = ThreadId.make("thread-c2");
  const familyKey = linkFamilyKey("device-windows", FAMILY);
  const parentHere = linkFamilyThreadId(familyKey, PARENT);
  const childHere = linkFamilyThreadId(familyKey, CHILD);
  const transfer = (name: string) => ThreadMoveId.make(`transfer-${name}`);
  const imports = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
    dispatched.flatMap((command) => (command.type === "thread.import" ? [command] : []));
  /** Waits until the move's row reads `status` here. */
  const untilStatus = (transferId: ThreadMoveId, status: string) =>
    Effect.gen(function* () {
      const rows = yield* LinkMoveRepository;
      for (let tries = 0; tries < 200; tries += 1) {
        const row = yield* rows.get("device-windows", transferId);
        if (Option.isSome(row) && row.value.status === status) return row.value;
        yield* Effect.sleep("50 millis");
      }
      return assert.fail(`${transferId} never reached ${status}`);
    });

  it.live(
    "children that arrive first wait for their parent holding no slot, then land under it",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const child = (threadId: ThreadId, name: string) =>
          pack(repos, null, undefined, {
            threadId,
            transferId: transfer(name),
            family: { id: FAMILY, parentThreadId: PARENT, parentTurnId: TurnId.make("turn-1") },
          });
        const first = yield* child(CHILD, "c1");
        const second = yield* child(OTHER_CHILD, "c2");
        // Two children, as many as one link moves here at once: both wait.
        for (const [packed, name] of [
          [first, "c1"],
          [second, "c2"],
        ] as const) {
          const state = yield* deliver(packed.manifest, packed.payload, transfer(name), {
            settle: false,
          });
          assert.equal(state.status, "importing");
          yield* untilStatus(transfer(name), "waiting_for_family");
        }
        assert.deepEqual(imports(dispatched), []);
        // Their waits hold no slot: the parent is taken, and lands first.
        const parent = yield* pack(repos, null, undefined, {
          transferId: transfer("p"),
          family: { id: FAMILY, stayed: [{ title: "Review notes" }] },
        });
        const landed = yield* deliver(parent.manifest, parent.payload, transfer("p"));
        assert.equal(landed.status, "committed");
        yield* untilStatus(transfer("c1"), "committed");
        yield* untilStatus(transfer("c2"), "committed");
        const [parentImport, ...childImports] = imports(dispatched);
        assert.equal(parentImport?.threadId, parentHere);
        assert.equal(parentImport?.movedFrom.familyKey, familyKey);
        assert.include(
          parentImport?.arrival?.left ?? [],
          "1 thread it started stayed on Windows PC: Review notes.",
        );
        assert.deepEqual(
          childImports.map((command) => command.lineage?.parentThreadId).toSorted(),
          [parentHere, parentHere],
        );
        // Its turn there is named as the parent's history names it here.
        assert.equal(
          childImports[0]?.lineage?.parentTurnId,
          parentImport?.messages.find((message) => message.turnId !== null)?.turnId,
        );
        // The three manifests carry the same message ids there; here no two
        // members share one (one would move another's message).
        const ids = [parentImport, ...childImports].flatMap((command) =>
          (command?.messages ?? []).map((message) => message.messageId),
        );
        assert.equal(ids.length, 6);
        assert.equal(new Set(ids).size, ids.length);
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );

  it.live("a child whose parent is dropped is dropped too", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const child = yield* pack(repos, null, undefined, {
        threadId: CHILD,
        transferId: transfer("c1"),
        family: { id: FAMILY, parentThreadId: PARENT },
      });
      yield* deliver(child.manifest, child.payload, transfer("c1"), { settle: false });
      yield* untilStatus(transfer("c1"), "waiting_for_family");
      const parent = yield* pack(repos, null, undefined, {
        transferId: transfer("p"),
        family: { id: FAMILY },
      });
      const moves = yield* LinkMoves;
      yield* moves.prepare(link("allowed"), {
        transferId: transfer("p"),
        manifest: parent.manifest,
      });
      yield* moves.abort(link("allowed"), { transferId: transfer("p") });
      const dropped = yield* untilStatus(transfer("c1"), "aborted");
      assert.equal(dropped.reason, "Its parent thread didn't move.");
      assert.deepEqual(imports(dispatched), []);
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });

  it.live(
    "a member in a folder whose owner was dropped ends, and two members never hold each other's locks",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return Effect.gen(function* () {
        const moves = yield* LinkMoves;
        // One child makes its folder and waits for the parent; its sibling
        // works in that folder and waits too.
        const owner = yield* pack(repos, null, undefined, {
          threadId: CHILD,
          transferId: transfer("c1"),
          family: { id: FAMILY, parentThreadId: PARENT },
        });
        yield* deliver(owner.manifest, owner.payload, transfer("c1"), { settle: false });
        yield* untilStatus(transfer("c1"), "waiting_for_family");
        const sibling = yield* pack(repos, null, undefined, {
          threadId: OTHER_CHILD,
          transferId: transfer("c2"),
          family: { id: FAMILY, parentThreadId: PARENT, sharesCheckoutOf: CHILD },
        });
        yield* deliver(sibling.manifest, sibling.payload, transfer("c2"), { settle: false });
        const waiting = yield* untilStatus(transfer("c2"), "waiting_for_family");
        assert.equal(waiting.stage, "applied");
        // The folder's owner is dropped: its sharer can't stay pointing at it.
        yield* moves.abort(link("allowed"), { transferId: transfer("c1") });
        const ended = yield* untilStatus(transfer("c2"), "aborted");
        assert.equal(ended.reason, "The thread whose folder it works in didn't move.");
        // The owner offered again, now in its sibling's folder: a sharer is
        // nobody's folder, so it ends rather than waiting on it.
        const again = yield* pack(repos, null, undefined, {
          threadId: CHILD,
          transferId: transfer("c1-again"),
          family: { id: FAMILY, parentThreadId: PARENT, sharesCheckoutOf: OTHER_CHILD },
        });
        yield* deliver(again.manifest, again.payload, transfer("c1-again"), { settle: false });
        yield* untilStatus(transfer("c1-again"), "aborted");
        // The parent lands on its own; nothing waits on a lock.
        const parent = yield* pack(repos, null, undefined, {
          transferId: transfer("p"),
          family: { id: FAMILY },
        });
        const landed = yield* deliver(parent.manifest, parent.payload, transfer("p"));
        assert.equal(landed.status, "committed");
        assert.deepEqual(
          imports(dispatched).map((command) => command.threadId),
          [parentHere],
        );
      }).pipe(Effect.provide(testLayer(repos, dispatched)));
    },
  );

  it.live(
    "a parent working in its child's folder lands with it, neither waiting on the other",
    () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      const setupRuns: string[] = [];
      return Effect.gen(function* () {
        // The parent works in the child's worktree there: the child sends the
        // folder, the parent none of it.
        const parent = yield* pack(repos, null, undefined, {
          transferId: transfer("p"),
          family: { id: FAMILY, sharesCheckoutOf: CHILD },
        });
        assert.deepEqual(
          parent.manifest.parts.filter((part) => part.kind !== "attachment"),
          [],
        );
        const child = yield* pack(repos, null, undefined, {
          threadId: CHILD,
          transferId: transfer("c1"),
          family: { id: FAMILY, parentThreadId: PARENT },
        });
        yield* deliver(parent.manifest, parent.payload, transfer("p"), { settle: false });
        yield* untilStatus(transfer("p"), "waiting_for_family");
        yield* deliver(child.manifest, child.payload, transfer("c1"), { settle: false });
        yield* untilStatus(transfer("p"), "committed");
        const childRow = yield* untilStatus(transfer("c1"), "committed");
        const [parentImport, childImport] = imports(dispatched);
        assert.equal(parentImport?.threadId, parentHere);
        assert.equal(childImport?.threadId, childHere);
        assert.equal(parentImport?.worktreePath, childRow.worktreePath);
        assert.equal(parentImport?.branch, childRow.branch);
        // A guest there, as here: never the folder's owner.
        assert.deepEqual(parentImport?.worktreeOrigin, { kind: "thread", threadId: childHere });
        assert.equal(childImport?.lineage?.parentThreadId, parentHere);
        // The folder's own move ran its setup, once.
        assert.deepEqual(setupRuns, [childRow.worktreePath]);
        assert.equal(
          fs.readFileSync(path.join(childRow.worktreePath!, "c.txt"), "utf8"),
          "c.txt unstaged\n",
        );
      }).pipe(Effect.provide(testLayer(repos, dispatched, "allowed", () => false, setupRuns)));
    },
  );

  it.live("a child in its parent's folder takes it, and one dropped takes nothing of it", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const parent = yield* pack(repos, null, undefined, {
        transferId: transfer("p"),
        family: { id: FAMILY },
      });
      yield* deliver(parent.manifest, parent.payload, transfer("p"));
      const parentRow = yield* untilStatus(transfer("p"), "committed");
      const folder = parentRow.worktreePath!;
      // A sharer offered and dropped before it lands: nothing of the folder goes.
      const dropped = yield* pack(repos, null, undefined, {
        threadId: OTHER_CHILD,
        transferId: transfer("c2"),
        family: { id: FAMILY, parentThreadId: PARENT, sharesCheckoutOf: PARENT },
      });
      const moves = yield* LinkMoves;
      yield* moves.prepare(link("allowed"), {
        transferId: transfer("c2"),
        manifest: dropped.manifest,
      });
      yield* moves.abort(link("allowed"), { transferId: transfer("c2") });
      yield* untilStatus(transfer("c2"), "aborted");
      assert.isTrue(fs.existsSync(path.join(folder, "c.txt")));
      // One that lands takes the parent's folder and branch, as a guest.
      const child = yield* pack(repos, null, undefined, {
        threadId: CHILD,
        transferId: transfer("c1"),
        family: { id: FAMILY, parentThreadId: PARENT, sharesCheckoutOf: PARENT },
      });
      const landed = yield* deliver(child.manifest, child.payload, transfer("c1"));
      assert.equal(landed.status, "committed");
      const childImport = imports(dispatched).find((command) => command.threadId === childHere);
      assert.equal(childImport?.worktreePath, folder);
      assert.deepEqual(childImport?.worktreeOrigin, { kind: "thread", threadId: parentHere });
      assert.equal(childImport?.lineage?.parentThreadId, parentHere);
      assert.isTrue(fs.existsSync(path.join(folder, "c.txt")));
    }).pipe(Effect.provide(testLayer(repos, dispatched)));
  });

  it("shares a folder only between members that name the same project", () => {
    const named = (canonicalKey: string, subdirectory?: string) =>
      ({
        project: {
          canonicalKey,
          title: "Repo",
          ...(subdirectory !== undefined ? { subdirectory } : {}),
        },
      }) as unknown as PeerMoveManifest;
    const generalChat = { project: { title: "General chats" } } as unknown as PeerMoveManifest;
    assert.isTrue(sameProjectAs(named("example.com/repo"), named("example.com/repo", "")));
    assert.isFalse(sameProjectAs(named("example.com/repo"), named("example.com/other")));
    assert.isFalse(sameProjectAs(named("example.com/repo", "web"), named("example.com/repo")));
    assert.isFalse(sameProjectAs(generalChat, named("example.com/repo")));
  });

  it("refuses a family member that names itself, or carries files into another's folder", () => {
    const base = {
      totalBytes: 0,
      sha256: "x",
      parts: [],
      source: { environmentId: "e", environmentLabel: "Windows PC", threadId: CHILD },
      git: { headSha: "h", branch: null, baseSha: null },
      thread: { messages: [], activities: [] },
    } as unknown as PeerMoveManifest;
    assert.include(
      moveManifestRefusal({ ...base, family: { id: FAMILY, parentThreadId: CHILD } }),
      "itself as its parent",
    );
    assert.include(
      moveManifestRefusal({ ...base, family: { id: FAMILY, sharesCheckoutOf: CHILD } }),
      "shares its own folder",
    );
    assert.include(
      moveManifestRefusal({
        ...base,
        totalBytes: 4,
        parts: [{ kind: "file", offset: 0, length: 4, sha256: "y", path: "a.txt", mode: "file" }],
        family: { id: FAMILY, sharesCheckoutOf: PARENT },
      }),
      "carries none of its files",
    );
    assert.isNull(
      moveManifestRefusal({ ...base, family: { id: FAMILY, sharesCheckoutOf: PARENT } }),
    );
  });
});

describe("a thread moving across its link (Part 3f, (h))", () => {
  const WINDOWS = "environment-windows";
  const PARENT_THERE = ThreadId.make("thread-parent-on-windows");
  const PARENT_HERE = ThreadId.make("thread-parent-here");
  const remoteParent = { remoteParent: { threadId: PARENT_THERE, title: "Ship it" } };
  const home = { home: { parentThreadId: PARENT_HERE } };
  const importOf = (dispatched: ReadonlyArray<OrchestrationCommand>) => {
    const found = dispatched.find((command) => command.type === "thread.import");
    return found?.type === "thread.import" ? found : assert.fail("nothing was imported");
  };
  /** This computer's thread, holding `threadId` on `environmentId` as its child there. */
  const parentHere = (environmentId: string, threadId: string) => ({
    threadId: PARENT_HERE,
    projectId: ProjectId.make("project-b"),
    deletedAt: null,
    move: null,
    pendingMove: null,
    parentThreadId: null,
    attachedToParent: 0,
    childRequests: {
      open: [],
      deliveryEpoch: 0,
      startsSinceUser: 0,
      sendsSinceUser: 0,
      pendingNotes: [],
      remoteChildren: [
        {
          environmentId,
          label: "Windows PC",
          threadId,
          handle: "Agent",
          title: "Move me",
          attachmentEpoch: 0,
          cachedStatus: "idle",
          updatedAt: "2026-11-17T10:00:00.000Z",
        },
      ],
    },
  });
  const moved = (
    repos: ReturnType<typeof makeRepos>,
    dispatched: OrchestrationCommand[],
    lineage: MoveExportInput["linkLineage"],
    carry: Partial<CarryRecord> & {
      readonly sourceEnvironmentId?: EnvironmentId;
      /** The thread it is on the computer it leaves. */
      readonly sourceThreadId?: ThreadId;
    } = {},
  ) =>
    Effect.gen(function* () {
      const packed = yield* pack(repos, null, undefined, {
        linkLineage: lineage,
        sourceEnvironmentId: carry.sourceEnvironmentId,
        ...(carry.sourceThreadId !== undefined ? { threadId: carry.sourceThreadId } : {}),
        // What the move says it is called never names anything here.
        sourceLabel: "Not Windows",
      });
      return yield* deliver(packed.manifest, packed.payload);
    }).pipe(
      Effect.provide(
        testLayer(repos, dispatched, "allowed", () => false, [], {
          home: os.tmpdir(),
          adopted: [],
          linkLabel: "Windows PC",
          ...carry,
        }),
      ),
    );

  it.live("a child alone stays its parent's child, its link taken from the link itself", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const state = yield* moved(repos, dispatched, remoteParent, {
        pinnedEnvironmentId: WINDOWS,
      });
      assert.equal(state.status, "committed");
      assert.equal(state.keptParent, true);
      const imported = importOf(dispatched);
      assert.deepEqual(imported.remoteOrigin, {
        linkDeviceId: "device-windows",
        environmentId: EnvironmentId.make(WINDOWS),
        environmentPinned: true,
        environmentLabel: "Windows PC",
        threadId: PARENT_THERE,
        threadTitle: "Ship it",
      });
      assert.equal(imported.movedFrom.environmentId, WINDOWS);
      assert.equal(imported.movedFrom.environmentPinned, true);
      assert.isUndefined(imported.lineage);
      assert.isUndefined(imported.adopt);
    });
  });

  it.live("a link that can't prove its computer, or a forged one, keeps no parent", () => {
    const unpinned = makeRepos();
    const forged = makeRepos();
    const first: OrchestrationCommand[] = [];
    const second: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const plain = yield* moved(unpinned, first, remoteParent);
      assert.equal(plain.status, "committed");
      assert.isUndefined(plain.keptParent);
      assert.isUndefined(importOf(first).remoteOrigin);
      // Where it came from is only the move's word: its fence lets it go nowhere.
      assert.isUndefined(importOf(first).movedFrom.environmentPinned);
      assert.include(
        importOf(first).arrival?.left ?? [],
        "This computer can't confirm its link to Windows PC, so this is its own thread and 'Ship it' there can't reach it.",
      );
      // The move says it came from a computer the link wasn't made for.
      const lied = yield* moved(forged, second, remoteParent, {
        pinnedEnvironmentId: WINDOWS,
        sourceEnvironmentId: EnvironmentId.make("environment-mac"),
      });
      assert.equal(lied.status, "committed");
      assert.isUndefined(lied.keptParent);
      assert.isUndefined(importOf(second).remoteOrigin);
      // It came from the computer the link was made for, whatever the move says.
      assert.equal(importOf(second).movedFrom.environmentId, WINDOWS);
      assert.equal(importOf(second).movedFrom.environmentPinned, true);
    });
  });

  it.live("comes home under its parent only when this computer's own records hold it", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      yield* moved(repos, dispatched, home, {
        pinnedEnvironmentId: WINDOWS,
        threadsHere: [parentHere(WINDOWS, "thread-a")],
      });
      const imported = importOf(dispatched);
      assert.deepEqual(imported.adopt, { parentThreadId: PARENT_HERE });
      assert.isUndefined(imported.remoteOrigin);
    });
  });

  it.live(
    "comes home under its parent when its move here still waits for this computer's answer",
    () => {
      const LEFT = ThreadId.make("thread-left-here");
      /** The parent's child here, frozen for its own move (alone) to `environmentId`. */
      const leftHere = (environmentId: string, movedAway = false) => ({
        threadId: LEFT,
        projectId: ProjectId.make("project-b"),
        deletedAt: null,
        parentThreadId: PARENT_HERE,
        attachedToParent: 1,
        pendingMove: null,
        move: {
          transferId: "transfer-left",
          target: { environmentId, label: "Windows PC" },
          ...(movedAway
            ? { movedAway: { threadId: "thread-a", movedAt: "2026-11-17T10:00:00.000Z" } }
            : {}),
        },
      });
      const back = { home: { parentThreadId: PARENT_HERE, fromThreadId: LEFT } };
      // This computer's device on Windows PC, which named the copy that move made there.
      const DEVICE_THERE = "device-mac-on-windows";
      const copy = linkMoveCopyThreadId(DEVICE_THERE, "transfer-left");
      const completes = {
        parentThreadId: PARENT_HERE,
        completesMoveOf: { threadId: LEFT, deviceId: DEVICE_THERE },
      };
      const cases = [
        { left: leftHere(WINDOWS), source: copy, adopt: completes },
        // Another thread there, naming the child here: never under the parent.
        { left: leftHere(WINDOWS), source: ThreadId.make("thread-a"), adopt: undefined },
        // No link of this computer's own there to name the copy by.
        { left: leftHere(WINDOWS), source: copy, deviceThere: null, adopt: undefined },
        // Moving to another computer, or already heard to have landed: its own thread.
        { left: leftHere("environment-mac"), source: copy, adopt: undefined },
        { left: leftHere(WINDOWS, true), source: copy, adopt: undefined },
      ];
      return Effect.forEach(cases, ({ left, source, adopt, ...rest }) => {
        const repos = makeRepos();
        const dispatched: OrchestrationCommand[] = [];
        return moved(repos, dispatched, back, {
          pinnedEnvironmentId: WINDOWS,
          sourceThreadId: source,
          ...("deviceThere" in rest ? {} : { deviceThere: DEVICE_THERE }),
          // The parent holds nothing there yet: this computer hasn't heard.
          threadsHere: [parentHere(WINDOWS, "thread-other"), left],
        }).pipe(
          Effect.map((state) => {
            assert.equal(state.status, "committed");
            assert.deepEqual(importOf(dispatched).adopt, adopt);
          }),
        );
      });
    },
  );

  it.live("a home claim this computer's records don't back lands as its own thread", () => {
    const cases = [
      // The parent here never held that thread.
      { pinnedEnvironmentId: WINDOWS, threadsHere: [parentHere(WINDOWS, "thread-other")] },
      // It held a thread of that id on another computer, not the one this link is for.
      { pinnedEnvironmentId: WINDOWS, threadsHere: [parentHere("environment-mac", "thread-a")] },
      // A link that can't prove its computer.
      { threadsHere: [parentHere(WINDOWS, "thread-a")] },
      // No such parent here at all.
      { pinnedEnvironmentId: WINDOWS },
    ];
    return Effect.forEach(cases, (carry) => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      return moved(repos, dispatched, home, carry).pipe(
        Effect.map((state) => {
          assert.equal(state.status, "committed");
          const imported = importOf(dispatched);
          assert.isUndefined(imported.adopt);
          assert.isUndefined(imported.lineage);
          assert.include(
            imported.arrival?.left ?? [],
            "The thread that started it isn't on this computer anymore, so this is its own thread.",
          );
        }),
      );
    });
  });

  it.live("a parent arriving where a thread it started already is names that thread", () => {
    const repos = makeRepos();
    const dispatched: OrchestrationCommand[] = [];
    /** A thread here that `startedBy` on Windows PC started, over `linkDeviceId`. */
    const startedHere = (
      threadId: string,
      title: string,
      {
        linkDeviceId = "device-windows",
        startedBy = "thread-a",
        archivedAt = null as string | null,
        movedAway = false,
      },
    ) => ({
      threadId: ThreadId.make(threadId),
      title,
      deletedAt: null,
      archivedAt,
      ...(movedAway
        ? {
            move: {
              movedAway: {
                threadId: ThreadId.make("thread-back-home"),
                movedAt: "2026-11-17T10:00:00.000Z",
              },
            },
          }
        : {}),
      remoteOrigin: {
        linkDeviceId,
        environmentId: WINDOWS,
        environmentPinned: true,
        environmentLabel: "Windows PC",
        threadId: startedBy,
        threadTitle: "Ship it",
      },
    });
    return Effect.gen(function* () {
      const state = yield* moved(repos, dispatched, undefined, {
        pinnedEnvironmentId: WINDOWS,
        threadsHere: [
          startedHere("thread-child", "Fix tests", {}),
          // Over another link, by another thread there, archived, or moved
          // away again: not this one's here.
          startedHere("thread-other-link", "Other link", { linkDeviceId: "device-mac" }),
          startedHere("thread-other-parent", "Other parent", { startedBy: "thread-b" }),
          startedHere("thread-archived", "Archived", { archivedAt: "2026-11-17T10:00:00.000Z" }),
          startedHere("thread-moved-away", "Moved away", { movedAway: true }),
        ],
      });
      assert.equal(state.status, "committed");
      const imported = importOf(dispatched);
      assert.deepEqual(
        (imported.arrival?.left ?? []).filter((sentence) => sentence.includes("this computer")),
        [
          "Its thread 'Fix tests' is already on this computer. It stays separate, so this thread can't reach it.",
        ],
      );
      // It stays apart: nothing here becomes its child.
      assert.isUndefined(imported.adopt);
      assert.isUndefined(imported.lineage);
      assert.isUndefined(imported.remoteOrigin);
    });
  });

  describe("a parent taking back the threads it started here (Part 3f, (g))", () => {
    /** A thread the link started here for the moving thread (`thread-a` there). */
    const startedHere = (threadId: string, title: string) => ({
      threadId: ThreadId.make(threadId),
      title,
      deletedAt: null,
      archivedAt: null,
      remoteOrigin: {
        linkDeviceId: "device-windows",
        environmentId: WINDOWS,
        environmentPinned: true,
        environmentLabel: "Windows PC",
        threadId: "thread-a",
        threadTitle: "Ship it",
      },
    });
    const wrapped = { state: "done", at: "2026-11-17T09:00:00.000Z" } as const;
    const startedThere = [
      { threadId: ThreadId.make("thread-both"), override: wrapped },
      // On its list there, but not a thread this link started here for it.
      { threadId: ThreadId.make("thread-not-here") },
    ];
    const arriving = (
      repos: ReturnType<typeof makeRepos>,
      dispatched: OrchestrationCommand[],
      carry: Pick<CarryRecord, "released" | "closed">,
      linkLineage?: MoveExportInput["linkLineage"],
    ) =>
      Effect.gen(function* () {
        const packed = yield* pack(repos, null, undefined, { startedThere, linkLineage });
        const state = yield* deliver(packed.manifest, packed.payload);
        // Asked again (a restart, a lost answer): read from the threads, the same.
        const again = yield* (yield* LinkMoves).status(link("allowed"), { transferId: TRANSFER });
        return { state, again };
      }).pipe(
        Effect.provide(
          testLayer(repos, dispatched, "allowed", () => false, [], {
            home: os.tmpdir(),
            adopted: [],
            linkLabel: "Windows PC",
            pinnedEnvironmentId: WINDOWS,
            threadsHere: [
              startedHere("thread-both", "Fix tests"),
              startedHere("thread-only-here", "Only here"),
            ],
            ...carry,
          }),
        ),
      );

    it.live("only those both its list and this computer's records name, released first", () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      const released: NonNullable<CarryRecord["released"]> = [];
      const closed: ThreadId[] = [];
      return Effect.gen(function* () {
        const { state, again } = yield* arriving(repos, dispatched, { released, closed });
        assert.equal(state.status, "committed");
        const imported = importOf(dispatched);
        assert.deepEqual(imported.adoptsChildren, {
          linkDeviceId: "device-windows",
          children: [{ threadId: ThreadId.make("thread-both"), override: wrapped }],
        });
        // Here but not on its list: it stays apart, with today's words.
        assert.deepEqual(
          (imported.arrival?.left ?? []).filter((sentence) => sentence.includes("this computer")),
          [
            "Its thread 'Only here' is already on this computer. It stays separate, so this thread can't reach it.",
          ],
        );
        // The link let go of it before the import, and owes it nothing once it landed.
        assert.deepEqual(
          released.map((entry) => entry.threadId),
          ["thread-both"],
        );
        assert.isAtMost(released[0]!.dispatchedBefore, dispatched.indexOf(imported));
        assert.include(closed, ThreadId.make("thread-both"));
        assert.deepEqual(state.adopted, [ThreadId.make("thread-both")]);
        assert.deepEqual(again.adopted, [ThreadId.make("thread-both")]);
      });
    });

    it.live("a thread landing under a parent takes none back", () => {
      const repos = makeRepos();
      const dispatched: OrchestrationCommand[] = [];
      const released: NonNullable<CarryRecord["released"]> = [];
      return Effect.gen(function* () {
        const { state } = yield* arriving(
          repos,
          dispatched,
          { released, closed: [] },
          { remoteParent: { threadId: ThreadId.make("thread-parent-on-windows"), title: "Ship" } },
        );
        assert.equal(state.status, "committed");
        assert.isUndefined(importOf(dispatched).adoptsChildren);
        assert.deepEqual(released, []);
        assert.isUndefined(state.adopted);
      });
    });
  });

  it("refuses a manifest naming both a parent and a home, itself, or a family too", () => {
    const base = {
      totalBytes: 0,
      sha256: "x",
      parts: [],
      source: { environmentId: "e", environmentLabel: "Windows PC", threadId: "thread-a" },
      git: { headSha: "h", branch: null, baseSha: null },
      thread: { messages: [], activities: [] },
    } as unknown as PeerMoveManifest;
    assert.include(
      moveManifestRefusal({ ...base, linkLineage: { ...remoteParent, ...home } }),
      "not both",
    );
    assert.include(moveManifestRefusal({ ...base, linkLineage: {} }), "not both");
    assert.include(
      moveManifestRefusal({
        ...base,
        linkLineage: { remoteParent: { threadId: ThreadId.make("thread-a"), title: "Me" } },
      }),
      "itself as its parent",
    );
    assert.include(
      moveManifestRefusal({
        ...base,
        linkLineage: home,
        family: { id: ThreadMoveFamilyId.make("family-1") },
      }),
      "moves on no link",
    );
    assert.isNull(moveManifestRefusal({ ...base, linkLineage: home }));
  });
});
