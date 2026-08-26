import {
  attachResolvedLanguages,
  attachResolvedThemes,
  getSharedHighlighter,
  ShikiStreamTokenizer,
  type DiffsHighlighter,
  type ThemedToken,
} from "@pierre/diffs";

import type {
  CodeHighlightRequest,
  CodeHighlightResponse,
  CodeHighlightStreamRequest,
  CodeHighlightStreamResponse,
  CodeHighlightWorkerRequest,
  StreamToken,
} from "./codeHighlight";

/**
 * Syntax highlighting for chat code blocks, off the main thread.
 *
 * Shiki compiles a grammar's regexes the first time it tokenizes that language,
 * which is a second or more of straight-line work on a slow machine. On the
 * main thread that freezes the page mid-reply, so it happens here instead.
 *
 * Grammars and themes are network-loaded modules that Pierre refuses to resolve
 * inside a worker, so {@link CodeHighlightRequest} carries the resolved data
 * from the client the first time a language or theme is needed.
 */

let highlighterPromise: Promise<DiffsHighlighter> | null = null;

function loadHighlighter(): Promise<DiffsHighlighter> {
  // Asking for no themes and only `text` resolves nothing, which is what makes
  // this call legal in a worker; everything else arrives pre-resolved.
  highlighterPromise ??= getSharedHighlighter({
    themes: [],
    langs: ["text"],
    preferredHighlighter: "shiki-js",
  });
  return highlighterPromise;
}

function highlightToHtml(
  highlighter: DiffsHighlighter,
  request: CodeHighlightRequest,
): string | null {
  try {
    return highlighter.codeToHtml(request.code, { lang: request.language, theme: request.theme });
  } catch {
    // The grammar is missing or broke on this input; plain text still reads.
    try {
      return highlighter.codeToHtml(request.code, { lang: "text", theme: request.theme });
    } catch {
      return null;
    }
  }
}

async function handleRequest(request: CodeHighlightRequest): Promise<void> {
  let response: CodeHighlightResponse;
  try {
    const highlighter = await loadHighlighter();
    if (request.resolvedThemes.length > 0) {
      attachResolvedThemes(request.resolvedThemes, highlighter);
    }
    if (request.resolvedLanguages.length > 0) {
      attachResolvedLanguages(request.resolvedLanguages, highlighter);
    }
    const html = highlightToHtml(highlighter, request);
    response =
      html === null
        ? { id: request.id, error: `No usable grammar for "${request.language}"` }
        : { id: request.id, html };
  } catch (error) {
    response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  postMessage(response);
}

/**
 * One open fence. `queue` serializes open/append/close so a chunk never
 * tokenizes before its grammar is attached, and so the tokenizer sees the
 * deltas in the order the client sent them.
 */
interface StreamEntry {
  queue: Promise<void>;
  tokenizer: ShikiStreamTokenizer | null;
  lastSeq: number;
}

const streams = new Map<number, StreamEntry>();

function toStreamTokens(tokens: readonly ThemedToken[]): StreamToken[] {
  return tokens.map((token) => ({
    content: token.content,
    color: token.color,
    fontStyle: token.fontStyle,
  }));
}

function postStreamTokens(response: CodeHighlightStreamResponse): void {
  postMessage(response);
}

function openStream(request: Extract<CodeHighlightStreamRequest, { kind: "stream-open" }>): void {
  const entry: StreamEntry = { queue: Promise.resolve(), tokenizer: null, lastSeq: 0 };
  streams.set(request.streamId, entry);
  entry.queue = (async () => {
    const highlighter = await loadHighlighter();
    if (request.resolvedThemes.length > 0) {
      attachResolvedThemes(request.resolvedThemes, highlighter);
    }
    if (request.resolvedLanguages.length > 0) {
      attachResolvedLanguages(request.resolvedLanguages, highlighter);
    }
    entry.tokenizer = new ShikiStreamTokenizer({
      highlighter,
      lang: request.language,
      theme: request.theme,
    });
  })().catch(() => {
    // No grammar, no tokens: the client keeps showing the block plain.
    streams.delete(request.streamId);
  });
}

function appendToStream(
  request: Extract<CodeHighlightStreamRequest, { kind: "stream-append" }>,
): void {
  const entry = streams.get(request.streamId);
  if (!entry) return;
  entry.lastSeq = request.seq;
  entry.queue = entry.queue
    .then(async () => {
      const tokenizer = entry.tokenizer;
      if (!tokenizer) return;
      const { recall, stable, unstable } = await tokenizer.enqueue(request.chunk);
      postStreamTokens({
        kind: "stream-tokens",
        streamId: request.streamId,
        seq: request.seq,
        recall,
        tokens: toStreamTokens([...stable, ...unstable]),
        final: false,
      });
    })
    .catch(() => {
      streams.delete(request.streamId);
    });
}

function closeStream(request: Extract<CodeHighlightStreamRequest, { kind: "stream-close" }>): void {
  const entry = streams.get(request.streamId);
  if (!entry) return;
  streams.delete(request.streamId);
  entry.queue = entry.queue
    .then(() => {
      const tokenizer = entry.tokenizer;
      if (!tokenizer) return;
      entry.tokenizer = null;
      // `close()` hands back the unstable tail unchanged, so recalling exactly
      // that tail leaves the client's tokens identical: settling never repaints.
      const recall = tokenizer.tokensUnstable.length;
      postStreamTokens({
        kind: "stream-tokens",
        streamId: request.streamId,
        seq: entry.lastSeq + 1,
        recall,
        tokens: toStreamTokens(tokenizer.close().stable),
        final: true,
      });
    })
    .catch(() => {});
}

function handleStreamRequest(request: CodeHighlightStreamRequest): void {
  switch (request.kind) {
    case "stream-open": {
      openStream(request);
      return;
    }
    case "stream-append": {
      appendToStream(request);
      return;
    }
    case "stream-close": {
      closeStream(request);
    }
  }
}

self.addEventListener("message", (event: MessageEvent<CodeHighlightWorkerRequest>) => {
  const request = event.data;
  if ("kind" in request) {
    handleStreamRequest(request);
    return;
  }
  void handleRequest(request);
});
