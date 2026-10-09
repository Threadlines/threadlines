/**
 * Runs a page in the preview browser the way the chat shows it, and reports
 * what it looks like: a screenshot, its content height, and its console.
 *
 * The browser speaks CDP over `--remote-debugging-pipe` (fd 3 in, fd 4 out,
 * NUL-delimited JSON) and lives for one scope. It loads a small host page
 * from a made-up origin, served from memory, that embeds the page exactly as
 * the chat does: `<iframe sandbox="allow-scripts allow-forms" srcdoc=…>`. The
 * page's bootstrap reports its height to the host with
 * `ui/notifications/size-changed`; the host keeps the last value.
 *
 * Every connection the browser makes goes through `previewProxy`, which only
 * reaches a few public CDNs. The host page never navigates away, the browser
 * opens no popups, and WebRTC is gone, so a page can't reach this machine or
 * its network.
 *
 * Ported from T3 Code's `htmlRender/headlessChrome.ts` (MIT), which shares
 * this repo's ancestry, with T3's follow-up that reports how the browser
 * exited (pingdotgg/t3code#16872).
 *
 * @module pages/preview/headlessChrome
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import { previewProxy } from "./previewProxy.ts";

export class PagePreviewBrowserError extends Schema.TaggedError<PagePreviewBrowserError>()(
  "PagePreviewBrowserError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /** The end of the browser's stderr when it exited, for diagnosing the host. */
    output: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `The preview browser could not show the page: ${this.reason}.`;
  }
}

/** Where AppArmor profiles live; `PREVIEW_BROWSER_APPARMOR_PROFILE` is saved here. */
export const PREVIEW_BROWSER_APPARMOR_PATH = "/etc/apparmor.d/threadlines-preview-browser";

/**
 * Lets the preview browser, in any Threadlines home and at any pinned
 * version, create the user namespace Chrome's sandbox runs in. Modelled on
 * the profile Ubuntu ships for Google Chrome; `unconfined` adds nothing
 * beyond `userns`.
 */
export const PREVIEW_BROWSER_APPARMOR_PROFILE = [
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "profile threadlines-preview-browser /**/caches/preview-browser/*/versions/*/chrome-headless-shell flags=(unconfined) {",
  "  userns,",
  "}",
];

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** One command that installs and loads the AppArmor profile. */
export const PREVIEW_BROWSER_APPARMOR_COMMAND = `printf '%s\\n' ${PREVIEW_BROWSER_APPARMOR_PROFILE.map(shellQuote).join(" ")} | sudo tee ${PREVIEW_BROWSER_APPARMOR_PATH} >/dev/null && sudo apparmor_parser -r ${PREVIEW_BROWSER_APPARMOR_PATH}`;

/**
 * Chrome cannot start its sandbox here. Threadlines never runs the browser
 * without it, so the host has to allow it.
 */
export class PagePreviewSandboxError extends Schema.TaggedError<PagePreviewSandboxError>()(
  "PagePreviewSandboxError",
  { blockedBy: Schema.Literals(["userNamespaces", "root"]) },
) {
  override get message(): string {
    return this.blockedBy === "root"
      ? "The preview browser cannot start its sandbox because the Threadlines server runs as root, and Threadlines never runs it unsandboxed. Run the server as a regular user to preview pages."
      : `This Linux host blocks the sandbox the preview browser runs pages in (AppArmor restricts unprivileged user namespaces, as on Ubuntu 23.10 and later). Ask the user to run this once on the host, then try again: ${PREVIEW_BROWSER_APPARMOR_COMMAND}`;
  }
}

type BrowserFailure = PagePreviewBrowserError | PagePreviewSandboxError;

export interface ConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const MAX_EXIT_OUTPUT_CHARS = 300;
/** The host page's viewport while the page loads. */
const VIEWPORT_HEIGHT = 800;
/** The frame's height before its content is measured, as an iframe has by default. */
export const INITIAL_FRAME_HEIGHT = 150;
export const MAX_CAPTURE_HEIGHT = 4_000;
/** How many times a capture resizes the frame to follow the height the page reports. */
const MAX_RESIZE_ROUNDS = 3;
/** After the page settles, size reports must stop for this long. */
const SIZE_QUIET_MS = 100;
/** How long a settled page that has not reported its size yet gets to report it. */
const FIRST_SIZE_WAIT_MS = 500;
// The host page loads from this made-up web origin, never from a file, so no
// page can read local files. `.localhost` keeps it a secure context, and the
// request never leaves the browser: it is served from memory.
const HOST_ORIGIN = "http://threadlines-preview.localhost";
const HOST_URL = `${HOST_ORIGIN}/`;
// Each measuring load reads its own copy of the host page off the pipe.
const MEASURE_CONCURRENCY = 3;

