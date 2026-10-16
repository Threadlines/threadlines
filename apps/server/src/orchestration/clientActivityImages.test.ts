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

it("drops screenshot copies only from progress rows of calls that completed with them", () => {
  const caption = { type: "text", text: "Captured the page" };
  const activities = [
    toolRow("a1", "tool.updated", "call-a", [caption, screenshot("AAAA")]),
    // Its completion carries a different image, so this copy is the only one.
    toolRow("b1", "tool.updated", "call-b", [screenshot("BBBB")]),
    // Still running: nothing later shows its image.
    toolRow("c1", "tool.updated", "call-c", [screenshot("CCCC")]),
    toolRow("a2", "tool.completed", "call-a", [caption, screenshot("AAAA")]),
    toolRow("b2", "tool.completed", "call-b", [screenshot("BBB2")]),
  ];

  const sent = dropSupersededToolUpdateImages(activities);

  assert.deepEqual(
    sent.map((activity) => contentOf(activity)),
    [1, 1, 1, 2, 1],
  );
  // The caption stays; the completion keeps its image; stored rows are untouched.
  assert.deepEqual((sent[0]!.payload as ToolResultPayload).data.result.content, [caption]);
  assert.equal(sent[3], activities[3]);
  assert.equal(contentOf(activities[0]!), 2);
});

it("returns the same list when nothing is superseded", () => {
  const activities = [toolRow("c1", "tool.updated", "call-c", [screenshot("CCCC")])];
  assert.equal(dropSupersededToolUpdateImages(activities), activities);
});
