import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SettingsChangeRequestId,
  ThreadId,
  ThreadMoveId,
  ThreadParticipantId,
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

const now = "2026-11-02T10:00:00.000Z";
const at = (second: number) => `2026-11-02T10:00:${String(second).padStart(2, "0")}.000Z`;
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const TURN = TurnId.make("turn-1");
const REVIEWER = ThreadParticipantId.make("reviewer");
const PHONE = { claimId: "claim-phone", deviceLabel: "iPhone" };
const LAPTOP = { claimId: "claim-laptop", deviceLabel: "this computer's app" };

let sequence = 0;
let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCount += 1)}`);

/** Decides `command` and projects what it planned; the refusal's words when it is refused. */
async function apply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{
  readonly model: OrchestrationReadModel;
  readonly events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;
  readonly refusal: string | null;
}> {
  const decided = await Effect.runPromise(
    Effect.result(decideOrchestrationCommand({ command, readModel })),
  );
  if (decided._tag === "Failure") {
    return { model: readModel, events: [], refusal: decided.failure.message };
  }
  const planned = Array.isArray(decided.success) ? decided.success : [decided.success];
  let model = readModel;
  for (const event of planned) {
    sequence += 1;
    model = await Effect.runPromise(
      projectEvent(model, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { model, events: planned, refusal: null };
}

/** Projects an event as the engine would store it. */
async function project(
  model: OrchestrationReadModel,
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
): Promise<OrchestrationReadModel> {
  sequence += 1;
  return Effect.runPromise(
    projectEvent(model, {
      sequence,
      eventId: EventId.make(`evt-${sequence}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type,
      occurredAt: now,
      commandId: nextCommandId(),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { threadId: THREAD, ...payload },
    } as OrchestrationEvent),
  );
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
    title: "Tidy the settings",
    modelSelection,
    runtimeMode: "auto",
    interactionMode: "default",
    branch: "fix/settings",
    worktreePath: "/worktrees/fix-settings",
    createdAt: now,
  }));
  return model;
}

const ask = (
  id: string,
  options: {
    readonly participantId?: ThreadParticipantId | null;
    readonly turnId?: TurnId;
    readonly createdAt?: string;
  } = {},
): OrchestrationCommand => ({
  type: "thread.settings-change.request",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SettingsChangeRequestId.make(id),
  participantId: options.participantId ?? null,
  turnId: options.turnId ?? TURN,
  changes: [
    { place: "general.streamReplies", value: false, from: true },
    { place: "general.theme", value: "light" },
  ],
  createdAt: options.createdAt ?? now,
});

const claim = (id: string, by: typeof PHONE): OrchestrationCommand => ({
  type: "thread.settings-change.claim",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SettingsChangeRequestId.make(id),
  claim: by,
  createdAt: now,
});

const settle = (
  id: string,
  ending: "changed" | "declined" | "failed" | "uncertain",
  claimId?: string,
): OrchestrationCommand => ({
  type: "thread.settings-change.settle",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SettingsChangeRequestId.make(id),
  ending,
  ...(claimId !== undefined ? { claimId } : {}),
  createdAt: now,
});

const report = (id: string, claimId: string): OrchestrationCommand => ({
  type: "thread.settings-change.report-device",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SettingsChangeRequestId.make(id),
  claimId,
  device: { applied: ["general.theme"], failed: [] },
  createdAt: now,
});

const statuses = (model: OrchestrationReadModel) =>
  (model.threads.find((thread) => thread.id === THREAD)?.settingsRequests ?? []).map((request) => [
    request.requestId,
    request.status,
    request.detail,
  ]);

