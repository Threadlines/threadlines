import { describe, expect, it } from "vitest";

import {
  splitStreamingAssistantMarkdownFlush,
  STREAMING_MARKDOWN_START,
  streamingMarkdownStateAfter,
} from "./streamingMarkdownFlush.ts";

/** Feeds `text` in `size`-character chunks the way ingestion batches it; reports what waited after each. */
function stream(text: string, size: number) {
  let state = STREAMING_MARKDOWN_START;
  let buffered = "";
  let sent = "";
  const waiting: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    buffered += text.slice(index, index + size);
    const { readyText, pendingText } = splitStreamingAssistantMarkdownFlush(buffered, state);
    if (readyText.length > 0) {
      sent += readyText;
      state = streamingMarkdownStateAfter(readyText, state);
      buffered = pendingText;
    }
    waiting.push(buffered);
  }
  return { sent, buffered, waiting };
}

const REPLY = [
  "Change this:\n\n",
  "```diff\n",
  "-  const end = start + pageSize;\n",
  "+  const end = Math.min(items[start + pageSize], *limit);\n",
  "```\n\n",
  "```ts\n",
  "const page = Number(url.searchParams.get(`page`) ?? 1);\n",
  "```\n\n",
  "Done **now**.",
].join("");

describe("splitStreamingAssistantMarkdownFlush", () => {
  it("sends a code block as it streams, wherever the batches cut its fences", () => {
    for (const size of [1, 2, 3, 5, 8]) {
      const { sent, buffered, waiting } = stream(REPLY, size);
      expect(sent + buffered).toBe(REPLY);
      // Brackets, stars and backticks inside the blocks never hold the text after them.
      const insideBlocks = waiting.slice(
        Math.ceil(REPLY.indexOf("```diff") / size) + 2,
        Math.floor(REPLY.indexOf("Done") / size),
      );
      for (const held of insideBlocks) expect(held.length).toBeLessThanOrEqual(size + 3);
    }
  });

  it("finds a fence whose indent ended the batch before it", () => {
    let state = STREAMING_MARKDOWN_START;
    let buffered = "";
    for (const batch of ["```js\nx\n ", "```\n", "**unfinished"]) {
      buffered += batch;
      const { readyText, pendingText } = splitStreamingAssistantMarkdownFlush(buffered, state);
      state = streamingMarkdownStateAfter(readyText, state);
      buffered = pendingText;
    }
    // The block closed, so the open emphasis after it waits.
    expect(state.fence).toBeNull();
    expect(buffered).toBe("**unfinished");
  });

  it("still holds a span opened after the code blocks until it closes", () => {
    const text = REPLY.slice(0, REPLY.indexOf("now**") + 3);
    const { buffered } = stream(text, 4);
    expect(buffered.startsWith("**no")).toBe(true);
  });
});
