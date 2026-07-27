import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { LRUCache } from "../../lib/lruCache";
import { Button } from "../ui/button";

const INITIAL_VISUALIZATION_HEIGHT = 240;
const MIN_VISUALIZATION_HEIGHT = 80;
const MAX_VISUALIZATION_HEIGHT = 10_000;
const BRIDGE_SOURCE = "threadlines-codex-inline-vis";
const visualizationContentsCache = new LRUCache<string>(32, 40 * 1024 * 1024);
const visualizationReadPromises = new Map<string, Promise<string>>();

type VisualizationTheme = "light" | "dark";

interface CodexInlineVisualizationProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly file: string;
  readonly theme: VisualizationTheme;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly contents: string };

interface VisualizationBridgeMessage {
  readonly source?: unknown;
  readonly token?: unknown;
  readonly type?: unknown;
  readonly height?: unknown;
  readonly url?: unknown;
  readonly message?: unknown;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  return "The visualization could not be loaded.";
}

function safeJson(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function visualizationCacheKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly file: string;
}): string {
  return `${input.environmentId}\u0000${input.threadId}\u0000${input.file}`;
}

async function readVisualizationContents(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly file: string;
}): Promise<string> {
  const cacheKey = visualizationCacheKey(input);
  const cached = visualizationContentsCache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const pending = visualizationReadPromises.get(cacheKey);
  if (pending) {
    return pending;
  }

  const read = (async () => {
    const api = ensureEnvironmentApi(input.environmentId);
    if (!api.visualizations) {
      throw new Error("This Threadlines server does not support inline visualizations yet.");
    }
    const result = await api.visualizations.read({ threadId: input.threadId, file: input.file });
    visualizationContentsCache.set(cacheKey, result.contents, result.contents.length * 2);
    return result.contents;
  })();
  visualizationReadPromises.set(cacheKey, read);
  const clearPending = () => {
    if (visualizationReadPromises.get(cacheKey) === read) {
      visualizationReadPromises.delete(cacheKey);
    }
  };
  void read.then(clearPending, clearPending);
  return read;
}

export function buildCodexInlineVisualizationDocument(input: {
  readonly contents: string;
  readonly theme: VisualizationTheme;
  readonly bridgeToken: string;
}): string {
  const dark = input.theme === "dark";
  const colors = dark
    ? {
        background: "#171717",
        foreground: "#f3f3f3",
        muted: "#292929",
        mutedForeground: "#a3a3a3",
        border: "#3a3a3a",
        primary: "#e7e7e7",
        primaryForeground: "#171717",
        secondary: "#303030",
        secondaryForeground: "#ededed",
      }
    : {
        background: "#ffffff",
        foreground: "#171717",
        muted: "#f1f1f1",
        mutedForeground: "#666666",
        border: "#dedede",
        primary: "#252525",
        primaryForeground: "#ffffff",
        secondary: "#eeeeee",
        secondaryForeground: "#252525",
      };
  const bridgeToken = safeJson(input.bridgeToken);

  return `<!doctype html>
<html lang="en" data-theme="${input.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com; style-src 'unsafe-inline' data: blob: https://fonts.bunny.net https://fonts.googleapis.com; font-src data: https://fonts.bunny.net https://fonts.gstatic.com; img-src data: blob: https:; media-src data: blob: https:; connect-src data: blob:; worker-src data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <style>
    :root {
      color-scheme: ${input.theme};
      --background: ${colors.background};
      --foreground: ${colors.foreground};
      --card: ${colors.background};
      --card-foreground: ${colors.foreground};
      --popover: ${colors.background};
      --popover-foreground: ${colors.foreground};
      --primary: ${colors.primary};
      --primary-foreground: ${colors.primaryForeground};
      --secondary: ${colors.secondary};
      --secondary-foreground: ${colors.secondaryForeground};
      --muted: ${colors.muted};
      --muted-foreground: ${colors.mutedForeground};
      --accent: ${colors.secondary};
      --accent-foreground: ${colors.secondaryForeground};
      --border: ${colors.border};
      --input: ${colors.border};
      --ring: ${colors.mutedForeground};
      --destructive: #dc2626;
      --destructive-foreground: #ffffff;
      --viz-series-1: #3b82f6;
      --viz-series-2: #f59e0b;
      --viz-series-3: #22c55e;
      --viz-series-4: #a855f7;
      --viz-series-5: #ec4899;
      --radius: 6px;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { min-width: 0; margin: 0; background: var(--background); color: var(--foreground); }
    body { padding: 5px; overflow: hidden; }
    button, input, select, textarea { color: inherit; font: inherit; }
    button { cursor: pointer; }
    a { color: inherit; text-underline-offset: 3px; }
    svg { display: block; width: 1em; height: 1em; stroke-width: 1.75; }
    [hidden] { display: none !important; }
    .text-small { font-size: 12px; line-height: 1.4; }
    .text-muted { color: var(--muted-foreground); }
    .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .btn {
      display: inline-flex; min-height: 28px; align-items: center; justify-content: center; gap: 6px;
      padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius);
      background: var(--background); color: var(--foreground); font-weight: 500;
    }
    .btn:hover { background: var(--muted); }
    .btn[aria-pressed="true"], .btn-primary { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
    .form-input, .form-select, input[type="text"], input[type="number"], select, textarea {
      min-height: 30px; border: 1px solid var(--input); border-radius: var(--radius);
      background: var(--background); padding: 5px 8px;
    }
    .table-responsive { max-width: 100%; overflow-x: auto; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { padding: 7px 8px; border-bottom: 1px solid var(--border); text-align: left; }
    .card { border-block: 1px solid var(--border); padding-block: 12px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; background: var(--muted); padding: 2px 7px; font-size: 12px; }
    #threadlines-viz-tooltip {
      position: fixed; z-index: 2147483647; display: none; pointer-events: none;
      border: 1px solid var(--border); border-radius: 4px; background: var(--foreground);
      color: var(--background); padding: 3px 6px; font-size: 11px; white-space: nowrap;
    }
  </style>
  <script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"></script>
  <script>
    (() => {
      const token = ${bridgeToken};
      const send = (type, payload = {}) => parent.postMessage({ source: "${BRIDGE_SOURCE}", token, type, ...payload }, "*");
      let lastHeight = 0;
      let lastViewportHeight = 0;
      const measure = () => {
        const range = document.createRange();
        range.selectNodeContents(document.body);
        const rangeHeight = Math.ceil(range.getBoundingClientRect().height);
        const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, rangeHeight);
        const viewportHeight = window.innerHeight;
        const followsViewport =
          lastHeight > 0 &&
          lastViewportHeight > 0 &&
          Math.abs(height - lastHeight - (viewportHeight - lastViewportHeight)) <= 1;
        lastViewportHeight = viewportHeight;
        if (followsViewport) {
          lastHeight = height;
          return;
        }
        if (Number.isFinite(height) && height > 0 && height !== lastHeight) {
          lastHeight = height;
          send("height", { height });
        }
      };
      const install = () => {
        try { window.lucide?.createIcons?.(); } catch (_) {}
        const tooltip = document.createElement("div");
        tooltip.id = "threadlines-viz-tooltip";
        document.body.append(tooltip);
        document.addEventListener("pointerover", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
          if (!target) return;
          tooltip.textContent = target.getAttribute("data-tooltip") || "";
          const rect = target.getBoundingClientRect();
          tooltip.style.left = Math.max(5, rect.left + rect.width / 2) + "px";
          tooltip.style.top = Math.max(5, rect.top - 5) + "px";
          tooltip.style.transform = "translate(-50%, -100%)";
          tooltip.style.display = "block";
        });
        document.addEventListener("pointerout", () => { tooltip.style.display = "none"; });
        document.addEventListener("click", (event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
          if (!anchor) return;
          const href = anchor.getAttribute("href") || "";
          if (href.startsWith("#")) return;
          event.preventDefault();
          try {
            const url = new URL(anchor.href);
            if (url.protocol === "https:" || url.protocol === "http:") send("external-link", { url: url.href });
          } catch (_) {}
        }, true);
        new ResizeObserver(measure).observe(document.body);
        new MutationObserver(measure).observe(document.body, { childList: true, subtree: true, attributes: true });
        measure();
        requestAnimationFrame(measure);
      };
      addEventListener("error", (event) => send("error", { message: event.message || "Visualization script error" }));
      addEventListener("unhandledrejection", () => send("error", { message: "Visualization script error" }));
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
      else install();
    })();
  </script>
</head>
<body>
${input.contents}
</body>
</html>`;
}

