import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Guards our patch to the checked-in msw worker (mswjs/msw#2801, see the note
 * at the top of public/mockServiceWorker.js). The client never replies to the
 * worker's one-way notifications, so a message event that awaits one never
 * settles and Chromium kills the worker about five minutes later. A plain
 * `msw init` brings the awaits back; this fails when it does.
 */

const workerSource = readFileSync(
  new URL("../public/mockServiceWorker.js", import.meta.url),
  "utf8",
);

const openChannels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of openChannels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

/** Loads the worker script with a single window client that never answers it. */
function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const client = {
    id: "client-1",
    frameType: "top-level",
    postMessage: vi.fn<(message: { type: string }, transfer: unknown[]) => void>(),
  };
  const registration = { unregister: vi.fn(async () => true) };

  runInNewContext(workerSource, {
    self: {
      clients: {
        get: async (id: string) => (id === client.id ? client : undefined),
        matchAll: async () => [client],
        claim: async () => undefined,
      },
      registration,
      skipWaiting: () => undefined,
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    MessageChannel: class extends MessageChannel {
      constructor() {
        super();
        openChannels.push(this);
      }
    },
    crypto,
    Headers,
    ReadableStream,
    Response,
  });

  /** Sends the worker a message from the client and returns what it passed to `waitUntil`. */
  const dispatchMessage = (data: string): Promise<unknown> => {
    const lifetimes: Promise<unknown>[] = [];
    listeners.get("message")?.({
      data,
      source: client,
      waitUntil: (promise: Promise<unknown>) => lifetimes.push(promise),
    });
    expect(lifetimes, `${data} should extend the event's lifetime`).toHaveLength(1);
    return lifetimes[0]!;
  };

  return { client, dispatchMessage };
}

describe("mockServiceWorker.js", () => {
  it.each([
    ["KEEPALIVE_REQUEST", "KEEPALIVE_RESPONSE"],
    ["INTEGRITY_CHECK_REQUEST", "INTEGRITY_CHECK_RESPONSE"],
    ["MOCK_ACTIVATE", "MOCKING_ENABLED"],
    ["CLIENT_CLOSE", "CLIENT_CLOSED"],
  ])("settles %s although the client never replies", async (request, notification) => {
    const worker = loadWorker();
    const lifetime = worker.dispatchMessage(request);

    // Every step before the notification is an already-settled stub, so the
    // event is done once the microtask queue drains.
    const settled = await Promise.race([lifetime.then(() => true), setImmediate(false)]);

    // The worker's objects come from the vm's realm, so compare by type name.
    const sent = worker.client.postMessage.mock.calls.map(([message]) => message.type);
    expect(sent).toEqual([notification]);
    expect(settled, `${request} left its message event pending`).toBe(true);
  });
});
