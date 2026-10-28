// Runs the "Screenshots on Windows" story through the real decider for both
// computers with the user's click synthesized, no app and no waiting. Any
// command either server would refuse fails here first. `node dry-run-fleet.ts`
import { randomUUID } from "node:crypto";
import { createEngine } from "./engine.ts";
import { createStory, OPUS, PROJECT_NAME, THREAD_TITLE, type FleetPc } from "./story-fleet.ts";

const threadId = randomUUID();
const macProjectId = randomUUID();
const engine = createEngine(async () => {});
const pcEngine = createEngine(async () => {});
const now = () => new Date().toISOString();
const pc: FleetPc = {
  environmentId: randomUUID(),
  label: "Windows PC",
  macLabel: "MacBook Pro",
  macEnvironmentId: randomUUID(),
  linkDeviceId: randomUUID(),
  projectId: randomUUID(),
  projectCwd: "/tmp/tl-080/pc/threadlines",
  worktreesDir: "/tmp/tl-080/pc/worktrees",
};

await engine.run({
  type: "project.create",
  commandId: "dry:project",
  projectId: macProjectId,
  title: PROJECT_NAME,
  workspaceRoot: "/Users/Shared/Threadlines Marketing Studio/threadlines",
  createdAt: now(),
});
await pcEngine.run({
  type: "project.create",
  commandId: "dry:pc-project",
  projectId: pc.projectId,
  title: PROJECT_NAME,
  workspaceRoot: pc.projectCwd,
  createdAt: now(),
});
await engine.run({
  type: "thread.create",
  commandId: "dry:thread",
  threadId,
  projectId: macProjectId,
  title: THREAD_TITLE,
  modelSelection: OPUS,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now(),
});

const snapshots: Record<string, unknown> = {};
const parentState = (label: string) => {
  const parent = engine.thread(threadId);
  snapshots[label] = {
    open: parent.childRequests.open.map((request: any) => ({
      status: request.status,
      remote: request.remote ?? null,
    })),
    remoteChildren: (parent.childRequests.remoteChildren ?? []).map(
      (entry: any) => `${entry.label}: ${entry.cachedStatus}`,
    ),
    session: parent.session?.status ?? null,
  };
};
const marks: string[] = [];
const story = createStory({
  engine,
  pcEngine,
  threadId,
  pc,
  ui: {
    async send(text) {
      const messageId = randomUUID();
      await engine.run({
        type: "thread.turn.start",
        commandId: `dry:${randomUUID()}`,
        threadId,
        message: { messageId, role: "user", text, attachments: [] },
        modelSelection: OPUS,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now(),
      });
      return { messageId };
    },
    registerThread: async () => {},
    async clickStart() {
      const parent = engine.thread(threadId);
      parentState("before-start");
      await engine.run({
        type: "thread.child-request.respond",
        commandId: `dry:${randomUUID()}`,
        threadId,
        batchId: parent.childRequests.open[0]?.batchId,
        choice: "start",
        createdAt: now(),
      });
      parentState("after-start");
    },
    openFamily: async () => {},
    openThread: async () => {},
    openFleet: async () => {},
    unfoldReport: async () => {},
    openFromFleet: async () => {},
    mark: (name) => {
      marks.push(name);
      if (["started", "peek", "report", "end"].includes(name)) parentState(name);
    },
    track: () => {},
    trackSelector: () => {},
    sleep: async () => {},
  },
});

await story.prologue();
await story.take();
const parent = engine.thread(threadId);
const pcThread = pcEngine.thread(story.child.threadId);
console.log(
  JSON.stringify(
    {
      marks,
      snapshots,
      parent: parent.messages.map(
        (m: any) =>
          `${m.role}${m.fromThread ? ` (from ${m.fromThread.kind})` : ""}: ${m.text.slice(0, 60)}`,
      ),
      pc: {
        title: pcThread.title,
        remoteOrigin: pcThread.remoteOrigin,
        branch: pcThread.branch,
        worktree: pcThread.worktreePath,
        session: pcThread.session?.status,
        messages: pcThread.messages.map((m: any) => `${m.role}: ${m.text.slice(0, 50)}`),
      },
    },
    null,
    1,
  ),
);
