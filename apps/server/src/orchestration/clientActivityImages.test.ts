import { EventId, type OrchestrationThreadActivity } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";

import { dropSupersededToolUpdateImages } from "./clientActivityImages.ts";

const screenshot = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

const toolRow = (
  id: string,
  kind: "tool.updated" | "tool.completed",
  toolCallId: string,
  content: ReadonlyArray<unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind,
  summary: kind,
  payload: {
    toolCallId,
    status: kind === "tool.completed" ? "completed" : "inProgress",
    data: { toolName: "browser_screenshot", result: { type: "tool_result", content } },
  },
  turnId: null,
  createdAt: "2026-10-15T10:00:00.000Z",
});

type ToolResultPayload = { readonly data: { readonly result: { readonly content: unknown[] } } };

const contentOf = (activity: OrchestrationThreadActivity) =>
  (activity.payload as ToolResultPayload).data.result.content.length;

it("drops screenshot copies only from progress rows a completion fully replaces", () => {
  const caption = { type: "text", text: "Captured the page" };
  const activities = [
    toolRow("a1", "tool.updated", "call-a", [caption, screenshot("AAAA")]),
    // Its second image has no counterpart in the completion, so it stays on
    // screen; dropping only the first would renumber it into the first's place.
    toolRow("b1", "tool.updated", "call-b", [screenshot("AAAA"), screenshot("BBBB")]),
    // Its completion carries a different image at that position.
    toolRow("d1", "tool.updated", "call-d", [screenshot("DDDD")]),
    // Still running: nothing later shows its image.
    toolRow("c1", "tool.updated", "call-c", [screenshot("CCCC")]),
    toolRow("a2", "tool.completed", "call-a", [caption, screenshot("AAAA")]),
    toolRow("b2", "tool.completed", "call-b", [screenshot("AAAA")]),
    toolRow("d2", "tool.completed", "call-d", [screenshot("DDD2")]),
  ];

  const sent = dropSupersededToolUpdateImages(activities);

  assert.deepEqual(
    sent.map((activity) => contentOf(activity)),
    [1, 2, 1, 1, 2, 1, 1],
  );
  // The caption stays; completions keep their images; stored rows are untouched.
  assert.deepEqual((sent[0]!.payload as ToolResultPayload).data.result.content, [caption]);
  assert.equal(sent[4], activities[4]);
  assert.equal(contentOf(activities[0]!), 2);
});

it("returns the same list when nothing is superseded", () => {
  const activities = [toolRow("c1", "tool.updated", "call-c", [screenshot("CCCC")])];
  assert.equal(dropSupersededToolUpdateImages(activities), activities);
});