describe("agents' settings changes", () => {
  it("puts a request on the card, replaces the agent's waiting one, and caps an agent at 5 a turn", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, ask("r", { participantId: REVIEWER })));
    ({ model } = await apply(model, ask("b")));
    expect(statuses(model)).toEqual([
      ["a", "replaced", undefined],
      ["r", "waiting", undefined],
      ["b", "waiting", undefined],
    ]);
    // The same request id is one request, never a second card.
    expect((await apply(model, ask("b"))).refusal).toContain("already asked for");
    for (const id of ["c", "d", "e"]) ({ model } = await apply(model, ask(id)));
    expect((await apply(model, ask("f"))).refusal).toContain("at most 5");
    // Another agent, or the next turn, has its own count.
    expect((await apply(model, ask("g", { turnId: TurnId.make("turn-2") }))).refusal).toBeNull();
    // Only settings agents may change ever reach a card.
    const widening = await apply(model, {
      ...ask("h", { turnId: TurnId.make("turn-2") }),
      changes: [{ place: "threads.agentThreads", value: "auto" }],
    } as OrchestrationCommand);
    expect(widening.refusal).toContain("Only the user can change");
  });

  it("lets one answer claim a card; only that claim ends it and reports its device", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, claim("a", PHONE)));
    // A second window's Change, or Not now, loses to the claim.
    expect((await apply(model, claim("a", LAPTOP))).refusal).toContain("already claimed");
    expect((await apply(model, settle("a", "declined"))).refusal).toContain("already claimed");
    expect((await apply(model, settle("a", "changed", LAPTOP.claimId))).refusal).toContain(
      "claimed by another answer",
    );
    expect((await apply(model, settle("a", "changed"))).refusal).toContain(
      "claimed by another answer",
    );
    // No device report until the claim's own answer ended it.
    expect((await apply(model, report("a", PHONE.claimId))).refusal).toContain("hasn't ended");
    ({ model } = await apply(model, settle("a", "changed", PHONE.claimId)));
    expect(statuses(model)).toEqual([["a", "changed", undefined]]);
    expect((await apply(model, report("a", LAPTOP.claimId))).refusal).toContain(
      "wasn't claimed by this answer",
    );
    ({ model } = await apply(model, report("a", PHONE.claimId)));
    expect((await apply(model, report("a", PHONE.claimId))).refusal).toContain(
      "already has its device report",
    );
    // Nothing goes back: an ended card takes no claim or decline.
    expect((await apply(model, claim("a", LAPTOP))).refusal).toContain("already ended");
    expect((await apply(model, settle("b", "declined"))).refusal).toContain("gone");
  });

  it("marks notes delivered only for settled requests, and refuses when none are left", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, ask("r", { participantId: REVIEWER })));
    ({ model } = await apply(model, settle("a", "declined")));
    const deliver = (ids: ReadonlyArray<string>): OrchestrationCommand => ({
      type: "thread.settings-change.deliver-notes",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestIds: ids.map((id) => SettingsChangeRequestId.make(id)),
      createdAt: now,
    });
    const delivered = await apply(model, deliver(["a", "r"]));
    expect(delivered.events.map((event) => event.payload)).toEqual([
      { threadId: THREAD, requestIds: ["a"], deliveredAt: now },
    ]);
    expect((await apply(delivered.model, deliver(["a", "r"]))).refusal).toContain(
      "has a note left to deliver",
    );
  });

  it("cancels waiting cards on archive and leaves a claimed one to finish there", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, ask("r", { participantId: REVIEWER })));
    ({ model } = await apply(model, claim("r", PHONE)));
    ({ model } = await apply(model, {
      type: "thread.archive",
      commandId: nextCommandId(),
      threadId: THREAD,
    }));
    expect(statuses(model)).toEqual([
      ["a", "cancelled", "The thread was archived."],
      ["r", "claimed", undefined],
    ]);
    expect((await apply(model, ask("b"))).refusal).toContain("archived");
    ({ model } = await apply(model, settle("r", "changed", PHONE.claimId)));
    ({ model } = await apply(model, report("r", PHONE.claimId)));
    expect(statuses(model)).toEqual([
      ["a", "cancelled", "The thread was archived."],
      ["r", "changed", undefined],
    ]);
  });

  it("cancels waiting cards when a move starts, and lets a claimed one settle through the freeze", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, ask("r", { participantId: REVIEWER })));
    ({ model } = await apply(model, claim("r", PHONE)));
    ({ model } = await apply(model, {
      type: "thread.move.start",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: ThreadMoveId.make("transfer-1"),
      target: { environmentId: EnvironmentId.make("environment-mac-mini"), label: "Mac mini" },
      agent: modelSelection,
      createdAt: now,
    }));
    expect(statuses(model)).toEqual([
      ["a", "cancelled", "The thread started moving to Mac mini."],
      ["r", "claimed", undefined],
    ]);
    // A frozen thread takes no new card, but the accepted one finishes.
    expect((await apply(model, ask("b"))).refusal).toContain("moving to Mac mini");
    ({ model } = await apply(model, settle("r", "failed", PHONE.claimId)));
    expect((await apply(model, report("r", PHONE.claimId))).refusal).toBeNull();
    expect(statuses(model).at(-1)).toEqual(["r", "failed", undefined]);
  });

  it("cancels on revert only the waiting cards from the turns it undoes", async () => {
    let model = await seeded();
    for (const [turn, count] of [
      ["turn-1", 1],
      ["turn-2", 2],
    ] as const) {
      model = await project(model, "thread.message-sent", {
        messageId: MessageId.make(`user-${count}`),
        role: "user",
        text: `Edit ${count}`,
        turnId: null,
        streaming: false,
        createdAt: at(count * 10),
        updatedAt: at(count * 10),
      });
      model = await project(model, "thread.message-sent", {
        messageId: MessageId.make(`assistant-${count}`),
        role: "assistant",
        text: `Done ${count}`,
        turnId: TurnId.make(turn),
        streaming: false,
        createdAt: at(count * 10 + 2),
        updatedAt: at(count * 10 + 2),
      });
      // Two agents, so the second card doesn't replace the first.
      ({ model } = await apply(
        model,
        ask(`ask-${count}`, {
          participantId: count === 1 ? REVIEWER : null,
          turnId: TurnId.make(turn),
          createdAt: at(count * 10 + 1),
        }),
      ));
      model = await project(model, "thread.turn-diff-completed", {
        turnId: TurnId.make(turn),
        checkpointTurnCount: count,
        checkpointRef: CheckpointRef.make(`refs/threadlines/checkpoints/thread-1/turn/${count}`),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make(`assistant-${count}`),
        completedAt: at(count * 10 + 3),
      });
    }
    ({ model } = await apply(model, {
      type: "thread.revert.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      turnCount: 1,
      createdAt: at(40),
    }));
    expect(statuses(model)).toEqual([
      ["ask-1", "waiting", undefined],
      ["ask-2", "cancelled", "The turn that asked was undone."],
    ]);
  });
});
