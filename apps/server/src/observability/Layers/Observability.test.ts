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
  attributes: {},
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

  it.effect("writes few of the spans our SQLite client opens for statements", () =>
    Effect.gen(function* () {
      const names: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          names.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`.pipe(Effect.withTracer(tracer));
      const statementName = names.at(-1);
      assert.isDefined(statementName);

      const statements = Array.from({ length: 1_000 }, (_, index) =>
        span(index, [], statementName),
      );
      assert.isBelow(statements.filter(shouldRecordServerLocalTrace).length, 50);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
