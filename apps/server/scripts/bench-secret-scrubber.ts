/**
 * The throughput check for hiding a printed key (docs/design/secret-scrubbing.md, "Cost").
 * Runs provider events through `scrubRuntimeEvent` with 0, 1, 50 and 200 watched values
 * and prints the time per event. A report for the PR, not a CI gate.
 *
 *   node scripts/bench-secret-scrubber.ts
 */
import { performance } from "node:perf_hooks";

import { makeSecretScrubber } from "../src/secrets/SecretScrubber.ts";

const reply = (index: number, text: string) => ({
  eventId: `e${index}`,
  provider: "codex",
  threadId: "session",
  createdAt: "2026-11-19T00:00:00.000Z",
  turnId: "turn",
  itemId: "item",
  type: "content.delta",
  payload: { streamKind: "assistant_text", delta: text },
  raw: {
    source: "codex.app-server.notification",
    method: "item/agentMessage/delta",
    payload: { delta: text },
  },
});

const words = "the quick brown fox jumps over a lazy dog while compiling the project ".split(" ");
const tokens = Array.from({ length: 100_000 }, (_, index) => ` ${words[index % words.length]}`);
const big = "x".repeat(64 * 1024 - 20) + " build ok, 12 passed";
const pem = `-----BEGIN KEY-----\n${"Ab9+".repeat(16 * 1024 - 10)}\n-----END KEY-----`;

function scrubberWith(count: number) {
  const scrubber = makeSecretScrubber();
  for (let index = 0; index < count; index += 1) {
    scrubber.watch(
      `KEY_${index}`,
      index === 0 && count === 200 ? pem : `sk_test_${index}_Qa9Zr7Lm2Xc4`,
    );
  }
  return scrubber;
}

function time(label: string, run: () => number) {
  const started = performance.now();
  const events = run();
  const ms = performance.now() - started;
  console.log(
    `${label.padEnd(44)} ${((ms * 1000) / events).toFixed(2).padStart(9)} µs/event  (${events} events, ${ms.toFixed(0)} ms)`,
  );
}

for (const count of [0, 1, 50, 200]) {
  console.log(`\n${count} watched`);
  time("100,000 token-sized reply pieces", () => {
    const scrubber = scrubberWith(count);
    tokens.forEach((token, index) => scrubber.scrubRuntimeEvent(reply(index, token) as never));
    return tokens.length;
  });
  time("2,000 command-output events of 64 KB", () => {
    const scrubber = scrubberWith(count);
    for (let index = 0; index < 2000; index += 1) {
      scrubber.scrubRuntimeEvent({
        ...reply(index, big),
        payload: { streamKind: "command_output", delta: big },
      } as never);
    }
    return 2000;
  });
  time("holder: 200 buffers at once, 50 pieces each", () => {
    const scrubber = scrubberWith(count);
    const states = new Map<number, Parameters<typeof scrubber.holdPiece>[0]>();
    let pieces = 0;
    for (let round = 0; round < 50; round += 1) {
      for (let buffer = 0; buffer < 200; buffer += 1) {
        const held = scrubber.holdPiece(states.get(buffer), " sk_test_1");
        states.set(buffer, held.state);
        pieces += 1;
      }
    }
    return pieces;
  });
}

console.log("\n64 KB key arriving one character per piece through the holder (200 watched)");
time("one character per piece", () => {
  const scrubber = scrubberWith(200);
  let state: Parameters<typeof scrubber.holdPiece>[0];
  const chars = [...pem];
  for (const char of chars) state = scrubber.holdPiece(state, char).state;
  return chars.length;
});
