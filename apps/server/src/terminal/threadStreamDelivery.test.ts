import { it } from "@effect/vitest";
import type { TerminalStreamEvent } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { describe, expect } from "vite-plus/test";

import { makeThreadStreamDelivery } from "./threadStreamDelivery.ts";

const output = (data: string): TerminalStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-10-22T00:00:00.000Z",
  data,
});

describe("makeThreadStreamDelivery", () => {
  it.live("drops output a slow connection can't take, then asks it to redraw", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<TerminalStreamEvent>();
        const deliver = yield* makeThreadStreamDelivery(queue, "thread-1", {
          maxQueued: 3,
          resumeAt: 0,
          checkEvery: "10 millis",
        });

        for (const data of ["a", "b", "c", "d", "e"]) yield* deliver(output(data));
        yield* deliver({
          type: "exited",
          threadId: "thread-1",
          terminalId: "default",
          createdAt: "2026-10-22T00:00:01.000Z",
          exitCode: 1,
          exitSignal: null,
        });
        const waiting = yield* Queue.takeAll(queue);
        expect(waiting.map((event) => (event.type === "output" ? event.data : event.type))).toEqual(
          ["a", "b", "c", "exited"],
        );

        // Caught up, with nothing new printed: the redraw request still comes.
        const next = yield* Queue.take(queue).pipe(Effect.timeout("1 second"));
        expect(next).toMatchObject({ type: "resync", threadId: "thread-1" });

        yield* deliver(output("f"));
        expect(yield* Queue.take(queue)).toMatchObject({ type: "output", data: "f" });
      }),
    ),
  );
});
