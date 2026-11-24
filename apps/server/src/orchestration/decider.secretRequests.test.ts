import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SecretRequestId,
  ThreadId,
  ThreadMoveId,
  ThreadParticipantId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type SecretRequestUse,
} from "@threadlines/contracts";
import { secretAnswerMessageId } from "@threadlines/shared/secretRequests";
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
const FOLDER = "/worktrees/fix-checkout";
const REVIEWER = ThreadParticipantId.make("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e");
const PHONE = { claimId: "claim-phone", deviceLabel: "iPhone" };
const LAPTOP = { claimId: "claim-laptop", deviceLabel: "this computer's app" };
const ENV_LOCAL: SecretRequestUse = { kind: "env_file", path: ".env.local" };

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

/** The agent at work, as the provider reactor would record it. */
async function working(
  model: OrchestrationReadModel,
  participantId: ThreadParticipantId | null,
  turnId: TurnId,
): Promise<OrchestrationReadModel> {
  sequence += 1;
  return Effect.runPromise(
    projectEvent(model, {
      sequence,
      eventId: EventId.make(`evt-${sequence}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type: "thread.session-set",
      occurredAt: now,
      commandId: nextCommandId(),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: THREAD,
        session: {
          threadId: THREAD,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          participantId,
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
      },
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
    title: "Fix checkout",
    modelSelection,
    runtimeMode: "auto",
    interactionMode: "default",
    branch: "fix/checkout",
    worktreePath: FOLDER,
    createdAt: now,
  }));
  return model;
}

/** A room with the reviewer in it. */
async function withReviewer(): Promise<OrchestrationReadModel> {
  const { model } = await apply(await seeded(), {
    type: "thread.participant.add",
    commandId: nextCommandId(),
    threadId: THREAD,
    participant: { id: REVIEWER, handle: "reviewer", modelSelection },
    createdAt: now,
  });
  return model;
}

const removeReviewer = (): OrchestrationCommand => ({
  type: "thread.participant.remove",
  commandId: nextCommandId(),
  threadId: THREAD,
  participantId: REVIEWER,
  createdAt: now,
});

const ask = (
  id: string,
  options: {
    readonly participantId?: ThreadParticipantId | null;
    readonly turnId?: TurnId;
    readonly name?: string;
    readonly use?: SecretRequestUse;
    readonly bound?: boolean;
    readonly createdAt?: string;
  } = {},
): OrchestrationCommand => ({
  type: "thread.secret-request.request",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SecretRequestId.make(id),
  participantId: options.participantId ?? null,
  turnId: options.turnId ?? TURN,
  name: options.name ?? "STRIPE_SECRET_KEY",
  reason: "To run the checkout tests.",
  use: options.use ?? ENV_LOCAL,
  replaces: false,
  ...(options.bound === false ? {} : { folder: FOLDER, parent: FOLDER }),
  createdAt: options.createdAt ?? now,
});

const claim = (id: string, by: typeof PHONE = PHONE): OrchestrationCommand => ({
  type: "thread.secret-request.claim",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SecretRequestId.make(id),
  claim: by,
  createdAt: now,
});

const settle = (
  id: string,
  ending: "saved" | "failed" | "uncertain" | "declined",
  options: { readonly by?: typeof PHONE; readonly text?: string } = {},
): OrchestrationCommand => ({
  type: "thread.secret-request.settle",
  commandId: nextCommandId(),
  threadId: THREAD,
  requestId: SecretRequestId.make(id),
  ending,
  claim: options.by ?? PHONE,
  ...(ending === "saved" ? { savedAt: now } : {}),
  ...(options.text !== undefined
    ? { message: { messageId: secretAnswerMessageId(id), text: options.text } }
    : {}),
  createdAt: now,
});

const SAVED_TEXT = "I saved STRIPE_SECRET_KEY to .env.local.";

const threadOf = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === THREAD);

const statuses = (model: OrchestrationReadModel) =>
  (threadOf(model)?.secretRequests ?? []).map((request) => [
    request.requestId,
    request.status,
    request.detail,
  ]);

describe("agents' secret requests", () => {
  it("puts a request on the card and replaces the waiting one for the same name and use, whoever asked", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(
      model,
      ask("other-file", { use: { kind: "env_file", path: ".env" } }),
    ));
    const replacing = await apply(model, ask("b", { participantId: REVIEWER }));
    ({ model } = replacing);
    expect(statuses(model)).toEqual([
      ["a", "replaced", undefined],
      ["other-file", "waiting", undefined],
      ["b", "waiting", undefined],
    ]);
    expect(replacing.events[0]?.payload).toMatchObject({ replaces: ["a"] });
    // One being saved is never replaced: the agent waits for it.
    ({ model } = await apply(model, claim("b")));
    expect((await apply(model, ask("c"))).refusal).toContain("saving STRIPE_SECRET_KEY right now");
  });

  it("caps an agent at 5 requests a turn and a thread at 5 waiting cards", async () => {
    let model = await seeded();
    for (const index of [1, 2, 3, 4, 5]) {
      ({ model } = await apply(model, ask(`a${index}`, { name: `KEY_${index}` })));
    }
    // Five waiting: a sixth is refused, wherever it comes from, unless it replaces one.
    const otherTurn = { participantId: REVIEWER, turnId: TurnId.make("turn-2") };
    expect((await apply(model, ask("x", { ...otherTurn, name: "KEY_6" }))).refusal).toContain(
      "already waiting",
    );
    expect((await apply(model, ask("y", { ...otherTurn, name: "KEY_1" }))).refusal).toBeNull();
    for (const index of [1, 2, 3, 4, 5]) {
      ({ model } = await apply(model, settle(`a${index}`, "declined")));
    }
    // Answered ones still count toward the turn's five.
    expect((await apply(model, ask("a6", { name: "KEY_6" }))).refusal).toContain(
      "at most 5 keys in one turn",
    );
    expect((await apply(model, ask("z", { ...otherTurn, name: "KEY_6" }))).refusal).toBeNull();
  });

  it("refuses an unbound env file, a name browsers see, and an archived thread", async () => {
    const model = await seeded();
    expect((await apply(model, ask("a", { bound: false }))).refusal).toContain("needs the folders");
    // A key for commands is bound to no folder.
    expect(
      (await apply(model, ask("a", { bound: false, use: { kind: "commands" } }))).refusal,
    ).toBeNull();
    expect((await apply(model, ask("a", { name: "VITE_STRIPE_KEY" }))).refusal).toContain(
      "sent to browsers",
    );
    const { model: archived } = await apply(model, {
      type: "thread.archive",
      commandId: nextCommandId(),
      threadId: THREAD,
    });
    expect((await apply(archived, ask("a"))).refusal).toContain("archived");
  });

  it("lets the first Save claim a card, and only that claim save it", async () => {
    let { model } = await apply(await seeded(), ask("a"));
    ({ model } = await apply(model, ask("b", { name: "GH_TOKEN" })));
    expect((await apply(model, settle("b", "saved"))).refusal).toContain("isn't claimed yet");
    ({ model } = await apply(model, claim("a", PHONE)));
    expect((await apply(model, claim("a", LAPTOP))).refusal).toContain("already claimed");
    expect((await apply(model, settle("a", "declined", { by: LAPTOP }))).refusal).toContain(
      "already claimed",
    );
    expect((await apply(model, settle("a", "saved", { by: LAPTOP }))).refusal).toContain(
      "claimed by another answer",
    );
    ({ model } = await apply(model, settle("a", "saved")));
    expect(threadOf(model)?.secretRequests?.[0]).toMatchObject({
      status: "saved",
      claim: PHONE,
    });
    // Not now records the app that said it; nothing ends twice or goes back.
    ({ model } = await apply(model, settle("b", "declined", { by: LAPTOP })));
    expect(threadOf(model)?.secretRequests?.[1]).toMatchObject({
      status: "declined",
      claim: LAPTOP,
    });
    expect((await apply(model, claim("b"))).refusal).toContain("already ended (declined)");
    expect((await apply(model, settle("a", "failed"))).refusal).toContain("already ended");
    // A replaced card takes no claim.
    ({ model } = await apply(model, ask("c", { name: "NPM_TOKEN" })));
    ({ model } = await apply(model, ask("d", { name: "NPM_TOKEN" })));
    expect((await apply(model, claim("c"))).refusal).toContain("already ended (replaced)");
  });

  it("steers the answer into the asking agent's running turn, in the same decision", async () => {
    let { model } = await apply(await withReviewer(), ask("a", { participantId: REVIEWER }));
    ({ model } = await apply(model, claim("a")));
    model = await working(model, REVIEWER, TurnId.make("turn-2"));
    const { events } = await apply(model, settle("a", "saved", { text: SAVED_TEXT }));
    expect(events.map((event) => event.type)).toEqual([
      "thread.secret-request-settled",
      "thread.follow-up-submitted",
    ]);
    expect(events[0]?.payload).toMatchObject({ ending: "saved", noted: true });
    expect(events[1]?.payload).toMatchObject({
      turnId: "turn-2",
      messageId: "secret-answer:a",
      text: SAVED_TEXT,
      participantId: REVIEWER,
    });
  });

  it("queues the answer for an asking agent that isn't at work", async () => {
    let { model } = await apply(await withReviewer(), ask("a", { participantId: REVIEWER }));
    ({ model } = await apply(model, claim("a")));
    // Another agent's turn is running: the answer waits for the reviewer's.
    model = await working(model, null, TurnId.make("turn-2"));
    const { events } = await apply(model, settle("a", "saved", { text: SAVED_TEXT }));
    expect(events.map((event) => event.type)).toEqual([
      "thread.secret-request-settled",
      "thread.follow-up-queued",
    ]);
    expect(events[0]?.payload).toMatchObject({ noted: true });
    expect(events[1]?.payload).toMatchObject({
      followUp: { messageId: "secret-answer:a", text: SAVED_TEXT, participantId: REVIEWER },
    });
  });

  it("tells nobody when the asking agent left, and never hands its queued answer to another", async () => {
    // Left before the user saved: settled and noted, no message.
    let { model } = await apply(await withReviewer(), ask("a", { participantId: REVIEWER }));
    ({ model } = await apply(model, claim("a")));
    ({ model } = await apply(model, removeReviewer()));
    const late = await apply(model, settle("a", "saved", { text: SAVED_TEXT }));
    expect(late.events.map((event) => event.type)).toEqual(["thread.secret-request-settled"]);
    expect(late.events[0]?.payload).toMatchObject({ noted: true });

    // Left after its answer was queued: the drain takes it back.
    ({ model } = await apply(await withReviewer(), ask("b", { participantId: REVIEWER })));
    ({ model } = await apply(model, claim("b")));
    ({ model } = await apply(model, settle("b", "saved", { text: SAVED_TEXT })));
    ({ model } = await apply(model, removeReviewer()));
    expect(threadOf(model)?.queuedFollowUps?.map((queued) => queued.messageId)).toEqual([
      "secret-answer:b",
    ]);
    const drained = await apply(model, {
      type: "thread.follow-up.send-queued",
      commandId: nextCommandId(),
      threadId: THREAD,
      messageId: MessageId.make("secret-answer:b"),
      createdAt: now,
    });
    expect(drained.events.map((event) => [event.type, event.payload])).toEqual([
      [
        "thread.follow-up-unqueued",
        expect.objectContaining({ messageId: "secret-answer:b", reason: "cancelled" }),
      ],
    ]);
  });

  it("finishes a claimed card on an archived thread without waking anyone, and cancels the waiting ones", async () => {
    let { model } = await apply(await seeded(), ask("waiting"));
    ({ model } = await apply(model, ask("claimed", { name: "GH_TOKEN" })));
    ({ model } = await apply(model, claim("claimed")));
    ({ model } = await apply(model, {
      type: "thread.archive",
      commandId: nextCommandId(),
      threadId: THREAD,
    }));
    expect(statuses(model)).toEqual([
      ["waiting", "cancelled", "The thread was archived."],
      ["claimed", "claimed", undefined],
    ]);
    const settled = await apply(model, settle("claimed", "saved", { text: SAVED_TEXT }));
    expect(settled.events.map((event) => event.type)).toEqual(["thread.secret-request-settled"]);
    // It hears how it ended as a note at its next turn.
    expect(threadOf(settled.model)?.secretRequests?.[1]).toMatchObject({
      status: "saved",
      noted: false,
    });
  });

  it("cancels waiting cards when a move starts", async () => {
    let { model } = await apply(await seeded(), ask("waiting"));
    ({ model } = await apply(model, ask("claimed", { name: "GH_TOKEN" })));
    ({ model } = await apply(model, claim("claimed")));
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
      ["waiting", "cancelled", "The thread started moving to Mac mini."],
      ["claimed", "claimed", undefined],
    ]);
  });

  it("cancels on revert only the waiting cards from turns it doesn't keep", async () => {
    let model = await seeded();
    for (const turn of ["turn-1", "turn-2"]) {
      ({ model } = await apply(
        model,
        ask(turn, { name: `KEY_${turn.slice(-1)}`, turnId: TurnId.make(turn) }),
      ));
    }
    ({ model } = await apply(model, {
      type: "thread.revert.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      turnCount: 1,
      keptTurnIds: [TurnId.make("turn-1")],
      createdAt: at(40),
    }));
    expect(statuses(model)).toEqual([
      ["turn-1", "waiting", undefined],
      ["turn-2", "cancelled", "The turn that asked was undone."],
    ]);
  });

  it("cancels a leaving agent's waiting cards with nobody to tell, and leaves the others", async () => {
    let { model } = await apply(await withReviewer(), ask("theirs", { participantId: REVIEWER }));
    ({ model } = await apply(model, ask("mine", { name: "GH_TOKEN" })));
    ({ model } = await apply(model, removeReviewer()));
    expect(
      (threadOf(model)?.secretRequests ?? []).map((request) => [
        request.requestId,
        request.status,
        request.noted,
      ]),
    ).toEqual([
      ["theirs", "cancelled", true],
      ["mine", "waiting", false],
    ]);
  });

  it("marks notes delivered only for settled requests not told yet", async () => {
    let { model } = await apply(await seeded(), ask("declined"));
    ({ model } = await apply(model, ask("open", { name: "GH_TOKEN" })));
    ({ model } = await apply(model, settle("declined", "declined")));
    const deliver = (ids: ReadonlyArray<string>): OrchestrationCommand => ({
      type: "thread.secret-request.deliver-notes",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestIds: ids.map((id) => SecretRequestId.make(id)),
      createdAt: now,
    });
    const delivered = await apply(model, deliver(["declined", "open"]));
    expect(delivered.events.map((event) => event.payload)).toEqual([
      { threadId: THREAD, requestIds: ["declined"], deliveredAt: now },
    ]);
    expect((await apply(delivered.model, deliver(["declined", "open"]))).refusal).toContain(
      "has a note left to deliver",
    );
  });
});
