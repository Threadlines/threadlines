import type {
  AgentPageId,
  AgentPageReadResult,
  AgentPageVersionId,
  EnvironmentId,
  ThreadId,
} from "@threadlines/contracts";
import {
  AGENT_PAGE_FALLBACK_THEMES,
  AGENT_PAGE_THEME_TOKENS,
  type AgentPageAppearance,
  type AgentPageTheme,
  agentPageTheme,
} from "@threadlines/shared/agentPages";
import { useMemo } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useTheme } from "../../hooks/useTheme";
import { LRUCache } from "../../lib/lruCache";

/**
 * The web's side of agent pages (docs/agent-pages.md): the theme a page
 * is handed, read from the app's live tokens, and the stored versions,
 * fetched once and kept in a small cache.
 */

let colorContext: CanvasRenderingContext2D | null | undefined;

/**
 * Any color the browser understands, as hex (`#rrggbb`, or `#rrggbbaa` with
 * transparency), by painting one pixel. Pages get hex because some chart
 * libraries reject newer syntax such as oklch() and color-mix().
 */
function cssColorToHex(value: string): string | null {
  if (colorContext === undefined) {
    colorContext =
      document.createElement("canvas").getContext("2d", { willReadFrequently: true }) ?? null;
  }
  const context = colorContext;
  if (context === null || value.trim().length === 0) return null;
  // Two sentinels: a value the canvas cannot parse leaves fillStyle as it was.
  context.fillStyle = "#010203";
  context.fillStyle = value;
  const first = context.fillStyle;
  context.fillStyle = "#040506";
  context.fillStyle = value;
  if (first === "#010203" && context.fillStyle === "#040506") return null;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  const hex = (channel: number | undefined) => (channel ?? 0).toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}${alpha === 255 ? "" : hex(alpha)}`;
}

/** The theme a page is handed: the app's live tokens as hex, falling back per token. */
export function readAgentPageTheme(appearance: AgentPageAppearance): AgentPageTheme {
  const fallback = AGENT_PAGE_FALLBACK_THEMES[appearance];
  const computed = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = { ...fallback.variables };
  for (const [pageVariable, appToken] of Object.entries(AGENT_PAGE_THEME_TOKENS)) {
    const hex = cssColorToHex(computed.getPropertyValue(appToken));
    if (hex !== null) variables[pageVariable] = hex;
  }
  // The page's own background is the thread's exact color, not its hex copy.
  const surface = computed.getPropertyValue("--background").trim();
  if (surface.length > 0) variables["--tl-surface"] = surface;
  return agentPageTheme({ appearance, variables });
}

/** The current page theme; a new object only when the app's appearance changes. */
export function useAgentPageTheme(): AgentPageTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(() => readAgentPageTheme(resolvedTheme), [resolvedTheme]);
}

// ---------------------------------------------------------------------------
// Stored versions

// Versions never change once stored, so a cached copy is always right.
const contentCache = new LRUCache<AgentPageReadResult>(24, 48 * 1024 * 1024);
const pendingReads = new Map<string, Promise<AgentPageReadResult>>();

export interface AgentPageVersionRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pageId: AgentPageId;
  readonly versionId: AgentPageVersionId;
}

const cacheKey = (ref: AgentPageVersionRef) =>
  `${ref.environmentId}\u0000${ref.threadId}\u0000${ref.pageId}\u0000${ref.versionId}`;

export function cachedAgentPageContent(ref: AgentPageVersionRef): AgentPageReadResult | null {
  return contentCache.get(cacheKey(ref));
}

/** One stored version, read once however many frames ask for it at the same time. */
export function readAgentPageContent(ref: AgentPageVersionRef): Promise<AgentPageReadResult> {
  const key = cacheKey(ref);
  const cached = contentCache.get(key);
  if (cached !== null) return Promise.resolve(cached);
  const pending = pendingReads.get(key);
  if (pending !== undefined) return pending;
  const read = (async () => {
    const api = ensureEnvironmentApi(ref.environmentId);
    if (!api.pages) {
      throw new Error("This Threadlines server cannot show pages yet.");
    }
    const result = await api.pages.read({
      threadId: ref.threadId,
      pageId: ref.pageId,
      versionId: ref.versionId,
    });
    contentCache.set(key, result, result.content.length * 2);
    return result;
  })();
  pendingReads.set(key, read);
  const clear = () => {
    if (pendingReads.get(key) === read) pendingReads.delete(key);
  };
  void read.then(clear, clear);
  return read;
}
