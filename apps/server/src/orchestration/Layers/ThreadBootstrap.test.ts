import { describe, expect, it } from "@effect/vitest";
import {
  ChildRequestId,
  type ChildThreadLaunch,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  OutsideAgentConnectionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { childWorktreeBranch, firstSendWorktreeBranch } from "../childRequestIds.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  type ChildBootstrapInput,
  ThreadBootstrap,
  type ThreadTurnStartCommand,
} from "../Services/ThreadBootstrap.ts";
import { ThreadBootstrapLive } from "./ThreadBootstrap.ts";

const AT = "2026-10-04T10:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const PARENT = ThreadId.make("parent-thread");
const CHILD = ThreadId.make("2f6c1d7e-9a4b-5c3d-8e2f-1a0b9c8d7e6f");
const REQUEST = ChildRequestId.make("7d1e2f3a-4b5c-5d6e-8f70-819a2b3c4d5e");
const PROJECT_CWD = "/repo";
const BASE = "b".repeat(40);

const launch = (patch: Partial<ChildThreadLaunch> = {}): ChildThreadLaunch => ({
  title: "Check the migration",
  prompt: "Read the migration and say whether it is safe.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  reportBack: true,
  runSetup: true,
  workspace: { kind: "worktree", projectCwd: PROJECT_CWD, baseRef: BASE },
  ...patch,
});

const input = (patch: Partial<ChildBootstrapInput> = {}): ChildBootstrapInput => ({
  lineage: { kind: "local", parentThreadId: PARENT, parentTurnId: TurnId.make("parent-turn") },
  projectId: PROJECT,
  requestId: REQUEST,
  childThreadId: CHILD,
  childMessageId: MessageId.make("child-message"),
  launch: launch(),
  fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
  createdAt: AT,
  ...patch,
});

type ThreadStart = Extract<OrchestrationCommand, { type: "thread.start" }>;
type FailHow = "interrupt" | "refuse" | NonNullable<OrchestrationCommandInvariantError["refusal"]>;

/** The worktree path the mock git gives a branch. */
const worktreePathFor = (branch: string) => `/worktrees/repo/${branch.split("/").at(-1)}`;

/**
 * Durable state as the engine, the read model and git keep it, shared by
 * every run so a second run sees what an interrupted first one left.
 * `failOn` makes the next matching command fail before it lands: refused by
 * the decider, or cut off the way the server stopping would cut it.
 */
