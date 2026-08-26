import {
  getSharedHighlighter,
  resolveLanguages,
  resolveThemes,
  type DiffsHighlighter,
  type SupportedLanguages,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";
import type { ResolvedLanguage } from "@pierre/diffs/worker";

import type { DiffThemeName } from "./diffRendering";

/**
 * Client for the syntax-highlighting worker.
 *
 * Callers get HTML for one code block and nothing else: the worker owns the
 * highlighter, this module owns the request plumbing, and the caller decides
 * what to show until the HTML arrives. Highlighting is never worth a frame, so
 * every failure path here resolves to `null` and leaves the plain block up.
 */

export interface CodeHighlightRequest {
  readonly id: number;
  readonly code: string;
  readonly language: string;
  readonly theme: DiffThemeName;
  /** Grammar data the worker has not seen yet; empty once it has. */
  readonly resolvedLanguages: ResolvedLanguage[];
  readonly resolvedThemes: ThemeRegistrationResolved[];
}

export type CodeHighlightResponse =
  | { readonly id: number; readonly html: string }
  | { readonly id: number; readonly error: string };

/** One themed token, trimmed to the fields a chat code block renders. */
export interface StreamToken {
  readonly content: string;
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}

/** One tokenizer flush: drop `recall` tokens off the tail, then append `tokens`. */
export interface StreamTokenUpdate {
  readonly recall: number;
  readonly tokens: readonly StreamToken[];
}

/**
 * Streaming half of the worker protocol. A stream is opened once per open
 * fence, fed the deltas as they arrive, and closed when the fence settles;
 * the worker keeps one incremental tokenizer per live `streamId`.
 */
export type CodeHighlightStreamRequest =
  | {
      readonly kind: "stream-open";
      readonly streamId: number;
      readonly language: string;
      readonly theme: DiffThemeName;
      readonly resolvedLanguages: ResolvedLanguage[];
      readonly resolvedThemes: ThemeRegistrationResolved[];
    }
  | {
      readonly kind: "stream-append";
      readonly streamId: number;
      readonly seq: number;
      readonly chunk: string;
    }
  | { readonly kind: "stream-close"; readonly streamId: number };

export interface CodeHighlightStreamResponse extends StreamTokenUpdate {
  readonly kind: "stream-tokens";
  readonly streamId: number;
  readonly seq: number;
  readonly tokens: StreamToken[];
  /** Set on the reply to `stream-close`; nothing else follows for this stream. */
  readonly final: boolean;
}

export type CodeHighlightWorkerRequest = CodeHighlightRequest | CodeHighlightStreamRequest;
export type CodeHighlightWorkerResponse = CodeHighlightResponse | CodeHighlightStreamResponse;

/** Languages Shiki tokenizes without loading a grammar. */
const GRAMMARLESS_LANGUAGES = new Set(["text", "ansi"]);
const PLAIN_TEXT_LANGUAGE = "text";

let workerHolder: { worker: Worker | null } | null = null;
let nextRequestId = 0;
let nextStreamId = 0;
const pendingRequests = new Map<number, (html: string | null) => void>();
const streamResponders = new Map<number, (response: CodeHighlightStreamResponse) => void>();
const languageResolutions = new Map<string, Promise<ResolvedLanguage[]>>();
const themeResolutions = new Map<string, Promise<ThemeRegistrationResolved[]>>();
const deliveredLanguages = new Set<string>();
const deliveredThemes = new Set<string>();
const warmedThemes = new Set<string>();

function settleAllPending(html: string | null): void {
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const resolve of pending) resolve(html);
}

/** The one highlighting worker, or null where workers are unavailable. */
function getWorker(): Worker | null {
  workerHolder ??= { worker: createWorker() };
  return workerHolder.worker;
}

function createWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    // A module worker, not Vite's `?worker` default: the highlighter reaches
    // Shiki's bundled-grammar table, and an IIFE worker cannot code-split, so
    // `?worker` inlines every grammar into an 11 MB script.
    const worker = new Worker(new URL("./codeHighlightWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<CodeHighlightWorkerResponse>) => {
      const response = event.data;
      if ("kind" in response) {
        streamResponders.get(response.streamId)?.(response);
        return;
      }
      const resolve = pendingRequests.get(response.id);
      if (!resolve) return;
      pendingRequests.delete(response.id);
      resolve("html" in response ? response.html : null);
    });
    worker.addEventListener("error", (event) => {
      console.warn("Syntax highlighting worker failed; showing plain code.", event.message);
      settleAllPending(null);
    });
    worker.addEventListener("messageerror", () => {
      settleAllPending(null);
    });
    return worker;
  } catch (error) {
    console.warn(
      "Syntax highlighting worker is unavailable; highlighting on the main thread.",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Grammar and theme data for one request. Resolution is a dynamic import, so it
 * is cached per language and per theme and sent to the worker only once. A
 * fence label Shiki has no grammar for comes back as plain text.
 */
async function resolveRequestAssets(
  language: string,
  theme: DiffThemeName,
): Promise<{
  language: string;
  resolvedLanguages: ResolvedLanguage[];
  resolvedThemes: ThemeRegistrationResolved[];
}> {
  let resolvedThemes: ThemeRegistrationResolved[] = [];
  if (!deliveredThemes.has(theme)) {
    let themeResolution = themeResolutions.get(theme);
    if (!themeResolution) {
      themeResolution = resolveThemes([theme]);
      themeResolutions.set(theme, themeResolution);
    }
    resolvedThemes = await themeResolution;
  }

  if (GRAMMARLESS_LANGUAGES.has(language) || deliveredLanguages.has(language)) {
    return { language, resolvedLanguages: [], resolvedThemes };
  }

  let languageResolution = languageResolutions.get(language);
  if (!languageResolution) {
    languageResolution = resolveLanguages([language as SupportedLanguages]);
    languageResolutions.set(language, languageResolution);
  }
  try {
    return { language, resolvedLanguages: await languageResolution, resolvedThemes };
  } catch {
    // Shiki has no grammar for this fence label; plain text still reads.
    languageResolutions.delete(language);
    return { language: PLAIN_TEXT_LANGUAGE, resolvedLanguages: [], resolvedThemes };
  }
}

let fallbackHighlighterPromise: Promise<DiffsHighlighter> | null = null;

/** Main-thread highlighting, for environments with no worker (tests, failures). */
async function highlightOnMainThread(
  code: string,
  language: string,
  theme: DiffThemeName,
): Promise<string | null> {
  try {
    fallbackHighlighterPromise ??= getSharedHighlighter({
      themes: [theme],
      langs: [language as SupportedLanguages],
      preferredHighlighter: "shiki-js",
    });
    const highlighter = await fallbackHighlighterPromise;
    try {
      return highlighter.codeToHtml(code, { lang: language, theme });
    } catch {
      return highlighter.codeToHtml(code, { lang: PLAIN_TEXT_LANGUAGE, theme });
    }
  } catch (error) {
    console.warn(
      "Syntax highlighting is unavailable; showing plain code.",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Highlighted HTML for one code block, or null when it has to stay plain. */
export async function highlightCode(
  code: string,
  language: string,
  theme: DiffThemeName,
): Promise<string | null> {
  const worker = getWorker();
  const assets = await resolveRequestAssets(language, theme);
  if (!worker) {
    return highlightOnMainThread(code, assets.language, theme);
  }

  const id = (nextRequestId += 1);
  const request: CodeHighlightRequest = {
    id,
    code,
    language: assets.language,
    theme,
    resolvedLanguages: assets.resolvedLanguages,
    resolvedThemes: assets.resolvedThemes,
  };
  deliveredThemes.add(theme);
  if (assets.resolvedLanguages.length > 0) deliveredLanguages.add(assets.language);

  return new Promise<string | null>((resolve) => {
    pendingRequests.set(id, resolve);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes a transfer list, not a target origin
    worker.postMessage(request);
  });
}

/**
 * Folds one tokenizer flush into the tokens a caller is holding. `recall` only
 * ever covers the trailing tokens of the last (still partial) line, so every
 * token before it is final.
 */
export function applyStreamTokens(
  previous: readonly StreamToken[],
  update: StreamTokenUpdate,
): readonly StreamToken[] {
  const keep = Math.max(0, previous.length - Math.max(0, update.recall));
  return [...previous.slice(0, keep), ...update.tokens];
}

/**
 * A code block being tokenized as it streams. Feed it the delta on every flush;
 * subscribers get the block's tokens so far. Inert where no worker exists, so
 * the caller keeps showing plain code instead of blocking on the main thread.
 */
export interface StreamingHighlight {
  /** The next slice of code. Chunks sent before the grammar lands are buffered. */
  append(chunk: string): void;
  /** Flushes the last partial line; further appends are ignored. */
  close(): void;
  subscribe(listener: (tokens: readonly StreamToken[]) => void): () => void;
  dispose(): void;
}

const INERT_STREAMING_HIGHLIGHT: StreamingHighlight = {
  append() {},
  close() {},
  subscribe: () => () => {},
  dispose() {},
};

/** Opens an incremental tokenizer in the worker for one growing code block. */
export function openStreamingHighlight(language: string, theme: DiffThemeName): StreamingHighlight {
  const worker = getWorker();
  if (!worker) return INERT_STREAMING_HIGHLIGHT;

  const streamId = (nextStreamId += 1);
  const listeners = new Set<(tokens: readonly StreamToken[]) => void>();
  const buffered: string[] = [];
  let tokens: readonly StreamToken[] = [];
  let appliedSeq = 0;
  let sentSeq = 0;
  let opened = false;
  let closed = false;
  let disposed = false;

  const post = (message: CodeHighlightStreamRequest) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes a transfer list, not a target origin
    worker.postMessage(message);
  };

  const release = () => {
    streamResponders.delete(streamId);
    listeners.clear();
  };

  const flushBuffered = () => {
    if (buffered.length > 0) {
      // Coalesced: the tokenizer's cost is in the text, not the message count.
      const chunk = buffered.join("");
      buffered.length = 0;
      sentSeq += 1;
      post({ kind: "stream-append", streamId, seq: sentSeq, chunk });
    }
    if (closed) post({ kind: "stream-close", streamId });
  };

  streamResponders.set(streamId, (response) => {
    if (response.seq <= appliedSeq) return;
    appliedSeq = response.seq;
    tokens = applyStreamTokens(tokens, response);
    for (const listener of listeners) listener(tokens);
    if (response.final) release();
  });

  void resolveRequestAssets(language, theme).then(
    (assets) => {
      if (disposed) return;
      deliveredThemes.add(theme);
      if (assets.resolvedLanguages.length > 0) deliveredLanguages.add(assets.language);
      post({
        kind: "stream-open",
        streamId,
        language: assets.language,
        theme,
        resolvedLanguages: assets.resolvedLanguages,
        resolvedThemes: assets.resolvedThemes,
      });
      opened = true;
      flushBuffered();
    },
    () => {
      // No grammar and no theme means no tokens; the block stays plain.
      release();
    },
  );

  return {
    append(chunk) {
      if (disposed || closed || chunk.length === 0) return;
      buffered.push(chunk);
      if (opened) flushBuffered();
    },
    close() {
      if (disposed || closed) return;
      closed = true;
      if (opened) flushBuffered();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (tokens.length > 0) listener(tokens);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (opened && !closed) post({ kind: "stream-close", streamId });
      release();
    },
  };
}

/**
 * Starts the worker and loads the theme before any reply needs them, so the
 * first code block of a session is not also the one that boots Shiki. Cheap and
 * idempotent: call it from any surface that renders markdown.
 */
export function warmCodeHighlighter(theme: DiffThemeName): void {
  if (warmedThemes.has(theme)) return;
  warmedThemes.add(theme);
  const warm = () => {
    void highlightCode("", PLAIN_TEXT_LANGUAGE, theme);
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warm, { timeout: 2_000 });
  } else {
    setTimeout(warm, 0);
  }
}