/** What Chrome prints before aborting when it cannot sandbox itself. */
const NO_SANDBOX_SIGNATURE = "No usable sandbox";
const ROOT_SANDBOX_SIGNATURE = "Running as root without --no-sandbox is not supported";
// Effect's spawner names the signal that ended a child only in its error message.
const EXIT_SIGNAL = /signal: '(\w+)'/;

/** Why the browser went away: its exit code or signal, and the last line it printed. */
const exitReason = (status: string | undefined, output: string) => {
  const lastLine = output.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const said =
    lastLine.length > MAX_EXIT_OUTPUT_CHARS
      ? `${lastLine.slice(0, MAX_EXIT_OUTPUT_CHARS)}…`
      : lastLine;
  return `the browser exited unexpectedly${status ? ` (${status})` : ""}${said ? `: ${said}` : ""}`;
};

const textEncoder = new TextEncoder();

/**
 * The host page's script, which runs before the frame exists. It keeps the
 * last height the page reported and answers the two calls below.
 */
const HOST_SCRIPT = `(() => {
  const state = { height: 0, reported: false, changedAt: 0, settled: new Set() };
  const wake = new Set();
  const frame = () => document.querySelector("iframe");
  addEventListener("message", (event) => {
    if (!frame() || event.source !== frame().contentWindow) return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if (typeof data.threadlinesPreviewSettled === "string") {
      state.settled.add(data.threadlinesPreviewSettled);
    } else if (data.jsonrpc === "2.0" && data.method === "ui/notifications/size-changed") {
      const height = data.params && data.params.height;
      if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return;
      state.height = height;
      state.reported = true;
      state.changedAt = performance.now();
    } else return;
    for (const resolve of wake) resolve();
    wake.clear();
  });
  const changeOr = (ms) => new Promise((resolve) => { wake.add(resolve); setTimeout(resolve, Math.max(0, ms)); });
  window.__threadlinesPreview = {
    async read(nonce, quietMs, firstMs) {
      while (!state.settled.has(nonce)) await changeOr(1000);
      const settledAt = performance.now();
      for (;;) {
        const now = performance.now();
        const left = state.reported ? quietMs - (now - state.changedAt) : firstMs - (now - settledAt);
        if (left <= 0) return { height: state.height, reported: state.reported };
        await changeOr(left);
      }
    },
    async resize(height) {
      frame().style.height = height + "px";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = frame().getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
  };
})();`;

