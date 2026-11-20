import { describe, expect, it } from "vite-plus/test";

import {
  appendDeviceEventLog,
  DEVICE_EVENT_LOG_LIMIT,
  subscribeDeviceEventLog,
} from "./eventLog.ts";
import type { DeviceHubTransport } from "./hubTransport.ts";

const encoder = new TextEncoder();

describe("subscribeDeviceEventLog", () => {
  it("reads the backlog and each new event as they stream, split anywhere, and cancels on stop", async () => {
    let push: (text: string) => void = () => {};
    let cancelled = false;
    const paths: string[] = [];
    const transport: DeviceHubTransport = {
      fetch: async (path, init) => {
        paths.push(path);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text));
            init?.signal?.addEventListener("abort", () => {
              cancelled = true;
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
      socket: () => {
        throw new Error("not used");
      },
    };

    const batches: Array<{ ids: number[]; reset: boolean }> = [];
    const stop = subscribeDeviceEventLog(transport, "ABC 1", (entries, reset) =>
      batches.push({ ids: entries.map((entry) => entry.id), reset }),
    );
    await Promise.resolve();
    push(': hello\n\ndata: {"events":[{"id":1,"kind":"launch","summary":"Settings"}]}\n\n');
    push('data: {"event":{"id":2,"kind":"tap",');
    push('"msg":"Tapped"}}\r\n\r\ndata: not json\n\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paths[0]).toBe("/vendor/serve-sim/api/event-log/events?device=ABC%201&limit=100");
    expect(batches).toEqual([
      { ids: [1], reset: true },
      { ids: [2], reset: false },
    ]);
    expect(cancelled).toBe(true);
  });

  it("keeps only the newest entries", () => {
    const entry = (id: number) => ({ id, timestamp: "", kind: "", summary: "" });
    const full = Array.from({ length: DEVICE_EVENT_LOG_LIMIT }, (_, index) => entry(index));
    const next = appendDeviceEventLog(full, [entry(500)], false);
    expect(next).toHaveLength(DEVICE_EVENT_LOG_LIMIT);
    expect(next.at(0)?.id).toBe(1);
    expect(next.at(-1)?.id).toBe(500);
    expect(appendDeviceEventLog(full, [entry(7)], true)).toEqual([entry(7)]);
  });
});
