import { describe, expect, it } from "vitest";

import { applyTerminalInputData, createTerminalCommandInputState } from "./terminalCommandTracker";

function applyInput(...chunks: string[]) {
  let state = createTerminalCommandInputState();
  let submittedCommand: string | null = null;
  for (const chunk of chunks) {
    const result = applyTerminalInputData(state, chunk);
    state = result.state;
    submittedCommand = result.submittedCommand ?? submittedCommand;
  }
  return { state, submittedCommand };
}

describe("terminalCommandTracker", () => {
  it("captures a submitted command", () => {
    const result = applyInput("vp run dev:desktop", "\r");

    expect(result.submittedCommand).toBe("vp run dev:desktop");
    expect(result.state).toEqual({ draft: "", cursor: 0 });
  });

  it("captures the last command from a pasted multi-line input", () => {
    const result = applyInput("\u001b[200~cd apps/web\rvp run dev:desktop\r\u001b[201~");

    expect(result.submittedCommand).toBe("vp run dev:desktop");
  });

  it("tracks common line editing controls before submit", () => {
    const result = applyInput("vp run dev:desktopx", "\u007f", "\r");

    expect(result.submittedCommand).toBe("vp run dev:desktop");
  });

  it("keeps the previous submitted command when an empty prompt is submitted", () => {
    const result = applyInput("vp run dev:desktop\r", "\r");

    expect(result.submittedCommand).toBe("vp run dev:desktop");
  });

  it("ignores history navigation escape sequences instead of inventing a command", () => {
    const result = applyInput("\u001b[A", "\r");

    expect(result.submittedCommand).toBeNull();
  });
});
