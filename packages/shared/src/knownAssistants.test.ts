import { describe, expect, it } from "vite-plus/test";

import {
  assistantDisplayName,
  assistantOfKeyLabel,
  assistantOfSignInHost,
} from "./knownAssistants.ts";

describe("known assistants", () => {
  it("knows a sign-in by the site it returns to, and a key by the label typed for it", () => {
    // Grok Bot signs in as "Cursor" through Cursor's site.
    expect(assistantOfSignInHost("www.cursor.com")).toBe("grok-bot");
    expect(assistantOfSignInHost("chatgpt.com")).toBe("chatgpt");
    expect(assistantOfSignInHost("claude.ai:443")).toBe("claude");
    // A site that only ends like a known one doesn't count.
    expect(assistantOfSignInHost("notcursor.com")).toBeNull();
    // An app's return address is no site, whatever host it names.
    expect(assistantOfSignInHost("com.evil.app://x.claude.ai/")).toBeNull();
    expect(assistantOfSignInHost("com.evil.app://x.claude.ai")).toBeNull();
    expect(assistantOfSignInHost("com.example.app:")).toBeNull();
    expect(assistantOfKeyLabel("Muse work")).toBe("muse");
    expect(assistantOfKeyLabel("my dots")).toBe("chatgpt");
    expect(assistantOfKeyLabel("Helper")).toBeNull();
    expect(assistantDisplayName(null, "Helper")).toBe("Helper");
    expect(assistantDisplayName("grok-bot", "Cursor")).toBe("Grok Bot");
  });
});
