import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import { recallablePrompts, stepPromptRecall } from "./composerPromptRecall";

const message = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: text, role: "user", text, createdAt: "", streaming: false, ...extra }) as ChatMessage;

describe("composer prompt recall", () => {
  it("walks only what the user wrote, newest first, each once in a row", () => {
    expect(
      recallablePrompts([
        message("first"),
        message("an answer", { role: "assistant" }),
        message("second"),
        message("second"),
        message("from an agent", { fromAgent: {} as never }),
        message("a child's report", { fromThread: {} as never }),
        message("a side question", { sideTurnId: "side" as never }),
        message("an invite", { requestKind: "invite" }),
        message("   "),
        message("third"),
      ]),
    ).toEqual(["third", "second", "first"]);
  });

  it("goes back from an empty box, forward again, and lets an edit have the arrows back", () => {
    const prompts = ["third", "second", "first"];
    const up1 = stepPromptRecall({ key: "ArrowUp", value: "", recall: null, prompts });
    expect(up1?.value).toBe("third");
    const up2 = stepPromptRecall({ key: "ArrowUp", value: "third", recall: up1!.recall, prompts });
    expect(up2?.value).toBe("second");
    const up3 = stepPromptRecall({ key: "ArrowUp", value: "second", recall: up2!.recall, prompts });
    const atOldest = stepPromptRecall({
      key: "ArrowUp",
      value: "first",
      recall: up3!.recall,
      prompts,
    });
    // At the oldest Up stays put.
    expect(atOldest?.value).toBe("first");
    const down = stepPromptRecall({
      key: "ArrowDown",
      value: "first",
      recall: atOldest!.recall,
      prompts,
    });
    expect(down?.value).toBe("second");
    // Past the newest, Down empties the box.
    const back = stepPromptRecall({
      key: "ArrowDown",
      value: "third",
      recall: up1!.recall,
      prompts,
    });
    expect(back).toEqual({ recall: null, value: "" });
    // Typed words, or an edited recall, keep the arrows for the caret.
    expect(stepPromptRecall({ key: "ArrowUp", value: "draft", recall: null, prompts })).toBeNull();
    expect(
      stepPromptRecall({ key: "ArrowUp", value: "third, edited", recall: up1!.recall, prompts }),
    ).toBeNull();
    expect(stepPromptRecall({ key: "ArrowDown", value: "", recall: null, prompts })).toBeNull();
  });
});
