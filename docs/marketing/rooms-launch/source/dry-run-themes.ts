// Runs the themes story through the real decider with the user's side
// synthesized, no app and no waiting. Any command the server would refuse
// fails here first (the agent's turns, the two versions of the offered
// theme's page). What happens in the app's page (the picker, the trial, the
// Share dialog) is not played: those calls answer at once. `node dry-run-themes.ts`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEngine } from "./engine.ts";

// The story reads its theme files when it dresses the studio; the decider
// never sees them, so empty stand-ins do unless real ones are given.
if (!process.env.PROMO_THEMES_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-themes-"));
  for (const name of ["honu-v1", "honu-v2", "speedcube"]) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name }));
  }
  process.env.PROMO_THEMES_DIR = dir;
}
const { createStory, OPUS, THREAD_TITLE } = await import("./story-themes.ts");

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
const story = createStory({
  engine,
  threadId,
  ui: {
    mark: (name) => marks.push(name),
    sleep: async () => {},
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
    track: () => {},
    trackSelector: () => {},
    // The page isn't there: nothing shows, no trial runs, every wait is over.
    evaluate: async () => ({ name: "", trial: false }) as never,
    clickOn: async () => {},
    hoverOn: async () => {},
    dragAlong: async () => {},
    type: async () => {},
    press: async () => {},
    focusComposer: async () => {},
    blur: async () => {},
    steady: async () => {},
    rest: async () => {},
    until: async () => {},
    openThread: async () => {},
    narrow: false,
  },
});

await story.prologue();
await story.take();
const thread = engine.thread(threadId);
console.log(
  JSON.stringify(
    {
      marks,
      messages: thread.messages.map((m: any) => ({ role: m.role, text: m.text.slice(0, 70) })),
      pages: (thread.pages ?? []).map((page: any) => ({
        title: page.title,
        kind: page.kind,
        version: page.version,
      })),
      session: thread.session?.status,
    },
    null,
    1,
  ),
);
