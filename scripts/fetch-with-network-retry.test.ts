import { assert, expect, it } from "vite-plus/test";

import { fetchWithNetworkRetry, isTransientNetworkFailure } from "./fetch-with-network-retry.ts";

it("identifies the external download failures seen in release jobs", () => {
  assert.equal(isTransientNetworkFailure(new Error("socket hang up")), true);
  assert.equal(isTransientNetworkFailure(new TypeError("fetch failed")), true);
  assert.equal(isTransientNetworkFailure(new Error("UND_ERR_SOCKET: other side closed")), true);
  assert.equal(isTransientNetworkFailure(new Error("checksum mismatch")), false);
});

it("retries transient network failures with a fresh attempt", async () => {
  const response = new Response("electron artifact");
  const networkFailure = new TypeError("fetch failed");
  let fetchAttempts = 0;
  const fetchImplementation = (async () => {
    fetchAttempts += 1;
    if (fetchAttempts < 3) {
      throw networkFailure;
    }
    return response;
  }) as typeof fetch;
  const sleepDelays: number[] = [];
  const retries: Array<{ attempt: number; delayMs: number; maxAttempts: number }> = [];

  const result = await fetchWithNetworkRetry("https://example.test/electron.zip", {
    fetchImplementation,
    maxAttempts: 3,
    retryDelayMs: 250,
    sleep: async (delayMs) => {
      sleepDelays.push(delayMs);
    },
    onRetry: ({ attempt, delayMs, maxAttempts }) => {
      retries.push({ attempt, delayMs, maxAttempts });
    },
  });

  assert.strictEqual(result, response);
  assert.equal(fetchAttempts, 3);
  assert.deepStrictEqual(sleepDelays, [250, 500]);
  assert.deepStrictEqual(retries, [
    { attempt: 1, delayMs: 250, maxAttempts: 3 },
    { attempt: 2, delayMs: 500, maxAttempts: 3 },
  ]);
});

it("fails after the bounded number of attempts", async () => {
  const networkFailure = new TypeError("other side closed");
  let fetchAttempts = 0;
  const fetchImplementation = (async () => {
    fetchAttempts += 1;
    throw networkFailure;
  }) as typeof fetch;

  await expect(
    fetchWithNetworkRetry("https://example.test/electron.zip", {
      fetchImplementation,
      maxAttempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
    }),
  ).rejects.toBe(networkFailure);

  assert.equal(fetchAttempts, 3);
});
