import { describe, expect, it } from "@effect/vitest";
import {
  ChildRequestId,
  type ChildThreadLaunch,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { childWorktreeBranch } from "../childRequestIds.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { type ChildBootstrapInput, ThreadBootstrap } from "../Services/ThreadBootstrap.ts";
import { ThreadBootstrapLive } from "./ThreadBootstrap.ts";

const AT = "2026-10-04T10:00:00.000Z";
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
  parentThreadId: PARENT,
  parentTurnId: TurnId.make("parent-turn"),
  projectId: ProjectId.make("project-1"),
  requestId: REQUEST,
  childThreadId: CHILD,
  childMessageId: MessageId.make("child-message"),
  launch: launch(),
  fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
  createdAt: AT,
  ...patch,
});

/**
 * Durable state as the engine, the read model and git keep it, shared by
 * every run so a second run sees what an interrupted first one left.
 * `crashOn` makes the next matching command fail before it lands, the way a
 * process dying at that moment would leave things.
 */
const makeWorld = () => {
  const receipts = new Map<string, number>();
  const threads = new Map<string, OrchestrationThread>();
  const accepted: OrchestrationCommand[] = [];
  const worktrees: Array<{ path: string; branch: string }> = [];
  const branches = new Set<string>();
  const createWorktreeCalls: unknown[] = [];
  const setupRuns: unknown[] = [];
  let crashOn: ((command: OrchestrationCommand) => boolean) | undefined;

  const apply = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.create":
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          branch: command.branch,
          worktreePath: command.worktreePath,
          activities: [] as ReadonlyArray<OrchestrationThreadActivity>,
          messages: [],
        } as unknown as OrchestrationThread);
        return;
      case "thread.meta.update": {
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, {
          ...thread,
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
        });
        return;
      }
      case "thread.activity.append": {
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, {
          ...thread,
          activities: [...thread.activities, command.activity],
        });
        return;
      }
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
        if (crashOn?.(command)) {
          crashOn = undefined;
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The server went away.",
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
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: (threadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
        }),
        Layer.mock(GitWorkflowService)({
          listWorktrees: () => Effect.succeed(worktrees.map((entry) => ({ ...entry }))),
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
          createWorktree: (request) =>
            Effect.sync(() => {
              createWorktreeCalls.push(request);
              const branch = request.newRefName ?? request.refName;
              branches.add(branch);
              const path = `/worktrees/repo/${branch.split("/").at(-1)}`;
              worktrees.push({ path, branch });
              return { worktree: { path, refName: branch } };
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
    createWorktreeCalls,
    setupRuns,
    crashOn: (predicate: (command: OrchestrationCommand) => boolean) => {
      crashOn = predicate;
    },
    of: (type: OrchestrationCommand["type"]) => accepted.filter((command) => command.type === type),
  };
};

const startChild = (request: ChildBootstrapInput = input()) =>
  Effect.gen(function* () {
    const bootstrap = yield* ThreadBootstrap;
    return yield* bootstrap.startChild(request);
  });

describe("ThreadBootstrap.startChild", () => {
  it.effect("sets a child up in its own worktree and starts its first turn", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* startChild();

      const [create] = world.of("thread.create");
      expect(create).toMatchObject({
        threadId: CHILD,
        parentThreadId: PARENT,
        attachedToParent: true,
        runtimeMode: "auto-accept-edits",
      });
      expect(world.createWorktreeCalls).toEqual([
        { cwd: PROJECT_CWD, refName: BASE, newRefName: childWorktreeBranch(REQUEST), path: null },
      ]);
      expect(world.threads.get(CHILD)?.branch).toMatch(/^threadlines\/[0-9a-f]{8}$/);
      expect(world.setupRuns).toHaveLength(1);
      const [turn] = world.of("thread.turn.start");
      expect(turn).toMatchObject({
        threadId: CHILD,
        message: { messageId: "child-message", text: launch().prompt },
        fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
      });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("resumes after a crash at any stage with one thread, one worktree, one turn", () => {
    const world = makeWorld();
    const crashes: Array<(command: OrchestrationCommand) => boolean> = [
      // After the thread exists, before its worktree is recorded on it.
      (command) => command.type === "thread.meta.update",
      // After the setup script started, before the turn.
      (command) => command.type === "thread.turn.start",
    ];
    return Effect.gen(function* () {
      for (const crash of crashes) {
        world.crashOn(crash);
        const exit = yield* Effect.exit(startChild());
        expect(Exit.isFailure(exit)).toBe(true);
      }
      yield* startChild();
      // Run once more after it finished: answered from the turn's receipt.
      const before = world.accepted.length;
      yield* startChild();

      expect(world.accepted.length).toBe(before);
      expect(world.of("thread.create")).toHaveLength(1);
      expect(world.createWorktreeCalls).toHaveLength(1);
      expect(world.worktrees).toHaveLength(1);
      expect(world.of("thread.meta.update")).toHaveLength(1);
      expect(world.setupRuns).toHaveLength(1);
      expect(world.of("thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("names the stage that failed", () => {
    const world = makeWorld();
    world.crashOn((command) => command.type === "thread.create");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(startChild());
      expect(error.stage).toBe("create");
      expect(error.message).toBe("Couldn't create the thread: The server went away.");
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("skips the worktree and setup for a child in the project folder", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* startChild(input({ launch: launch({ workspace: { kind: "project_folder" } }) }));

      expect(world.createWorktreeCalls).toHaveLength(0);
      expect(world.setupRuns).toHaveLength(0);
      expect(world.threads.get(CHILD)?.activities.map((activity) => activity.kind)).toEqual([
        "setup-script.skipped",
      ]);
      expect(world.of("thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.provide(world.layer));
  });
});
