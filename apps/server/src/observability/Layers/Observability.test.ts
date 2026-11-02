import { assert, describe, it } from "@effect/vitest";
import type { EffectTraceRecord } from "@threadlines/shared/observability";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { shouldRecordServerLocalTrace } from "./Observability.ts";

const span = (
  index: number,
  events: EffectTraceRecord["events"] = [],
  name = "handleSdkMessage",
  attributes: EffectTraceRecord["attributes"] = {},
): EffectTraceRecord => ({
  type: "effect-span",
  name,
  kind: "internal",
  traceId: "trace",
  spanId: `span-${index}`,
  sampled: true,
  startTimeUnixNano: "0",
  endTimeUnixNano: "1000",
  durationMs: 0.4,
  attributes,
  events,
  links: [],
  exit: { _tag: "Success" },
});

describe("shouldRecordServerLocalTrace", () => {
  it("writes few of the spans a streamed message opens, but every one carrying a log line", () => {
    const quiet = Array.from({ length: 1_000 }, (_, index) => span(index));
    const kept = quiet.filter(shouldRecordServerLocalTrace).length;
    assert.isAbove(kept, 0);
    assert.isBelow(kept, 50);

    const logged = Array.from({ length: 1_000 }, (_, index) =>
      span(index, [
        {
          name: "claude.api-retry.first-attempt",
          timeUnixNano: "500",
          attributes: { "effect.logLevel": "INFO" },
        },
      ]),
    );
    assert.strictEqual(logged.filter(shouldRecordServerLocalTrace).length, 1_000);
  });

  it.effect("writes few of the spans our SQLite client opens for statements and transactions", () =>
    Effect.gen(function* () {
      const opened: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const native = new Tracer.NativeSpan(options);
          opened.push(native);
          return native;
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(sql`SELECT 1`).pipe(Effect.withTracer(tracer));
      // The transaction, its statement, and its BEGIN and COMMIT.
      assert.isAtLeast(opened.length, 4);

      for (const native of opened) {
        const attributes = Object.fromEntries(native.attributes);
        const records = Array.from({ length: 1_000 }, (_, index) =>
          span(index, [], native.name, attributes),
        );
        assert.isBelow(records.filter(shouldRecordServerLocalTrace).length, 50, native.name);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
