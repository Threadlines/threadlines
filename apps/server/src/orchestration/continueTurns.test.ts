import {
  ChildRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RESTART_CONTINUE_MESSAGE, restartContinueVerdict } from "./continueTurns.ts";

const now = "2026-01-01T01:00:00.000Z";
const threadId = ThreadId.make("thread-restart");

function userMessage(
  id: string,
  createdAt: string,
  fields: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: "words",
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  };
}

function cutThread(
  messages: ReadonlyArray<OrchestrationMessage>,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-restart"),
    title: "Restart",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    pullRequestAutoFix: false,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    parentThreadId: null,
    parentTurnId: null,
    attachedToParent: false,
    parentAttachmentEpoch: 0,
    handedBackAt: null,
    handedBackTurnId: null,
    archivedWithParentAt: null,
    childRequests: EMPTY_CHILD_REQUEST_STATE,
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
    deletedAt: null,
    messages: [...messages],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "interrupted",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    ...overrides,
  } as OrchestrationThread;
}

const verdict = (
  thread: OrchestrationThread,
  input: Partial<Parameters<typeof restartContinueVerdict>[1]> = {},
) =>
  restartContinueVerdict(thread, {
    turnStarted: true,
    participantId: null,
    waitingOnUser: false,
    settingOn: true,
    now,
    ...input,
  });

const withSessionStatus = (
  thread: OrchestrationThread,
  status: NonNullable<OrchestrationThread["session"]>["status"],
): OrchestrationThread => ({ ...thread, session: { ...thread.session!, status } });

const minutesAgo = (minutes: number) =>
  new Date(Date.parse(now) - minutes * 60 * 1000).toISOString();

describe("restartContinueVerdict", () => {
  it("continues a turn the user typed, and a continue of one, until restarts loop", () => {
    const typed = userMessage("typed", minutesAgo(30), { composer: "typed" });
    const restartContinue = (id: string, at: string) =>
      userMessage(id, at, { text: RESTART_CONTINUE_MESSAGE, trigger: "serverRestart" });

    expect(verdict(cutThread([typed]))).toEqual({ kind: "continue", participantId: null });
    // Startup's reaper marks the interrupted session stopped before this runs.
    expect(verdict(withSessionStatus(cutThread([typed]), "stopped")).kind).toBe("continue");
    // A turn the user started since: neither continue nor note.
    expect(verdict(withSessionStatus(cutThread([typed]), "running")).kind).toBe("movedOn");
    expect(verdict(cutThread([typed, restartContinue("c1", minutesAgo(3))]))).toEqual({
      kind: "continue",
      participantId: null,
    });
    // Three continues in five minutes, each cut off again: stop trying.
    expect(
      verdict(
        cutThread([
          typed,
          restartContinue("c1", minutesAgo(4)),
          restartContinue("c2", minutesAgo(2)),
          restartContinue("c3", minutesAgo(1)),
        ]),
      ).kind,
    ).toBe("note");
    // The same three spread over more than the window keep going.
    expect(
      verdict(
        cutThread([
          typed,
          restartContinue("c1", minutesAgo(20)),
          restartContinue("c2", minutesAgo(2)),
          restartContinue("c3", minutesAgo(1)),
        ]),
      ).kind,
    ).toBe("continue");
  });

  it("leaves a note when the turn waited on the user or wasn't the user's", () => {
    const typed = userMessage("typed", minutesAgo(1), { composer: "typed" });
    expect(verdict(cutThread([typed]), { waitingOnUser: true }).kind).toBe("note");

    // Another thread's request: continuing it would not answer that thread.
    const fromParent = userMessage("request", minutesAgo(1), {
      fromThread: {
        kind: "request",
        threadId: ThreadId.make("parent"),
        requestId: ChildRequestId.make("child-request-1"),
      },
    });
    expect(verdict(cutThread([fromParent])).kind).toBe("note");

    expect(verdict(cutThread([typed], { archivedAt: now })).kind).toBe("note");
    expect(verdict(cutThread([typed]), { settingOn: false }).kind).toBe("note");
    // The agent never got the message: "continue" would lose it.
    expect(verdict(cutThread([typed]), { turnStarted: false }).kind).toBe("note");
  });

  it("judges a continue by the turn the restart cut, not the newest message (finding 7)", () => {
    const typed = userMessage("typed", minutesAgo(30), { composer: "typed" });
    // A check-back's turn was cut: it started with no message, so no continue.
    expect(verdict(cutThread([typed]), { turnMessageId: null }).kind).toBe("note");
    // The person's own turn was cut: it continues.
    expect(verdict(cutThread([typed]), { turnMessageId: MessageId.make("typed") }).kind).toBe(
      "continue",
    );
  });
});
