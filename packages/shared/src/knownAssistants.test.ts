import { describe, expect, it } from "vite-plus/test";

import { assistantDisplayName, guessKnownAssistant } from "./knownAssistants.ts";

describe("guessKnownAssistant", () => {
  it("goes by the site a sign-in returns to, then by the name it gave", () => {
    // Grok Bot signs in as "Cursor" through Cursor's site.
    expect(guessKnownAssistant({ host: "www.cursor.com", name: "Cursor" })).toBe("grok-bot");
    expect(guessKnownAssistant({ host: "chatgpt.com", name: "ChatGPT" })).toBe("chatgpt");
    expect(guessKnownAssistant({ host: "claude.ai:443", name: "Claude" })).toBe("claude");
    // A key has no site: its name says.
    expect(guessKnownAssistant({ host: null, name: "Muse" })).toBe("muse");
    expect(guessKnownAssistant({ host: null, name: "my dots" })).toBe("chatgpt");
    // A site that only ends like a known one doesn't count.
    expect(guessKnownAssistant({ host: "notcursor.com", name: "Helper" })).toBeNull();
    expect(assistantDisplayName(null, "Helper")).toBe("Helper");
    expect(assistantDisplayName("grok-bot", "Cursor")).toBe("Grok Bot");
  });
});
