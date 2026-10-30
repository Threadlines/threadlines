import { DEFAULT_SERVER_SETTINGS } from "@threadlines/contracts";
import { isPlaceId } from "@threadlines/shared/appPlaces";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { topicPlaceIds } from "../guide/appGuide.ts";
import { GUIDE_TOPICS } from "../guide/topics.ts";
import { type GuideToolDeps, makeGuideToolHandler } from "./guideToolHandlers.ts";

/** Readers that count their reads, so a test can see which values an answer needed. */
function readers(overrides: Partial<GuideToolDeps> = {}) {
  const reads: string[] = [];
  const counted =
    <A>(name: string, value: A) =>
    () =>
      Effect.sync(() => {
        reads.push(name);
        return value;
      });
  const deps: GuideToolDeps = {
    computerName: Effect.succeed("Denys's MacBook Pro"),
    settings: Effect.suspend(
      counted("settings", { ...DEFAULT_SERVER_SETTINGS, agentThreads: "ask" as const }),
    ),
    linkedComputers: Effect.suspend(
      counted("linkedComputers", [
        {
          name: "Wilfredo",
          reachable: false,
          theirAgentsHere: { access: "allowed" as const, maxRuntimeMode: "auto" as const },
          ourAgentsThere: {
            access: "ask" as const,
            maxRuntimeMode: "full-access" as const,
            fresh: false,
          },
        },
      ]),
    ),
    providers: Effect.suspend(counted("providers", [])),
    outsideAgents: Effect.suspend(counted("outsideAgents", [])),
    scheduledTasks: Effect.suspend(counted("scheduledTasks", { active: 0, paused: 0 })),
    ...overrides,
  };
  return { guide: makeGuideToolHandler(deps), reads };
}

describe("app_guide", () => {
  it("finds a setting from plain words, with where it is, its link and its value here", async () => {
    const { guide, reads } = readers();
    const result = await Effect.runPromise(guide({ query: "why can't you start threads" }));
    expect(result.outcome).toBe("ok");
    expect(result.answer).toContain(
      "[Settings › Threads › New threads › Agents can start threads](threadlines-place:threads.agentThreads)",
    );
    expect(result.answer).toContain("Now on Denys's MacBook Pro: Ask me first");
    // Only what an answer shows is read: none of this computer's values for the theme.
    reads.length = 0;
    await Effect.runPromise(guide({ query: "dark mode" }));
    expect(reads).toEqual([]);
  });

  it("says what each linked computer allows in both directions, and when a value is old", async () => {
    const { guide } = readers();
    const result = await Effect.runPromise(
      guide({ query: "let your agents work on my windows pc" }),
    );
    expect(result.answer).toContain("threadlines-place:fleet.worksWith");
    expect(result.answer).toContain(
      "Wilfredo (offline): its agents on Denys's MacBook Pro: Allowed, up to Auto; Denys's MacBook Pro's agents on it: Ask first, up to Full access (as last seen).",
    );
  });

  it("answers without a value it couldn't read", async () => {
    const { guide } = readers({ settings: Effect.succeed(undefined) });
    const result = await Effect.runPromise(guide({ query: "agent pages" }));
    expect(result.answer).toContain("threadlines-place:threads.agentPages");
    expect(result.answer).not.toContain("Now on");
  });

  it("says a device's own setting can't be seen, and lists pages and topics with no question", async () => {
    const { guide } = readers();
    const sites = await Effect.runPromise(guide({ query: "sites agents can visit" }));
    expect(sites.answer).toContain("Set on each device; you can't see its value.");
    const index = await Effect.runPromise(guide({}));
    expect(index.answer).toContain("threadlines-place:fleet");
    expect(index.answer).toContain("`linking-computers`");
    const unknown = await Effect.runPromise(guide({ topic: "nowhere" }));
    expect(unknown.outcome).toBe("no_match");
  });

  it("names only places the catalog knows in its topics", () => {
    for (const topic of GUIDE_TOPICS) {
      for (const id of topicPlaceIds(topic.body)) {
        expect(isPlaceId(id), `${topic.id} names ${id}`).toBe(true);
      }
    }
  });
});
