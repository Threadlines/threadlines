import { describe, expect, it } from "vite-plus/test";

import {
  applyTerminalInputData,
  createTerminalCommandInputState,
  normalizeTerminalActivityCommand,
} from "./terminalCommandTracker";

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

  it("holds a bracketed multi-line paste until Enter, then submits all of it", () => {
    // A shell with bracketed paste on keeps pasted lines in its editor; none
    // runs until the user presses Enter.
    const pasted = applyInput("\u001b[200~cd apps/web\rvp run dev:desktop\r\u001b[201~");
    expect(pasted.submittedCommand).toBeNull();

    // The paste can arrive in pieces.
    const result = applyInput("\u001b[200~cd apps/web\rvp run", " dev:desktop\u001b[201~", "\r");
    expect(result.submittedCommand).toBe("cd apps/web vp run dev:desktop");
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

  it("reports submissions even when shell history hides the command text", () => {
    let state = createTerminalCommandInputState();
    const historyNavigation = applyTerminalInputData(state, "\u001b[A");
    state = historyNavigation.state;

    expect(historyNavigation.didSubmit).toBe(false);
    expect(applyTerminalInputData(state, "\r")).toMatchObject({
      submittedCommand: null,
      didSubmit: true,
    });
  });

  it("keeps a line exactly as typed only while it can follow every key", () => {
    const submittedLine = (...chunks: string[]) => {
      let state = createTerminalCommandInputState();
      let line: string | null = null;
      for (const chunk of chunks) {
        const result = applyTerminalInputData(state, chunk);
        state = result.state;
        if (result.didSubmit) line = result.submittedLine;
      }
      return line;
    };

    // Spacing inside quotes is part of the command; the label folds it.
    expect(submittedLine('echo "a  b"', "\r")).toBe('echo "a  b"');
    expect(submittedLine("npm run dex", "\u007f", "v\r")).toBe("npm run dev");
    // Completion and history change the shell's line where the draft can't see.
    expect(submittedLine("npm run d", "\t", "\r")).toBeNull();
    expect(submittedLine("\u001b[A", "\r")).toBeNull();
    expect(submittedLine("npm\u001b[A", "\u001b[B", " test\r")).toBeNull();
    // A fresh line after Ctrl+C is exact again.
    expect(submittedLine("npm run d\t", "\u0003", "make\r")).toBe("make");
    // A paste of several lines isn't one line to run again.
    expect(submittedLine("\u001b[200~cd web\rnpm test\u001b[201~\r")).toBeNull();
    // Words end in different places in each shell.
    expect(submittedLine("npm run dev", "\u001b[1;5D", "x\r")).toBeNull();
    expect(submittedLine("npm run dev", "\u0017", "test\r")).toBeNull();
    // The terminal's own reports aren't keys; a trailing space is kept.
    expect(submittedLine("echo x\\ ", "\u001b[12;34R", "\r")).toBe("echo x\\ ");
  });

  it("removes absolute executable paths from detected terminal activity commands", () => {
    expect(
      normalizeTerminalActivityCommand(
        `"C:\\Users\\wilfr\\OneDrive\\Desktop\\GitHubCode\\badcode\\.codex-local\\toolchain\\node.exe" -e "let n=0"`,
      ),
    ).toBe(`node -e "let n=0"`);
    expect(
      normalizeTerminalActivityCommand(
        `C:\\Users\\wilfr\\OneDrive\\Desktop\\GitHubCode\\badcode\\node_modules\\.bin\\vp.cmd run dev:desktop`,
      ),
    ).toBe("vp run dev:desktop");
  });
});
