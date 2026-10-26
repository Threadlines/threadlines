import { assert, describe, it } from "@effect/vitest";
import type { EffectTraceRecord } from "@threadlines/shared/observability";

import { shouldRecordServerLocalTrace } from "./Observability.ts";

const span = (index: number, events: EffectTraceRecord["events"] = []): EffectTraceRecord => ({
  type: "effect-span",
  name: "handleSdkMessage",
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
});
