// Runs the whole story through the real decider with the user's clicks
// synthesized, no app and no waiting. Any command the server would refuse
// fails here first. `node dry-run.ts`
import { randomUUID } from "node:crypto";
import { createEngine } from "./engine.ts";
import { createStory, OPUS, THREAD_TITLE } from "./story.ts";

const threadId = randomUUID();
const projectId = randomUUID();
const engine = createEngine(async () => {});
const now = () => new Date().toISOString();
const client = (type: string, fields: Record<string, unknown>) =>
  engine.run({ type, commandId: `dry:${randomUUID()}`, threadId, createdAt: now(), ...fields });

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
const story = createStory({
  engine,
  threadId,
  ui: {
    async addAstra() {
      const id = randomUUID();
      await client("thread.participant.add", {
        participant: {
          id,
          handle: "GPT-6-Astra",
          modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        },
      });
      return id;
    },
    async sendTo(agent, text) {
      const astra = engine.thread(threadId).participants.find((p: any) => !p.guest);
      const messageId = randomUUID();
      await client("thread.turn.start", {
        message: { messageId, role: "user", text, attachments: [] },
        ...(agent === "astra"
          ? { participantId: astra.id, modelSelection: astra.modelSelection }
          : { modelSelection: OPUS }),
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      return messageId;
    },
    mark: (name) => marks.push(name),
    track: () => {},
    sleep: async () => {},
  },
});

const prologue = await story.prologue();
await story.take(prologue);
const thread = engine.thread(threadId);
console.log(
  JSON.stringify(
    {
      marks,
      messages: thread.messages.map((m: any) => ({
        role: m.role,
        by: m.participantId ?? null,
        side: m.sideTurnId ?? null,
        kind: m.requestKind ?? null,
        text: m.text.slice(0, 60),
      })),
      participants: thread.participants.map((p: any) => ({
        handle: p.handle,
        guest: p.guest ?? false,
      })),
      openRequests: thread.agentRequests.open,
      session: thread.session,
      queued: thread.queuedFollowUps,
    },
    null,
    1,
  ),
);