const makeWorld = () => {
  const receipts = new Map<string, number>();
  const threads = new Map<string, OrchestrationThread>();
  const accepted: OrchestrationCommand[] = [];
  const worktrees: Array<{ path: string; branch: string }> = [];
  /** Worktrees git still holds locked, by path: an add a crash cut short. */
  const locks = new Map<string, string>();
  const branches = new Set<string>();
  const createWorktreeCalls: unknown[] = [];
  const removedWorktrees: string[] = [];
  const deletedBranches: string[] = [];
  const setupRuns: unknown[] = [];
  /** Whether any thread existed while each worktree was cut. */
  const threadsWhileCutting: boolean[] = [];
  let failNext:
    | { readonly matches: (command: OrchestrationCommand) => boolean; readonly how: FailHow }
    | undefined;

  const appendActivity = (threadId: string, activity: OrchestrationThreadActivity) => {
    const thread = threads.get(threadId)!;
    threads.set(threadId, { ...thread, activities: [...thread.activities, activity] });
  };

  const apply = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.start": {
        if (command.create !== undefined) {
          threads.set(command.threadId, {
            id: command.threadId,
            projectId: command.create.projectId,
            title: command.create.title,
            branch: command.create.branch,
            worktreePath: command.create.worktreePath,
            runtimeMode: command.create.runtimeMode,
            interactionMode: command.create.interactionMode,
            ...(command.create.outsideOrigin !== undefined
              ? { outsideOrigin: command.create.outsideOrigin }
              : {}),
            activities: [] as ReadonlyArray<OrchestrationThreadActivity>,
            messages: [],
          } as unknown as OrchestrationThread);
        }
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, {
          ...thread,
          ...(command.checkout !== undefined
            ? { branch: command.checkout.branch, worktreePath: command.checkout.worktreePath }
            : {}),
        });
        if (command.setupScriptClaim !== undefined) {
          appendActivity(command.threadId, command.setupScriptClaim);
        }
        return;
      }
      case "thread.activity.append":
        appendActivity(command.threadId, command.activity);
        return;
      default:
        return;
    }
  };

  const engine = {
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    getCommandReceipt: (commandId: string) =>
      Effect.succeed(
        receipts.has(commandId)
          ? Option.some({
              commandId,
              aggregateKind: "thread",
              aggregateId: CHILD,
              acceptedAt: AT,
              resultSequence: receipts.get(commandId)!,
              status: "accepted",
              error: null,
            })
          : Option.none(),
      ),
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        const known = receipts.get(command.commandId);
        if (known !== undefined) {
          return { sequence: known };
        }
        if (failNext?.matches(command)) {
          const { how } = failNext;
          failNext = undefined;
          if (how === "interrupt") {
            return yield* Effect.interrupt;
          }
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The decider said no.",
            ...(how !== "refuse" ? { refusal: how } : {}),
          });
        }
        apply(command);
        accepted.push(command);
        receipts.set(command.commandId, accepted.length);
        return { sequence: accepted.length };
      }),
  };

  const layer = ThreadBootstrapLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine as never),
        Layer.succeed(ServerConfig, { worktreesDir: "/worktrees" } as never),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: (threadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
          getProjectShellById: () =>
            Effect.succeed(
              Option.some({
                scripts: [
                  {
                    id: "setup",
                    name: "Install",
                    command: "bun install",
                    icon: "configure",
                    runOnWorktreeCreate: true,
                  },
                ],
              } as never),
            ),
        }),
        Layer.mock(GitWorkflowService)({
          listWorktrees: () =>
            Effect.succeed(
              worktrees.map((entry) => ({
                ...entry,
                ...(locks.has(entry.path) ? { lockReason: locks.get(entry.path)! } : {}),
              })),
            ),
          listRefs: () =>
            Effect.succeed({
              refs: [...branches].map((name) => ({
                name,
                current: false,
                isDefault: false,
                worktreePath: null,
              })),
              isRepo: true,
              hasPrimaryRemote: false,
              nextCursor: null,
              totalCount: branches.size,
            }),
          resolveFreshWorktreeBase: (request) =>
            Effect.succeed({ refName: `origin/${request.branch}` } as never),
          createWorktree: (request) =>
            Effect.sync(() => {
              threadsWhileCutting.push(threads.size > 0);
              createWorktreeCalls.push(request);
              const branch = request.newRefName ?? request.refName;
              branches.add(branch);
              const path = request.path ?? worktreePathFor(branch);
              worktrees.push({ path, branch });
              return { worktree: { path, refName: branch } };
            }),
          removeWorktree: (request) =>
            Effect.sync(() => {
              removedWorktrees.push(request.path);
              const index = worktrees.findIndex((entry) => entry.path === request.path);
              if (index !== -1) worktrees.splice(index, 1);
              locks.delete(request.path);
            }),
          deleteBranch: (request) =>
            Effect.sync(() => {
              deletedBranches.push(request.branchName);
              return { branchName: request.branchName };
            }),
        }),
        Layer.mock(VcsStatusBroadcaster)({
          refreshStatus: () => Effect.succeed({} as never),
        }),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (request) =>
            Effect.sync(() => {
              setupRuns.push(request);
              return {
                status: "started" as const,
                scriptId: "setup",
                scriptName: "Install",
                terminalId: "setup-setup",
                cwd: request.worktreePath,
              };
            }),
        }),
      ),
    ),
  );

  return {
    layer,
    threads,
    accepted,
    worktrees,
    branches,
    locks,
    createWorktreeCalls,
    removedWorktrees,
    deletedBranches,
    setupRuns,
    threadsWhileCutting,
    failOn: (matches: (command: OrchestrationCommand) => boolean, how: FailHow = "refuse") => {
      failNext = { matches, how };
    },
    starts: () =>
      accepted.filter((command): command is ThreadStart => command.type === "thread.start"),
  };
};

const startChild = (request: ChildBootstrapInput = input()) =>
  Effect.gen(function* () {
    const bootstrap = yield* ThreadBootstrap;
    return yield* bootstrap.startChild(request);
  });

const isStart = (command: OrchestrationCommand) => command.type === "thread.start";

