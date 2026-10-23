import type {
  ProviderAuthEvent,
  ProviderAuthFlow,
  ProviderAuthQuestionKind,
  ProviderAuthQuestionOption,
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
  /**
   * The run's command or agent opens its sign-in page itself, on the
   * server's computer (`true`), or leaves that to the client (`false`). Null
   * when the server didn't say. See `shouldOpenPrintedPage`.
   */
  readonly opensPageItself: boolean | null;
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
   * URL and wait; the client that started the run opens it instead.
   */
  readonly signInUrl: string | null;
  /**
   * Recent raw output not yet holding a finished URL. Terminal output arrives
   * in arbitrary chunks, so a device-code URL (or the code around a link) can
   * be split mid-way; it is only taken once something follows it.
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
    /** A device sign-in's code to type on the page; such a request takes no answer. */
    readonly code: string | null;
  } | null;
  /** What the agent asked and is waiting on (which provider, a key, a code). */
  readonly question: {
    readonly requestId: string;
    readonly kind: ProviderAuthQuestionKind;
    readonly message: string;
    readonly placeholder: string | null;
    readonly options: ReadonlyArray<ProviderAuthQuestionOption>;
  } | null;
}

export const initialProviderConnectFlowState: ProviderConnectFlowState = {
  status: "idle",
  exitCode: null,
  detail: null,
  command: null,
  flowId: null,
  surface: "terminal",
  opensPageItself: null,
  lastLine: "",
  openLine: "",
  signInUrl: null,
  urlScanTail: "",
  pageRequest: null,
  question: null,
};

const OPEN_LINE_CHARS = 2048;

const SIGN_IN_URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gu;
const URL_SCAN_TAIL_CHARS = 2048;

/**
 * Whether `url` is a page to open: it parses, and its host is not the machine
 * the CLI runs on. A local address (`codex login`'s `localhost:1455`) is where
 * the CLI waits for the browser to come back.
 */
function isOpenablePage(url: string): boolean {
  let hostname: string;
  try {
    // WHATWG parsing writes every IPv4 form (`127.1`, `2130706433`) as dotted.
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // Cut short, like `http://[::1` where the pattern stops at `]`.
    return false;
  }
  return !(
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/u.test(hostname)
  );
}

/**
 * The first http(s) URL in `text` that something follows (so it cannot still
 * be streaming in), minus trailing punctuation, skipping any that is not a
 * page to open.
 */
export function extractSignInUrl(text: string): string | null {
  for (const match of text.matchAll(SIGN_IN_URL_PATTERN)) {
    if (match.index + match[0].length >= text.length) continue;
    const url = match[0].replace(/[.,;:!?]+$/u, "");
    if (isOpenablePage(url)) return url;
  }
  return null;
}

const ANSI_ESCAPE_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]/gu;
/**
 * Cursor moves to another row. Windows terminals (ConPTY) draw blank lines as
 * such a jump instead of line breaks, so dropping it would run a printed URL
 * into the words of the next line.
 */
// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const CURSOR_ROW_MOVE_PATTERN = /\u001B\[[0-9;]*[ABEFHdf]/gu;
const OTHER_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/** Terminal output as plain text: a jump to another row reads as a line break. */
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(CURSOR_ROW_MOVE_PATTERN, "\n")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(OTHER_CONTROL_PATTERN, "");
}

/**
 * A hyperlink's opening code (OSC 8) and its target. A TUI that wraps a long
 * link (`/login` in Pi) cuts the visible address into rows, but each row's
 * link still carries the whole address.
 */
const HYPERLINK_TARGET_PATTERN =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001B\]8;[^;\u0007\u001B]*;([^\u0007\u001B]*)(?:\u0007|\u001B\\)/gu;

/** Output as the URL scan reads it: each hyperlink's target on a line of its own. */
function urlScanText(raw: string): string {
  return stripTerminalControlSequences(
    raw.replace(HYPERLINK_TARGET_PATTERN, (_, target: string) => (target ? `\n${target}\n` : "")),
  );
}

