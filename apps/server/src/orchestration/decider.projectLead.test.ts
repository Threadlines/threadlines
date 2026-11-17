import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import { LEAD_MOVE_REFUSAL } from "@threadlines/shared/projectLead";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { isProjectLeadThread } from "./commandInvariants.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { threadMoveRefusals } from "./threadMoveDecisions.ts";

const now = "2026-11-16T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const LEAD = ThreadId.make("lead");
const OTHER = ThreadId.make("other");
const CHILD = ThreadId.make("child");
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" };

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId,
    title: id,
    modelSelection: model,
    runtimeMode: "auto-accept-edits",
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
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    diffStatBaselineTurnCount: 0,
    session: null,
    ...overrides,
  };
}

function readModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        kind: "workspace",
        title: "threadlines",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads,
  };
}

type Planned = Omit<OrchestrationEvent, "sequence">;

async function run(current: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<Planned>;
  let next = current;
  let sequence = current.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { events, model: next };
}

const refusal = async (current: OrchestrationReadModel, command: OrchestrationCommand) => {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : null;
};

const setLead = (threadId: ThreadId | null): OrchestrationCommand => ({
  type: "project.lead.set",
  commandId: CommandId.make(`lead-${threadId ?? "none"}`),
  projectId,
  threadId,
});

const leadOf = (current: OrchestrationReadModel) =>
  current.projects.find((project) => project.id === projectId)?.leadThreadId ?? null;

describe("project lead chat", () => {
  it("names a lead, replaces it in one event, and stops having one", async () => {
    const start = readModel([thread(LEAD), thread(OTHER)]);
    const first = await run(start, setLead(LEAD));
    expect(leadOf(first.model)).toBe(LEAD);
    expect(isProjectLeadThread(first.model, thread(LEAD))).toBe(true);

    const replaced = await run(first.model, setLead(OTHER));
    expect(replaced.events).toHaveLength(1);
    expect(leadOf(replaced.model)).toBe(OTHER);
    expect(isProjectLeadThread(replaced.model, thread(LEAD))).toBe(false);

    const cleared = await run(replaced.model, setLead(null));
    expect(leadOf(cleared.model)).toBeNull();
  });

  it("refuses a thread another thread owns, an archived one, and General Chats", async () => {
    const owned = thread(CHILD, { parentThreadId: LEAD, attachedToParent: true });
    const archived = thread(OTHER, { archivedAt: now });
    const start = readModel([thread(LEAD), owned, archived]);
    expect(await refusal(start, setLead(CHILD))).toContain("belongs to the thread that started");
    expect(await refusal(start, setLead(OTHER))).toContain("Archived threads");

    const generalChats = {
      ...start,
      projects: start.projects.map((project) => ({ ...project, kind: "general-chat" as const })),
    };
    expect(await refusal(generalChats, setLead(LEAD))).not.toBeNull();
  });

  it("ends the lead when its thread is archived or deleted", async () => {
    const start = (await run(readModel([thread(LEAD)]), setLead(LEAD))).model;
    const archived = await run(start, {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: LEAD,
    });
    expect(leadOf(archived.model)).toBeNull();
    // Coming back from the archive does not make it the lead again.
    const unarchived = await run(archived.model, {
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive"),
      threadId: LEAD,
    });
    expect(leadOf(unarchived.model)).toBeNull();

    const deleted = await run(start, {
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: LEAD,
    });
    expect(leadOf(deleted.model)).toBeNull();
  });

  it("reads a pointer at an archived or missing thread as no lead", () => {
    const ghost = readModel([thread(LEAD, { archivedAt: now })]);
    const pointing = {
      ...ghost,
      projects: ghost.projects.map((project) => ({ ...project, leadThreadId: LEAD })),
    };
    expect(isProjectLeadThread(pointing, thread(LEAD))).toBe(false);
    const missing = { ...pointing, threads: [] };
    expect(isProjectLeadThread(missing, thread(LEAD))).toBe(false);
  });

  it("keeps the lead top-level and on this computer", async () => {
    const separated = thread(LEAD, { parentThreadId: OTHER, attachedToParent: false });
    const start = (await run(readModel([thread(OTHER), separated]), setLead(LEAD))).model;
    expect(
      await refusal(start, {
        type: "thread.parent-attachment.set",
        commandId: CommandId.make("attach"),
        threadId: LEAD,
        attached: true,
        createdAt: now,
      }),
    ).toContain("lead chat");

    const lead = start.threads.find((entry) => entry.id === LEAD)!;
    expect(threadMoveRefusals(start, lead)).toContainEqual({
      kind: "blocked",
      code: "lead",
      words: LEAD_MOVE_REFUSAL,
    });
  });
});
