import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_PAYLOAD_REF_KEY,
  restoreSharedPayloadValues,
  shareRepeatedPayloadValues,
} from "./activityPayloadRefs.ts";

const screenshot = "iVBORw0KGgo".padEnd(4096, "A");
const output = "line\n".repeat(400);
const toolRow = (id: string, kind: string, content: unknown[]) => ({
  id,
  kind,
  payload: {
    toolCallId: "call-1",
    data: { toolName: "browser_screenshot", result: { type: "tool_result", content } },
  },
});

describe("activity payload refs", () => {
  it("sends each repeated large value once and restores the payloads exactly", () => {
    const activities = [
      toolRow("a1", "tool.started", [{ type: "text", text: "short" }]),
      toolRow("a2", "tool.updated", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
        { type: "text", text: output },
      ]),
      toolRow("a3", "tool.completed", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
        { type: "text", text: output },
        // The same image twice in one row.
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
      ]),
    ];
    const stored = JSON.stringify(activities);

    const shared = shareRepeatedPayloadValues(activities);
    const sent = JSON.stringify(shared);
    expect(sent.length).toBeLessThan(screenshot.length + output.length + 2_000);
    expect(sent).toContain(ACTIVITY_PAYLOAD_REF_KEY);
    // Nothing the server keeps is touched.
    expect(JSON.stringify(activities)).toBe(stored);

    // Over the wire and back: the client works with what was stored, key order included.
    const restored = restoreSharedPayloadValues(JSON.parse(sent) as typeof activities);
    expect(JSON.stringify(restored)).toBe(stored);
  });

  it("leaves activities whole when nothing repeats or a payload already uses the key", () => {
    const unique = [toolRow("a1", "tool.updated", [{ type: "text", text: output }])];
    expect(shareRepeatedPayloadValues(unique)).toBe(unique);

    const colliding = [
      toolRow("a1", "tool.updated", [{ type: "text", text: output }]),
      {
        id: "a2",
        kind: "tool.completed",
        payload: { [ACTIVITY_PAYLOAD_REF_KEY]: ["x"], text: output },
      },
    ];
    expect(shareRepeatedPayloadValues(colliding)).toBe(colliding);
  });

  it("keeps a reference it cannot resolve as it came", () => {
    const received = [
      {
        id: "a1",
        kind: "tool.updated",
        payload: { text: { [ACTIVITY_PAYLOAD_REF_KEY]: ["gone", "text"] } },
      },
    ];
    expect(restoreSharedPayloadValues(received)).toBe(received);
  });
});