const escapeAttribute = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The host page for a document: the document in a sandboxed frame as wide as the viewport. */
const hostPage = (document: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:${INITIAL_FRAME_HEIGHT}px}</style><script>${HOST_SCRIPT}</script></head><body><iframe sandbox="allow-scripts allow-forms" srcdoc="${escapeAttribute(document)}"></iframe></body></html>`;

/**
 * A host page as the base64 bytes `HOST_URL` serves, encoded once however
 * often it loads. Node's encoder, since pages run to megabytes.
 */
const hostBody = (document: string) =>
  Buffer.from(Buffer.from(hostPage(document), "utf8").toString("base64"), "latin1");

/** Resolves in the page's frame once it has loaded, its fonts are in, and two frames have painted. */
const settleExpression = (nonce: string) =>
  `(async () => {
    if (document.readyState !== "complete") await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    parent.postMessage({ threadlinesPreviewSettled: ${JSON.stringify(nonce)} }, "*");
    return true;
  })()`;
// Previews have no use for WebRTC, whose ICE servers can make the browser
// resolve names and send traffic outside the proxy. Runs before page scripts.
const NO_WEBRTC_SCRIPT = "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;";

/**
 * Splits pipe output into CDP messages. `partial` carries the unterminated
 * tail between chunks, since a chunk may end anywhere and a screenshot reply
 * spans many.
 */
export const splitCdpMessages = (partial: Array<string>, text: string) => {
  const complete: Array<string> = [];
  let start = 0;
  for (let end = text.indexOf("\0"); end !== -1; end = text.indexOf("\0", start)) {
    partial.push(text.slice(start, end));
    complete.push(partial.join(""));
    partial.length = 0;
    start = end + 1;
  }
  if (start < text.length) partial.push(text.slice(start));
  return complete;
};

const CdpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);
const encodeCdpCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RemoteObject = Schema.Struct({
  type: Schema.String,
  value: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});
const decodeConsoleApiCalled = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    args: Schema.Array(RemoteObject),
    executionContextId: Schema.optional(Schema.Number),
  }),
);
const decodeExceptionThrown = Schema.decodeUnknownOption(
  Schema.Struct({
    exceptionDetails: Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(RemoteObject),
      executionContextId: Schema.optional(Schema.Number),
      stackTrace: Schema.optional(
        Schema.Struct({
          callFrames: Schema.Array(
            Schema.Struct({
              functionName: Schema.String,
              url: Schema.String,
              lineNumber: Schema.Number,
              columnNumber: Schema.Number,
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeLogEntryAdded = Schema.decodeUnknownOption(
  Schema.Struct({
    entry: Schema.Struct({
      level: Schema.String,
      text: Schema.String,
      url: Schema.optional(Schema.String),
    }),
  }),
);
const decodeRequestPaused = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String }),
    frameId: Schema.optional(Schema.String),
    resourceType: Schema.optional(Schema.String),
  }),
);
const decodeAttachedToTarget = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    targetInfo: Schema.Struct({ targetId: Schema.String, type: Schema.String }),
  }),
);
const decodeDetachedFromTarget = Schema.decodeUnknownOption(
  Schema.Struct({ sessionId: Schema.String }),
);
const decodeContextCreated = Schema.decodeUnknownOption(
  Schema.Struct({
    context: Schema.Struct({
      id: Schema.Number,
      auxData: Schema.optional(Schema.Struct({ frameId: Schema.optional(Schema.String) })),
    }),
  }),
);

/** A CDP stack trace the way V8 prints one under an error (CDP counts lines and columns from 0). */
const formatStack = (
  callFrames: ReadonlyArray<{
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
    readonly columnNumber: number;
  }>,
) =>
  callFrames
    .map(({ functionName, url, lineNumber, columnNumber }) => {
      const at = `${url}:${lineNumber + 1}:${columnNumber + 1}`;
      return `\n    at ${functionName ? `${functionName} (${at})` : at}`;
    })
    .join("");

const remoteObjectText = (value: typeof RemoteObject.Type) =>
  typeof value.value === "string"
    ? value.value
    : (value.description ?? (value.value === undefined ? value.type : String(value.value)));

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};

/**
 * Everything a frame logs, its uncaught exceptions, and the browser's own
 * errors about it (blocked requests, CSP), with the context a message came
 * from when it has one.
 */
const consoleMessageFromEvent = (
  method: string,
  params: unknown,
): { readonly message: ConsoleMessage; readonly contextId?: number | undefined } | undefined => {
  if (method === "Runtime.consoleAPICalled") {
    const event = Option.getOrUndefined(decodeConsoleApiCalled(params));
    const level = event === undefined ? undefined : CONSOLE_LEVELS[event.type];
    return event && level
      ? {
          message: { level, text: event.args.map(remoteObjectText).join(" ") },
          contextId: event.executionContextId,
        }
      : undefined;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = Option.getOrUndefined(decodeExceptionThrown(params))?.exceptionDetails;
    return details
      ? {
          message: {
            level: "error",
            // An Error's description carries its stack; a thrown value
            // that is not one has its stack only in the trace.
            text:
              details.exception?.description ??
              `${details.exception ? `${details.text} ${remoteObjectText(details.exception)}` : details.text}${formatStack(details.stackTrace?.callFrames ?? [])}`,
          },
          contextId: details.executionContextId,
        }
      : undefined;
  }
  if (method === "Log.entryAdded") {
    const entry = Option.getOrUndefined(decodeLogEntryAdded(params))?.entry;
    return entry && (entry.level === "error" || entry.level === "warning")
      ? {
          message: {
            level: entry.level,
            text: entry.url ? `${entry.text} ${entry.url}` : entry.text,
          },
        }
      : undefined;
  }
  return undefined;
};

const Ignored = Schema.Unknown;
const Navigation = Schema.Struct({ errorText: Schema.optional(Schema.String) });
const IsolatedWorld = Schema.Struct({ executionContextId: Schema.Number });
const FrameTree = Schema.Struct({
  frameTree: Schema.Struct({
    childFrames: Schema.optional(
      Schema.Array(Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) })),
    ),
  }),
});
const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(
    Schema.Struct({ text: Schema.String, exception: Schema.optional(RemoteObject) }),
  ),
});
const Settled = Schema.Unknown;
const SizeReport = Schema.Struct({ height: Schema.Finite, reported: Schema.Boolean });
const FrameRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

interface PageState {
  /** The host page's target; its id is also its main frame's. */
  readonly targetId: string;
  readonly sessionId: string;
  /** The host page served for `HOST_URL`, from `hostBody`. */
  body: Uint8Array | undefined;
  loaded: Deferred.Deferred<void, BrowserFailure> | undefined;
  /** Set once the page or its frame crashed; every later command fails with it. */
  failure: BrowserFailure | undefined;
  /** The host page's own JavaScript contexts, whose console is not the page's. */
  readonly hostContexts: Set<number>;
  /** Frames running in their own process, by session: their target id and who attached them. */
  readonly frameSessions: Map<string, { readonly targetId: string; readonly parent: string }>;
  readonly consoleMessages: Array<ConsoleMessage>;
  omittedConsoleMessages: number;
}

/** A loaded page: the height it settled at, and a way to capture it. */
interface LoadedPage {
  /** The last height the page reported, rounded up; 0 when it never reported one. */
  readonly contentHeight: number;
  readonly reported: boolean;
  /** Sizes the frame to the page and returns a PNG (base64) of just the frame. */
  readonly capture: Effect.Effect<Omit<PageCapture, "consoleMessages">, BrowserFailure>;
}

/**
 * Starts the browser for the life of the scope. Scope close kills its
 * process group. Each page is its own target, so pages load in parallel.
 */
const launchBrowser = Effect.fnUntraced(function* (input: {
  readonly executable: string;
  readonly profileDirectory: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const proxyPort = yield* previewProxy().pipe(
    Effect.mapError(
      (cause) =>
        new PagePreviewBrowserError({ reason: "the preview proxy could not start", cause }),
    ),
  );
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        input.executable,
        [
          "--headless=new",
          "--remote-debugging-pipe",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--block-new-web-contents",
          `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
          // Loopback would otherwise skip the proxy.
          "--proxy-bypass-list=<-loopback>",
          // WebRTC would otherwise send UDP, which no proxy carries.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          `--user-data-dir=${input.profileDirectory}`,
          "about:blank",
        ],
        hideWindowsConsole({
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
          additionalFds: {
            fd3: { type: "input", stream: Stream.fromQueue(outgoing) },
            fd4: { type: "output" },
          },
        }),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PagePreviewBrowserError({ reason: "the browser could not be started", cause }),
      ),
    );

  let stderrTail = "";
  const stderrReader = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + text).slice(-2_048);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const pending = new Map<
    number,
    {
      readonly method: string;
      readonly sessionId: string | undefined;
      readonly reply: Deferred.Deferred<unknown, BrowserFailure>;
    }
  >();
  const pages = new Map<string, PageState>();
  /** Every session the browser opened for a page: the page's own and its frames'. */
  const sessionPages = new Map<string, PageState>();
  let disconnected: BrowserFailure | undefined;
  let nextId = 0;

  const encodeCommand = (method: string, params: Record<string, unknown>, sessionId?: string) => {
    const id = ++nextId;
    const message = encodeCdpCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return { id, bytes: textEncoder.encode(`${message}\0`) };
  };

  // A command whose reply nobody awaits; `receive` drops replies without a waiter.
  const post = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    Queue.offer(outgoing, encodeCommand(method, params, sessionId).bytes).pipe(Effect.asVoid);

  // Serves the host page. Its body is shared bytes between two small JSON
  // halves, queued together, so loading a large page at several widths never
  // copies it on this side.
  const fulfillHost = (sessionId: string, requestId: string, body: Uint8Array) =>
    Queue.offerAll(outgoing, [
      textEncoder.encode(
        `{"id":${++nextId},"sessionId":${JSON.stringify(sessionId)},"method":"Fetch.fulfillRequest","params":{"requestId":${JSON.stringify(requestId)},"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html; charset=utf-8"}],"body":"`,
      ),
      body,
      textEncoder.encode('"}}\0'),
    ]).pipe(Effect.asVoid);

  /** Fails a page and everything waiting on it, as when its renderer crashes. */
  const failPage = (page: PageState, error: BrowserFailure) =>
    Effect.gen(function* () {
      if (page.failure) return;
      page.failure = error;
      for (const [id, waiter] of pending) {
        if (waiter.sessionId === undefined || sessionPages.get(waiter.sessionId) !== page) continue;
        pending.delete(id);
        yield* Deferred.fail(waiter.reply, error);
      }
      if (page.loaded) yield* Deferred.fail(page.loaded, error);
    });

  /**
   * A frame (or worker) of a page attached in its own process, paused until
   * it is set up: its console reported, WebRTC gone, and its own children
   * attached the same way.
   */
  const setUpAttached = (page: PageState, parent: string, params: unknown) => {
    const attached = Option.getOrUndefined(decodeAttachedToTarget(params));
    if (!attached) return Effect.void;
    const { sessionId, targetInfo } = attached;
    sessionPages.set(sessionId, page);
    const commands: Array<readonly [string, Record<string, unknown>]> = [];
    if (targetInfo.type === "iframe") {
      page.frameSessions.set(sessionId, { targetId: targetInfo.targetId, parent });
      commands.push(
        ["Page.enable", {}],
        [
          "Page.addScriptToEvaluateOnNewDocument",
          { source: NO_WEBRTC_SCRIPT, runImmediately: true },
        ],
        ["Runtime.enable", {}],
        ["Log.enable", {}],
        ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
      );
    } else if (targetInfo.type === "worker") {
      commands.push(["Runtime.enable", {}]);
    }
    commands.push(["Runtime.runIfWaitingForDebugger", {}]);
    return Effect.forEach(commands, ([method, commandParams]) =>
      post(method, commandParams, sessionId),
    ).pipe(Effect.asVoid);
  };

  const recordConsole = (page: PageState, sessionId: string, method: string, params: unknown) => {
    const found = consoleMessageFromEvent(method, params);
    if (!found) return;
    // The host page's own contexts say nothing about the page.
    if (
      sessionId === page.sessionId &&
      found.contextId !== undefined &&
      page.hostContexts.has(found.contextId)
    ) {
      return;
    }
    if (page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
      page.omittedConsoleMessages += 1;
      return;
    }
    const { text } = found.message;
    page.consoleMessages.push({
      level: found.message.level,
      text:
        text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
    });
  };

  const receive = (raw: string) => {
    const message = Option.getOrUndefined(decodeCdpMessage(raw));
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return Effect.void;
      return message.error
        ? Deferred.fail(
            waiter.reply,
            new PagePreviewBrowserError({
              reason: `${waiter.method} failed`,
              cause: message.error.message,
            }),
          )
        : Deferred.succeed(waiter.reply, message.result);
    }
    const sessionId = message?.sessionId;
    const page = sessionId === undefined ? undefined : sessionPages.get(sessionId);
    if (sessionId === undefined || !page || !message?.method) return Effect.void;
    const params = message.params;
    const onHost = sessionId === page.sessionId;
    switch (message.method) {
      case "Page.loadEventFired":
        return onHost && page.loaded ? Deferred.succeed(page.loaded, undefined) : Effect.void;
      case "Inspector.targetCrashed":
        return failPage(page, new PagePreviewBrowserError({ reason: "the page crashed" }));
      case "Target.attachedToTarget":
        return setUpAttached(page, sessionId, params);
      case "Target.detachedFromTarget": {
        const detached = Option.getOrUndefined(decodeDetachedFromTarget(params));
        if (detached) {
          sessionPages.delete(detached.sessionId);
          page.frameSessions.delete(detached.sessionId);
        }
        return Effect.void;
      }
      case "Runtime.executionContextCreated": {
        const context = Option.getOrUndefined(decodeContextCreated(params))?.context;
        if (onHost && context?.auxData?.frameId === page.targetId) {
          page.hostContexts.add(context.id);
        }
        return Effect.void;
      }
      case "Fetch.requestPaused": {
        const paused = Option.getOrUndefined(decodeRequestPaused(params));
        if (!paused || !onHost) return Effect.void;
        const url = paused.request.url.split("#", 1)[0]!;
        const body = page.body;
        if (url === HOST_URL && paused.frameId === page.targetId && body !== undefined) {
          return fulfillHost(sessionId, paused.requestId, body);
        }
        // A frame inside the page may show another site, which the proxy
        // still holds to the allowed hosts. The host page itself never leaves
        // its origin, and that origin serves nothing else.
        const otherSiteFrame =
          paused.resourceType === "Document" &&
          paused.frameId !== page.targetId &&
          !url.startsWith(`${HOST_ORIGIN}/`);
        return otherSiteFrame
          ? post("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
          : post(
              "Fetch.failRequest",
              { requestId: paused.requestId, errorReason: "AccessDenied" },
              sessionId,
            );
      }
      default:
        return Effect.sync(() => recordConsole(page, sessionId, message.method!, params));
    }
  };

  // The pipe closes when the browser exits. A startup abort, such as a missing
  // sandbox, says why on stderr, which may still be draining, so give it a
  // moment; the exit status may also be a moment behind the pipe.
  const disconnect = Effect.gen(function* () {
    yield* Fiber.await(stderrReader).pipe(Effect.timeout("1 second"), Effect.ignore);
    const status = yield* child.exitCode.pipe(
      Effect.map((code) => `exit code ${code}`),
      Effect.catch((error) =>
        Effect.succeed(`signal ${EXIT_SIGNAL.exec(String(error.cause))?.[1] ?? "unknown"}`),
      ),
      Effect.timeoutOption("1 second"),
    );
    const error: BrowserFailure = stderrTail.includes(NO_SANDBOX_SIGNATURE)
      ? new PagePreviewSandboxError({ blockedBy: "userNamespaces" })
      : stderrTail.includes(ROOT_SANDBOX_SIGNATURE)
        ? new PagePreviewSandboxError({ blockedBy: "root" })
        : new PagePreviewBrowserError({
            reason: exitReason(Option.getOrUndefined(status), stderrTail),
            output: stderrTail,
          });
    disconnected = error;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiters, ({ reply }) => Deferred.fail(reply, error), { discard: true });
    yield* Effect.forEach(
      pages.values(),
      (page) => (page.loaded ? Deferred.fail(page.loaded, error) : Effect.void),
      { discard: true },
    );
  });

  const partial: Array<string> = [];
  yield* child.getOutputFd(4).pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.forEach(splitCdpMessages(partial, text), receive, { discard: true }),
    ),
    Effect.ignore,
    // Interruption means the scope is closing on purpose; only an exit disconnects.
    Effect.andThen(disconnect),
    Effect.forkScoped,
  );

  const send = <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ) =>
    Effect.gen(function* () {
      if (disconnected) return yield* disconnected;
      const page = sessionId === undefined ? undefined : sessionPages.get(sessionId);
      if (page?.failure) return yield* page.failure;
      const command = encodeCommand(method, params, sessionId);
      const reply = yield* Deferred.make<unknown, BrowserFailure>();
      pending.set(command.id, { method, sessionId, reply });
      yield* Queue.offer(outgoing, command.bytes);
      return yield* Deferred.await(reply).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(result)),
        Effect.mapError((error) =>
          error._tag === "PagePreviewBrowserError" || error._tag === "PagePreviewSandboxError"
            ? error
            : new PagePreviewBrowserError({
                reason: `${method} returned an unexpected result`,
                cause: error,
              }),
        ),
      );
    });

  /** Runs `expression` (awaiting it), and decodes what it returns; fails when it throws. */
  const evaluate = <A>(
    expression: string,
    value: Schema.Decoder<A>,
    sessionId: string,
    contextId?: number,
  ) =>
    send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId === undefined ? {} : { contextId }),
      },
      Evaluated,
      sessionId,
    ).pipe(
      Effect.flatMap(({ result, exceptionDetails }) =>
        exceptionDetails === undefined
          ? Schema.decodeUnknownEffect(value)(result.value).pipe(
              Effect.mapError(
                (cause) =>
                  new PagePreviewBrowserError({
                    reason: "measuring the page returned an unexpected result",
                    cause,
                  }),
              ),
            )
          : Effect.fail(
              new PagePreviewBrowserError({
                reason: "the page could not be measured",
                cause: exceptionDetails.exception?.description ?? exceptionDetails.text,
              }),
            ),
      ),
    );

  /** A fresh host page at `width`; each `load` navigates it and settles the page in it. */
  const openPage = Effect.fnUntraced(function* (width: number) {
    const { targetId } = yield* send(
      "Target.createTarget",
      { url: "about:blank" },
      Schema.Struct({ targetId: Schema.String }),
    );
    const { sessionId } = yield* send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      Schema.Struct({ sessionId: Schema.String }),
    );
    const page: PageState = {
      targetId,
      sessionId,
      body: undefined,
      loaded: undefined,
      failure: undefined,
      hostContexts: new Set(),
      frameSessions: new Map(),
      consoleMessages: [],
      omittedConsoleMessages: 0,
    };
    pages.set(sessionId, page);
    sessionPages.set(sessionId, page);
    yield* send("Page.enable", {}, Ignored, sessionId);
    yield* send("Runtime.enable", {}, Ignored, sessionId);
    yield* send("Log.enable", {}, Ignored, sessionId);
    // Runs before page scripts in every frame in this process; frames in
    // their own process get it when they attach.
    yield* send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: NO_WEBRTC_SCRIPT, runImmediately: true },
      Ignored,
      sessionId,
    );
    // Sandboxed frames may run in their own process; attach them paused, so
    // their console is reported from the first script on.
    yield* send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      Ignored,
      sessionId,
    );
    // Pauses the host origin, to serve the host page, and every document, to
    // keep the host page where it is.
    yield* send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `${HOST_ORIGIN}/*` },
          { urlPattern: "*", resourceType: "Document" },
        ],
      },
      Ignored,
      sessionId,
    );
    const setViewport = (height: number) =>
      send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        Ignored,
        sessionId,
      );
    yield* setViewport(VIEWPORT_HEIGHT);

    /** The page's frame: a session of its own when it runs out of process, else the host's. */
    const pageFrame = Effect.gen(function* () {
      const outOfProcess = [...page.frameSessions].findLast(
        ([, frame]) => frame.parent === sessionId,
      );
      if (outOfProcess) return { sessionId: outOfProcess[0], frameId: outOfProcess[1].targetId };
      const tree = yield* send("Page.getFrameTree", {}, FrameTree, sessionId);
      const frameId = tree.frameTree.childFrames?.[0]?.frame.id;
      if (frameId === undefined) {
        return yield* new PagePreviewBrowserError({ reason: "the page's frame did not load" });
      }
      return { sessionId, frameId };
    });

    /** Loads a host page from `hostBody`, so callers loading it often encode it once. */
    const load = Effect.fnUntraced(function* (body: Uint8Array) {
      const loaded = yield* Deferred.make<void, BrowserFailure>();
      page.body = body;
      page.loaded = loaded;
      const navigation = yield* send("Page.navigate", { url: HOST_URL }, Navigation, sessionId);
      if (navigation.errorText) {
        return yield* new PagePreviewBrowserError({ reason: "the page could not be opened" });
      }
      // The host's load waits for the frame's.
      yield* Deferred.await(loaded);
      const frame = yield* pageFrame;
      // A world of its own, so nothing here shows up in the page's scripts.
      const { executionContextId } = yield* send(
        "Page.createIsolatedWorld",
        { frameId: frame.frameId, worldName: "threadlines-preview" },
        IsolatedWorld,
        frame.sessionId,
      );
      /** Waits for the page to settle, then reads the last height it reported. */
      const settleAndRead = Effect.gen(function* () {
        const nonce = crypto.randomUUID();
        yield* evaluate(settleExpression(nonce), Settled, frame.sessionId, executionContextId);
        return yield* evaluate(
          `window.__threadlinesPreview.read(${JSON.stringify(nonce)}, ${SIZE_QUIET_MS}, ${FIRST_SIZE_WAIT_MS})`,
          SizeReport,
          sessionId,
        );
      });
      const size = yield* settleAndRead;
      const roundedHeight = (report: typeof size) =>
        report.reported ? Math.max(0, Math.ceil(report.height)) : 0;

      /** Sizes the frame (and the viewport) to `height`; returns the frame's box. */
      const resize = (height: number) =>
        setViewport(height).pipe(
          Effect.andThen(
            evaluate(`window.__threadlinesPreview.resize(${height})`, FrameRect, sessionId),
          ),
        );

      // Sizes the frame to the reported height and follows the reports that
      // causes, as the chat does, a few rounds at most: a page whose height
      // grows with its frame would never stop. A page that never reports a
      // height keeps the frame's initial one.
      const capture = Effect.gen(function* () {
        let report = size;
        let capturedHeight = INITIAL_FRAME_HEIGHT;
        let rect = yield* resize(capturedHeight);
        for (let round = 0; round < MAX_RESIZE_ROUNDS && report.reported; round += 1) {
          const next = Math.max(1, Math.min(roundedHeight(report), MAX_CAPTURE_HEIGHT));
          if (next === capturedHeight) break;
          capturedHeight = next;
          rect = yield* resize(capturedHeight);
          // Also lets the frame repaint at its new size, in whichever process it runs.
          report = yield* settleAndRead;
        }
        const { data } = yield* send(
          "Page.captureScreenshot",
          { format: "png", clip: { ...rect, scale: 1 } },
          Schema.Struct({ data: Schema.String }),
          sessionId,
        );
        return { png: data, contentHeight: roundedHeight(report), capturedHeight };
      });

      return {
        contentHeight: roundedHeight(size),
        reported: size.reported,
        capture,
      } satisfies LoadedPage;
    });

    const consoleMessages = (): ReadonlyArray<ConsoleMessage> =>
      page.omittedConsoleMessages === 0
        ? [...page.consoleMessages]
        : [
            ...page.consoleMessages,
            {
              level: "warning",
              text: `${page.omittedConsoleMessages} more console messages were omitted.`,
            },
          ];

    // Frees the page in the browser once it is no longer needed. It runs as
    // cleanup, so it never waits on a browser that may have stopped answering.
    const close = post("Target.closeTarget", { targetId }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pages.delete(sessionId);
          for (const [session, owner] of sessionPages) {
            if (owner === page) sessionPages.delete(session);
          }
        }),
      ),
    );

    return { load, consoleMessages, close };
  });

  return { openPage };
});