/**
 * One whole code at a given index: an OSC string with its end, a CSI
 * sequence, or a two-character escape (never `ESC ]`, which starts an OSC).
 */
const ESCAPE_CODE_AT =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/uy;
/** The longest code kept whole across the cut: a link's target is one address. */
const OPEN_CODE_MAX_CHARS = 16_384;

/**
 * The raw output the scan keeps for the next chunk: the last
 * `URL_SCAN_TAIL_CHARS`, unless that cut lands inside a code. Then the tail
 * starts at the code instead, so a link's target is never split from its
 * code and run into the text after it.
 */
function nextUrlScanTail(raw: string): string {
  const cut = raw.length - URL_SCAN_TAIL_CHARS;
  if (cut <= 0) return raw;
  const codeStart = raw.lastIndexOf("\u001B", cut - 1);
  if (codeStart === -1) return raw.slice(cut);
  ESCAPE_CODE_AT.lastIndex = codeStart;
  // An unfinished code runs to the end of the output so far.
  const codeEnd = ESCAPE_CODE_AT.test(raw) ? ESCAPE_CODE_AT.lastIndex : raw.length;
  if (codeEnd <= cut) return raw.slice(cut);
  return raw.length - codeStart <= OPEN_CODE_MAX_CHARS ? raw.slice(codeStart) : raw.slice(codeEnd);
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
        opensPageItself: event.opensPageItself ?? null,
      };
    case "output": {
      const preview = appendOutputPreview(state.openLine, event.data);
      const lastLine = preview.length > 0 ? preview : state.lastLine;
      const tail = `${state.openLine}${stripTerminalControlSequences(event.data).replace(/\r/g, "\n")}`;
      const openLine = tail.slice(tail.lastIndexOf("\n") + 1).slice(-OPEN_LINE_CHARS);
      if (state.signInUrl !== null) {
        return { ...state, lastLine, openLine };
      }
      const scanned = `${state.urlScanTail}${event.data}`;
      const signInUrl = extractSignInUrl(urlScanText(scanned));
      return {
        ...state,
        lastLine,
        openLine,
        signInUrl,
        urlScanTail: signInUrl === null ? nextUrlScanTail(scanned) : "",
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
        ...(event.status === "running" ? {} : { pageRequest: null, question: null }),
      };
    case "pageRequest":
      if (event.settled) {
        return state.pageRequest?.requestId === event.requestId
          ? { ...state, pageRequest: null }
          : state;
      }
      return {
        ...state,
        pageRequest: {
          requestId: event.requestId,
          url: event.url,
          message: event.message,
          code: event.code ?? null,
        },
      };
    case "question":
      if (event.settled) {
        return state.question?.requestId === event.requestId ? { ...state, question: null } : state;
      }
      return {
        ...state,
        question: {
          requestId: event.requestId,
          kind: event.kind,
          message: event.message,
          placeholder: event.placeholder ?? null,
          options: event.options ?? [],
        },
      };
  }
}

/**
 * Whether the client that started a run opens the sign-in page it prints.
 * A browser sign-in's page works from any device, so it opens, unless the
 * agent already opened it on this very computer (Grok). A terminal
 * command's page may need the server's computer (a local callback), so it
 * opens only when the server says the command leaves it to the client,
 * never on a guess.
 */
export function shouldOpenPrintedPage(input: {
  readonly surface: ProviderConnectFlowState["surface"];
  readonly opensPageItself: boolean | null;
  readonly onServerComputer: boolean;
}): boolean {
  if (input.surface === "browser") {
    return !(input.opensPageItself === true && input.onServerComputer);
  }
  return input.opensPageItself === false;
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
      // What the agent asked is the step the user is on.
      if (input.state.question) return input.state.question.message;
      if (input.state.pageRequest?.code) return "Enter the code below on the sign-in page.";
      if (input.runningHint) return input.runningHint;
      // A browser sign-in has nothing to finish in the browser before it opens a page.
      if (input.state.surface === "browser" && !input.state.signInUrl && !isSignOut && !isToken) {
        return `Signing in to ${input.displayName}`;
      }
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
