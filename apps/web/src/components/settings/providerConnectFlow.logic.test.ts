import { describe, expect, it } from "vite-plus/test";
import type { ProviderAuthEvent, ProviderInstanceId } from "@threadlines/contracts";

import {
  applyProviderAuthEvent,
  appendOutputPreview,
  extractSignInUrl,
  initialProviderConnectFlowState,
  providerConnectStatusLine,
  shouldAutoExpandTerminal,
  shouldOpenPrintedPage,
  type ProviderConnectFlowState,
} from "./providerConnectFlow.logic";

const INSTANCE = "claude" as ProviderInstanceId;

// Omit must distribute over the event union — plain Omit collapses the
// discriminated variants into their common keys.
type ProviderAuthEventBody = ProviderAuthEvent extends infer E
  ? E extends ProviderAuthEvent
    ? Omit<E, "instanceId" | "createdAt">
    : never
  : never;

function event(partial: ProviderAuthEventBody): ProviderAuthEvent {
  return {
    instanceId: INSTANCE,
    createdAt: "2026-08-03T00:00:00.000Z",
    ...partial,
  } as ProviderAuthEvent;
}

function replay(events: ReadonlyArray<ProviderAuthEvent>): ProviderConnectFlowState {
  return events.reduce(applyProviderAuthEvent, initialProviderConnectFlowState);
}