/** A temporary directory for the browser profile, removed with the scope. */
const scratchDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "threadlines-page-preview-" }),
    (directory) => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new PagePreviewBrowserError({
          reason: "a temporary directory could not be created",
          cause,
        }),
    ),
  );
});

const startBrowser = (executable: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* scratchDirectory;
    return yield* launchBrowser({ executable, profileDirectory: path.join(directory, "profile") });
  });

export interface PageCapture {
  /** Base64 PNG of the frame, its top `capturedHeight` CSS pixels. */
  readonly png: string;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
}

/**
 * Loads `document` at `width`, sizes its frame to the height it reports (at
 * most `MAX_CAPTURE_HEIGHT`), and captures the frame. A page that never
 * reports a height is captured at the frame's initial height.
 */
export const capturePage = Effect.fn("headlessChrome.capturePage")(function* (input: {
  readonly executable: string;
  readonly document: string;
  readonly width: number;
}) {
  const browser = yield* startBrowser(input.executable);
  const page = yield* browser.openPage(input.width);
  const loaded = yield* page.load(hostBody(input.document));
  const captured = yield* loaded.capture;
  return { ...captured, consoleMessages: page.consoleMessages() } satisfies PageCapture;
}, Effect.scoped);

/**
 * The height `document` reports at each width, each from a fresh load,
 * since pages often lay themselves out from the width once at load. One
 * browser, a few widths at a time. Fails when the page reports no height.
 */
export const measurePage = Effect.fn("headlessChrome.measurePage")(function* (input: {
  readonly executable: string;
  readonly document: string;
  readonly widths: ReadonlyArray<number>;
}) {
  const browser = yield* startBrowser(input.executable);
  const body = hostBody(input.document);
  return yield* Effect.forEach(
    input.widths,
    (width) =>
      browser.openPage(width).pipe(
        Effect.flatMap((page) => page.load(body).pipe(Effect.ensuring(page.close))),
        Effect.flatMap((loaded) =>
          loaded.reported
            ? Effect.succeed([width, loaded.contentHeight] as const)
            : Effect.fail(
                new PagePreviewBrowserError({
                  reason: `the page reported no height at ${width}px`,
                }),
              ),
        ),
      ),
    { concurrency: MEASURE_CONCURRENCY },
  );
}, Effect.scoped);
