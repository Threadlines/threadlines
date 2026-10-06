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
  /** The server's id for this run; writes and stops name it. */
  readonly flowId: string | null;
  /** `browser`: no terminal; the panel opens the sign-in page and takes its final address. */
  readonly surface: "terminal" | "browser";
  /** Last non-empty output line, shown as a one-line live preview. */
  readonly lastLine: string;
  /**
   * Output after the last newline: a line still being written. A chunk
   * continues it; a finished line never runs into the next one.
   */
  readonly openLine: string;
  /**
   * First sign-in URL the command printed this run. CLIs that cannot open a
   * browser themselves (fx inside WSL, headless hosts) print a device-code
   * URL and wait; the panel opens it for the user instead.
   */
  readonly signInUrl: string | null;
  /**
   * Recent output not yet holding a finished URL. Terminal output arrives in
   * arbitrary chunks, so a device-code URL can be split mid-code; it is only
   * taken once something follows it.
   */
  readonly urlScanTail: string;
  /**
   * A page the agent asked to have opened, waiting for the user's click.
   * Never opened by itself: the address comes from an agent Threadlines
   * hasn't tested.
   */
  readonly pageRequest: {
    readonly requestId: string;
    readonly url: string;
    readonly message: string | null;
  } | null;
}

export const initialProviderConnectFlowState: ProviderConnectFlowState = {
  status: "idle",
  exitCode: null,
  detail: null,
  command: null,
  flowId: null,
  surface: "terminal",
  lastLine: "",
  openLine: "",
  signInUrl: null,
  urlScanTail: "",
  pageRequest: null,
};

const OPEN_LINE_CHARS = 2048;

const SIGN_IN_URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gu;
const URL_SCAN_TAIL_CHARS = 2048;

/**
 * The first http(s) URL in `text` that something follows (so it cannot still
 * be streaming in), minus trailing punctuation.
 */
export function extractSignInUrl(text: string): string | null {
  for (const match of text.matchAll(SIGN_IN_URL_PATTERN)) {
    if (match.index + match[0].length < text.length) {
      return match[0].replace(/[.,;:!?]+$/u, "");
    }
  }
  return null;
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
      return {
        ...state,
        command: event.command,
        flowId: event.flowId ?? null,
        surface: event.surface ?? "terminal",
      };
    case "output": {
      const preview = appendOutputPreview(state.openLine, event.data);
      const lastLine = preview.length > 0 ? preview : state.lastLine;
      const tail = `${state.openLine}${stripTerminalControlSequences(event.data).replace(/\r/g, "\n")}`;
      const openLine = tail.slice(tail.lastIndexOf("\n") + 1).slice(-OPEN_LINE_CHARS);
      if (state.signInUrl !== null) {
        return { ...state, lastLine, openLine };
      }
      const scanned = `${state.urlScanTail}${stripTerminalControlSequences(event.data)}`;
      const signInUrl = extractSignInUrl(scanned);
      return {
        ...state,
        lastLine,
        openLine,
        signInUrl,
        urlScanTail: signInUrl === null ? scanned.slice(-URL_SCAN_TAIL_CHARS) : "",
      };
    }
    case "status":
      return {
        ...state,
        status: event.status,
        exitCode: event.exitCode,
        detail: event.detail,
        ...(event.status === "starting"
          ? { lastLine: "", openLine: "", signInUrl: null, urlScanTail: "" }
          : {}),
        // A request belongs to the run that made it.
        ...(event.status === "running" ? {} : { pageRequest: null }),
      };
    case "pageRequest":
      if (event.settled) {
        return state.pageRequest?.requestId === event.requestId
          ? { ...state, pageRequest: null }
          : state;
      }
      return {
        ...state,
        pageRequest: { requestId: event.requestId, url: event.url, message: event.message },
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
  /** What to do while it runs, for sign-ins that start in the terminal. */
  readonly runningHint?: string | undefined;
}): string {
  const isToken = input.flow === "claude-setup-token";
  const isSignOut = input.flow === "logout";
  switch (input.state.status) {
    case "idle":
      return "";
    case "starting":
      return isToken
        ? "Starting token setup"
        : isSignOut
          ? `Signing out of ${input.displayName}`
          : `Starting ${input.displayName} sign-in`;
    case "running":
      if (input.runningHint) return input.runningHint;
      return isToken
        ? "Finish authorization in your browser. The token is saved here automatically."
        : isSignOut
          ? `Signing out of ${input.displayName}`
          : "Finish sign-in in your browser, then come back to this page.";
    case "succeeded":
      return isToken ? "Token saved" : isSignOut ? "Signed out" : "Signed in";
    case "failed": {
      if (input.state.detail && input.state.detail.trim().length > 0) {
        return input.state.detail;
      }
      return isToken ? "Token setup failed" : isSignOut ? "Sign-out failed" : "Sign-in failed";
    }
  }
}
