// Runs the "Slow checkout" story through the real decider with the user's
// clicks synthesized, no app and no waiting. Any command the server would
// refuse fails here first. `node dry-run-child-threads.ts`
import { randomUUID } from "node:crypto";
import { createEngine } from "./engine.ts";
import { createStory, OPUS, THREAD_TITLE } from "./story-child-threads.ts";

const threadId = randomUUID();
const projectId = randomUUID();
const engine = createEngine(async () => {});
const now = () => new Date().toISOString();

await engine.run({
  type: "project.create",
  commandId: "dry:project",
  projectId,
  title: "Orbit",
  workspaceRoot: "/Users/Shared/Threadlines Marketing Studio/Orbit",
  createdAt: now(),
});
await engine.run({
  type: "thread.create",
  commandId: "dry:thread",
  threadId,
  projectId,
  title: THREAD_TITLE,
  modelSelection: OPUS,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now(),
});

const marks: string[] = [];
const snapshots: Record<string, unknown> = {};
const parentState = (label: string) => {
  const parent = engine.thread(threadId);
  snapshots[label] = {
    open: parent.childRequests.open.map((request: any) => request.status),
    queued: (parent.queuedFollowUps ?? []).map((entry: any) => entry.messageId),
    latestTurn: parent.latestTurn && {
      state: parent.latestTurn.state,
      pendingMessageId: parent.latestTurn.pendingMessageId ?? null,
    },
    session: parent.session?.status ?? null,
  };
};
const story = createStory({
  engine,
  threadId,
  ui: {
    registerThread: async () => {},
    async clickStart() {
      const parent = engine.thread(threadId);
      const batchId = parent.childRequests.open[0]?.batchId;
      parentState("before-start");
      await engine.run({
        type: "thread.child-request.respond",
        commandId: `dry:${randomUUID()}`,
        threadId,
        batchId,
        choice: "start",
        createdAt: now(),
      });
      parentState("after-start");
    },
    openFamily: async () => {},
    openThread: async () => {},
    mark: (name) => {
      marks.push(name);
      if (name.startsWith("report-") || name.startsWith("ack-")) parentState(name);
    },
    track: () => {},
    trackSelector: () => {},
    sleep: async () => {},
  },
});

const prologue = await story.prologue();
await story.take(prologue);
const parent = engine.thread(threadId);
console.log(
  JSON.stringify(
    {
      marks,
      snapshots,
      parent: {
        messages: parent.messages.map((m: any) => ({
          role: m.role,
          from: m.fromThread?.kind ?? null,
          text: m.text.slice(0, 50),
        })),
        open: parent.childRequests.open,
        queued: parent.queuedFollowUps,
        session: parent.session?.status,
      },
      children: story.children.map((entry) => {
        const child = engine.thread(entry.threadId);
        return {
          title: child.title,
          parent: child.parentThreadId === threadId,
          attached: child.attachedToParent,
          branch: child.branch,
          worktree: child.worktreePath,
          handedBack: child.handedBackTurnId !== null,
          messages: child.messages.map((m: any) => `${m.role}: ${m.text.slice(0, 40)}`),
        };
      }),
    },
    null,
    1,
  ),
);
