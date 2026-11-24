import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { describe, it } from "vite-plus/test";

import { SecretRequestRespondInput } from "./secretRequests.ts";

const CANARY = "sk_test_CANARY_7f3a9c";
const decode = Schema.decodeUnknownEffect(SecretRequestRespondInput);

describe("answering a secret request", () => {
  it("decodes the value into a Redacted that prints <redacted>", () => {
    const input = Effect.runSync(
      decode({
        threadId: "thread-1",
        requestId: "request-1",
        claimId: "claim-a",
        deviceLabel: "iPhone",
        answer: { type: "save", value: ` ${CANARY} ` },
      }),
    );
    assert.equal(input.answer.type, "save");
    if (input.answer.type !== "save") return;
    assert.equal(Redacted.value(input.answer.value), ` ${CANARY} `);
    assert.ok(!String(input.answer.value).includes(CANARY));
    assert.ok(!JSON.stringify(input).includes(CANARY));
  });

  // The RPC server answers a frame that fails to decode with the default
  // formatter's text (RpcServer's decode failure), so it must never quote the value.
  it("a frame that fails to decode beside a valid value never quotes it", () => {
    for (const frame of [
      {
        threadId: "t",
        requestId: "r",
        claimId: 5,
        deviceLabel: "x",
        answer: { type: "save", value: CANARY },
      },
      {
        threadId: "t",
        requestId: "r",
        claimId: "c",
        deviceLabel: "x",
        answer: { type: "sav", value: CANARY },
      },
      {
        threadId: "t",
        requestId: "r",
        claimId: "c",
        deviceLabel: "",
        answer: { type: "save", value: CANARY },
      },
    ]) {
      const result = Effect.runSync(Effect.result(decode(frame)));
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") continue;
      assert.ok(!SchemaIssue.makeFormatterDefault()(result.failure.issue).includes(CANARY));
    }
  });
});
