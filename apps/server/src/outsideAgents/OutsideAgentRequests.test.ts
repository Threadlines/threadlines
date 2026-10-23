import { describe, expect, it } from "@effect/vitest";
import { CommandId, OutsideAgentConnectionId, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeOutsideAgentRequests } from "./OutsideAgentRequests.ts";

const CONNECTION = OutsideAgentConnectionId.make("connection-1");
const row = (requestId: string, createdAt: string) => ({
  connectionId: CONNECTION,
  requestId,
  tool: "thread_start" as const,
  inputHash: "hash",
  threadId: ThreadId.make(`thread-${requestId}`),
  commandId: CommandId.make(`command-${requestId}`),
  createdAt,
});

describe("OutsideAgentRequests", () => {
  it.effect("claims once, marks a start a restart cut off failed, and forgets old rows", () =>
    Effect.gen(function* () {
      const first = yield* makeOutsideAgentRequests;
      expect(yield* first.claim(row("a", "2026-10-22T09:00:00.000Z"))).toBe(true);
      expect(yield* first.claim(row("a", "2026-10-22T09:00:00.000Z"))).toBe(false);
      expect(yield* first.claim(row("b", "2026-10-23T09:00:00.000Z"))).toBe(true);
      yield* first.finish({ connectionId: CONNECTION, requestId: "b", resultJson: "{}" });
      expect(
        yield* first.countStartsSince({
          connectionId: CONNECTION,
          since: "2026-10-22T00:00:00.000Z",
        }),
      ).toBe(2);

      // The server starts again: what was still starting was cut off.
      const second = yield* makeOutsideAgentRequests;
      const cutOff = yield* second.get({ connectionId: CONNECTION, requestId: "a" });
      const answered = yield* second.get({ connectionId: CONNECTION, requestId: "b" });
      expect(Option.map(cutOff, (entry) => entry.state)).toEqual(Option.some("failed"));
      expect(Option.map(answered, (entry) => [entry.state, entry.resultJson])).toEqual(
        Option.some(["done", "{}"]),
      );

      yield* second.prune({ before: "2026-10-23T00:00:00.000Z" });
      expect(Option.isNone(yield* second.get({ connectionId: CONNECTION, requestId: "a" }))).toBe(
        true,
      );
      yield* second.release({ connectionId: CONNECTION, requestId: "b" });
      expect(Option.isNone(yield* second.get({ connectionId: CONNECTION, requestId: "b" }))).toBe(
        true,
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistenceMemory))),
  );
});