export function CodexInlineVisualization({
  environmentId,
  threadId,
  file,
  theme,
}: CodexInlineVisualizationProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeToken = useId();
  const [height, setHeight] = useState(INITIAL_VISUALIZATION_HEIGHT);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setHeight(INITIAL_VISUALIZATION_HEIGHT);
    setPendingExternalUrl(null);
    setRuntimeError(null);
    void (async () => {
      try {
        const contents = await readVisualizationContents({ environmentId, threadId, file });
        if (!cancelled) {
          setLoadState({ status: "loaded", contents });
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadState({ status: "error", message: errorMessage(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, file, threadId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<VisualizationBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.source !== BRIDGE_SOURCE || data.token !== bridgeToken) return;
      if (data.type === "height" && typeof data.height === "number") {
        setHeight(
          Math.max(
            MIN_VISUALIZATION_HEIGHT,
            Math.min(MAX_VISUALIZATION_HEIGHT, Math.ceil(data.height)),
          ),
        );
      } else if (data.type === "external-link" && typeof data.url === "string") {
        try {
          const url = new URL(data.url);
          if (url.protocol === "https:" || url.protocol === "http:") {
            setPendingExternalUrl(url.href);
          }
        } catch {
          // Ignore malformed URLs posted by untrusted visualization content.
        }
      } else if (data.type === "error" && typeof data.message === "string") {
        setRuntimeError(data.message.slice(0, 180));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bridgeToken]);

  const document = useMemo(
    () =>
      loadState.status === "loaded"
        ? buildCodexInlineVisualizationDocument({
            contents: loadState.contents,
            theme,
            bridgeToken,
          })
        : null,
    [bridgeToken, loadState, theme],
  );

  if (loadState.status === "loading") {
    return (
      <div
        role="status"
        aria-label={`Loading visualization ${file}`}
        className="my-3 h-60 w-full animate-pulse border-y border-border bg-muted/25"
      />
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="my-3 border-y border-border py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Visualization unavailable.</span>{" "}
        {loadState.message}
      </div>
    );
  }

  return (
    <div className="relative my-3 w-full border-y border-border bg-background">
      {pendingExternalUrl ? (
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Open {pendingExternalUrl}?
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              window.open(pendingExternalUrl, "_blank", "noopener,noreferrer");
              setPendingExternalUrl(null);
            }}
          >
            <ExternalLinkIcon aria-hidden />
            Open
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel opening external link"
            onClick={() => setPendingExternalUrl(null)}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={`Interactive visualization: ${file.replace(/\.html$/, "").replaceAll("-", " ")}`}
        srcDoc={document ?? undefined}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
      {runtimeError ? (
        <div className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          Visualization reported an error: {runtimeError}
        </div>
      ) : null}
    </div>
  );
}
