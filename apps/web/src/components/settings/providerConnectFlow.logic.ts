import type {
  ProviderAuthEvent,
  ProviderAuthFlow,
  ProviderAuthStatus,
} from "@threadlines/contracts";

/**
 * Everything the sign-in panel renders, derived only from the server's
 * event stream. Kept out of the component so the transitions can be tested
 * without mounting a terminal.
 */
export interface ProviderConnectFlowState {
  readonly status: ProviderAuthStatus;
  readonly exitCode: number | null;
  readonly detail: string | null;
  /** Shell-quoted command as resolved by the server, once it reports one. */
  readonly command: string | null;
  /** Last non-empty output line, shown as a one-line live preview. */
  readonly lastLine: string;
  /**
   * First sign-in URL the command printed this run. CLIs that cannot open a
   * browser themselves (fx inside WSL, headless hosts) print a device-code
   * URL and wait; the panel opens it for the user instead.
   */
  readonly signInUrl: string | null;
}

export const initialProviderConnectFlowState: ProviderConnectFlowState = {
  status: "idle",
  exitCode: null,
  detail: null,
  command: null,
  lastLine: "",
  signInUrl: null,
};

const SIGN_IN_URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/u;

/** The first http(s) URL in a chunk of terminal output, minus trailing punctuation. */
export function extractSignInUrl(chunk: string): string | null {
  const match = SIGN_IN_URL_PATTERN.exec(stripTerminalControlSequences(chunk));
  if (!match) {
    return null;
  }
  return match[0].replace(/[.,;:!?]+$/u, "");
}

const ANSI_ESCAPE_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]/gu;
const OTHER_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function stripTerminalControlSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "").replace(OTHER_CONTROL_PATTERN, "");
}

/**
 * Track the newest visible line across chunk boundaries: a chunk without a
 * newline continues the current line, one with newlines replaces it.
 */
export function appendOutputPreview(previous: string, chunk: string): string {
  const cleaned = stripTerminalControlSequences(chunk).replace(/\r/g, "\n");
  const combined = `${previous}${cleaned}`;
  const lines = combined.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length > 0) {
      return line;
    }
  }
  return "";
}

export function applyProviderAuthEvent(
  state: ProviderConnectFlowState,
  event: ProviderAuthEvent,
): ProviderConnectFlowState {
  switch (event.type) {
    case "command":
      return { ...state, command: event.command };
    case "output":
      return {
        ...state,
        lastLine: appendOutputPreview(state.lastLine, event.data),
        signInUrl: state.signInUrl ?? extractSignInUrl(event.data),
      };
    case "status":
      return {
        ...state,
        status: event.status,
        exitCode: event.exitCode,
        detail: event.detail,
        ...(event.status === "starting" ? { lastLine: "", signInUrl: null } : {}),
      };
  }
}

export function isProviderConnectFlowActive(status: ProviderAuthStatus): boolean {
  return status === "starting" || status === "running";
}

/** Milliseconds of "still running" after which the terminal opens itself. */
export const PROVIDER_CONNECT_TERMINAL_AUTO_EXPAND_MS = 15_000;

/**
 * A flow that is still running after ~15s is almost always waiting for the
 * user to paste a code or pick a menu entry, so the terminal opens itself —
 * as it does on failure, where the error text is the whole point.
 */
export function shouldAutoExpandTerminal(input: {
  readonly status: ProviderAuthStatus;
  readonly runningForMs: number;
}): boolean {
  if (input.status === "failed") return true;
  return (
    isProviderConnectFlowActive(input.status) &&
    input.runningForMs >= PROVIDER_CONNECT_TERMINAL_AUTO_EXPAND_MS
  );
}

export function providerConnectStatusLine(input: {
  readonly flow: ProviderAuthFlow;
  readonly state: ProviderConnectFlowState;
  readonly displayName: string;
}): string {
  const isToken = input.flow === "claude-setup-token";
  switch (input.state.status) {
    case "idle":
      return "";
    case "starting":
      return isToken ? "Starting token setup" : `Starting ${input.displayName} sign-in`;
    case "running":
      return isToken
        ? "Finish authorization in your browser. The token is saved here automatically."
        : "Finish sign-in in your browser, then come back to this page.";
    case "succeeded":
      return isToken ? "Token saved" : "Signed in";
    case "failed": {
      if (input.state.detail && input.state.detail.trim().length > 0) {
        return input.state.detail;
      }
      return isToken ? "Token setup failed" : "Sign-in failed";
    }
  }
}