describe("provider connect flow state", () => {
  it("keeps the first sign-in URL the command prints and drops it on the next attempt", () => {
    const state = replay([
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      event({
        type: "output",
        data: "Open https://vercel.com/oauth/device?user_code=QJQL-JLJT\r\nCode: QJQL-JLJT\r\n",
      }),
      event({ type: "output", data: "See https://example.com/other.\r\n" }),
    ]);
    expect(state.signInUrl).toBe("https://vercel.com/oauth/device?user_code=QJQL-JLJT");

    const restarted = applyProviderAuthEvent(
      state,
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
    );
    expect(restarted.signInUrl).toBeNull();
  });

  it("holds a page the agent asks for until it is answered or the run ends", () => {
    const asked = event({
      type: "pageRequest",
      flowId: "flow-1",
      requestId: "page-1",
      url: "https://agent.example/login",
      message: "Sign in to Example",
      settled: false,
    });
    const running = [
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      asked,
    ];
    expect(replay(running).pageRequest).toEqual({
      requestId: "page-1",
      url: "https://agent.example/login",
      message: "Sign in to Example",
      code: null,
    });

    // Answered on any device: every panel lets go of it. An answer to an
    // older request leaves the current one alone.
    const settled = (requestId: string) =>
      event({ ...asked, type: "pageRequest", requestId, settled: true } as ProviderAuthEventBody);
    expect(replay([...running, settled("page-0")]).pageRequest).not.toBeNull();
    expect(replay([...running, settled("page-1")]).pageRequest).toBeNull();
    // The run ending takes its request with it.
    expect(
      replay([
        ...running,
        event({ type: "status", status: "failed", exitCode: null, detail: "Timed out." }),
      ]).pageRequest,
    ).toBeNull();
  });

  it("shows what the agent asks until it is answered, and says it as the step", () => {
    const asked = event({
      type: "question",
      flowId: "flow-1",
      requestId: "question-1",
      kind: "choice",
      message: "Choose what Pi connects to",
      options: [{ id: "oauth:openai", label: "OpenAI (ChatGPT subscription)" }],
      settled: false,
    });
    const running = [
      event({ type: "command", flow: "login", command: "Sign in to Pi", surface: "browser" }),
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "status", status: "running", exitCode: null, detail: null }),
    ];
    const line = (state: ProviderConnectFlowState) =>
      providerConnectStatusLine({ flow: "login", state, displayName: "Pi" });
    // Before any page or question, a browser sign-in has nothing to finish in the browser.
    expect(line(replay(running))).toBe("Signing in to Pi");

    const asking = replay([...running, asked]);
    expect(asking.question).toMatchObject({ requestId: "question-1", kind: "choice" });
    expect(line(asking)).toBe("Choose what Pi connects to");
    expect(
      replay([
        ...running,
        asked,
        event({ ...asked, type: "question", settled: true } as ProviderAuthEventBody),
      ]).question,
    ).toBeNull();

    // A device code is the step until the run ends.
    const code = replay([
      ...running,
      event({
        type: "pageRequest",
        flowId: "flow-1",
        requestId: "page-1",
        url: "https://github.com/login/device",
        message: null,
        code: "ABCD-1234",
        settled: false,
      }),
    ]);
    expect(code.pageRequest?.code).toBe("ABCD-1234");
    expect(line(code)).toBe("Enter the code below on the sign-in page.");
    expect(
      applyProviderAuthEvent(
        code,
        event({ type: "status", status: "succeeded", exitCode: null, detail: null }),
      ),
    ).toMatchObject({ pageRequest: null, question: null });
  });

  it("takes Codex's sign-in page, not its local server, as Windows prints them", () => {
    const authUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc&originator=codex_cli_rs";
    // ConPTY draws the blank lines around the address as a jump to a later row.
    const state = replay([
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({
        type: "output",
        data: `Starting local login server on http://localhost:1455.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\u001B[5;1H${authUrl}\u001B[7;1HOn a remote or headless machine? Use \`codex login --device-auth\` instead.`,
      }),
    ]);
    expect(state.signInUrl).toBe(authUrl);
    expect(state.lastLine).toBe(
      "On a remote or headless machine? Use `codex login --device-auth` instead.",
    );
  });

  it("reads the whole address of a link Pi's screen wraps into rows", () => {
    const authUrl = `https://claude.ai/oauth/authorize?code=true&client_id=pi&state=${"s".repeat(200)}`;
    // Each row: a jump to it, the link with its full target, a 98-character slice.
    const rows = [0, 98, 196]
      .map(
        (start, index) =>
          `\u001B[${index + 4};1H\u001B[2K \u001B]8;;${authUrl}\u001B\\${authUrl.slice(start, start + 98)}\u001B]8;;\u001B\\`,
      )
      .join("");
    // Split inside the first link's code: the target must survive the chunk boundary.
    const split = rows.indexOf("claude.ai");
    const state = replay([
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "output", data: rows.slice(0, split) }),
      event({ type: "output", data: rows.slice(split) }),
    ]);
    expect(state.signInUrl).toBe(authUrl);

    // A link longer than the kept tail, split just before its code ends.
    const longUrl = `https://auth.example.com/authorize?state=${"x".repeat(2400)}`;
    const longRow = `\u001B[4;1H \u001B]8;;${longUrl}\u001B\\${longUrl.slice(0, 98)}\u001B]8;;\u001B\\\u001B[5;1H`;
    const end = longRow.indexOf("\u001B\\");
    expect(
      replay([
        event({ type: "output", data: longRow.slice(0, end) }),
        event({ type: "output", data: longRow.slice(end) }),
      ]).signInUrl,
    ).toBe(longUrl);
  });

  it("never takes an address on the CLI's own machine, or one cut short", () => {
    expect(
      extractSignInUrl(
        "http://127.0.0.2:1455/ http://0.0.0.0:8080 http://login.localhost/ http://[::1]:1455/ https://auth.example.com/sign-in\n",
      ),
    ).toBe("https://auth.example.com/sign-in");
  });

  it("waits for a URL split across output chunks to finish before taking it", () => {
    const state = replay([
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "output", data: "Open htt" }),
      event({ type: "output", data: "ps://vercel.com/oauth/device?user_code=QJ" }),
    ]);
    // Mid-code: taking it now would open a truncated device code.
    expect(state.signInUrl).toBeNull();

    const finished = applyProviderAuthEvent(state, event({ type: "output", data: "QL-JLJT\r\n" }));
    expect(finished.signInUrl).toBe("https://vercel.com/oauth/device?user_code=QJQL-JLJT");

    // Still waiting for its line to end when the kept output is trimmed.
    const authUrl = "https://auth.example.com/sign-in?code=abc";
    expect(
      replay([
        event({
          type: "output",
          data: `${"Waiting for sign-in\r".repeat(120)}${authUrl}\u001B[0m`,
        }),
        event({ type: "output", data: "\r\n" }),
      ]).signInUrl,
    ).toBe(authUrl);
  });

  it("tracks a run from start to success and keeps the resolved command", () => {
    const state = replay([
      event({ type: "command", flow: "login", command: "codex login" }),
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      event({ type: "output", data: "Opening browser...\r\nWaiting for sign-in" }),
      event({ type: "status", status: "succeeded", exitCode: 0, detail: null }),
    ]);

    expect(state.command).toBe("codex login");
    expect(state.status).toBe("succeeded");
    expect(state.lastLine).toBe("Waiting for sign-in");
  });

  it("surfaces the server's failure detail", () => {
    const state = replay([
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      event({
        type: "status",
        status: "failed",
        exitCode: 7,
        detail: "The sign-in command exited with code 7.",
      }),
    ]);

    expect(providerConnectStatusLine({ flow: "login", state, displayName: "Codex" })).toBe(
      "The sign-in command exited with code 7.",
    );
    expect(state.exitCode).toBe(7);
  });

  it("clears the previous preview line when a new attempt starts", () => {
    const state = replay([
      event({ type: "output", data: "old failure text\n" }),
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
    ]);

    expect(state.lastLine).toBe("");
  });

  it("keeps the newest visible line across chunk boundaries and ignores styling", () => {
    expect(appendOutputPreview("", "Paste the code: ")).toBe("Paste the code:");
    expect(appendOutputPreview("Paste the code:", "\u001B[32mabc123\u001B[0m")).toBe(
      "Paste the code:abc123",
    );
    expect(appendOutputPreview("done", "\nnext line\n")).toBe("next line");
  });

  it("never runs a finished line into the next one", () => {
    const state = replay([
      event({ type: "output", data: "Starting Antigravity…\r\n" }),
      event({ type: "output", data: "Finish signing in with Google in your browser.\r\n" }),
    ]);
    expect(state.lastLine).toBe("Finish signing in with Google in your browser.");
    // A line still being written keeps growing across chunks.
    const prompt = replay([
      event({ type: "output", data: "Paste the code: " }),
      event({ type: "output", data: "abc123" }),
    ]);
    expect(prompt.lastLine).toBe("Paste the code: abc123");
  });

  it("opens a printed page only where nothing else already opened it", () => {
    const opens = (
      surface: "terminal" | "browser",
      opensPageItself: boolean | null,
      onServerComputer: boolean,
    ) => shouldOpenPrintedPage({ surface, opensPageItself, onServerComputer });
    // A terminal command: only when the server says it leaves the page to us.
    expect(opens("terminal", false, true)).toBe(true);
    expect(opens("terminal", true, false)).toBe(false);
    expect(opens("terminal", null, false)).toBe(false);
    // A browser sign-in: unless the agent opened it on this very computer.
    expect(opens("browser", null, true)).toBe(true);
    expect(opens("browser", true, false)).toBe(true);
    expect(opens("browser", true, true)).toBe(false);
  });

  it("opens the terminal on failure and after a long-running wait", () => {
    expect(shouldAutoExpandTerminal({ status: "running", runningForMs: 4_000 })).toBe(false);
    expect(shouldAutoExpandTerminal({ status: "running", runningForMs: 16_000 })).toBe(true);
    expect(shouldAutoExpandTerminal({ status: "failed", runningForMs: 0 })).toBe(true);
    expect(shouldAutoExpandTerminal({ status: "succeeded", runningForMs: 60_000 })).toBe(false);
  });

  it("uses token wording for the setup-token flow", () => {
    const succeeded: ProviderConnectFlowState = {
      ...initialProviderConnectFlowState,
      status: "succeeded",
    };
    expect(
      providerConnectStatusLine({
        flow: "claude-setup-token",
        state: succeeded,
        displayName: "Claude",
      }),
    ).toBe("Token saved");
    expect(
      providerConnectStatusLine({ flow: "login", state: succeeded, displayName: "Claude" }),
    ).toBe("Signed in");
  });
});
