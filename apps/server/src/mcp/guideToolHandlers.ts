/**
 * The handler behind `app_guide` (guideTools.ts): plans the answer from the
 * question, reads only the values that answer shows, and writes it. Every
 * read is best effort: one that fails leaves its value out of the answer,
 * never the answer itself.
 */
import type { ServerSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import {
  guideNeeds,
  type GuideLinkedComputer,
  type GuideValues,
  planGuide,
  renderGuide,
} from "../guide/appGuide.ts";
import type { AppGuideResult } from "./guideTools.ts";

/** Each reader yields undefined when its value can't be read (or the server has no such records). */
export interface GuideToolDeps {
  readonly computerName: Effect.Effect<string>;
  readonly settings: Effect.Effect<ServerSettings | undefined>;
  readonly linkedComputers: Effect.Effect<ReadonlyArray<GuideLinkedComputer> | undefined>;
  readonly providers: Effect.Effect<GuideValues["providers"]>;
  readonly outsideAgents: Effect.Effect<GuideValues["outsideAgents"]>;
  readonly scheduledTasks: Effect.Effect<GuideValues["scheduledTasks"]>;
}

/** A value read when the answer shows it. */
const readIf = <A>(needed: boolean, read: Effect.Effect<A | undefined>) =>
  needed ? read : Effect.succeed(undefined);

export function makeGuideToolHandler(deps: GuideToolDeps) {
  return (input: {
    readonly query?: string | undefined;
    readonly topic?: string | undefined;
  }): Effect.Effect<AppGuideResult> =>
    Effect.gen(function* () {
      const plan = planGuide(input);
      const needs = guideNeeds(plan);
      const [settings, linkedComputers, providers, outsideAgents, scheduledTasks] =
        yield* Effect.all(
          [
            readIf(needs.settings, deps.settings),
            readIf(needs.states.has("linkedComputers"), deps.linkedComputers),
            readIf(needs.states.has("providers"), deps.providers),
            readIf(needs.states.has("outsideAgents"), deps.outsideAgents),
            readIf(needs.states.has("scheduledTasks"), deps.scheduledTasks),
          ],
          { concurrency: "unbounded" },
        );
      const values: GuideValues = {
        computerName: yield* deps.computerName,
        ...(settings !== undefined ? { settings } : {}),
        ...(linkedComputers !== undefined ? { linkedComputers } : {}),
        ...(providers !== undefined ? { providers } : {}),
        ...(outsideAgents !== undefined ? { outsideAgents } : {}),
        ...(scheduledTasks !== undefined ? { scheduledTasks } : {}),
      };
      return {
        outcome:
          plan.kind === "noMatch" || plan.kind === "unknownTopic"
            ? ("no_match" as const)
            : ("ok" as const),
        answer: renderGuide(plan, values),
      };
    });
}