describe("ThreadBootstrap.startChild", () => {
  it.effect(
    "cuts a child's worktree first, then makes it with its first turn and setup claim",
    () => {
      const world = makeWorld();
      const branch = childWorktreeBranch(REQUEST);
      return Effect.gen(function* () {
        yield* startChild();

        expect(world.createWorktreeCalls).toEqual([
          { cwd: PROJECT_CWD, refName: BASE, newRefName: branch, path: null },
        ]);
        // Nothing could reach the thread while its worktree was cut: it didn't exist.
        expect(world.threadsWhileCutting).toEqual([false]);
        const [start] = world.starts();
        expect(start?.create).toMatchObject({
          parentThreadId: PARENT,
          attachedToParent: true,
          runtimeMode: "auto-accept-edits",
          branch,
          worktreePath: worktreePathFor(branch),
        });
        expect(start?.setupScriptClaim?.kind).toBe("setup-script.requested");
        expect(start?.turn).toMatchObject({
          threadId: CHILD,
          message: { messageId: "child-message", text: launch().prompt },
          fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
        });
        expect(world.setupRuns).toHaveLength(1);
        expect(world.threads.get(CHILD)?.activities.map((activity) => activity.kind)).toEqual([
          "setup-script.requested",
          "setup-script.started",
        ]);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect(
    "resumes after a cut at any stage with one worktree, one thread, one setup script",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        // Cut off after its worktree, before its start.
        const cutBeforeStart = yield* Effect.exit(
          startChild(
            input({
              checkpoint: (stage) => (stage === "turn" ? Effect.interrupt : Effect.succeed(true)),
            }),
          ),
        );
        expect(Exit.isFailure(cutBeforeStart)).toBe(true);
        expect(world.threads.has(CHILD)).toBe(false);
        // Cut off as the start was sent.
        world.failOn(isStart, "interrupt");
        expect(Exit.isFailure(yield* Effect.exit(startChild()))).toBe(true);
        // Cut off after the start, as the script's launch was recorded: the
        // run stops (it is never reported done), and its script never runs again.
        world.failOn(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "setup-script.started",
          "interrupt",
        );
        const cutAfterStart = yield* Effect.exit(startChild());
        expect(Exit.isFailure(cutAfterStart) && Cause.hasInterruptsOnly(cutAfterStart.cause)).toBe(
          true,
        );
        // Run once more after it finished: answered from the start's receipt.
        const before = world.accepted.length;
        yield* startChild();

        expect(world.accepted.length).toBe(before);
        expect(world.createWorktreeCalls).toHaveLength(1);
        expect(world.worktrees).toHaveLength(1);
        expect(world.starts()).toHaveLength(1);
        expect(world.setupRuns).toHaveLength(1);
        expect(world.removedWorktrees).toEqual([]);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect("removes the worktree a refused start made, and never one it found", () => {
    const world = makeWorld();
    const branch = childWorktreeBranch(REQUEST);
    return Effect.gen(function* () {
      world.failOn(isStart);
      const refused = yield* Effect.flip(startChild());
      expect(refused.stage).toBe("turn");
      expect(refused.message).toBe("Couldn't start its first turn: The decider said no.");
      expect(world.removedWorktrees).toEqual([worktreePathFor(branch)]);
      expect(world.deletedBranches).toEqual([branch]);

      // A worktree already on the request's branch (an earlier run's) stays.
      world.removedWorktrees.length = 0;
      world.deletedBranches.length = 0;
      world.worktrees.push({ path: worktreePathFor(branch), branch });
      world.failOn(isStart);
      yield* Effect.flip(startChild());
      expect(world.removedWorktrees).toEqual([]);
      expect(world.deletedBranches).toEqual([]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("makes again a worktree whose add a crash cut short, in a folder of its own", () => {
    const world = makeWorld();
    const branch = childWorktreeBranch(REQUEST);
    const halfMade = worktreePathFor(branch);
    world.worktrees.push({ path: halfMade, branch });
    world.branches.add(branch);
    world.locks.set(halfMade, "initializing");
    return Effect.gen(function* () {
      yield* startChild();

      expect(world.removedWorktrees).toEqual([halfMade]);
      // Never the usual folder: a cut-off git still running cleans up only that one.
      const [made] = world.createWorktreeCalls as Array<{ readonly path: string }>;
      expect(made).toMatchObject({ cwd: PROJECT_CWD, refName: branch });
      expect(made?.path).toMatch(new RegExp(`^${halfMade}-[0-9a-f]{4}$`));
      expect(world.starts()[0]?.create?.worktreePath).toBe(made?.path);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("leaves alone a worktree someone locked on purpose, and says so", () => {
    const world = makeWorld();
    const branch = childWorktreeBranch(REQUEST);
    const pinned = worktreePathFor(branch);
    world.worktrees.push({ path: pinned, branch });
    world.locks.set(pinned, "on a USB drive");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(startChild());

      expect(error.stage).toBe("worktree");
      expect(error.message).toContain(`${pinned} is locked (on a USB drive)`);
      expect(world.removedWorktrees).toEqual([]);
      expect(world.createWorktreeCalls).toEqual([]);
      expect(world.starts()).toEqual([]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("makes a child in the project folder with no worktree and no setup script", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* startChild(input({ launch: launch({ workspace: { kind: "project_folder" } }) }));

      expect(world.createWorktreeCalls).toHaveLength(0);
      expect(world.setupRuns).toHaveLength(0);
      const [start] = world.starts();
      expect(start?.create).toMatchObject({ branch: null, worktreePath: null });
      expect(start?.setupScriptClaim).toBeUndefined();
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    "finishes a child an older build made without its first turn, never claiming its setup twice",
    () => {
      const world = makeWorld();
      world.threads.set(CHILD, {
        id: CHILD,
        projectId: PROJECT,
        branch: null,
        worktreePath: null,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        activities: [
          {
            id: "older-claim",
            tone: "info",
            kind: "setup-script.requested",
            summary: "Starting setup script",
            payload: {},
            turnId: null,
            createdAt: AT,
          },
        ],
        messages: [],
      } as unknown as OrchestrationThread);
      return Effect.gen(function* () {
        yield* startChild();

        const [start] = world.starts();
        expect(start?.create).toBeUndefined();
        expect(start?.checkout?.branch).toBe(childWorktreeBranch(REQUEST));
        expect(start?.setupScriptClaim).toBeUndefined();
        expect(world.setupRuns).toHaveLength(0);
      }).pipe(Effect.provide(world.layer));
    },
  );
});

describe("ThreadBootstrap.runTurnStart", () => {
  const NEW_THREAD = ThreadId.make("new-thread");
  const AGENT = {
    connectionId: OutsideAgentConnectionId.make("connection-1"),
    name: "Claude Code",
  };
  const createThread = {
    projectId: PROJECT,
    title: "Fix the flaky test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: "main",
    worktreePath: null,
    createdAt: AT,
  };
  const firstSend = (patch: Partial<ThreadTurnStartCommand> = {}): ThreadTurnStartCommand => ({
    type: "thread.turn.start",
    commandId: CommandId.make("client-first-send"),
    threadId: NEW_THREAD,
    message: {
      messageId: MessageId.make("first-message"),
      role: "user",
      text: "Go",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    bootstrap: {
      createThread,
      prepareWorktree: {
        projectCwd: PROJECT_CWD,
        baseBranch: "main",
        branch: "threadlines/1a2b3c4d",
      },
      runSetupScript: true,
    },
    createdAt: AT,
    ...patch,
  });
  const outsideStart = firstSend({
    fromOutside: { ...AGENT, maxRuntimeMode: "approval-required" },
    bootstrap: { createThread: { ...createThread, branch: null, outsideOrigin: AGENT } },
  });
  const runTurnStart = (command: ThreadTurnStartCommand) =>
    Effect.gen(function* () {
      const bootstrap = yield* ThreadBootstrap;
      return yield* bootstrap.runTurnStart(command);
    });

  it.effect("makes the thread in its fresh worktree with its first turn, after cutting it", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* runTurnStart(firstSend());

      // Named by the command, whatever placeholder the client sent.
      const branch = firstSendWorktreeBranch("client-first-send");
      expect(world.createWorktreeCalls).toEqual([
        { cwd: PROJECT_CWD, refName: "origin/main", newRefName: branch, path: null },
      ]);
      expect(world.threadsWhileCutting).toEqual([false]);
      const [start] = world.starts();
      expect(start?.commandId).toBe("client-first-send");
      expect(start?.create).toMatchObject({ branch, worktreePath: worktreePathFor(branch) });
      expect(start?.turn).not.toHaveProperty("bootstrap");
      expect(world.setupRuns).toHaveLength(1);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("finishes a first send a restart cut off when its client sends it again", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      world.failOn(isStart, "interrupt");
      const cut = yield* Effect.exit(runTurnStart(firstSend()));
      // Still an interruption to whoever was waiting, not a failed send.
      expect(Exit.isFailure(cut) && Cause.hasInterruptsOnly(cut.cause)).toBe(true);
      // No half-made thread: only the worktree, which the retry reuses.
      expect(world.threads.size).toBe(0);
      yield* runTurnStart(firstSend());
      yield* runTurnStart(firstSend());

      expect(world.createWorktreeCalls).toHaveLength(1);
      expect(world.starts()).toHaveLength(1);
      expect(world.setupRuns).toHaveLength(1);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("labels an outside agent's thread in the same decision as its first turn", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* runTurnStart(outsideStart);
      const [start] = world.starts();
      expect(start?.create).toMatchObject({ outsideOrigin: AGENT });
      expect(start?.turn).toMatchObject({
        fromOutside: { ...AGENT, maxRuntimeMode: "approval-required" },
      });
      expect(world.threads.get(NEW_THREAD)?.outsideOrigin).toEqual(AGENT);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("keeps the decider's typed refusal, and makes no thread", () => {
    const world = makeWorld();
    world.failOn(isStart, "above_ceiling");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runTurnStart(outsideStart));
      expect(error.refusal).toBe("above_ceiling");
      expect(world.threads.size).toBe(0);
    }).pipe(Effect.provide(world.layer));
  });
});
