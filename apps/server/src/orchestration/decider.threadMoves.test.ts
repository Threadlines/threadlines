import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-22T10:00:00.000Z";
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const TRANSFER = ThreadMoveId.make("transfer-1");
const MAC_MINI = { environmentId: EnvironmentId.make("environment-mac-mini"), label: "Mac mini" };

let sequence = 0;
let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCount += 1)}`);

/** Decides `command` and projects what it planned; the refusal's words when it is refused. */
async function apply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{ readonly model: OrchestrationReadModel; readonly refusal: string | null }> {
  const decided = await Effect.runPromise(
    Effect.result(decideOrchestrationCommand({ command, readModel })),
  );
  if (decided._tag === "Failure") return { model: readModel, refusal: decided.failure.message };
  const planned = Array.isArray(decided.success) ? decided.success : [decided.success];
  let model = readModel;
  for (const event of planned) {
    sequence += 1;
    model = await Effect.runPromise(
      projectEvent(model, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { model, refusal: null };
}

async function seeded(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(now);
  ({ model } = await apply(model, {
    type: "project.create",
    commandId: nextCommandId(),
    projectId: PROJECT,
    title: "Threadlines",
    workspaceRoot: "/repo",
    createdAt: now,
  }));
  ({ model } = await apply(model, {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: THREAD,
    projectId: PROJECT,
    title: "Fix the flaky test",
    modelSelection,
    runtimeMode: "auto",
    interactionMode: "default",
    branch: "fix/flaky",
    worktreePath: "/worktrees/fix-flaky",
    createdAt: now,
  }));
  return model;
}

const rename = (title: string): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: nextCommandId(),
  threadId: THREAD,
  title,
});

const startMove = (threadId: ThreadId = THREAD): OrchestrationCommand => ({
  type: "thread.move.start",
  commandId: nextCommandId(),
  threadId,
  transferId: TRANSFER,
  target: MAC_MINI,
  agent: modelSelection,
  createdAt: now,
});

const threadOf = (model: OrchestrationReadModel, threadId = THREAD) =>
  model.threads.find((thread) => thread.id === threadId)!;

describe("moving a thread to a linked computer", () => {
  it("freezes the thread while it moves, and unfreezes it only when the move is dropped", async () => {
    let { model } = await apply(await seeded(), startMove());
    expect(threadOf(model).move).toMatchObject({
      transferId: TRANSFER,
      phase: "exporting",
      target: MAC_MINI,
    });

    const frozen = await apply(model, rename("Something else"));
    expect(frozen.refusal).toContain("moving to Mac mini");
    // Filing it away still works.
    expect(
      (
        await apply(model, {
          type: "thread.pin",
          commandId: nextCommandId(),
          threadId: THREAD,
          createdAt: now,
        } as OrchestrationCommand)
      ).refusal,
    ).toBeNull();

    ({ model } = await apply(model, {
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      reason: "Mac mini didn't allow the move.",
      createdAt: now,
    }));
    expect(threadOf(model).move ?? null).toBeNull();
    expect(threadOf(model).activities.at(-1)).toMatchObject({
      kind: "thread.move-failed",
      summary: "Couldn't move to Mac mini",
    });
    expect((await apply(model, rename("Something else"))).refusal).toBeNull();
  });

  it("keeps a moved thread read-only for good", async () => {
    let { model } = await apply(await seeded(), startMove());
    ({ model } = await apply(model, {
      type: "thread.move.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      movedThreadId: ThreadId.make("thread-there"),
      createdAt: now,
    }));
    expect(threadOf(model).move?.movedAway).toMatchObject({ threadId: "thread-there" });
    expect((await apply(model, rename("x"))).refusal).toContain("moved to Mac mini");
    // A late abort can't undo it, and a cancel has nothing to stop.
    expect(
      (
        await apply(model, {
          type: "thread.move.abort",
          commandId: nextCommandId(),
          threadId: THREAD,
          transferId: TRANSFER,
          reason: "late",
          createdAt: now,
        })
      ).refusal,
    ).toContain("can't be undone");
  });

  it("refuses to freeze a thread that can't move, and a frozen parent takes no child", async () => {
    let model = await seeded();
    // A child attached to its parent can't move on its own.
    ({ model } = await apply(model, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: ThreadId.make("thread-child"),
      projectId: PROJECT,
      title: "Child",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand));
    expect((await apply(model, startMove(ThreadId.make("thread-child")))).refusal).toContain(
      "belongs to the thread that started it",
    );
    // Nor can the parent, while it has the child.
    expect((await apply(model, startMove())).refusal).toContain("started other threads");

    let lone = await seeded();
    ({ model: lone } = await apply(lone, startMove()));
    const child = await apply(lone, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: ThreadId.make("thread-late-child"),
      projectId: PROJECT,
      title: "Late child",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand);
    expect(child.refusal).toContain("moving to Mac mini");
  });

  it("imports a moved thread with its history once, owing its agent the conversation", async () => {
    const model = await seeded();
    const ARRIVED = ThreadId.make("thread-arrived");
    const importCommand = (): OrchestrationCommand => ({
      type: "thread.import",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      projectId: PROJECT,
      title: "Fix the flaky test",
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      branch: "fix/flaky",
      worktreePath: "/worktrees/moved-1",
      movedFrom: {
        environmentId: EnvironmentId.make("environment-windows"),
        label: "Windows PC",
        threadId: THREAD,
        movedAt: now,
      },
      messages: [
        {
          messageId: MessageId.make("moved-message-1"),
          role: "user",
          text: "Why does it flake?",
          turnId: null,
          createdAt: now,
        },
        {
          messageId: MessageId.make("moved-message-2"),
          role: "assistant",
          text: "A timer races the click.",
          turnId: TurnId.make("moved-turn-1"),
          createdAt: now,
        },
      ],
      activities: [
        {
          id: EventId.make("moved-activity-1"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran the test",
          payload: {},
          turnId: TurnId.make("moved-turn-1"),
          createdAt: now,
        },
      ],
      createdAt: now,
    });
    const { model: after, refusal } = await apply(model, importCommand());
    expect(refusal).toBeNull();
    const arrived = threadOf(after, ARRIVED);
    expect(arrived.movedFrom).toMatchObject({ label: "Windows PC", threadId: THREAD });
    expect(arrived.historySeedOwed).toBe(true);
    expect(arrived.messages.map((message) => [message.text, message.imported])).toEqual([
      ["Why does it flake?", true],
      ["A timer races the click.", true],
    ]);
    // Tool steps carry no turn of this computer's, so every revert keeps them.
    expect(arrived.activities.map((activity) => [activity.kind, activity.turnId])).toEqual([
      ["tool.completed", null],
      ["thread.moved-in", null],
    ]);
    expect((await apply(after, importCommand())).refusal).toContain("already exists");

    const { model: seeded2 } = await apply(after, {
      type: "thread.history-seed.delivered",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      createdAt: now,
    });
    expect(threadOf(seeded2, ARRIVED).historySeedOwed).toBe(false);
  });
});
