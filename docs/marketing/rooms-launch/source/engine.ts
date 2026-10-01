// A stand-in server for one promo thread. Commands (the app's own, intercepted
// in the renderer, and the agents' scripted ones) run through the server's real
// decider and projector, and the events they produce go to a sink (the
// renderer's store in a take, nothing in a dry run). No provider ever runs.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../../../..");
const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);

const Effect = await load("apps/server/node_modules/effect/dist/Effect.js");
const { decideOrchestrationCommand } = await load("apps/server/src/orchestration/decider.ts");
const { createEmptyReadModel, projectEvent } = await load(
  "apps/server/src/orchestration/projector.ts",
);

type Json = Record<string, any>;
export type Sink = (events: ReadonlyArray<Json>) => Promise<void>;

export function createEngine(sink: Sink) {
  let model: Json = createEmptyReadModel(new Date().toISOString());
  // Above anything the studio server has written: the store orders a
  // thread's messages by sequence.
  let sequence = 50_000_000;
  let chain: Promise<unknown> = Promise.resolve();
  // Events held back inside `batch`, applied together at its end.
  let held: Json[] | null = null;

  const decide = async (command: Json, push: boolean) => {
    let decided: Json | ReadonlyArray<Json>;
    try {
      decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel: model }));
    } catch (error) {
      throw new Error(`${command.type} refused: ${String((error as Error).message ?? error)}`, {
        cause: error,
      });
    }
    const planned = Array.isArray(decided) ? decided : [decided];
    const events: Json[] = [];
    for (const entry of planned) {
      const event = { ...entry, sequence: ++sequence };
      model = await Effect.runPromise(projectEvent(model, event));
      events.push(event);
    }
    if (push && events.length > 0) {
      if (held !== null) held.push(...events);
      else await sink(events);
    }
    return events;
  };

  return {
    /** Decide one command in order with every other. `push: false` keeps it local. */
    run(command: Json, options: { push?: boolean } = {}) {
      const next = chain.then(() => decide(command, options.push ?? true));
      chain = next.catch(() => undefined);
      return next;
    },
    /**
     * Runs `steps` with their events held back, then applies them in one go,
     * the way the app sees a burst of server events arrive together. Keeps
     * split-second states (a turn over, the next not yet started) off screen.
     */
    async batch<T>(steps: () => Promise<T>): Promise<T> {
      if (held !== null) return steps();
      held = [];
      try {
        return await steps();
      } finally {
        await chain;
        const events = held;
        held = null;
        if (events.length > 0) await sink(events);
      }
    },
    thread(threadId: string): Json {
      const thread = model.threads.find((entry: Json) => entry.id === threadId);
      if (!thread) throw new Error(`No thread ${threadId} in the promo model.`);
      return thread;
    },
  };
}
