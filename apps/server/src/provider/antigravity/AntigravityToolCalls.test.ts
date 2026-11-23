import { describe, expect, it } from "vite-plus/test";

import { boundAntigravityCommandLine, boundAntigravityText } from "./AntigravityToolCalls.ts";

describe("Antigravity tool text", () => {
  it("never cuts a character in half", () => {
    // "😀" is two UTF-16 units; a cut between them would leave half a character.
    const tail = boundAntigravityText(`a😀${"b".repeat(9)}`, 10);
    expect(tail).toBe(`[Earlier output truncated]\n\n${"b".repeat(9)}`);
    const head = boundAntigravityCommandLine(`${"c".repeat(9)}😀d`, 10);
    expect(head).toBe(`${"c".repeat(9)}\n\n[Command truncated]`);
    expect(boundAntigravityText("short")).toBe("short");
  });
});
