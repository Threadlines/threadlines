import {
  AgentPageId,
  AgentPageVersionId,
  CommandId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const THREAD = ThreadId.make("thread-pages");

// Only what the page rule reads; the rest of a thread plays no part in it.
const readModelWith = (thread: Partial<OrchestrationThread>): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: THREAD,
        deletedAt: null,
        latestTurn: null,
        session: null,
        messages: [],
        pages: [],
        ...thread,
      },
    ],
  }) as unknown as OrchestrationReadModel;

const publish = (
  turnId: string,
): Extract<OrchestrationCommand, { type: "thread.page.publish" }> => ({
  type: "thread.page.publish",
  commandId: CommandId.make(`cmd-page-${turnId}`),
  threadId: THREAD,
  page: {
    pageId: AgentPageId.make("11111111-1111-4111-8111-111111111111"),
    versionId: AgentPageVersionId.make("22222222-2222-4222-8222-222222222222"),
    version: 1,
    turnId: TurnId.make(turnId),
    participantId: null,
    title: "Funnel",
    kind: "html",
    height: 400,
  },
  createdAt: now,
});

describe("decider page publishing", () => {
  it("shows a page that arrives after its turn ended, while the turn is still in the thread", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: publish("turn-1"),
        // The next turn is already running; turn 1 left its reply behind.
        readModel: readModelWith({
          latestTurn: { turnId: TurnId.make("turn-2") } as OrchestrationThread["latestTurn"],
          messages: [
            { turnId: TurnId.make("turn-1") },
          ] as unknown as OrchestrationThread["messages"],
        }),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;
    expect(event).toMatchObject({ type: "thread.page-published" });
  });

  it("refuses a page whose turn was taken back while it was on its way", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: publish("turn-taken-back"),
          readModel: readModelWith({
            latestTurn: { turnId: TurnId.make("turn-1") } as OrchestrationThread["latestTurn"],
          }),
        }),
      ),
    ).rejects.toThrow(/no longer part of this thread/);
  });
});
